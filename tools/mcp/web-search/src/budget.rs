// Copyright (C) The Infumap Authors
// This file is part of Infumap.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use std::collections::BTreeMap;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use jiff::{Span, Timestamp, civil::Date, tz::TimeZone};
use log::{debug, error, info};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::providers::{
  ProviderError, ProviderErrorKind, ProviderResult, RequestCost, SearchProvider, SearchRequest, SearchResponse,
  UsageSnapshot,
};

const LEDGER_VERSION: u32 = 2;
const MAX_LEDGER_BYTES: usize = 4 * 1024 * 1024;

/// One process owns a ledger directory. Within that process the mutex serializes
/// durable transactions; no mutex guard is held during a provider request.
pub struct BudgetStore {
  directory: PathBuf,
  _lock: File,
  state: Mutex<StoreState>,
}

struct StoreState {
  ledger: Ledger,
  failed: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
  version: u32,
  next_reservation_id: u64,
  accounts: BTreeMap<String, BTreeMap<String, AccountState>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AccountState {
  reset_day: u8,
  period_start: i64,
  period_end: i64,
  free_limit_usd_micros: u64,
  consumed_usd_micros: u64,
  reservations: BTreeMap<u64, u64>,
  reported_remaining_cap_usd_micros: Option<u64>,
  reported_allowance_cap_usd_micros: Option<u64>,
}

#[derive(Clone)]
pub struct BudgetAccount {
  store: Arc<BudgetStore>,
  provider: String,
  account_id: String,
}

#[derive(Serialize)]
pub struct BudgetBalance {
  pub free_allowance_usd_micros: u64,
  pub free_remaining_usd_micros: u64,
  pub reserved_usd_micros: u64,
  pub consumed_usd_micros: u64,
  pub period_start: i64,
  pub period_end: i64,
}

#[derive(Serialize)]
pub struct BudgetSnapshot {
  #[serde(flatten)]
  pub balance: BudgetBalance,
  pub configured_free_allowance_usd_micros: u64,
  pub adjusted_remaining_cap_usd_micros: Option<u64>,
  pub reported_allowance_cap_usd_micros: Option<u64>,
  pub reset_day: u8,
  pub persistence_error: Option<&'static str>,
}

/// Dispatched reservations are conservatively charged on cancellation. Cleanup
/// runs in a blocking worker so dropping a timed-out request never waits on I/O.
struct Reservation {
  account: BudgetAccount,
  id: u64,
  dispatched: bool,
  finished: bool,
  dispatch_guard: Option<OwnedMutexGuard<()>>,
}

impl BudgetStore {
  pub fn open(directory: &Path) -> ProviderResult<Arc<Self>> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::DirBuilderExt;
      builder.mode(0o700);
    }
    builder.create(directory).map_err(|_| internal("Could not create budget state directory."))?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.mode(0o600);
    }
    let lock = options.open(directory.join("budget.lock")).map_err(|_| internal("Could not open budget lock file."))?;
    lock.try_lock().map_err(|_| internal("Budget state directory is already in use or cannot be locked."))?;

    let mut ledger = match File::open(directory.join("budget.json")) {
      Ok(file) => {
        let mut bytes = Vec::new();
        file
          .take((MAX_LEDGER_BYTES + 1) as u64)
          .read_to_end(&mut bytes)
          .map_err(|_| internal("Could not read budget ledger."))?;
        if bytes.len() > MAX_LEDGER_BYTES {
          return Err(internal("Budget ledger exceeds the size limit."));
        }
        parse_ledger(&bytes)?
      }
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
        Ledger { version: LEDGER_VERSION, next_reservation_id: 1, accounts: BTreeMap::new() }
      }
      Err(_) => return Err(internal("Could not open budget ledger.")),
    };
    if ledger.version != LEDGER_VERSION || ledger.next_reservation_id == 0 {
      return Err(internal("Unsupported or invalid budget ledger version or reservation counter."));
    }
    let now = Timestamp::now();
    for accounts in ledger.accounts.values_mut() {
      for account in accounts.values_mut() {
        account.validate(ledger.next_reservation_id)?;
        account.advance(now)?;
        // The exclusive process lock proves no previous owner is still running.
        // Its unresolved requests may have been billed: keep their full estimates.
        let recovered = account.reserved()?;
        account.charge(recovered)?;
        account.reservations.clear();
      }
    }
    persist(directory, &ledger)?;
    Ok(Arc::new(Self {
      directory: directory.to_owned(),
      _lock: lock,
      state: Mutex::new(StoreState { ledger, failed: false }),
    }))
  }

  pub fn account(self: &Arc<Self>, provider: &str, free_cents: u64, reset_day: u8) -> ProviderResult<BudgetAccount> {
    let free_limit =
      free_cents.checked_mul(10_000).ok_or_else(|| internal("Free budget exceeds the supported range."))?;
    if provider.is_empty() || !(1..=31).contains(&reset_day) {
      return Err(internal("Budget account settings are invalid."));
    }
    let now = Timestamp::now();
    let account_id = self.transaction(|ledger| {
      let accounts = ledger.accounts.entry(provider.to_owned()).or_default();
      // One account per provider. Reuse the saved entry, including a former
      // custom label, so removing configuration cannot reset usage or quota caps.
      if accounts.len() > 1 {
        return Err(internal(
          "Multiple saved accounts for a provider; automatic single-account selection is ambiguous.",
        ));
      }
      let account_id = accounts.keys().next().cloned().unwrap_or_else(|| "default".to_owned());
      if let Some(account) = accounts.get_mut(&account_id) {
        if account.reset_day != reset_day {
          return Err(internal("Monthly reset day differs from the stored account schedule; refusing to reset usage."));
        }
        account.advance(now)?;
        account.free_limit_usd_micros = free_limit;
      } else {
        let (period_start, period_end) = period_at(now, reset_day)?;
        accounts.insert(
          account_id.clone(),
          AccountState {
            reset_day,
            period_start,
            period_end,
            free_limit_usd_micros: free_limit,
            consumed_usd_micros: 0,
            reservations: BTreeMap::new(),
            reported_remaining_cap_usd_micros: None,
            reported_allowance_cap_usd_micros: None,
          },
        );
      }
      Ok(account_id)
    })?;
    Ok(BudgetAccount { store: Arc::clone(self), provider: provider.to_owned(), account_id })
  }

  fn transaction<T>(&self, update: impl FnOnce(&mut Ledger) -> ProviderResult<T>) -> ProviderResult<T> {
    let mut state = self.state.lock().map_err(|_| internal("Budget ledger lock is poisoned."))?;
    if state.failed {
      return Err(internal("Budget persistence previously failed; restart after repairing the state directory."));
    }
    let mut next = state.ledger.clone();
    let result = update(&mut next)?;
    if let Err(error) = persist(&self.directory, &next) {
      // A rename may have succeeded before a sync failed. Never dispatch another
      // metered request using memory that could disagree with durable state.
      state.failed = true;
      return Err(error);
    }
    state.ledger = next;
    Ok(result)
  }
}

