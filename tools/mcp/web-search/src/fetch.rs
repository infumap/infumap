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

mod browser;
mod config;
mod http;
mod isolation;
mod markdown;
mod pdf;
mod policy;
mod proxy;

use std::sync::OnceLock;

use reqwest::Url;
use serde::Serialize;
use tokio::time::{Instant, timeout_at};

use crate::error::InfuResult;
use browser::BrowserRenderer;
use config::FetchConfig;
use http::{DocumentKind, DownloadedDocument, HttpDownloader};
use policy::{assert_public_destination, hosts_differ, normalize_url_scheme};

pub const DEFAULT_MAX_CHARS: usize = 8_000;
pub const MAX_CHARS_CAP: usize = 100_000;

pub fn run_browser_helper() -> Option<i32> {
  isolation::run_browser_helper()
}

static FETCH_STATE: OnceLock<Result<FetchState, String>> = OnceLock::new();

struct FetchState {
  config: FetchConfig,
  http: HttpDownloader,
  browser: BrowserRenderer,
}

impl FetchState {
  fn from_env() -> Result<Self, String> {
    let config = FetchConfig::from_env()?;
    Ok(Self { http: HttpDownloader::new(config.clone()), browser: BrowserRenderer::new(config.clone()), config })
  }

  async fn fetch(&self, requested: Url, max_chars: usize) -> InfuResult<FetchedPage> {
    let deadline = Instant::now() + self.config.timeout;
    timeout_at(deadline, async {
      assert_public_destination(&requested).await?;
      // A suffix is only a routing hint: classify the actual response again.
      let document = if http::is_direct_text_url(&requested) {
        let document = self.http.download(&requested).await?;
        if document.kind() == DocumentKind::Html { self.browser.render(&requested, deadline).await? } else { document }
      } else {
        self.browser.render(&requested, deadline).await?
      };
      // Parsing a bounded but large DOM must not block the async search server
      // or prevent its overall fetch deadline from being observed.
      tokio::task::spawn_blocking(move || Self::finish(&requested, document, max_chars))
        .await
        .map_err(|error| format!("Document extraction worker failed: {error}"))?
    })
    .await
    .map_err(|_| "Web fetch exceeded its overall deadline.")?
  }

  fn finish(requested: &Url, document: DownloadedDocument, max_chars: usize) -> InfuResult<FetchedPage> {
    let text = match document.kind() {
      DocumentKind::Pdf => pdf::extract_native(&document)?,
      DocumentKind::Html => markdown::html_to_markdown(&String::from_utf8_lossy(&document.body)),
      DocumentKind::Text => String::from_utf8_lossy(&document.body).trim().to_string(),
      DocumentKind::Unsupported => {
        return Err("Unsupported web document type; expected HTML, text, JSON or PDF.".into());
      }
    };
    let decoded = markdown::truncate_text(&text, max_chars.clamp(1, MAX_CHARS_CAP));
    Ok(FetchedPage {
      url: requested.to_string(),
      final_url: document.final_url.to_string(),
      content_type: document.content_type,
      truncated: decoded.truncated,
      text: decoded.text,
    })
  }
}

/// Prepare fetch configuration once, independently of search providers. No browser is launched here.
pub fn initialize() -> InfuResult<()> {
  state().map(|_| ())
}

fn state() -> InfuResult<&'static FetchState> {
  FETCH_STATE.get_or_init(FetchState::from_env).as_ref().map_err(|error| error.clone().into())
}

#[derive(Clone, Debug, Serialize)]
pub struct FetchedPage {
  pub url: String,
  pub final_url: String,
  pub content_type: String,
  pub truncated: bool,
  pub text: String,
}

#[derive(Serialize)]
struct CompactFetchedPage<'a> {
  url: &'a str,
  #[serde(rename = "finalUrl")]
  final_url: &'a str,
  truncated: bool,
  text: &'a str,
  #[serde(rename = "hostChanged", skip_serializing_if = "is_false")]
  host_changed: bool,
}

pub async fn fetch_page_json(url: &str, max_chars: usize) -> InfuResult<String> {
  compact_fetch_page_json(&fetch_url(url, max_chars).await?)
}

pub fn compact_fetch_page_json(page: &FetchedPage) -> InfuResult<String> {
  serde_json::to_string(&CompactFetchedPage {
    url: &page.url,
    final_url: &page.final_url,
    truncated: page.truncated,
    text: &page.text,
    host_changed: hosts_differ(&page.url, &page.final_url),
  })
  .map_err(|error| format!("Could not serialize fetched page: {error}").into())
}

pub async fn fetch_url(url: &str, max_chars: usize) -> InfuResult<FetchedPage> {
  state()?.fetch(normalize_url_scheme(url.trim())?, max_chars).await
}

fn is_false(value: &bool) -> bool {
  !*value
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn blocks_loopback_fetch() {
    let err = fetch_url("http://127.0.0.1/", 100).await.unwrap_err();
    assert!(err.to_string().contains("Blocked"), "{}", err);
  }

  #[tokio::test]
  async fn blocks_localhost_by_name() {
    let err = fetch_url("http://localhost/", 100).await.unwrap_err();
    assert!(err.to_string().contains("Blocked"), "{}", err);
  }

  #[tokio::test]
  async fn blocks_link_local_metadata_host() {
    let err = fetch_url("http://169.254.169.254/", 100).await.unwrap_err();
    assert!(err.to_string().contains("Blocked"), "{}", err);
  }
}
