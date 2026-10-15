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

mod bootstrap;
mod browser;
mod cache;
mod config;
mod http;
mod isolation;
mod markdown;
mod pdf;
mod policy;
mod proxy;
mod supervision;

use std::sync::{Arc, OnceLock};

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

pub async fn setup_browser(update: bool) -> InfuResult<std::path::PathBuf> {
  bootstrap::command(update).await
}

static FETCH_STATE: OnceLock<Result<FetchState, String>> = OnceLock::new();

struct FetchState {
  config: FetchConfig,
  http: HttpDownloader,
  browser: BrowserRenderer,
  pdf: Arc<pdf::PdfService>,
}

impl FetchState {
  fn from_env() -> Result<Self, String> {
    let config = FetchConfig::from_env()?;
    Ok(Self {
      http: HttpDownloader::new(config.clone()),
      browser: BrowserRenderer::new(config.clone()),
      pdf: Arc::new(pdf::PdfService::new(config.clone())),
      config,
    })
  }

  async fn fetch(&self, requested: Url, max_chars: usize) -> InfuResult<FetchedPage> {
    let deadline = Instant::now() + self.config.timeout;
    timeout_at(deadline, async {
      assert_public_destination(&requested).await?;
      let _source_lock =
        self.pdf.cache.lock("url", &cache::digest(requested.as_str().as_bytes()), deadline).await.unwrap_or(None);
      let cached = self.pdf.cache.lookup(requested.as_str()).await.unwrap_or(None);
      let mut revalidated = None;
      if let Some(cached) = cached {
        let final_url = Url::parse(&cached.source.final_url).map_err(|_| "Invalid cached PDF destination.")?;
        assert_public_destination(&final_url).await?;
        let unchanged = if cached.fresh {
          true
        } else {
          match self.http.download_conditional(&final_url, &cached.source.validators).await {
            Ok(http::DownloadOutcome::Unmodified) => true,
            Ok(http::DownloadOutcome::Document(document)) => {
              revalidated = Some(document);
              false
            }
            Err(_) => false, // A fresh browser context may be required by the site.
          }
        };
        if unchanged {
          if !cached.fresh {
            let _ = self.pdf.cache.publish(&cached.source.content_hash, cached.bytes, &cached.text, deadline).await;
            let _ = self.pdf.cache.remember(cached.source.clone(), deadline).await;
          }
          let document = DownloadedDocument {
            final_url,
            content_type: "application/pdf".into(),
            body: Vec::new(),
            validators: cached.source.validators,
          };
          let requested = requested.clone();
          return tokio::task::spawn_blocking(move || {
            Self::finish(&requested, document, max_chars, Some(cached.text.markdown))
          })
          .await
          .map_err(|error| format!("Cached PDF extraction worker failed: {error}"))?;
        }
      }
      // Suffixes and a previously validated PDF are routing hints only.
      let used_direct = revalidated.is_some() || http::is_direct_text_url(&requested);
      let mut document = if let Some(document) = revalidated {
        document
      } else if http::is_direct_text_url(&requested) {
        self.http.download(&requested).await?
      } else {
        self.browser.render(&requested, deadline).await?
      };
      if document.kind() == DocumentKind::Html && used_direct {
        document = self.browser.render(&requested, deadline).await?;
      }
      let native_text = if document.kind() == DocumentKind::Pdf {
        let source = cache::Source {
          url: requested.to_string(),
          final_url: document.final_url.to_string(),
          validators: document.validators.clone(),
          content_hash: String::new(),
          checked_at: 0,
        };
        Some(self.pdf.extract(bytes::Bytes::from(std::mem::take(&mut document.body)), source, deadline).await?.markdown)
      } else {
        None
      };
      // Parsing a bounded but large DOM must not block the async search server
      // or prevent its overall fetch deadline from being observed.
      tokio::task::spawn_blocking(move || Self::finish(&requested, document, max_chars, native_text))
        .await
        .map_err(|error| format!("Document extraction worker failed: {error}"))?
    })
    .await
    .map_err(|_| "Web fetch exceeded its overall deadline.")?
  }

  fn finish(
    requested: &Url,
    document: DownloadedDocument,
    max_chars: usize,
    native_text: Option<String>,
  ) -> InfuResult<FetchedPage> {
    let text = if let Some(text) = native_text {
      text
    } else {
      match document.kind() {
        DocumentKind::Pdf => return Err("Missing verified native PDF text.".into()),
        DocumentKind::Html => markdown::html_to_markdown(&String::from_utf8_lossy(&document.body))?,
        DocumentKind::Text => String::from_utf8_lossy(&document.body).trim().to_string(),
        DocumentKind::Unsupported => {
          return Err("Unsupported web document type; expected HTML, text, JSON or PDF.".into());
        }
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

/// Read local configuration/last-observed state only: no network or browser probes.
pub fn readiness() -> serde_json::Value {
  match FETCH_STATE.get() {
    Some(Ok(state)) => serde_json::json!({
      "browser": state.browser.status(),
      "pdf": { "service": state.pdf.status(), "policy": "native_only", "policy_version": pdf::POLICY_VERSION,
        "ocr_allowed": false, "cache_enabled": state.config.cache_dir.is_some(),
        "refresh_requested": state.config.pdf_refresh, "cache_ttl_secs": state.config.cache_ttl.as_secs(),
        "cache_artifact_budget_bytes": state.config.cache_max_bytes },
      "timeout_secs": state.config.timeout.as_secs(),
      "max_document_bytes": state.config.max_document_bytes,
      "max_rendered_bytes": state.config.max_rendered_bytes,
      "max_pdf_bytes": state.config.max_pdf_bytes,
      "max_pdf_response_bytes": state.config.max_pdf_response_bytes,
      "html_dumps_enabled": state.config.html_dump_dir.is_some(),
    }),
    _ => serde_json::json!({ "available": false, "reason": "not_initialized" }),
  }
}

pub async fn shutdown() {
  if let Some(Ok(state)) = FETCH_STATE.get() {
    state.browser.shutdown().await;
    state.pdf.shutdown().await;
  }
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