impl AccountState {
  fn reserved(&self) -> ProviderResult<u64> {
    self.reservations.values().try_fold(0, |sum, &cost| checked_total(sum, cost))
  }

  fn validate(&self, next_id: u64) -> ProviderResult<()> {
    if !(1..=31).contains(&self.reset_day) || self.reservations.keys().any(|&id| id == 0 || id >= next_id) {
      return Err(internal("Budget ledger contains an invalid account or reservation."));
    }
    let timestamp = Timestamp::from_second(self.period_start).map_err(|_| internal("Budget period is invalid."))?;
    if period_at(timestamp, self.reset_day)? != (self.period_start, self.period_end) {
      return Err(internal("Budget ledger contains an invalid monthly period."));
    }
    checked_total(self.consumed_usd_micros, self.reserved()?)?;
    Ok(())
  }

  fn advance(&mut self, now: Timestamp) -> ProviderResult<()> {
    if now.as_second() < self.period_start {
      return Err(internal("Clock precedes the stored budget period; refusing to reset usage."));
    }
    if now.as_second() >= self.period_end {
      (self.period_start, self.period_end) = period_at(now, self.reset_day)?;
      self.consumed_usd_micros = 0;
      self.reported_remaining_cap_usd_micros = None;
      self.reported_allowance_cap_usd_micros = None;
      // Outstanding requests can be billed after the boundary. Their reservations
      // also constrain the new period until they settle.
    }
    Ok(())
  }

