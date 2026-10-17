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

use std::sync::Arc;
use std::time::Duration;

use jiff::Timestamp;
use log::{debug, warn};
use serde::Serialize;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::budget::{BudgetSnapshot, BudgetedProvider};
use crate::providers::{
  ProviderError, ProviderErrorKind, ProviderResult, RequestCost, SearchProvider, SearchRequest, SearchResult,
};

const SEARCH_DEADLINE: Duration = Duration::from_secs(30);
const ATTEMPT_DEADLINE: Duration = Duration::from_secs(20);
const MAX_ATTEMPTS: usize = 3;

pub enum Backend {
  Unmetered(Box<dyn SearchProvider>),
  Metered(BudgetedProvider),
}

impl Backend {
  fn provider(&self) -> &dyn SearchProvider {
    match self {
      Self::Unmetered(provider) => provider.as_ref(),
      Self::Metered(provider) => provider,
    }
  }

  async fn search(&self, request: SearchRequest<'_>, deadline: Instant) -> ProviderResult<Vec<SearchResult>> {
    if Instant::now() >= deadline {
      return Err(ProviderError::new(ProviderErrorKind::Transient, "Search provider exceeded the request deadline."));
    }
    match self {
      Self::Unmetered(provider) => provider.search(request).await,
      Self::Metered(provider) => provider.search_with_budget(request, Some(deadline)).await,
    }
    .map(|response| response.results)
  }
}

pub struct SearchRouter {
  providers: Vec<ProviderSlot>,
}

struct ProviderSlot {
  backend: Backend,
  health: Arc<Mutex<Health>>,
  usage_status: Mutex<UsageStatus>,
}

#[derive(Clone, Default)]
struct Health {
  disabled: Option<&'static str>,
  cooldown_until: Option<Instant>,
  quota_reset: Option<i64>,
  failures: u32,
  generation: u64,
  in_flight: usize,
  recovering: bool,
}

#[derive(Serialize)]
pub struct ProviderStatus {
  pub name: &'static str,
  pub enabled: bool,
  pub available: bool,
  pub unavailable_reasons: Vec<String>,
  pub reference_cost_usd_micros: Option<u64>,
  pub funding: Option<&'static str>,
  pub health: Option<HealthStatus>,
  pub budget: Option<BudgetSnapshot>,
  pub usage: Option<UsageStatus>,
}

impl ProviderStatus {
  pub fn unconfigured(name: &'static str, reason: &str) -> Self {
    Self {
      name,
      enabled: false,
      available: false,
      unavailable_reasons: vec![reason.to_owned()],
      reference_cost_usd_micros: None,
      funding: None,
      health: None,
      budget: None,
      usage: None,
    }
  }
}

#[derive(Serialize)]
pub struct HealthStatus {
  disabled_reason: Option<&'static str>,
  cooldown_remaining_ms: u64,
  quota_resets_at: Option<i64>,
  consecutive_failures: u32,
  in_flight: usize,
  recovery_probe_required: bool,
}

#[derive(Clone, Serialize)]
pub struct UsageStatus {
  state: &'static str,
  last_checked_at: Option<i64>,
  last_report: Option<ReportedUsage>,
  error: Option<String>,
}

impl Default for UsageStatus {
  fn default() -> Self {
    Self { state: "not_checked", last_checked_at: None, last_report: None, error: None }
  }
}

#[derive(Clone, Serialize)]
struct ReportedUsage {
  observed_at: i64,
  remaining_usd_micros: Option<u64>,
  allowance_usd_micros: Option<u64>,
  resets_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Funding {
  Free,
  Unmetered,
}

struct Candidate {
  index: usize,
  funding: Funding,
  free_remaining: u64,
  free_allowance: u64,
  quota_reset: Option<i64>,
}

impl Candidate {
  fn preferred_to(&self, other: &Self) -> bool {
    if self.funding != other.funding {
      return self.funding < other.funding;
    }
    // Exact ratio comparison, including large configured allowances. Stable
    // registration order breaks ties and orders unmetered candidates.
    self.funding == Funding::Free
      && u128::from(self.free_remaining) * u128::from(other.free_allowance)
        > u128::from(other.free_remaining) * u128::from(self.free_allowance)
  }
}

impl SearchRouter {
  pub fn new(backends: Vec<Backend>) -> Self {
    Self {
      providers: backends
        .into_iter()
        .map(|backend| ProviderSlot { backend, health: Arc::default(), usage_status: Mutex::default() })
        .collect(),
    }
  }

  /// Inspect eligibility for a reference request without selecting a provider,
  /// updating health, persisting a rollover or contacting an external service.
  pub async fn status(&self, request: &SearchRequest<'_>) -> Vec<ProviderStatus> {
    let mut providers = Vec::with_capacity(self.providers.len());
    for slot in &self.providers {
      providers.push(slot.status(request).await);
    }
    providers
  }

