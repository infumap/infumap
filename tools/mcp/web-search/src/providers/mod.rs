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
pub mod exa;

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::time::{Duration, SystemTime};

use futures_util::future::BoxFuture;
use serde::Serialize;

pub type ProviderResult<T> = Result<T, ProviderError>;

pub struct SearchResponse {
  pub results: Vec<SearchResult>,
  /// Provider-reported request estimate, not an account balance or final bill.
  pub reported_cost_usd_micros: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SearchResult {
  pub title: String,
  pub url: String,
  pub snippet: String,
  // Retain provider metadata internally without changing the MCP result shape.
  #[serde(skip)]
  #[expect(dead_code, reason = "Optional metadata is retained for subsequent response formatting work.")]
  pub metadata: Option<SearchResultMetadata>,
}

#[expect(dead_code, reason = "Optional metadata is retained for subsequent response formatting work.")]
#[derive(Clone, Debug)]
pub struct SearchResultMetadata {
  pub published_date: Option<String>,
  pub author: Option<String>,
  pub excerpts: Vec<String>,
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
  UsdMicros(u64),
}

/// Provider-reported allowance for a billing period, normalized to millionths
/// of a US dollar. Unknown values remain None, rather than implying capacity.
#[derive(Clone, Debug)]
pub struct UsageSnapshot {
  pub remaining_usd_micros: Option<u64>,
  pub allowance_usd_micros: Option<u64>,
  pub resets_at: Option<SystemTime>,
}

/// Object-safe interface so the router can hold different provider adapters.
pub trait SearchProvider: Send + Sync {
  fn name(&self) -> &'static str;

  /// Local estimate only; this must not issue a request to the provider.
  fn estimate_cost(&self, request: &SearchRequest<'_>) -> ProviderResult<RequestCost>;

  /// Keep execution cooperative: move blocking I/O and lock waits off runtime
  /// threads so request deadlines can cancel this future promptly.
  fn search<'a>(&'a self, request: SearchRequest<'a>) -> BoxFuture<'a, ProviderResult<SearchResponse>>;

  /// None means usage reporting is unsupported. Never invent a full allowance.
  fn usage(&self) -> BoxFuture<'_, ProviderResult<Option<UsageSnapshot>>> {
    Box::pin(async { Ok(None) })
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderErrorKind {
  RateLimited,
  QuotaExhausted,
  InsufficientBudget,
  InvalidCredentials,
  Transient,
  InvalidRequest,
  Blocked,
  UnexpectedResponse,
  Internal,
}

#[derive(Debug)]
pub struct ProviderError {
  pub kind: ProviderErrorKind,
  pub retry_after: Option<Duration>,
  /// Only set when the provider explicitly guarantees this attempt was not billed.
  pub not_charged: bool,
  message: String,
}

impl ProviderError {
  pub fn new(kind: ProviderErrorKind, message: impl Into<String>) -> Self {
    Self { kind, retry_after: None, not_charged: false, message: message.into() }
  }

  pub fn with_retry_after(mut self, retry_after: Option<Duration>) -> Self {
    self.retry_after = retry_after;
    self
  }

  pub fn without_charge(mut self) -> Self {
    self.not_charged = true;
    self
  }
}

impl Display for ProviderError {
  fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.message)
  }
}

impl Error for ProviderError {}