  fn charge(&mut self, cost: u64) -> ProviderResult<()> {
    self.consumed_usd_micros = checked_total(self.consumed_usd_micros, cost)?;
    if let Some(remaining) = &mut self.reported_remaining_cap_usd_micros {
      *remaining = remaining.saturating_sub(cost);
    }
    Ok(())
  }

  fn balance(&self) -> ProviderResult<BudgetBalance> {
    let reserved = self.reserved()?;
    let committed = checked_total(self.consumed_usd_micros, reserved)?;
    let free_limit = self
      .reported_allowance_cap_usd_micros
      .map_or(self.free_limit_usd_micros, |allowance| self.free_limit_usd_micros.min(allowance));
    let free = free_limit.saturating_sub(committed);
    let reported = self.reported_remaining_cap_usd_micros.map(|remaining| remaining.saturating_sub(reserved));
    Ok(BudgetBalance {
      free_allowance_usd_micros: free_limit,
      free_remaining_usd_micros: reported.map_or(free, |cap| free.min(cap)),
      consumed_usd_micros: self.consumed_usd_micros,
      reserved_usd_micros: reserved,
      period_start: self.period_start,
      period_end: self.period_end,
    })
  }
}

impl BudgetAccount {
  /// Project a rollover on a copy, without writing or changing accounting state.
  /// Even after a write failure, operators can inspect the last in-memory ledger.
  fn snapshot(&self) -> ProviderResult<BudgetSnapshot> {
    let state = self.store.state.lock().map_err(|_| internal("Budget ledger lock is poisoned."))?;
    let mut account = state
      .ledger
      .accounts
      .get(&self.provider)
      .and_then(|accounts| accounts.get(&self.account_id))
      .cloned()
      .ok_or_else(|| internal("Budget account is not registered."))?;
    let failed = state.failed;
    drop(state);
    account.advance(Timestamp::now())?;
    Ok(BudgetSnapshot {
      balance: account.balance()?,
      configured_free_allowance_usd_micros: account.free_limit_usd_micros,
      adjusted_remaining_cap_usd_micros: account.reported_remaining_cap_usd_micros,
      reported_allowance_cap_usd_micros: account.reported_allowance_cap_usd_micros,
      reset_day: account.reset_day,
      persistence_error: failed.then_some("Budget persistence failed; repair the state directory and restart."),
    })
  }