  pub async fn search(&self, request: SearchRequest<'_>) -> ProviderResult<Vec<SearchResult>> {
    let deadline = Instant::now() + SEARCH_DEADLINE;
    // Cover selection, lock/worker waits, reservations and settlement, as well
    // as provider HTTP. Dropping this future never waits on synchronous cleanup.
    match tokio::time::timeout_at(deadline, self.search_until(request, deadline)).await {
      Ok(result) if Instant::now() < deadline => result,
      _ => Err(ProviderError::new(ProviderErrorKind::Transient, "Web search reached its 30-second deadline.")),
    }
  }

  async fn search_until(&self, request: SearchRequest<'_>, deadline: Instant) -> ProviderResult<Vec<SearchResult>> {
    if self.providers.is_empty() {
      return Err(internal(
        "No search providers enabled. Configure Exa or Tavily with a budget or unset WEB_SEARCH_DUCKDUCKGO_ENABLED to restore DuckDuckGo.",
      ));
    }
    let mut attempted = vec![false; self.providers.len()];
    let mut reasons = vec![None; self.providers.len()];
    let mut attempts = 0;
    let mut saw_empty_results = false;
    while attempts < MAX_ATTEMPTS && Instant::now() < deadline {
      let Some(candidate) = self.select(&request, &mut attempted, &mut reasons).await else { break };
      if Instant::now() >= deadline {
        break;
      }
      let slot = &self.providers[candidate.index];
      // Eligibility can change while other requests are selecting a provider.
      let flight = match slot.acquire().await {
        Some(flight) => flight,
        None => {
          attempted[candidate.index] = true;
          reasons[candidate.index] = Some("provider became unavailable".to_owned());
          continue;
        }
      };
      attempted[candidate.index] = true;
      attempts += 1;
      debug!("Searching with {} using {:?} capacity", slot.backend.provider().name(), candidate.funding);
      let attempt_deadline = deadline.min(Instant::now() + ATTEMPT_DEADLINE);
      let result = match tokio::time::timeout_at(attempt_deadline, slot.backend.search(request, attempt_deadline)).await
      {
        Ok(result) if Instant::now() < attempt_deadline => result,
        _ => Err(ProviderError::new(ProviderErrorKind::Transient, "Search provider exceeded the request deadline.")),
      };
      flight.finish(&result, candidate.quota_reset).await;
      match result {
        // Empty results are successful for health/accounting, but this query
        // should try the next eligible provider before returning to the model.
        Ok(results) if results.is_empty() => {
          saw_empty_results = true;
          debug!("{} returned no results; trying another eligible provider", slot.backend.provider().name());
        }
        Ok(results) => return Ok(results),
        Err(error) => {
          warn!("{} search failed ({:?}): {error}", slot.backend.provider().name(), error.kind);
          reasons[candidate.index] = Some(error.to_string());
        }
      }
    }
    // Preserve a completed empty search if no fallback produced results. If
    // every attempt failed, retain the normal unavailability error instead.
    // The outer timeout still enforces the overall deadline for either outcome.
    if saw_empty_results {
      return Ok(Vec::new());
    }
    let details = self
      .providers
      .iter()
      .zip(reasons)
      .filter_map(|(slot, reason)| reason.map(|reason| format!("{}: {reason}", slot.backend.provider().name())))
      .collect::<Vec<_>>()
      .join("; ");
    let message = if Instant::now() >= deadline {
      "Web search reached its 30-second deadline"
    } else if attempts >= MAX_ATTEMPTS {
      "Web search reached its attempt limit"
    } else {
      "No eligible search providers remain"
    };
    Err(ProviderError::new(ProviderErrorKind::Transient, format!("{message}. {details}")))
  }

  async fn select(
    &self,
    request: &SearchRequest<'_>,
    attempted: &mut [bool],
    reasons: &mut [Option<String>],
  ) -> Option<Candidate> {
    let mut best: Option<Candidate> = None;
    for (index, slot) in self.providers.iter().enumerate() {
      if attempted[index] {
        continue;
      }
      if let Some(reason) = slot.availability().await {
        reasons[index] = Some(reason.to_owned());
        continue;
      }
      match slot.candidate(index, request).await {
        Ok(Some(candidate)) => {
          if best.as_ref().is_none_or(|other| candidate.preferred_to(other)) {
            best = Some(candidate);
          }
        }
        Ok(None) => {
          reasons[index] = Some("insufficient local budget for this request".to_owned());
        }
        Err(error) => {
          attempted[index] = true;
          reasons[index] = Some(error.to_string());
          slot.record_failure(&error, None).await;
        }
      }
    }
    best
  }

