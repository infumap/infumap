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

use std::env;

use once_cell::sync::Lazy;

static CONFIG: Lazy<Result<SearchConfig, String>> = Lazy::new(SearchConfig::from_env);

pub struct SearchConfig {
  pub duckduckgo_enabled: bool,
  pub exa: Option<ExaConfig>,
}

// Deliberately does not implement Debug: configuration contains credentials.
pub struct ExaConfig {
  pub api_key: String,
  pub monthly_free_credits_cents: u64,
  pub monthly_paid_limit_cents: u64,
  pub monthly_reset_day: u8,
}

/// Load once at startup so configuration remains consistent for every request.
pub fn search_config() -> Result<&'static SearchConfig, &'static str> {
  CONFIG.as_ref().map_err(String::as_str)
}

impl SearchConfig {
  /// Configured preference only; runtime health and budget eligibility belong
  /// to the router. Unmetered DuckDuckGo follows metered providers.
  pub fn provider_preference(&self) -> Vec<&'static str> {
    let mut providers = Vec::new();
    if self.exa.as_ref().is_some_and(|exa| !exa.api_key.is_empty()) {
      providers.push("exa");
    }
    if self.duckduckgo_enabled {
      providers.push("duckduckgo");
    }
    providers
  }

  fn from_env() -> Result<Self, String> {
    let duckduckgo_enabled = optional_env("WEB_SEARCH_DUCKDUCKGO_ENABLED")?
      .map(|value| match value.as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err("WEB_SEARCH_DUCKDUCKGO_ENABLED must be true or false.".to_owned()),
      })
      .transpose()?
      .unwrap_or(false);
    let api_key = optional_env("EXA_API_KEY")?;
    // Unknown allowance means zero usable budget until configured or reported
    // by a future provider usage API. Do not assume today's advertised tier.
    let monthly_free_credits_cents = unsigned_env("WEB_SEARCH_EXA_MONTHLY_FREE_CREDITS_CENTS", 0)?;
    let monthly_paid_limit_cents = unsigned_env("WEB_SEARCH_EXA_MONTHLY_PAID_LIMIT_CENTS", 0)?;
    monthly_free_credits_cents
      .checked_add(monthly_paid_limit_cents)
      .ok_or("Combined Exa monthly credit and paid limits exceed the supported range.")?;
    let monthly_reset_day = unsigned_env("WEB_SEARCH_EXA_MONTHLY_RESET_DAY", 1)?;
    if !(1..=31).contains(&monthly_reset_day) {
      return Err("WEB_SEARCH_EXA_MONTHLY_RESET_DAY must be between 1 and 31.".to_owned());
    }
    let exa = api_key.map(|api_key| ExaConfig {
      api_key,
      monthly_free_credits_cents,
      monthly_paid_limit_cents,
      monthly_reset_day: monthly_reset_day as u8,
    });
    Ok(Self { duckduckgo_enabled, exa })
  }
}

fn optional_env(name: &str) -> Result<Option<String>, String> {
  match env::var(name) {
    Ok(value) => {
      let value = value.trim();
      if value.is_empty() { Ok(None) } else { Ok(Some(value.to_owned())) }
    }
    Err(env::VarError::NotPresent) => Ok(None),
    Err(env::VarError::NotUnicode(_)) => Err(format!("{name} must contain valid Unicode.")),
  }
}

fn unsigned_env(name: &str, default: u64) -> Result<u64, String> {
  optional_env(name)?
    .map(|value| {
      if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{name} must be a non-negative integer."));
      }
      value.parse().map_err(|_| format!("{name} exceeds the supported integer range."))
    })
    .unwrap_or(Ok(default))
}
