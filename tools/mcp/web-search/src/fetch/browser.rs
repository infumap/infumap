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
use chromiumoxide::cdp::browser_protocol::{browser as cdp_browser, fetch, io, network, target};
use chromiumoxide::{Browser, BrowserConfig, Page};
use futures_util::StreamExt;
use reqwest::Url;
use serde::Deserialize;
use tokio::sync::{Mutex, Semaphore, mpsc, oneshot, watch};
use tokio::time::{Instant, timeout, timeout_at};

use crate::error::InfuResult;

use super::config::FetchConfig;
use super::http::{DocumentKind, DownloadedDocument, classify};
use super::isolation::Isolation;
use super::policy::{assert_public_destination, public_addresses};
use super::proxy::{AbortTask, NetworkSession, PublicProxy, cancelled};

pub(super) struct BrowserRenderer {
  state: Arc<RendererState>,
}

struct RendererState {
  config: FetchConfig,
  slots: Arc<Semaphore>,
  owned: Mutex<Option<OwnedBrowser>>,
  shutdown: watch::Sender<bool>,
}

impl BrowserRenderer {
  pub fn new(config: FetchConfig) -> Self {
    let (shutdown, _) = watch::channel(false);
    Self {
      state: Arc::new(RendererState { config, slots: Arc::new(Semaphore::new(1)), owned: Mutex::new(None), shutdown }),
    }
  }

  pub async fn render(&self, requested: &Url, deadline: Instant) -> InfuResult<DownloadedDocument> {
    let state = self.state.clone();
    let permit = timeout_at(deadline, state.slots.clone().acquire_owned())
      .await
      .map_err(|_| "Browser fetch deadline expired while queued.")?
      .map_err(|_| "Browser fetch is shutting down.")?;
    let requested = requested.clone();
    let (mut response, receiver) = oneshot::channel();
    // Dropping the receiver cancels the worker. The worker retains its slot
    // through context/network/process cleanup, including after caller timeout.
    tokio::spawn(async move {
      let _permit = permit;
      let stopped = state.shutdown.subscribe();
      let mut owned = state.owned.lock().await;
      // Cleanup is deliberately outside the cancellable request future.
      if owned.as_ref().is_some_and(|browser| !browser.healthy())
        && let Some(mut old) = owned.take()
      {
        old.stop().await;
      }
      let operation = async {
        if owned.is_none() {
          *owned = Some(OwnedBrowser::prepare(&state.config).await?);
        }
        let browser = owned.as_mut().expect("Browser ownership initialized");
        if browser.browser.is_none() {
          browser.launch().await?;
        }
        browser.request(&state.config, requested, deadline).await
      };
      let mut result = tokio::select! {
        biased;
        _ = cancelled(stopped) => Err("Browser fetch is shutting down.".into()),
        _ = response.closed() => Err("Browser fetch was cancelled.".into()),
        result = timeout_at(deadline, operation) => result
          .map_err(|_| crate::error::InfuError::from("Browser fetch exceeded its overall deadline."))
          .and_then(|result| result),
      };
      if let Some(browser) = owned.as_mut()
        && let Some(network) = browser.network.take()
      {
        network.close().await;
      }
      if response.is_closed() || Instant::now() >= deadline {
        result = Err("Browser fetch was cancelled or exceeded its overall deadline.".into());
      }
      if result.is_err() {
        // This also disposes contexts whose creation was interrupted before a
        // context ID arrived. Do not reuse an uncertain/unresponsive browser.
        if let Some(mut browser) = owned.take() {
          browser.stop().await;
        }
      }
      let _ = response.send(result);
    });
    timeout_at(deadline, receiver)
      .await
      .map_err(|_| "Browser fetch exceeded its overall deadline.")?
      .map_err(|_| "Browser fetch worker stopped unexpectedly.")?
  }

  pub async fn shutdown(&self) {
    let _ = self.state.shutdown.send_replace(true);
    self.state.slots.close();
    let mut owned = self.state.owned.lock().await;
    if let Some(mut browser) = owned.take() {
      browser.stop().await;
    }
  }
}

struct OwnedBrowser {
  browser: Option<Browser>,
  handler: Option<AbortTask>,
  dead: watch::Receiver<bool>,
  isolation: Isolation,
  proxy: PublicProxy,
  network: Option<NetworkSession>,
  profile: tempfile::TempDir,
}

impl OwnedBrowser {
  async fn prepare(config: &FetchConfig) -> InfuResult<Self> {
    let profile = tempfile::Builder::new()
      .prefix("infumap-web-fetch-")
      .tempdir()
      .map_err(|error| format!("Could not create browser profile: {error}"))?;
    let proxy = PublicProxy::start().await?;
    let executable = config
      .browser_path
      .clone()
      .map(Ok)
      .unwrap_or_else(|| chromiumoxide::detection::default_executable(Default::default()))
      .map_err(|_| "No suitable browser found. Set WEB_FETCH_BROWSER_PATH to Chrome/Chromium.")?;
    let isolation = Isolation::prepare(profile.path(), proxy.address, executable).await?;
    let (_, dead) = watch::channel(false);
    Ok(Self { browser: None, handler: None, dead, isolation, proxy, network: None, profile })
  }