  pub async fn refresh_usage(&self) {
    for slot in &self.providers {
      let result = tokio::time::timeout(Duration::from_secs(20), slot.backend.provider().usage()).await;
      let checked_at = Timestamp::now().as_second();
      let update = match result {
        Ok(Ok(Some(snapshot))) => UsageStatus {
          state: "reported",
          last_checked_at: Some(checked_at),
          last_report: Some(ReportedUsage {
            observed_at: checked_at,
            remaining_usd_micros: snapshot.remaining_usd_micros,
            allowance_usd_micros: snapshot.allowance_usd_micros,
            resets_at: snapshot.resets_at.and_then(|time| Timestamp::try_from(time).ok()).map(|time| time.as_second()),
          }),
          error: None,
        },
        Ok(Ok(None)) => {
          UsageStatus { state: "unsupported", last_checked_at: Some(checked_at), last_report: None, error: None }
        }
        Ok(Err(error)) => {
          warn!("Could not reconcile {} usage: {error}", slot.backend.provider().name());
          UsageStatus {
            state: "error",
            last_checked_at: Some(checked_at),
            last_report: None,
            error: Some(format!("Usage refresh failed ({:?}).", error.kind)),
          }
        }
        Err(_) => {
          warn!("{} usage refresh timed out", slot.backend.provider().name());
          UsageStatus {
            state: "error",
            last_checked_at: Some(checked_at),
            last_report: None,
            error: Some("Usage refresh timed out.".to_owned()),
          }
        }
      };
      let mut status = slot.usage_status.lock().await;
      // A failed refresh must not erase the last successful observation.
      let last_report = update.last_report.clone().or_else(|| status.last_report.clone());
      *status = UsageStatus { last_report, ..update };
    }
  }
}

impl ProviderSlot {
  async fn status(&self, request: &SearchRequest<'_>) -> ProviderStatus {
    let mut status = ProviderStatus {
      enabled: true,
      unavailable_reasons: Vec::new(),
      ..ProviderStatus::unconfigured(self.backend.provider().name(), "")
    };
    // Expiry cleanup must only change this copy during inspection. Release the
    // health lock before waiting for any budget operation.
    let mut health = self.health.lock().await.clone();
    if let Some(reason) = health.unavailable() {
      status.unavailable_reasons.push(reason.to_owned());
    }
    status.health = Some(HealthStatus {
      disabled_reason: health.disabled,
      cooldown_remaining_ms: health.cooldown_until.map_or(0, |until| {
        u64::try_from(until.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(u64::MAX)
      }),
      quota_resets_at: health.quota_reset.filter(|reset| *reset > Timestamp::now().as_second()),
      consecutive_failures: health.failures,
      in_flight: health.in_flight,
      recovery_probe_required: health.recovering,
    });
    status.usage = Some(self.usage_status.lock().await.clone());
    if let Backend::Metered(provider) = &self.backend {
      match provider.snapshot().await {
        Ok(snapshot) => {
          if let Some(error) = snapshot.persistence_error {
            status.unavailable_reasons.push(error.to_owned());
          }
          status.budget = Some(snapshot);
        }
        Err(error) => status.unavailable_reasons.push(error.to_string()),
      }
    }
    match self.backend.provider().estimate_cost(request) {
      Ok(RequestCost::Unmetered) => status.funding = Some("unmetered"),
      Ok(RequestCost::UsdMicros(cost)) => {
        status.reference_cost_usd_micros = Some(cost);
        if let Some(snapshot) = &status.budget {
          let balance = &snapshot.balance;
          if balance.free_allowance_usd_micros > 0 && cost <= balance.free_remaining_usd_micros {
            status.funding = Some("free");
          } else {
            status.unavailable_reasons.push("Insufficient local budget for the reference request.".to_owned());
          }
        } else if status.unavailable_reasons.is_empty() {
          status.unavailable_reasons.push("Metered search provider has no budget accounting.".to_owned());
        }
      }
      Err(error) => status.unavailable_reasons.push(error.to_string()),
    }
    status.available = status.unavailable_reasons.is_empty();
    status
  }

  async fn availability(&self) -> Option<&'static str> {
    self.health.lock().await.unavailable()
  }

  async fn candidate(&self, index: usize, request: &SearchRequest<'_>) -> ProviderResult<Option<Candidate>> {
    let cost = match self.backend.provider().estimate_cost(request)? {
      RequestCost::Unmetered => {
        return Ok(Some(Candidate {
          index,
          funding: Funding::Unmetered,
          free_remaining: 0,
          free_allowance: 1,
          quota_reset: None,
        }));
      }
      RequestCost::UsdMicros(cost) => cost,
    };
    let Backend::Metered(provider) = &self.backend else {
      return Err(internal("Metered search provider has no budget accounting."));
    };
    let balance = provider.balance().await?;
    let funding = if balance.free_allowance_usd_micros > 0 && cost <= balance.free_remaining_usd_micros {
      Funding::Free
    } else {
      return Ok(None);
    };
    Ok(Some(Candidate {
      index,
      funding,
      free_remaining: balance.free_remaining_usd_micros,
      free_allowance: balance.free_allowance_usd_micros,
      quota_reset: Some(balance.period_end),
    }))
  }

