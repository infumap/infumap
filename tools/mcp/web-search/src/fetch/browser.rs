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

use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use chromiumoxide::cdp::browser_protocol::{browser as cdp_browser, fetch, io, network};
use chromiumoxide::{Browser, BrowserConfig, Page};
use futures_util::StreamExt;
use reqwest::Url;
use serde::Deserialize;
use tokio::sync::{Semaphore, mpsc};
use tokio::time::{Instant, timeout_at};

use crate::error::InfuResult;

use super::config::FetchConfig;
use super::http::{DocumentKind, DownloadedDocument, classify};
use super::policy::{assert_public_destination, public_addresses};
use super::proxy::{AbortTask, PublicProxy};

pub(super) struct BrowserRenderer {
  config: FetchConfig,
  slots: Arc<Semaphore>,
}

impl BrowserRenderer {
  pub fn new(config: FetchConfig) -> Self {
    Self { config, slots: Arc::new(Semaphore::new(1)) }
  }

  pub async fn render(&self, requested: &Url, deadline: Instant) -> InfuResult<DownloadedDocument> {
    let permit = self.slots.clone().acquire_owned().await.map_err(|_| "Browser queue closed.")?;
    let config = self.config.clone();
    let requested = requested.clone();
    // The worker owns its permit and browser until cleanup, even if the caller
    // stops waiting. The overall deadline bounds all browser and proxy work.
    let task = tokio::spawn(async move {
      let _permit = permit;
      timeout_at(deadline, render_owned(config, requested, deadline))
        .await
        .map_err(|_| "Browser fetch exceeded its overall deadline.")?
    });
    task.await.map_err(|error| format!("Browser fetch worker failed: {error}"))?
  }
}

async fn render_owned(config: FetchConfig, requested: Url, deadline: Instant) -> InfuResult<DownloadedDocument> {
  let profile = tempfile::Builder::new()
    .prefix("infumap-web-fetch-")
    .tempdir()
    .map_err(|error| format!("Could not create browser profile: {error}"))?;
  let proxy = PublicProxy::start(deadline).await?;
  let mut builder = BrowserConfig::builder()
    .new_headless_mode()
    .respect_https_errors()
    .user_data_dir(profile.path())
    .enable_request_intercept()
    .disable_cache()
    .launch_timeout(Duration::from_secs(10))
    .request_timeout(Duration::from_secs(10))
    .arg(format!("--proxy-server=http://{}", proxy.address))
    .arg("--proxy-bypass-list=<-loopback>")
    .arg("--host-resolver-rules=MAP * ~NOTFOUND")
    .arg("--disable-quic")
    .arg("--webrtc-ip-handling-policy=disable_non_proxied_udp")
    .arg("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  if let Some(path) = config.browser_path.as_ref() {
    builder = builder.chrome_executable(path);
  }
  let launch =
    builder.build().map_err(|_| "No suitable browser found. Set WEB_FETCH_BROWSER_PATH to Chrome/Chromium.")?;
  let (mut browser, mut handler) = Browser::launch(launch)
    .await
    .map_err(|error| format!("Could not launch browser (sandbox and certificate checks required): {error}"))?;
  let _handler = AbortTask(tokio::spawn(async move {
    while let Some(result) = handler.next().await {
      if result.is_err() {
        break;
      }
    }
  }));
  let result = render_page(&browser, &config, requested).await;
  // A fresh browser/profile is used for now. Reuse and shutdown supervision
  // belong to step 4; never reuse a normal user profile in the meantime.
  let _ = browser.kill().await;
  result
}