  fn state<'a>(&self, ledger: &'a mut Ledger) -> ProviderResult<&'a mut AccountState> {
    ledger
      .accounts
      .get_mut(&self.provider)
      .and_then(|accounts| accounts.get_mut(&self.account_id))
      .ok_or_else(|| internal("Budget account is not registered."))
  }

  pub fn balance(&self) -> ProviderResult<BudgetBalance> {
    self.store.transaction(|ledger| {
      let account = self.state(ledger)?;
      account.advance(Timestamp::now())?;
      account.balance()
    })
  }

  fn reserve(
    &self,
    cost: u64,
    deadline: Option<Instant>,
    dispatch_guard: OwnedMutexGuard<()>,
  ) -> ProviderResult<Reservation> {
    let id = self.store.transaction(|ledger| {
      // The worker may have waited for the ledger lock beyond the deadline.
      check_deadline(deadline)?;
      let id = ledger.next_reservation_id;
      ledger.next_reservation_id =
        id.checked_add(1).ok_or_else(|| internal("Budget reservation IDs are exhausted."))?;
      let account = self.state(ledger)?;
      account.advance(Timestamp::now())?;
      let balance = account.balance()?;
      let remaining = balance.free_remaining_usd_micros;
      if cost > remaining {
        return Err(
          ProviderError::new(
            ProviderErrorKind::InsufficientBudget,
            "Insufficient local search budget for this request.",
          )
          .without_charge(),
        );
      }
      account.reservations.insert(id, cost);
      Ok(id)
    })?;
    debug!("{} reserved {cost} free USD micros (reservation {id})", self.provider);
    Ok(Reservation {
      account: self.clone(),
      id,
      dispatched: false,
      finished: false,
      dispatch_guard: Some(dispatch_guard),
    })
  }

  fn settle(&self, id: u64, charged: bool, exhausted: bool, reported_cost: Option<u64>) -> ProviderResult<()> {
    let cost = self.store.transaction(|ledger| {
      let account = self.state(ledger)?;
      account.advance(Timestamp::now())?;
      let cost = account
        .reservations
        .remove(&id)
        .ok_or_else(|| internal("Budget reservation was already settled or is missing."))?;
      if charged {
        account.charge(reported_cost.unwrap_or(cost))?;
      }
      if exhausted {
        account.reported_remaining_cap_usd_micros = Some(0);
      }
      Ok(cost)
    })?;
    debug!(
      "{} settled reservation {id}, reserved {cost} USD micros, reported cost {reported_cost:?}: charged={charged}, quota_exhausted={exhausted}",
      self.provider
    );
    Ok(())
  }

  fn reconcile(&self, snapshot: &UsageSnapshot, period_start: i64) -> ProviderResult<()> {
    let applied = self.store.transaction(|ledger| {
      let account = self.state(ledger)?;
      account.advance(Timestamp::now())?;
      if account.period_start != period_start {
        // The query crossed a reset: its snapshot cannot safely describe this period.
        return Ok(false);
      }
      if let Some(reset) = snapshot.resets_at {
        let reset = Timestamp::try_from(reset).map_err(|_| internal("Reported usage reset time is invalid."))?;
        if reset.as_second() != account.period_end {
          return Err(ProviderError::new(
            ProviderErrorKind::UnexpectedResponse,
            "Provider usage reset does not match the configured budget period.",
          ));
        }
      }
      // Reports can only tighten free capacity, never refund uncertain charges.
      // Pending requests remain reserved separately.
      if let Some(remaining) = snapshot.remaining_usd_micros {
        account.reported_remaining_cap_usd_micros =
          Some(account.reported_remaining_cap_usd_micros.map_or(remaining, |old| old.min(remaining)));
      }
      if let Some(allowance) = snapshot.allowance_usd_micros {
        account.reported_allowance_cap_usd_micros =
          Some(account.reported_allowance_cap_usd_micros.map_or(allowance, |old| old.min(allowance)));
      }
      Ok(true)
    })?;
    debug!(
      "{} provider usage for period {period_start}: remaining {:?}, allowance {:?} USD micros; applied={applied}",
      self.provider, snapshot.remaining_usd_micros, snapshot.allowance_usd_micros
    );
    Ok(())
  }
}

impl Reservation {
  async fn finish(mut self, charged: bool, exhausted: bool, reported_cost: Option<u64>) -> ProviderResult<()> {
    // Queue before marking finished: cancellation while awaiting the worker must
    // not lose a known refund/quota cap or queue a second settlement from Drop.
    let task = self.schedule_settlement(charged, exhausted, reported_cost)?;
    self.finished = true;
    task.await.map_err(|_| internal("Budget settlement worker failed."))?
  }

  fn schedule_settlement(
    &mut self,
    charged: bool,
    exhausted: bool,
    reported_cost: Option<u64>,
  ) -> ProviderResult<JoinHandle<ProviderResult<()>>> {
    let runtime = tokio::runtime::Handle::try_current().map_err(|_| internal("Budget runtime is unavailable."))?;
    let account = self.account.clone();
    let id = self.id;
    let dispatch_guard = self.dispatch_guard.take();
    Ok(runtime.spawn_blocking(move || {
      // Retain provider exclusivity until the quota cap/charge is durable,
      // even if the caller times out while awaiting this worker.
      let _dispatch_guard = dispatch_guard;
      let result = account.settle(id, charged, exhausted, reported_cost);
      if let Err(error) = &result {
        error!("Could not settle search reservation: {error}");
      }
      result
    }))
  }
}

impl Drop for Reservation {
  fn drop(&mut self) {
    if !self.finished
      && let Err(error) = self.schedule_settlement(self.dispatched, false, None)
    {
      // The durable reservation still constrains capacity and is recovered on
      // restart, even when shutdown prevents scheduling its settlement.
      error!("Could not queue cancelled search settlement; durable reservation retained: {error}");
    }
  }
}