  async fn acquire(&self) -> Option<Flight> {
    let mut health = self.health.lock().await;
    if health.unavailable().is_some() {
      return None;
    }
    health.in_flight = health.in_flight.checked_add(1)?;
    Some(Flight { health: Arc::clone(&self.health), generation: health.generation, finished: false })
  }

  async fn record_failure(&self, error: &ProviderError, quota_reset: Option<i64>) {
    self.health.lock().await.fail(error, quota_reset);
  }
}

impl Health {
  fn unavailable(&mut self) -> Option<&'static str> {
    if let Some(reason) = self.disabled {
      return Some(reason);
    }
    if self.cooldown_until.is_some_and(|until| until > Instant::now()) {
      return Some("cooling down");
    }
    self.cooldown_until = None;
    if self.quota_reset.is_some_and(|reset| reset > Timestamp::now().as_second()) {
      return Some("quota exhausted until the monthly reset");
    }
    self.quota_reset = None;
    if self.recovering && self.in_flight > 0 {
      return Some("waiting for the recovery probe or earlier requests");
    }
    None
  }

  fn fail(&mut self, error: &ProviderError, quota_reset: Option<i64>) {
    if matches!(error.kind, ProviderErrorKind::InvalidRequest | ProviderErrorKind::InsufficientBudget) {
      // These are request-specific; another query may fit or be accepted.
      return;
    }
    self.generation = self.generation.wrapping_add(1);
    self.failures = self.failures.saturating_add(1);
    self.recovering = true;
    if self.disabled.is_some() {
      return;
    }
    match error.kind {
      ProviderErrorKind::InvalidCredentials => {
        self.disabled = Some("invalid credentials; restart after correcting configuration");
        return;
      }
      ProviderErrorKind::Internal => {
        self.disabled = Some("internal provider or budget error; restart after repair");
        return;
      }
      ProviderErrorKind::QuotaExhausted => {
        match quota_reset {
          Some(reset) => self.quota_reset = Some(self.quota_reset.map_or(reset, |old| old.max(reset))),
          None => self.disabled = Some("quota exhausted with no known reset; restart after replenishing it"),
        }
        return;
      }
      _ => (),
    }
    let backoff = Duration::from_secs((1u64 << self.failures.min(9)).min(300));
    let default = match error.kind {
      ProviderErrorKind::RateLimited => Duration::from_secs(60),
      ProviderErrorKind::Blocked => Duration::from_secs(900),
      ProviderErrorKind::UnexpectedResponse => backoff.max(Duration::from_secs(15)),
      _ => backoff,
    };
    let delay = error.retry_after.unwrap_or(default).max(Duration::from_secs(1));
    let Some(until) = Instant::now().checked_add(delay) else {
      self.disabled = Some("provider requested a cooldown beyond the supported clock range");
      return;
    };
    self.cooldown_until = Some(self.cooldown_until.map_or(until, |old| old.max(until)));
  }
}

struct Flight {
  health: Arc<Mutex<Health>>,
  generation: u64,
  finished: bool,
}

impl Flight {
  async fn finish(mut self, result: &ProviderResult<Vec<SearchResult>>, quota_reset: Option<i64>) {
    let mut health = self.health.lock().await;
    Self::complete(&mut health, self.generation, result.as_ref().err(), quota_reset);
    self.finished = true;
  }

  fn complete(health: &mut Health, generation: u64, error: Option<&ProviderError>, quota_reset: Option<i64>) {
    health.in_flight = health.in_flight.saturating_sub(1);
    if let Some(error) = error {
      health.fail(error, quota_reset);
    } else if health.generation == generation {
      // A late success must not clear a newer request's cooldown or suspension.
      health.failures = 0;
      health.recovering = false;
      health.cooldown_until = None;
      health.quota_reset = None;
    }
  }
}

impl Drop for Flight {
  fn drop(&mut self) {
    if !self.finished {
      let error = ProviderError::new(ProviderErrorKind::Transient, "Search request was cancelled.");
      if let Ok(mut health) = self.health.try_lock() {
        Self::complete(&mut health, self.generation, Some(&error), None);
      } else {
        // Timeout cleanup must not wait for another request's health update.
        let health = Arc::clone(&self.health);
        let generation = self.generation;
        tokio::spawn(async move {
          let mut health = health.lock().await;
          Self::complete(&mut health, generation, Some(&error), None);
        });
      }
    }
  }
}

fn internal(message: &str) -> ProviderError {
  ProviderError::new(ProviderErrorKind::Internal, message)
}