async fn render_page(browser: &Browser, config: &FetchConfig, requested: Url) -> InfuResult<DownloadedDocument> {
  browser
    .execute(cdp_browser::SetDownloadBehaviorParams::new(cdp_browser::SetDownloadBehaviorBehavior::Deny))
    .await
    .map_err(|error| format!("Could not disable browser file downloads: {error}"))?;
  let page =
    browser.new_page("about:blank").await.map_err(|error| format!("Could not create browser page: {error}"))?;
  let frame = page
    .mainframe()
    .await
    .map_err(|error| format!("Could not inspect browser frame: {error}"))?
    .ok_or("Browser page has no main frame.")?;
  let mut events = page
    .event_listener::<fetch::EventRequestPaused>()
    .await
    .map_err(|error| format!("Could not subscribe to browser requests: {error}"))?;
  page
    .execute(fetch::EnableParams {
      patterns: Some(vec![
        fetch::RequestPattern {
          url_pattern: None,
          resource_type: None,
          request_stage: Some(fetch::RequestStage::Request),
        },
        fetch::RequestPattern {
          url_pattern: None,
          resource_type: Some(network::ResourceType::Document),
          request_stage: Some(fetch::RequestStage::Response),
        },
      ]),
      handle_auth_requests: Some(false),
    })
    .await
    .map_err(|error| format!("Could not intercept browser responses: {error}"))?;
  let (sender, mut documents) = mpsc::channel(8);
  let intercept_page = page.clone();
  let config = config.clone();
  let document_limit = config.max_document_bytes;
  let _interceptor = AbortTask(tokio::spawn(async move {
    let mut navigations = 0;
    while let Some(event) = events.next().await {
      let top = event.frame_id == frame && event.resource_type == network::ResourceType::Document;
      let result = intercept(&intercept_page, &config, &event, top, &mut navigations).await;
      match result {
        Ok(Some(document)) => {
          if sender.send(Ok(document)).await.is_err() {
            break;
          }
        }
        Ok(None) => {}
        Err(error) => {
          let _ = sender.send(Err(error)).await;
          let _ = intercept_page
            .execute(fetch::FailRequestParams::new(event.request_id.clone(), network::ErrorReason::Aborted))
            .await;
          break;
        }
      }
    }
  }));
  // Listen before navigating: an aborted PDF/text navigation must still deliver
  // its original response, even when Page.navigate reports ERR_ABORTED.
  let navigation = page.goto(requested.as_str());
  tokio::pin!(navigation);
  let first = tokio::select! {
    result = documents.recv() => result,
    result = &mut navigation => {
      if let Err(error) = result {
        // Response interception can deliberately abort a non-HTML document.
        log::debug!("Browser navigation ended before document dispatch: {error}");
      }
      documents.recv().await
    }
  }
  .ok_or("Browser closed before returning a document.")??;
  if first.kind() != DocumentKind::Html {
    return Ok(first);
  }
  snapshot(&page, first, document_limit, &mut documents).await
}

async fn intercept(
  page: &Page,
  config: &FetchConfig,
  event: &fetch::EventRequestPaused,
  top: bool,
  navigations: &mut usize,
) -> InfuResult<Option<DownloadedDocument>> {
  let url = Url::parse(&event.request.url).map_err(|_| "Browser requested an invalid URL.")?;
  if event.response_status_code.is_none() && event.response_error_reason.is_none() {
    if event.resource_type == network::ResourceType::Document {
      assert_public_destination(&url).await?;
    } else if matches!(url.scheme(), "http" | "https") {
      public_addresses(&url).await?;
    } else if !matches!(url.scheme(), "data" | "blob" | "about") {
      return Err("Blocked unsupported browser request scheme.".into());
    }
    if top {
      *navigations += 1;
      if *navigations > 6 {
        return Err("Browser exceeded the navigation/redirect limit.".into());
      }
    }
    page
      .execute(fetch::ContinueRequestParams::new(event.request_id.clone()))
      .await
      .map_err(|error| format!("Could not continue browser request: {error}"))?;
    return Ok(None);
  }
  let status = event.response_status_code.unwrap_or(0);
  if !top || (300..400).contains(&status) {
    page
      .execute(fetch::ContinueRequestParams::new(event.request_id.clone()))
      .await
      .map_err(|error| format!("Could not continue browser response: {error}"))?;
    return Ok(None);
  }
  assert_public_destination(&url).await?;
  if !(200..300).contains(&status) {
    return Err(format!("Failed to fetch URL: HTTP {status}").into());
  }
  let headers = event.response_headers.clone().unwrap_or_default();
  let content_type = headers
    .iter()
    .find(|header| header.name.eq_ignore_ascii_case("content-type"))
    .map(|header| header.value.to_ascii_lowercase())
    .unwrap_or_default();
  let body = read_body(page, event, &content_type, config).await?;
  let document = DownloadedDocument { final_url: url, content_type, body };
  if document.kind() == DocumentKind::Html {
    // Continue rendering the exact response already downloaded by Chrome.
    // The stream contains decoded bytes, so drop transfer/compression lengths.
    let headers = headers
      .into_iter()
      .filter(|header| {
        !["content-length", "content-encoding", "transfer-encoding"]
          .iter()
          .any(|name| header.name.eq_ignore_ascii_case(name))
      })
      .collect();
    let mut response = fetch::FulfillRequestParams::new(event.request_id.clone(), status);
    response.response_headers = Some(headers);
    response.body = Some(BASE64_STANDARD.encode(&document.body).into());
    page.execute(response).await.map_err(|error| format!("Could not render captured HTML response: {error}"))?;
  } else {
    page
      .execute(fetch::FailRequestParams::new(event.request_id.clone(), network::ErrorReason::Aborted))
      .await
      .map_err(|error| format!("Could not stop non-HTML navigation: {error}"))?;
  }
  Ok(Some(document))
}