/// The adapter cannot issue a metered request without a durable reservation.
pub struct BudgetedProvider {
  inner: Box<dyn SearchProvider>,
  account: BudgetAccount,
  dispatch: Arc<AsyncMutex<()>>,
}

impl BudgetedProvider {
  pub fn new(inner: impl SearchProvider + 'static, account: BudgetAccount) -> ProviderResult<Self> {
    let balance = account.balance()?;
    info!(
      "{} local budget (USD micros): consumed {}, reserved {}, free remaining {}, resets at Unix second {}",
      inner.name(),
      balance.consumed_usd_micros,
      balance.reserved_usd_micros,
      balance.free_remaining_usd_micros,
      balance.period_end
    );
    Ok(Self { inner: Box::new(inner), account, dispatch: Arc::default() })
  }

  pub async fn balance(&self) -> ProviderResult<BudgetBalance> {
    let account = self.account.clone();
    budget_worker(move || account.balance()).await
  }

  pub async fn snapshot(&self) -> ProviderResult<BudgetSnapshot> {
    let account = self.account.clone();
    budget_worker(move || account.snapshot()).await
  }

  /// Dispatch requires enough free capacity for the entire request.
  pub async fn search_with_budget(
    &self,
    request: SearchRequest<'_>,
    deadline: Option<Instant>,
  ) -> ProviderResult<SearchResponse> {
    check_deadline(deadline)?;
    let cost = self.inner.estimate_cost(&request)?;
    let RequestCost::UsdMicros(cost) = cost else {
      return self.inner.search(request).await;
    };
    // A queued request must observe the previous request's durable quota cap
    // before reserving credits. Different providers remain independent.
    let dispatch_guard = Arc::clone(&self.dispatch).lock_owned().await;
    check_deadline(deadline)?;
    let account = self.account.clone();
    let mut reservation = budget_worker(move || {
      // Do not start a queued reservation after its request has expired.
      check_deadline(deadline)?;
      account.reserve(cost, deadline, dispatch_guard)
    })
    .await?;
    // A write may finish after timeout. A late reservation must never cause a
    // provider dispatch, even if the result wins a race with the timeout future.
    check_deadline(deadline)?;
    reservation.dispatched = true;
    let result = self.inner.search(request).await;
    let charged = !matches!(&result, Err(error) if error.not_charged);
    let exhausted = matches!(&result, Err(error) if error.kind == ProviderErrorKind::QuotaExhausted);
    let reported_cost = result.as_ref().ok().and_then(|response| response.reported_cost_usd_micros);
    // Settle consumption and a remote quota cap in one durable transaction.
    // Monthly rollover clears the cap; restarting the server does not.
    reservation.finish(charged, exhausted, reported_cost).await?;
    result
  }
}

impl SearchProvider for BudgetedProvider {
  fn name(&self) -> &'static str {
    self.inner.name()
  }

  fn estimate_cost(&self, request: &SearchRequest<'_>) -> ProviderResult<RequestCost> {
    self.inner.estimate_cost(request)
  }

  fn search<'a>(&'a self, request: SearchRequest<'a>) -> BoxFuture<'a, ProviderResult<SearchResponse>> {
    Box::pin(self.search_with_budget(request, None))
  }

  fn usage(&self) -> BoxFuture<'_, ProviderResult<Option<UsageSnapshot>>> {
    Box::pin(async {
      let period_start = self.balance().await?.period_start;
      let usage = self.inner.usage().await?;
      if let Some(snapshot) = &usage {
        let snapshot = snapshot.clone();
        let account = self.account.clone();
        budget_worker(move || account.reconcile(&snapshot, period_start)).await?;
      }
      Ok(usage)
    })
  }
}

async fn budget_worker<T: Send + 'static>(
  operation: impl FnOnce() -> ProviderResult<T> + Send + 'static,
) -> ProviderResult<T> {
  tokio::task::spawn_blocking(operation).await.map_err(|_| internal("Budget worker failed."))?
}

