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
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone)]
pub(super) struct FetchConfig {
  pub browser_path: Option<PathBuf>,
  pub timeout: Duration,
  pub max_document_bytes: usize,
  pub max_pdf_bytes: usize,
}

impl FetchConfig {
  pub fn from_env() -> Result<Self, String> {
    let browser_path = optional_env("WEB_FETCH_BROWSER_PATH")?.map(PathBuf::from);
    if browser_path.as_ref().is_some_and(|path| !path.is_absolute()) {
      return Err("WEB_FETCH_BROWSER_PATH must be an absolute path.".into());
    }
    Ok(Self {
      browser_path,
      timeout: Duration::from_secs(positive_env("WEB_FETCH_TIMEOUT_SECS", 30, 3_600)?),
      max_document_bytes: positive_env("WEB_FETCH_MAX_DOCUMENT_BYTES", 2 * 1024 * 1024, 16 * 1024 * 1024)? as usize,
      max_pdf_bytes: positive_env("WEB_FETCH_MAX_PDF_BYTES", 128 * 1024 * 1024, 128 * 1024 * 1024)? as usize,
    })
  }
}

fn optional_env(name: &str) -> Result<Option<String>, String> {
  match env::var(name) {
    Ok(value) => Ok((!value.trim().is_empty()).then(|| value.trim().to_owned())),
    Err(env::VarError::NotPresent) => Ok(None),
    Err(env::VarError::NotUnicode(_)) => Err(format!("{name} must contain valid Unicode.")),
  }
}

fn positive_env(name: &str, default: u64, cap: u64) -> Result<u64, String> {
  let Some(raw) = optional_env(name)? else { return Ok(default) };
  let value = raw.parse::<u64>().ok().filter(|value| (1..=cap).contains(value));
  value.ok_or_else(|| format!("{name} must be an integer between 1 and {cap}."))
}
