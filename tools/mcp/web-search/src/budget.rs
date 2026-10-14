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
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::providers::{
  ProviderError, ProviderErrorKind, ProviderResult, RequestCost, SearchProvider, SearchRequest, SearchResult,
  UsageSnapshot,
};

const LEDGER_VERSION: u32 = 1;
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
  paid_limit_usd_micros: u64,
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
  pub total_remaining_usd_micros: u64,
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
  pub configured_paid_limit_usd_micros: u64,
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
        serde_json::from_slice::<Ledger>(&bytes)
          .map_err(|_| internal("Budget ledger is invalid; refusing to reset usage."))?
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

  pub fn account(
    self: &Arc<Self>,
    provider: &str,
    account_id: &str,
    free_cents: u64,
    paid_cents: u64,
    reset_day: u8,
    initial_used_cents: u64,
  ) -> ProviderResult<BudgetAccount> {
    let free_limit =
      free_cents.checked_mul(10_000).ok_or_else(|| internal("Free budget exceeds the supported range."))?;
    let paid_limit =
      paid_cents.checked_mul(10_000).ok_or_else(|| internal("Paid budget exceeds the supported range."))?;
    let initial_used =
      initial_used_cents.checked_mul(10_000).ok_or_else(|| internal("Initial usage exceeds the supported range."))?;
    checked_total(free_limit, paid_limit)?;
    if provider.is_empty() || account_id.is_empty() || !(1..=31).contains(&reset_day) {
      return Err(internal("Budget account settings are invalid."));
    }
    let now = Timestamp::now();
    self.transaction(|ledger| {
      let accounts = ledger.accounts.entry(provider.to_owned()).or_default();
      if let Some(account) = accounts.get_mut(account_id) {
        if account.reset_day != reset_day {
          return Err(internal("Monthly reset day differs from the stored account schedule; refusing to reset usage."));
        }
        account.advance(now)?;
        account.free_limit_usd_micros = free_limit;
        account.paid_limit_usd_micros = paid_limit;
      } else {
        let (period_start, period_end) = period_at(now, reset_day)?;
        accounts.insert(
          account_id.to_owned(),
          AccountState {
            reset_day,
            period_start,
            period_end,
            free_limit_usd_micros: free_limit,
            paid_limit_usd_micros: paid_limit,
            consumed_usd_micros: initial_used,
            reservations: BTreeMap::new(),
            reported_remaining_cap_usd_micros: None,
            reported_allowance_cap_usd_micros: None,
          },
        );
      }
      Ok(())
    })?;
    Ok(BudgetAccount { store: Arc::clone(self), provider: provider.to_owned(), account_id: account_id.to_owned() })
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
    checked_total(self.free_limit_usd_micros, self.paid_limit_usd_micros)?;
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
    let total = checked_total(free_limit, self.paid_limit_usd_micros)?.saturating_sub(committed);
    let reported = self.reported_remaining_cap_usd_micros.map(|remaining| remaining.saturating_sub(reserved));
    Ok(BudgetBalance {
      free_allowance_usd_micros: free_limit,
      free_remaining_usd_micros: reported.map_or(free, |cap| free.min(cap)),
      total_remaining_usd_micros: reported.map_or(total, |cap| total.min(cap)),
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
      configured_paid_limit_usd_micros: account.paid_limit_usd_micros,
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

  fn reserve(&self, cost: u64, allow_paid: bool, deadline: Option<Instant>) -> ProviderResult<Reservation> {
    let id = self.store.transaction(|ledger| {
      // The worker may have waited for the ledger lock beyond the deadline.
      check_deadline(deadline)?;
      let id = ledger.next_reservation_id;
      ledger.next_reservation_id =
        id.checked_add(1).ok_or_else(|| internal("Budget reservation IDs are exhausted."))?;
      let account = self.state(ledger)?;
      account.advance(Timestamp::now())?;
      let balance = account.balance()?;
      let remaining = if allow_paid { balance.total_remaining_usd_micros } else { balance.free_remaining_usd_micros };
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
    debug!("{} reserved {cost} USD micros (reservation {id}, paid capacity permitted={allow_paid})", self.provider);
    Ok(Reservation { account: self.clone(), id, dispatched: false, finished: false })
  }

  fn settle(&self, id: u64, charged: bool, exhausted: bool) -> ProviderResult<()> {
    let cost = self.store.transaction(|ledger| {
      let account = self.state(ledger)?;
      account.advance(Timestamp::now())?;
      let cost = account
        .reservations
        .remove(&id)
        .ok_or_else(|| internal("Budget reservation was already settled or is missing."))?;
      if charged {
        account.charge(cost)?;
      }
      if exhausted {
        account.reported_remaining_cap_usd_micros = Some(0);
      }
      Ok(cost)
    })?;
    debug!(
      "{} settled reservation {id}, estimated cost {cost} USD micros: charged={charged}, quota_exhausted={exhausted}",
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
      // Reporting may tighten capacity, never grant paid balances as free credits
      // or refund uncertain requests. Pending requests remain reserved separately.
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
  async fn finish(mut self, charged: bool, exhausted: bool) -> ProviderResult<()> {
    // Queue before marking finished: cancellation while awaiting the worker must
    // not lose a known refund/quota cap or queue a second settlement from Drop.
    let task = self.schedule_settlement(charged, exhausted)?;
    self.finished = true;
    task.await.map_err(|_| internal("Budget settlement worker failed."))?
  }

  fn schedule_settlement(&self, charged: bool, exhausted: bool) -> ProviderResult<JoinHandle<ProviderResult<()>>> {
    let runtime = tokio::runtime::Handle::try_current().map_err(|_| internal("Budget runtime is unavailable."))?;
    let account = self.account.clone();
    let id = self.id;
    Ok(runtime.spawn_blocking(move || {
      let result = account.settle(id, charged, exhausted);
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
      && let Err(error) = self.schedule_settlement(self.dispatched, false)
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
}

impl BudgetedProvider {
  pub fn new(inner: impl SearchProvider + 'static, account: BudgetAccount) -> ProviderResult<Self> {
    let balance = account.balance()?;
    info!(
      "{} local budget (USD micros): consumed {}, reserved {}, free remaining {}, total remaining {}, resets at Unix second {}",
      inner.name(),
      balance.consumed_usd_micros,
      balance.reserved_usd_micros,
      balance.free_remaining_usd_micros,
      balance.total_remaining_usd_micros,
      balance.period_end
    );
    Ok(Self { inner: Box::new(inner), account })
  }

  pub async fn balance(&self) -> ProviderResult<BudgetBalance> {
    let account = self.account.clone();
    budget_worker(move || account.balance()).await
  }

  pub async fn snapshot(&self) -> ProviderResult<BudgetSnapshot> {
    let account = self.account.clone();
    budget_worker(move || account.snapshot()).await
  }

  /// Paid capacity requires the router to explicitly permit it for this attempt.
  pub async fn search_with_budget(
    &self,
    request: SearchRequest<'_>,
    allow_paid: bool,
    deadline: Option<Instant>,
  ) -> ProviderResult<Vec<SearchResult>> {
    check_deadline(deadline)?;
    let cost = self.inner.estimate_cost(&request)?;
    let RequestCost::UsdMicros(cost) = cost else {
      return self.inner.search(request).await;
    };
    let account = self.account.clone();
    let mut reservation = budget_worker(move || {
      // Do not start a queued reservation after its request has expired.
      check_deadline(deadline)?;
      account.reserve(cost, allow_paid, deadline)
    })
    .await?;
    // A write may finish after timeout. A late reservation must never cause a
    // provider dispatch, even if the result wins a race with the timeout future.
    check_deadline(deadline)?;
    reservation.dispatched = true;
    let result = self.inner.search(request).await;
    let charged = !matches!(&result, Err(error) if error.not_charged);
    let exhausted = matches!(&result, Err(error) if error.kind == ProviderErrorKind::QuotaExhausted);
    // Settle consumption and a remote quota cap in one durable transaction.
    // Monthly rollover clears the cap; restarting the server does not.
    reservation.finish(charged, exhausted).await?;
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

  fn search<'a>(&'a self, request: SearchRequest<'a>) -> BoxFuture<'a, ProviderResult<Vec<SearchResult>>> {
    Box::pin(self.search_with_budget(request, false, None))
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
