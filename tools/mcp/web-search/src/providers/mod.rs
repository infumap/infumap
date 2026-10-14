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

pub mod duckduckgo;

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::time::{Duration, SystemTime};

use futures_util::future::BoxFuture;
use serde::Serialize;

pub type ProviderResult<T> = Result<T, ProviderError>;

#[derive(Clone, Debug, Serialize)]
pub struct SearchResult {
  pub title: String,
  pub url: String,
  pub snippet: String,
}

/// Input is trimmed and result limits are normalized by the search layer.
#[derive(Clone, Copy, Debug)]
pub struct SearchRequest<'a> {
  pub query: &'a str,
  pub max_results: usize,
}

/// Monetary cost is independent of rate limits or available monthly quota.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestCost {
  Unmetered,
  #[expect(dead_code, reason = "Metered adapters are implemented in subsequent steps.")]
  UsdMicros(u64),
}

/// Provider-reported allowance for a billing period, normalized to millionths
/// of a US dollar. Unknown values remain None, rather than implying capacity.
#[expect(dead_code, reason = "Usage reconciliation is implemented in subsequent steps.")]
#[derive(Clone, Debug)]
pub struct UsageSnapshot {
  pub remaining_usd_micros: Option<u64>,
  pub allowance_usd_micros: Option<u64>,
  pub resets_at: Option<SystemTime>,
}

/// Object-safe interface so the router can hold different provider adapters.
pub trait SearchProvider: Send + Sync {
  #[expect(dead_code, reason = "Provider diagnostics are consumed by the upcoming router.")]
  fn name(&self) -> &'static str;

  /// Local estimate only; this must not issue a request to the provider.
  #[expect(dead_code, reason = "Budget reservations are implemented in subsequent steps.")]
  fn estimate_cost(&self, request: &SearchRequest<'_>) -> ProviderResult<RequestCost>;

  fn search<'a>(&'a self, request: SearchRequest<'a>) -> BoxFuture<'a, ProviderResult<Vec<SearchResult>>>;

  /// None means usage reporting is unsupported. Never invent a full allowance.
  #[expect(dead_code, reason = "Usage reconciliation is implemented in subsequent steps.")]
  fn usage(&self) -> BoxFuture<'_, ProviderResult<Option<UsageSnapshot>>> {
    Box::pin(async { Ok(None) })
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderErrorKind {
  RateLimited,
  #[expect(dead_code, reason = "DuckDuckGo has no billed quota.")]
  QuotaExhausted,
  #[expect(dead_code, reason = "DuckDuckGo does not use credentials.")]
  InvalidCredentials,
  Transient,
  InvalidRequest,
  Blocked,
  UnexpectedResponse,
  Internal,
}

#[derive(Debug)]
pub struct ProviderError {
  #[expect(dead_code, reason = "Typed failure handling is consumed by the upcoming router.")]
  pub kind: ProviderErrorKind,
  pub retry_after: Option<Duration>,
  message: String,
}

impl ProviderError {
  pub fn new(kind: ProviderErrorKind, message: impl Into<String>) -> Self {
    Self { kind, retry_after: None, message: message.into() }
  }

  pub fn with_retry_after(mut self, retry_after: Option<Duration>) -> Self {
    self.retry_after = retry_after;
    self
  }
}

impl Display for ProviderError {
  fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.message)
  }
}

impl Error for ProviderError {}
