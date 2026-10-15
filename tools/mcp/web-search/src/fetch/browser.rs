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
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use chromiumoxide::cdp::browser_protocol::{browser as cdp_browser, fetch, io, network, target};
use chromiumoxide::{Browser, BrowserConfig, Page};
use futures_util::StreamExt;
use reqwest::Url;
use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tokio::sync::{Mutex, Semaphore, mpsc, oneshot, watch};
use tokio::time::{Instant, timeout, timeout_at};

use crate::error::InfuResult;

use super::config::FetchConfig;
use super::http::{DocumentKind, DownloadedDocument, Validators, classify};
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
  readiness: AtomicU8,
}

impl BrowserRenderer {
  pub fn new(config: FetchConfig) -> Self {
    let (shutdown, _) = watch::channel(false);
    Self {
      state: Arc::new(RendererState {
        config,
        slots: Arc::new(Semaphore::new(1)),
        owned: Mutex::new(None),
        shutdown,
        readiness: AtomicU8::new(0),
      }),
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
          state.readiness.store(1, Ordering::Relaxed);
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
        state.readiness.store(2, Ordering::Relaxed);
        // This also disposes contexts whose creation was interrupted before a
        // context ID arrived. Do not reuse an uncertain/unresponsive browser.
        if let Some(mut browser) = owned.take() {
          browser.stop().await;
          let stderr = browser.stderr_tail();
          if !stderr.is_empty() {
            log::warn!("Fetch browser stderr after failure: {stderr}");
            result = result.map_err(|error| format!("{error}\nBrowser stderr: {stderr}").into());
          }
        }
      }
      let _ = response.send(result);
    });
    timeout_at(deadline, receiver)
      .await
      .map_err(|_| "Browser fetch exceeded its overall deadline.")?
      .map_err(|_| "Browser fetch worker stopped unexpectedly.")?
  }

  pub fn status(&self) -> serde_json::Value {
    serde_json::json!({
      "executable_available": super::bootstrap::resolve(self.state.config.browser_path.as_deref()).is_ok(),
      "selection": if self.state.config.browser_path.is_some() { "configured" } else { "managed_or_system" },
      "runtime_state": if *self.state.shutdown.borrow() { "shutting_down" } else { match self.state.readiness.load(Ordering::Relaxed) {
        1 => "launched", 2 => "recycled_after_error", _ => "not_launched",
      } },
      "busy_or_cleaning_up": self.state.slots.available_permits() == 0,
      "network_confinement_required": true,
    })
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
  child: Option<chromiumoxide::async_process::Child>,
  stderr_task: Option<AbortTask>,
  stderr: Arc<StdMutex<Vec<u8>>>,
  handler: Option<AbortTask>,
  dead: watch::Receiver<Option<String>>,
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
    let executable = super::bootstrap::resolve(config.browser_path.as_deref())?;
    log::info!("Selected owned fetch browser: {}", executable.display());
    let isolation = Isolation::prepare(profile.path(), proxy.address, executable).await?;
    let (_, dead) = watch::channel(None);
    Ok(Self {
      browser: None,
      child: None,
      stderr_task: None,
      stderr: Arc::default(),
      handler: None,
      dead,
      isolation,
      proxy,
      network: None,
      profile,
    })
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
      // Chromiumoxide adds "--" to keys and "=" before tuple values.
      .arg(("proxy-server", format!("http://{}", self.proxy.address).as_str()))
      .arg(("proxy-bypass-list", "<-loopback>"))
      .arg(("host-resolver-rules", "MAP * ~NOTFOUND"))
      .arg("disable-quic")
      .arg("disable-background-networking")
      .arg("disable-component-update")
      .arg("disable-sync")
      .arg("disable-default-apps")
      .arg("no-first-run")
      .arg("no-default-browser-check")
      .arg("block-new-web-contents")
      .arg(("webrtc-ip-handling-policy", "disable_non_proxied_udp"))
      .arg(("force-webrtc-ip-handling-policy", "disable_non_proxied_udp"));
    let launch = self.isolation.launch_config(builder)?;
    // Browser::launch consumes and drops stderr as soon as it sees the
    // DevTools URL. Retain our own reader through helper shutdown so later
    // diagnostics cannot fill a pipe or write into a closed reader.
    self.child = Some(launch.launch().map_err(|error| format!("Could not start isolated browser helper: {error}"))?);
    let stderr = self
      .child
      .as_mut()
      .expect("Browser helper assigned")
      .stderr
      .take()
      .ok_or("Browser helper stderr is unavailable.")?
      .into_inner();
    let (ready, endpoint) = oneshot::channel();
    self.stderr_task = Some(AbortTask(tokio::spawn(read_browser_stderr(stderr, self.stderr.clone(), ready))));
    let handler_config = chromiumoxide::handler::HandlerConfig {
      // Connecting separately must retain the launch builder's strict TLS,
      // request interception, cache and command deadline settings.
      ignore_https_errors: false,
      request_timeout: Duration::from_secs(10),
      request_intercept: true,
      cache_enabled: false,
      ..Default::default()
    };
    let connected = timeout(Duration::from_secs(10), async {
      let endpoint = endpoint.await.map_err(|_| "Browser helper stopped before reporting its DevTools endpoint.")?;
      Browser::connect_with_config(endpoint, handler_config).await.map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Browser helper did not establish its DevTools connection before the launch deadline.")?;
    let (browser, mut handler) = connected
      .map_err(|error| format!("Could not launch browser (sandbox and certificate checks required): {error}. Check browser host libraries and unprivileged namespace/sandbox support; configure WEB_FETCH_BROWSER_PATH if needed. No sandbox or TLS bypass is available."))?;
    let (died, dead) = watch::channel(None);
    self.dead = dead;
    self.handler = Some(AbortTask(tokio::spawn(async move {
      while let Some(result) = handler.next().await {
        if let Err(error) = result {
          let detail: String = error.to_string().chars().take(1024).collect();
          log::warn!("Browser control connection stopped: {detail}");
          let _ = died.send(Some(format!("Browser control connection stopped: {detail}")));
          return;
        }
      }
      let _ = died.send(Some("Browser control stream ended.".to_owned()));
    })));
    self.browser = Some(browser);
    let version = self
      .browser
      .as_ref()
      .expect("Owned browser assigned")
      .version()
      .await
      .map_err(|error| format!("Could not inspect browser version: {error}"))?;
    let major = version
      .product
      .rsplit('/')
      .next()
      .and_then(|product| product.split('.').next())
      .and_then(|major| major.parse::<u32>().ok());
    if major.is_none_or(|major| major < 112) {
      return Err("Chrome/Chromium 112 or newer is required for modern headless mode. Update the browser or configure WEB_FETCH_BROWSER_PATH.".into());
    }
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
      error = control_stopped(self.dead.clone()) => Err(error.into()),
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
    if let Some(child) = self.child.as_mut() {
      // Let the helper reap its guardian and exit before using force. The
      // ownership acknowledgement already established Chrome has stopped.
      if timeout(Duration::from_secs(1), child.wait()).await.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
      }
    }
    if let Some(handler) = self.handler.as_mut() {
      handler.0.abort();
      let _ = (&mut handler.0).await;
    }
    if let Some(task) = self.stderr_task.as_mut()
      && timeout(Duration::from_secs(1), &mut task.0).await.is_err()
    {
      task.0.abort();
      let _ = (&mut task.0).await;
    }
  }

  fn stderr_tail(&self) -> String {
    String::from_utf8_lossy(&self.stderr.lock().expect("Browser stderr lock poisoned")).trim().to_owned()
  }
}

