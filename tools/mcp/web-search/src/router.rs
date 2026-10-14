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

use std::sync::Mutex;
use std::time::Duration;

use jiff::Timestamp;
use log::{debug, warn};
use tokio::time::Instant;

use crate::budget::BudgetedProvider;
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

  async fn search(&self, request: SearchRequest<'_>, funding: Funding) -> ProviderResult<Vec<SearchResult>> {
    match self {
      Self::Unmetered(provider) => provider.search(request).await,
      Self::Metered(provider) => provider.search_with_budget(request, funding == Funding::Paid).await,
    }
  }
}

pub struct SearchRouter {
  providers: Vec<ProviderSlot>,
}

struct ProviderSlot {
  backend: Backend,
  health: Mutex<Health>,
}

#[derive(Default)]
struct Health {
  disabled: Option<&'static str>,
  cooldown_until: Option<Instant>,
  quota_reset: Option<i64>,
  failures: u32,
  generation: u64,
  in_flight: usize,
  recovering: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Funding {
  Free,
  Unmetered,
  Paid,
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
    // registration order breaks ties and orders unmetered/paid candidates.
    self.funding == Funding::Free
      && u128::from(self.free_remaining) * u128::from(other.free_allowance)
        > u128::from(other.free_remaining) * u128::from(self.free_allowance)
  }
}

impl SearchRouter {
  pub fn new(backends: Vec<Backend>) -> Self {
    Self { providers: backends.into_iter().map(|backend| ProviderSlot { backend, health: Mutex::default() }).collect() }
  }

  pub async fn search(&self, request: SearchRequest<'_>) -> ProviderResult<Vec<SearchResult>> {
    if self.providers.is_empty() {
      return Err(internal(
        "No search providers enabled. Configure Exa with a budget or set WEB_SEARCH_DUCKDUCKGO_ENABLED=true.",
      ));
    }
    let deadline = Instant::now() + SEARCH_DEADLINE;
    let mut attempted = vec![false; self.providers.len()];
    let mut reasons = vec![None; self.providers.len()];
    let mut attempts = 0;
    while attempts < MAX_ATTEMPTS && Instant::now() < deadline {
      let Some(candidate) = self.select(&request, &mut attempted, &mut reasons) else { break };
      if Instant::now() >= deadline {
        break;
      }
      let slot = &self.providers[candidate.index];
      // Eligibility can change while other requests are selecting a provider.
      let flight = match slot.acquire() {
        Ok(Some(flight)) => flight,
        Ok(None) => {
          attempted[candidate.index] = true;
          reasons[candidate.index] = Some("provider became unavailable".to_owned());
          continue;
        }
        Err(error) => {
          attempted[candidate.index] = true;
          reasons[candidate.index] = Some(error.to_string());
          continue;
        }
      };
      attempted[candidate.index] = true;
      attempts += 1;
      debug!("Searching with {} using {:?} capacity", slot.backend.provider().name(), candidate.funding);
      let attempt_deadline = deadline.min(Instant::now() + ATTEMPT_DEADLINE);
      let result =
        match tokio::time::timeout_at(attempt_deadline, slot.backend.search(request, candidate.funding)).await {
          Ok(result) => result,
          Err(_) => {
            Err(ProviderError::new(ProviderErrorKind::Transient, "Search provider exceeded the request deadline."))
          }
        };
      if let Err(error) = flight.finish(&result, candidate.quota_reset) {
        warn!("Could not update {} health: {error}", slot.backend.provider().name());
      }
      match result {
        // An empty result is still success: do not spend another provider's quota.
        Ok(results) => return Ok(results),
        Err(error) => {
          warn!("{} search failed ({:?}): {error}", slot.backend.provider().name(), error.kind);
          reasons[candidate.index] = Some(error.to_string());
        }
      }
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

  fn select(
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
      match slot.availability() {
        Ok(None) => (),
        Ok(Some(reason)) => {
          reasons[index] = Some(reason.to_owned());
          continue;
        }
        Err(error) => {
          reasons[index] = Some(error.to_string());
          continue;
        }
      }
      match slot.candidate(index, request) {
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
          if let Err(health_error) = slot.record_failure(&error, None) {
            warn!("Could not update {} health: {health_error}", slot.backend.provider().name());
          }
        }
      }
    }
    best
  }

  pub async fn refresh_usage(&self) {
    for slot in &self.providers {
      match tokio::time::timeout(Duration::from_secs(20), slot.backend.provider().usage()).await {
        Ok(Ok(_)) => (),
        Ok(Err(error)) => warn!("Could not reconcile {} usage: {error}", slot.backend.provider().name()),
        Err(_) => warn!("{} usage refresh timed out", slot.backend.provider().name()),
      }
    }
  }
}

impl ProviderSlot {
  fn availability(&self) -> ProviderResult<Option<&'static str>> {
    let mut health = self.health.lock().map_err(|_| internal("Provider health lock is poisoned."))?;
    Ok(health.unavailable())
  }

  fn candidate(&self, index: usize, request: &SearchRequest<'_>) -> ProviderResult<Option<Candidate>> {
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
    let balance = provider.balance()?;
    let funding = if balance.free_allowance_usd_micros > 0 && cost <= balance.free_remaining_usd_micros {
      Funding::Free
    } else if cost <= balance.total_remaining_usd_micros
      && balance.total_remaining_usd_micros > balance.free_remaining_usd_micros
    {
      Funding::Paid
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

  fn acquire(&self) -> ProviderResult<Option<Flight<'_>>> {
    let mut health = self.health.lock().map_err(|_| internal("Provider health lock is poisoned."))?;
    if health.unavailable().is_some() {
      return Ok(None);
    }
    health.in_flight = health.in_flight.checked_add(1).ok_or_else(|| internal("Too many concurrent searches."))?;
    Ok(Some(Flight { slot: self, generation: health.generation, finished: false }))
  }

  fn record_failure(&self, error: &ProviderError, quota_reset: Option<i64>) -> ProviderResult<()> {
    self.health.lock().map_err(|_| internal("Provider health lock is poisoned."))?.fail(error, quota_reset);
    Ok(())
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

struct Flight<'a> {
  slot: &'a ProviderSlot,
  generation: u64,
  finished: bool,
}

impl Flight<'_> {
  fn finish(mut self, result: &ProviderResult<Vec<SearchResult>>, quota_reset: Option<i64>) -> ProviderResult<()> {
    let result = self.complete(result.as_ref().err(), quota_reset);
    self.finished = true;
    result
  }

  fn complete(&self, error: Option<&ProviderError>, quota_reset: Option<i64>) -> ProviderResult<()> {
    let mut health = self.slot.health.lock().map_err(|_| internal("Provider health lock is poisoned."))?;
    health.in_flight = health.in_flight.saturating_sub(1);
    if let Some(error) = error {
      health.fail(error, quota_reset);
    } else if health.generation == self.generation {
      // A late success must not clear a newer request's cooldown or suspension.
      health.failures = 0;
      health.recovering = false;
      health.cooldown_until = None;
      health.quota_reset = None;
    }
    Ok(())
  }
}

impl Drop for Flight<'_> {
  fn drop(&mut self) {
    if !self.finished {
      let error = ProviderError::new(ProviderErrorKind::Transient, "Search request was cancelled.");
      if let Err(error) = self.complete(Some(&error), None) {
        warn!("Could not update cancelled search health: {error}");
      }
    }
  }
}

fn internal(message: &str) -> ProviderError {
  ProviderError::new(ProviderErrorKind::Internal, message)
}