async fn read_body(
  page: &Page,
  event: &fetch::EventRequestPaused,
  content_type: &str,
  config: &FetchConfig,
) -> InfuResult<Vec<u8>> {
  let stream = page
    .execute(fetch::TakeResponseBodyAsStreamParams::new(event.request_id.clone()))
    .await
    .map_err(|error| format!("Could not stream browser response: {error}"))?
    .result
    .stream;
  let result = async {
    let mut body = Vec::new();
    loop {
      let mut read = io::ReadParams::new(stream.clone());
      read.size = Some(64 * 1024);
      let chunk = page.execute(read).await.map_err(|error| format!("Could not read browser response: {error}"))?.result;
      let bytes = if chunk.base64_encoded.unwrap_or(false) {
        BASE64_STANDARD.decode(&chunk.data).map_err(|_| "Invalid encoded browser response.")?
      } else {
        chunk.data.into_bytes()
      };
      let mut prefix = body[..body.len().min(1024)].to_vec();
      prefix.extend_from_slice(&bytes[..bytes.len().min(1024 - prefix.len())]);
      let limit = if classify(content_type, &prefix) == DocumentKind::Pdf {
        config.max_pdf_bytes
      } else {
        config.max_document_bytes
      };
      if bytes.len() > limit.saturating_sub(body.len()) {
        return Err("Browser response exceeds its byte limit.".into());
      }
      body.extend_from_slice(&bytes);
      if chunk.eof {
        return Ok(body);
      }
    }
  }
  .await;
  let _ = page.execute(io::CloseParams::new(stream)).await;
  result
}

#[derive(Deserialize)]
struct Snapshot {
  ready: bool,
  url: String,
  html: Option<String>,
  oversized: bool,
}

async fn snapshot(
  page: &Page,
  mut document: DownloadedDocument,
  limit: usize,
  documents: &mut mpsc::Receiver<InfuResult<DownloadedDocument>>,
) -> InfuResult<DownloadedDocument> {
  loop {
    while let Ok(next) = documents.try_recv() {
      document = next?;
      if document.kind() != DocumentKind::Html {
        return Ok(document);
      }
    }
    let expression = format!(
      r#"(() => {{
      const ready = location.href !== 'about:blank' && document.readyState !== 'loading';
      const html = ready ? document.documentElement.outerHTML : '';
      const oversized = new TextEncoder().encode(html).length > {limit};
      return {{ready, url: location.href, html: oversized ? null : html, oversized}};
    }})()"#
    );
    let result = page
      .evaluate(expression)
      .await
      .map_err(|error| format!("Could not inspect rendered document: {error}"))?
      .into_value::<Snapshot>()
      .map_err(|error| format!("Invalid rendered document snapshot: {error}"))?;
    if result.oversized {
      return Err("Rendered document exceeds its byte limit.".into());
    }
    if result.ready {
      let final_url = Url::parse(&result.url).map_err(|_| "Browser returned an invalid final URL.")?;
      assert_public_destination(&final_url).await?;
      document.final_url = final_url;
      document.body = result.html.ok_or("Browser returned no rendered HTML.")?.into_bytes();
      return Ok(document);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
  }
}
