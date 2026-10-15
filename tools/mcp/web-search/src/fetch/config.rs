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
  pub cache_dir: Option<PathBuf>,
  pub cache_max_bytes: u64,
  pub cache_ttl: Duration,
  pub pdf_refresh: bool,
  pub gpu_tools_url: Option<reqwest::Url>,
  pub max_pdf_response_bytes: usize,
  pub browser_path: Option<PathBuf>,
  pub timeout: Duration,
  pub max_document_bytes: usize,
  pub max_rendered_bytes: usize,
  pub html_dump_dir: Option<PathBuf>,
  pub max_pdf_bytes: usize,
}

impl FetchConfig {
  pub fn from_env() -> Result<Self, String> {
    let browser_path = optional_env("WEB_FETCH_BROWSER_PATH")?.map(PathBuf::from);
    if browser_path.as_ref().is_some_and(|path| !path.is_absolute()) {
      return Err("WEB_FETCH_BROWSER_PATH must be an absolute path.".into());
    }
    let gpu_tools_url = optional_env("WEB_FETCH_GPU_TOOLS_URL")?
      .map(|raw| {
        let mut url = reqwest::Url::parse(&raw).map_err(|_| "WEB_FETCH_GPU_TOOLS_URL must be a valid HTTP(S) URL.")?;
        if !matches!(url.scheme(), "http" | "https")
          || url.host_str().is_none()
          || !url.username().is_empty()
          || url.password().is_some()
          || url.query().is_some()
          || url.fragment().is_some()
        {
          return Err("WEB_FETCH_GPU_TOOLS_URL must be HTTP(S) without credentials, query or fragment.");
        }
        let path = url.path().trim_end_matches('/').to_owned();
        url.set_path(path.strip_suffix("/gpu-tools").unwrap_or(&path));
        Ok(url)
      })
      .transpose()
      .map_err(str::to_owned)?;
    Ok(Self {
      cache_dir: if bool_env("WEB_FETCH_PDF_CACHE_ENABLED", true)? {
        let directory = optional_env("WEB_FETCH_PDF_CACHE_DIR")?
          .map(PathBuf::from)
          .or_else(|| cache_home().map(|path| path.join("infumap-web-search/pdf-native-v1")));
        if directory.as_ref().is_some_and(|path| !path.is_absolute()) {
          return Err("WEB_FETCH_PDF_CACHE_DIR must be absolute.".into());
        }
        directory
      } else {
        None
      },
      cache_max_bytes: positive_env("WEB_FETCH_PDF_CACHE_MAX_BYTES", 2 * 1024 * 1024 * 1024, 16 * 1024 * 1024 * 1024)?,
      cache_ttl: Duration::from_secs(positive_env("WEB_FETCH_PDF_CACHE_TTL_SECS", 86400, 30 * 86400)?),
      pdf_refresh: bool_env("WEB_FETCH_PDF_REFRESH", false)?,
      gpu_tools_url,
      max_pdf_response_bytes: positive_env("WEB_FETCH_MAX_PDF_RESPONSE_BYTES", 16 * 1024 * 1024, 32 * 1024 * 1024)?
        as usize,
      browser_path,
      timeout: Duration::from_secs(positive_env("WEB_FETCH_TIMEOUT_SECS", 30, 3_600)?),
      max_document_bytes: positive_env("WEB_FETCH_MAX_DOCUMENT_BYTES", 2 * 1024 * 1024, 16 * 1024 * 1024)? as usize,
      max_rendered_bytes: positive_env("WEB_FETCH_MAX_RENDERED_BYTES", 4 * 1024 * 1024, 16 * 1024 * 1024)? as usize,
      html_dump_dir: optional_env("WEB_FETCH_HTML_DUMP_DIR")?.map(PathBuf::from),
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

pub(super) fn cache_home() -> Option<PathBuf> {
  env::var_os("XDG_CACHE_HOME")
    .map(PathBuf::from)
    .filter(|path| path.is_absolute())
    .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")).filter(|path| path.is_absolute()))
}

fn bool_env(name: &str, default: bool) -> Result<bool, String> {
  match optional_env(name)?.as_deref() {
    None => Ok(default),
    Some("1" | "true") => Ok(true),
    Some("0" | "false") => Ok(false),
    _ => Err(format!("{name} must be true, false, 1 or 0.")),
  }
}