async fn control_stopped(mut dead: watch::Receiver<Option<String>>) -> String {
  loop {
    if let Some(error) = dead.borrow_and_update().clone() {
      return error;
    }
    if dead.changed().await.is_err() {
      return "Browser control handler stopped unexpectedly.".to_owned();
    }
  }
}

async fn read_browser_stderr(
  mut stderr: tokio::process::ChildStderr,
  tail: Arc<StdMutex<Vec<u8>>>,
  ready: oneshot::Sender<String>,
) {
  const LIMIT: usize = 8192;
  let mut ready = Some(ready);
  let mut pending = Vec::new();
  let mut buffer = [0; 4096];
  loop {
    let count = match stderr.read(&mut buffer).await {
      Ok(0) => break,
      Ok(count) => count,
      Err(error) => {
        log::warn!("Could not read browser helper stderr: {error}");
        break;
      }
    };
    {
      let mut tail = tail.lock().expect("Browser stderr lock poisoned");
      tail.extend_from_slice(&buffer[..count]);
      let discard = tail.len().saturating_sub(LIMIT);
      tail.drain(..discard);
    }
    if ready.is_some() {
      for byte in &buffer[..count] {
        if *byte == b'\n' {
          if let Ok(line) = std::str::from_utf8(&pending)
            && let Some(endpoint) = line.strip_prefix("DevTools listening on ")
            && let Ok(url) = Url::parse(endpoint.trim())
            && url.scheme() == "ws"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path().starts_with("/devtools/browser/")
            && let Some(ready) = ready.take()
          {
            let _ = ready.send(url.to_string());
          }
          pending.clear();
        } else if pending.len() < LIMIT {
          pending.push(*byte);
        }
      }
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
  let render_config = config.clone();
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
  snapshot(&page, first, &render_config, &mut documents).await
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
  let document = DownloadedDocument {
    final_url: url,
    content_type,
    body,
    validators: Validators {
      etag: headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("etag"))
        .filter(|header| header.value.len() <= 1024)
        .map(|header| header.value.clone()),
      last_modified: headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("last-modified"))
        .filter(|header| header.value.len() <= 1024)
        .map(|header| header.value.clone()),
    },
  };
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
struct Probe {
  ready: bool,
  signature: String,
  meaningful: bool,
}

#[derive(Deserialize)]
struct Snapshot {
  url: Option<String>,
  html: Option<String>,
  raw: Option<String>,
  blocked: Option<String>,
  oversized: bool,
}

async fn snapshot(
  page: &Page,
  mut document: DownloadedDocument,
  config: &FetchConfig,
  documents: &mut mpsc::Receiver<InfuResult<DownloadedDocument>>,
) -> InfuResult<DownloadedDocument> {
  let started = Instant::now();
  let mut changed = started;
  let mut signature = String::new();
  loop {
    while let Ok(next) = documents.try_recv() {
      document = next?;
      if document.kind() != DocumentKind::Html {
        return Ok(document);
      }
      changed = Instant::now();
    }
    let probe = page
      .evaluate(
        r#"(() => {
      const text = (document.querySelector('main,article,[role="main"]') || document.body)?.innerText || '';
      return {ready: location.href !== 'about:blank' && document.readyState !== 'loading',
        meaningful: text.trim().length > 0,
        signature: location.href + ':' + text.length + ':' + text.slice(0, 2048) + text.slice(-1024)};
    })()"#,
      )
      .await
      .map_err(|error| format!("Could not inspect document readiness: {error}"))?
      .into_value::<Probe>()
      .map_err(|error| format!("Invalid document readiness: {error}"))?;
    if signature != probe.signature {
      signature = probe.signature;
      changed = Instant::now();
    }
    let settled = started.elapsed() >= Duration::from_millis(750) && changed.elapsed() >= Duration::from_millis(400);
    if probe.ready && (settled && probe.meaningful || started.elapsed() >= Duration::from_secs(3)) {
      break;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
  }
  let expression = format!(
    "({})({})",
    include_str!("rendered.js"),
    serde_json::json!({
      "limit": config.max_rendered_bytes, "dump": config.html_dump_dir.is_some(),
    })
  );
  let result = page
    .evaluate(expression)
    .await
    .map_err(|error| format!("Could not capture rendered document: {error}"))?
    .into_value::<Snapshot>()
    .map_err(|error| format!("Invalid rendered document snapshot: {error}"))?;
  if result.oversized {
    return Err("Rendered document exceeds its byte or complexity limit.".into());
  }
  if let (Some(directory), Some(raw)) = (config.html_dump_dir.clone(), result.raw) {
    dump_html(directory, raw);
  }
  if let Some(blocked) = result.blocked {
    return Err(blocked.into());
  }
  let final_url = Url::parse(result.url.as_deref().ok_or("Browser returned no final URL.")?)
    .map_err(|_| "Browser returned an invalid final URL.")?;
  assert_public_destination(&final_url).await?;
  // A redirect racing the final snapshot must still be dispatched by type.
  if let Ok(next) = documents.try_recv() {
    let next = next?;
    if next.kind() != DocumentKind::Html {
      return Ok(next);
    }
    return Err("Page navigated while its rendered content was being captured; retry the fetch.".into());
  }
  document.final_url = final_url;
  document.body = result.html.ok_or("Browser returned no rendered HTML.")?.into_bytes();
  Ok(document)
}

fn dump_html(directory: std::path::PathBuf, raw: String) {
  use std::io::Write;
  static DUMPS: std::sync::OnceLock<Arc<Semaphore>> = std::sync::OnceLock::new();
  let Ok(permit) = DUMPS.get_or_init(|| Arc::new(Semaphore::new(2))).clone().try_acquire_owned() else { return };
  tokio::task::spawn_blocking(move || {
    let _permit = permit;
    let save = || -> std::io::Result<()> {
      std::fs::create_dir_all(&directory)?;
      let mut file = tempfile::Builder::new().prefix("rendered-").suffix(".html").tempfile_in(directory)?;
      file.write_all(raw.as_bytes())?;
      file.keep().map_err(|error| error.error)?;
      Ok(())
    };
    if save().is_err() {
      log::warn!("Could not save optional rendered HTML diagnostic.");
    }
  });
}