fn check_deadline(deadline: Option<Instant>) -> ProviderResult<()> {
  if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
    return Err(ProviderError::new(ProviderErrorKind::Transient, "Search provider exceeded the request deadline."));
  }
  Ok(())
}

/// Migrate version 1 in memory before the normal validated, durable startup
/// write. Drop only the obsolete paid allowance; retain consumption, quota caps,
/// periods, reservations and their IDs, including accounts not currently enabled.
fn parse_ledger(bytes: &[u8]) -> ProviderResult<Ledger> {
  let invalid = || internal("Budget ledger is invalid; refusing to reset usage.");
  let mut value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
  if value.get("version").and_then(serde_json::Value::as_u64) == Some(1) {
    let providers = value.get_mut("accounts").and_then(serde_json::Value::as_object_mut).ok_or_else(invalid)?;
    for accounts in providers.values_mut() {
      for account in accounts.as_object_mut().ok_or_else(invalid)?.values_mut() {
        let account = account.as_object_mut().ok_or_else(invalid)?;
        let paid = account.remove("paid_limit_usd_micros").and_then(|value| value.as_u64()).ok_or_else(invalid)?;
        let free = account.get("free_limit_usd_micros").and_then(serde_json::Value::as_u64).ok_or_else(invalid)?;
        // Reject malformed legacy limits rather than silently accepting a
        // ledger the previous version would have refused to load.
        checked_total(free, paid)?;
      }
    }
    value["version"] = serde_json::json!(LEDGER_VERSION);
  }
  serde_json::from_value(value).map_err(|_| invalid())
}

fn persist(directory: &Path, ledger: &Ledger) -> ProviderResult<()> {
  let bytes = serde_json::to_vec_pretty(ledger).map_err(|_| internal("Could not serialize budget ledger."))?;
  if bytes.len() > MAX_LEDGER_BYTES {
    return Err(internal("Budget ledger exceeds the size limit."));
  }
  let temporary = directory.join("budget.json.tmp");
  match fs::remove_file(&temporary) {
    Ok(()) => (),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
    Err(_) => return Err(internal("Could not remove an interrupted budget write.")),
  }
  let mut options = OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(&temporary).map_err(|_| internal("Could not create temporary budget ledger."))?;
  file
    .write_all(&bytes)
    .and_then(|_| file.sync_all())
    .map_err(|_| internal("Could not durably write budget ledger."))?;
  drop(file);
  fs::rename(&temporary, directory.join("budget.json")).map_err(|_| internal("Could not replace budget ledger."))?;
  #[cfg(unix)]
  File::open(directory)
    .and_then(|file| file.sync_all())
    .map_err(|_| internal("Could not sync budget state directory."))?;
  Ok(())
}

fn period_at(now: Timestamp, reset_day: u8) -> ProviderResult<(i64, i64)> {
  if !(1..=31).contains(&reset_day) {
    return Err(internal("Monthly reset day is invalid."));
  }
  let date = now.to_zoned(TimeZone::UTC).date();
  let month = Date::new(date.year(), date.month(), 1).map_err(|_| internal("Could not compute budget month."))?;
  let month = if now.as_second() < boundary(month, reset_day)? {
    month.checked_add(Span::new().months(-1)).map_err(|_| internal("Could not compute previous budget month."))?
  } else {
    month
  };
  let next = month.checked_add(Span::new().months(1)).map_err(|_| internal("Could not compute next budget month."))?;
  Ok((boundary(month, reset_day)?, boundary(next, reset_day)?))
}

fn boundary(month: Date, reset_day: u8) -> ProviderResult<i64> {
  let day = (reset_day as i8).min(month.days_in_month());
  Date::new(month.year(), month.month(), day)
    .and_then(|date| date.at(0, 0, 0, 0).to_zoned(TimeZone::UTC))
    .map(|date| date.timestamp().as_second())
    .map_err(|_| internal("Could not compute budget reset boundary."))
}

fn checked_total(left: u64, right: u64) -> ProviderResult<u64> {
  left.checked_add(right).ok_or_else(|| internal("Budget values exceed the supported range."))
}

fn internal(message: &str) -> ProviderError {
  ProviderError::new(ProviderErrorKind::Internal, message)
}