  fn healthy(&self) -> bool {
    !self.isolation.is_finished() && self.handler.as_ref().is_none_or(|handler| !handler.0.is_finished())
  }

  async fn launch(&mut self) -> InfuResult<()> {
    let builder = BrowserConfig::builder()
      // The library's defaults disable popup and IPC flooding protections.
      // Use an explicit list instead of inheriting those automation shortcuts.
      .disable_default_args()
      .new_headless_mode()
      .respect_https_errors()
      .user_data_dir(self.profile.path())
      .enable_request_intercept()
      .disable_cache()
      .launch_timeout(Duration::from_secs(10))
      .request_timeout(Duration::from_secs(10))
      .arg(format!("--proxy-server=http://{}", self.proxy.address))
      .arg("--proxy-bypass-list=<-loopback>")
      .arg("--host-resolver-rules=MAP * ~NOTFOUND")
      .arg("--disable-quic")
      .arg("--disable-background-networking")
      .arg("--disable-component-update")
      .arg("--disable-sync")
      .arg("--disable-default-apps")
      .arg("--no-first-run")
      .arg("--no-default-browser-check")
      .arg("--block-new-web-contents")
      .arg("--webrtc-ip-handling-policy=disable_non_proxied_udp")
      .arg("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    let launch = self.isolation.launch_config(builder)?;
    let (browser, mut handler) = Browser::launch(launch)
      .await
      .map_err(|error| format!("Could not launch browser (sandbox and certificate checks required): {error}"))?;
    let (died, dead) = watch::channel(false);
    self.dead = dead;
    self.handler = Some(AbortTask(tokio::spawn(async move {
      while let Some(result) = handler.next().await {
        if result.is_err() {
          break;
        }
      }
      let _ = died.send(true);
    })));
    self.browser = Some(browser);
    Ok(())
  }

  async fn request(
    &mut self,
    config: &FetchConfig,
    requested: Url,
    deadline: Instant,
  ) -> InfuResult<DownloadedDocument> {
    let browser = self.browser.as_ref().ok_or("Browser did not start.")?;
    self.network = Some(self.proxy.activate(deadline));
    tokio::select! {
      biased;
      _ = cancelled(self.dead.clone()) => Err("Browser control connection stopped.".into()),
      result = async {
        let context = browser.create_browser_context(target::CreateBrowserContextParams::builder()
          .dispose_on_detach(true).build()).await
          .map_err(|error| format!("Could not create isolated browser context: {error}"))?;
        let result = render_page(browser, config, requested, context.clone()).await;
        browser.dispose_browser_context(context).await
          .map_err(|error| format!("Could not dispose browser context: {error}"))?;
        result
      } => result,
    }
  }

  async fn stop(&mut self) {
    if let Some(network) = self.network.take() {
      network.close().await;
    }
    if let Some(browser) = self.browser.as_mut() {
      let _ = timeout(Duration::from_secs(1), browser.close()).await;
    }
    // Revoking ownership kills/reaps Chrome even if CDP stopped responding.
    // Keep the profile/bridges alive until the guardian acknowledges cleanup.
    self.isolation.shutdown().await;
    if let Some(browser) = self.browser.as_mut() {
      // Let the helper reap its guardian and exit before using force. The
      // ownership acknowledgement already established Chrome has stopped.
      if timeout(Duration::from_secs(1), browser.wait()).await.is_err() {
        let _ = browser.kill().await;
        let _ = browser.wait().await;
      }
    }
    if let Some(handler) = self.handler.as_mut() {
      handler.0.abort();
      let _ = (&mut handler.0).await;
    }
  }
}

async fn render_page(
  browser: &Browser,
  config: &FetchConfig,
  requested: Url,
  context: chromiumoxide::cdp::browser_protocol::browser::BrowserContextId,
) -> InfuResult<DownloadedDocument> {
  let mut downloads = cdp_browser::SetDownloadBehaviorParams::new(cdp_browser::SetDownloadBehaviorBehavior::Deny);
  downloads.browser_context_id = Some(context.clone());
  browser.execute(downloads).await.map_err(|error| format!("Could not disable browser file downloads: {error}"))?;
  let target = target::CreateTargetParams::builder()
    .url("about:blank")
    .browser_context_id(context)
    .build()
    .map_err(|error| format!("Could not configure browser page: {error}"))?;
  let page = browser.new_page(target).await.map_err(|error| format!("Could not create browser page: {error}"))?;
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
    if !top && matches!(url.scheme(), "data" | "blob" | "about") {
      // These do not create network connections. Any requests they initiate
      // still run inside the confined browser and through the public proxy.
    } else if event.resource_type == network::ResourceType::Document {
      assert_public_destination(&url).await?;
    } else if matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
      let mut destination = url.clone();
      if url.scheme() == "ws" {
        destination.set_scheme("http").map_err(|_| "Invalid WebSocket URL.")?;
      }
      if url.scheme() == "wss" {
        destination.set_scheme("https").map_err(|_| "Invalid WebSocket URL.")?;
      }
      public_addresses(&destination).await?;
    } else {
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
