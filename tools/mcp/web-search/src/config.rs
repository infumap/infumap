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
use std::num::NonZeroU32;
use std::path::PathBuf;

use once_cell::sync::Lazy;

static CONFIG: Lazy<Result<SearchConfig, String>> = Lazy::new(SearchConfig::from_env);

pub struct SearchConfig {
  pub duckduckgo_requests_per_minute: u32,
  pub exa: Option<MeteredConfig>,
  pub tavily: Option<MeteredConfig>,
  pub diffbot: Option<MeteredConfig>,
  pub diffbot_requests_per_minute: NonZeroU32,
  pub firecrawl: Option<MeteredConfig>,
  pub firecrawl_requests_per_minute: NonZeroU32,
  pub you_daily_free_requests: u32,
  pub you_requests_per_minute: NonZeroU32,
  pub state_dir: Option<PathBuf>,
}

// Deliberately does not implement Debug: configuration contains credentials.
pub struct MeteredConfig {
  pub api_key: String,
  pub monthly_free_credits_cents: u64,
  pub monthly_reset_day: u8,
}

/// Load once at startup so configuration remains consistent for every request.
pub fn search_config() -> Result<&'static SearchConfig, &'static str> {
  CONFIG.as_ref().map_err(String::as_str)
}

impl SearchConfig {
  /// Configured preference only; runtime health and budget eligibility belong
  /// to the router. Ready paced capacity precedes monthly credits.
  pub fn provider_preference(&self) -> Vec<&'static str> {
    let mut providers = Vec::new();
    if self.duckduckgo_requests_per_minute > 0 {
      providers.push("duckduckgo");
    }
    if self.you_daily_free_requests > 0 {
      providers.push("you");
    }
    if self.exa.as_ref().is_some_and(|exa| !exa.api_key.is_empty()) {
      providers.push("exa");
    }
    if self.tavily.as_ref().is_some_and(|tavily| !tavily.api_key.is_empty()) {
      providers.push("tavily");
    }
    if self.diffbot.is_some() {
      providers.push("diffbot");
    }
    if self.firecrawl.is_some() {
      providers.push("firecrawl");
    }
    providers
  }

  fn from_env() -> Result<Self, String> {
    let duckduckgo_requests_per_minute =
      u32::try_from(unsigned_env("WEB_SEARCH_DUCKDUCKGO_REQUESTS_PER_MINUTE", 0)?)
        .map_err(|_| "WEB_SEARCH_DUCKDUCKGO_REQUESTS_PER_MINUTE exceeds the supported integer range.".to_owned())?;
    let exa = MeteredConfig::from_env("EXA", "EXA_API_KEY", "Exa")?;
    let tavily = MeteredConfig::from_env("TAVILY", "TAVILY_API_KEY", "Tavily")?;
    let diffbot = MeteredConfig::from_env("DIFFBOT", "DIFFBOT_API_KEY", "Diffbot")?;
    let diffbot_requests_per_minute = u32::try_from(unsigned_env("WEB_SEARCH_DIFFBOT_REQUESTS_PER_MINUTE", 5)?)
      .ok()
      .and_then(NonZeroU32::new)
      .ok_or("WEB_SEARCH_DIFFBOT_REQUESTS_PER_MINUTE must be between 1 and 4294967295.")?;
    let firecrawl = MeteredConfig::from_env("FIRECRAWL", "FIRECRAWL_API_KEY", "Firecrawl")?;
    let firecrawl_requests_per_minute = u32::try_from(unsigned_env("WEB_SEARCH_FIRECRAWL_REQUESTS_PER_MINUTE", 10)?)
      .ok()
      .and_then(NonZeroU32::new)
      .ok_or("WEB_SEARCH_FIRECRAWL_REQUESTS_PER_MINUTE must be between 1 and 4294967295.")?;
    let you_daily_free_requests = unsigned_env("WEB_SEARCH_YOU_DAILY_FREE_REQUESTS", 0)?;
    if you_daily_free_requests > 100 {
      return Err("WEB_SEARCH_YOU_DAILY_FREE_REQUESTS must be between 0 and 100.".to_owned());
    }
    let you_daily_free_requests = you_daily_free_requests as u32;
    let you_requests_per_minute = u32::try_from(unsigned_env("WEB_SEARCH_YOU_REQUESTS_PER_MINUTE", 5)?)
      .ok()
      .and_then(NonZeroU32::new)
      .ok_or("WEB_SEARCH_YOU_REQUESTS_PER_MINUTE must be between 1 and 4294967295.")?;
    let state_dir = if let Some(path) = optional_env("WEB_SEARCH_STATE_DIR")? {
      Some(PathBuf::from(path))
    } else if let Some(path) = optional_env("XDG_STATE_HOME")? {
      Some(PathBuf::from(path).join("infumap-web-search"))
    } else {
      optional_env("HOME")?.map(|path| PathBuf::from(path).join(".local/state/infumap-web-search"))
    };
    if state_dir.as_ref().is_some_and(|path| !path.is_absolute()) {
      return Err("The web-search state directory must be an absolute path.".to_owned());
    }
    if state_dir.is_none() {
      if exa.is_some() {
        return Err("Exa budget accounting requires WEB_SEARCH_STATE_DIR, XDG_STATE_HOME or HOME.".to_owned());
      }
      if tavily.is_some() {
        return Err("Tavily budget accounting requires WEB_SEARCH_STATE_DIR, XDG_STATE_HOME or HOME.".to_owned());
      }
      if diffbot.is_some() {
        return Err("Diffbot budget accounting requires WEB_SEARCH_STATE_DIR, XDG_STATE_HOME or HOME.".to_owned());
      }
      if firecrawl.is_some() {
        return Err("Firecrawl budget accounting requires WEB_SEARCH_STATE_DIR, XDG_STATE_HOME or HOME.".to_owned());
      }
      if you_daily_free_requests > 0 {
        return Err("You.com quota accounting requires WEB_SEARCH_STATE_DIR, XDG_STATE_HOME or HOME.".to_owned());
      }
    }
    Ok(Self {
      duckduckgo_requests_per_minute,
      exa,
      tavily,
      diffbot,
      diffbot_requests_per_minute,
      firecrawl,
      firecrawl_requests_per_minute,
      you_daily_free_requests,
      you_requests_per_minute,
      state_dir,
    })
  }
}

impl MeteredConfig {
  fn from_env(provider: &str, key_variable: &str, label: &str) -> Result<Option<Self>, String> {
    let prefix = format!("WEB_SEARCH_{provider}");
    let api_key = optional_env(key_variable)?;
    // Zero allowance means no usable free budget. Reports can tighten configured
    // limits; they cannot grant free capacity. Do not assume an advertised tier.
    let monthly_free_credits_cents = unsigned_env(&format!("{prefix}_MONTHLY_FREE_CREDITS_CENTS"), 0)?;
    monthly_free_credits_cents
      .checked_mul(10_000)
      .ok_or_else(|| format!("{label} monthly free credits exceed the supported range."))?;
    let monthly_reset_day = unsigned_env(&format!("{prefix}_MONTHLY_RESET_DAY"), 1)?;
    if !(1..=31).contains(&monthly_reset_day) {
      return Err(format!("{prefix}_MONTHLY_RESET_DAY must be between 1 and 31."));
    }
    Ok(api_key.map(|api_key| Self { api_key, monthly_free_credits_cents, monthly_reset_day: monthly_reset_day as u8 }))
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
