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
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, Semaphore, oneshot};
use tokio::task::JoinSet;
use tokio::time::{Instant, timeout_at};

use super::cache::{PdfCache, Source, digest};
use super::config::FetchConfig;
use super::http::is_pdf;
use crate::error::InfuResult;

pub(super) const POLICY_VERSION: u32 = 1;
pub(super) const DEADLINE_HEADER: &str = "x-pdf-request-deadline-unix-ms";

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct NativeText {
  pub markdown: String,
  pub metadata: Value,
}

impl NativeText {
  pub fn validate(&self) -> InfuResult<()> {
    let info = &self.metadata["extraction"];
    if self.markdown.trim().is_empty()
      || info["policy"] != "native_only"
      || info["policy_version"] != POLICY_VERSION
      || info["ocr_performed"] != false
      || info["backend"] != "docling"
      || info["service_version"].as_str().is_none_or(str::is_empty)
      || info.get("fallback_reason").is_none()
      || !info["fallback_reason"].is_null()
      || !info["unusable_pages"].as_array().is_some_and(Vec::is_empty)
      || !info["warning_pages"].as_array().is_some_and(Vec::is_empty)
      || self.metadata["page_count"].as_u64().is_none_or(|count| count == 0)
      || self.metadata["docling"]["status"] != "success"
      || !self.metadata["docling"]["errors"].as_array().is_some_and(Vec::is_empty)
      || self.metadata["docling"]["assessment"]["pages"]
        .as_array()
        .is_none_or(|pages| Some(pages.len() as u64) != self.metadata["page_count"].as_u64())
    {
      return Err("PDF service returned unverified native-only extraction metadata; result rejected.".into());
    }
    Ok(())
  }
}

type DiscoveryCache = Option<(Instant, Result<Url, String>)>;

pub(super) struct PdfService {
  config: FetchConfig,
  discovery: Mutex<DiscoveryCache>,
  readiness: AtomicU8,
  pub cache: PdfCache,
  workers: Mutex<JoinSet<()>>,
  slots: Arc<Semaphore>,
}

#[derive(Deserialize)]
struct Discovery {
  schema_version: u32,
  endpoints: Vec<Endpoint>,
}

#[derive(Deserialize)]
struct Endpoint {
  id: String,
  method: Option<String>,
  path: String,
  policy: Option<String>,
  policy_version: Option<u32>,
  request_deadline_header: Option<String>,
}

impl PdfService {
  pub fn new(config: FetchConfig) -> Self {
    Self {
      cache: PdfCache::new(config.clone()),
      config,
      discovery: Mutex::new(None),
      readiness: AtomicU8::new(0),
      workers: Mutex::new(JoinSet::new()),
      slots: Arc::new(Semaphore::new(2)),
    }
  }

  pub fn status(&self) -> &'static str {
    if self.config.gpu_tools_url.is_none() {
      return "not_configured";
    }
    match self.readiness.load(Ordering::Relaxed) {
      1 => "native_only_capability_confirmed",
      2 => "unavailable_or_unsupported",
      _ => "not_checked",
    }
  }

  pub async fn shutdown(&self) {
    self.slots.close();
    let mut workers = self.workers.lock().await;
    workers.abort_all();
    while workers.join_next().await.is_some() {}
  }

  pub async fn extract(
    self: &Arc<Self>,
    bytes: Bytes,
    mut source: Source,
    deadline: Instant,
  ) -> InfuResult<NativeText> {
    let permit =
      self.slots.clone().try_acquire_owned().map_err(|_| "Native PDF fetch capacity is busy; retry later.")?;
    let service = self.clone();
    let (response, receiver) = oneshot::channel();
    let mut workers = self.workers.lock().await;
    while workers.try_join_next().is_some() {}
    workers.spawn(async move {
      let _permit = permit;
      // Keep the content lock and tracked operation through response validation
      // and atomic publication even if its original HTTP caller disconnects.
      let result = async {
        let hash_bytes = bytes.clone();
        let hash =
          tokio::task::spawn_blocking(move || digest(&hash_bytes)).await.map_err(|_| "PDF hash worker stopped.")?;
        source.content_hash = hash.clone();
        let _lock = match service.cache.lock("content", &hash, deadline).await {
          Ok(lock) => lock,
          Err(_) => {
            log::warn!("PDF cache lock unavailable; extraction will proceed without reuse.");
            None
          }
        };
        let cached = service.cache.content(&hash).await.unwrap_or(None);
        let text = if let Some(text) = cached {
          text
        } else {
          if Instant::now() >= deadline {
            return Err("Native PDF deadline expired before dispatch.".into());
          }
          let text = timeout_at(deadline, service.extract_inner(bytes.clone(), deadline))
            .await
            .map_err(|_| "Native PDF extraction exceeded the fetch deadline.")??;
          if service.cache.publish(&hash, bytes, &text, deadline).await.is_err() {
            log::warn!("Could not publish native PDF cache artifact.");
          }
          text
        };
        if service.cache.remember(source, deadline).await.is_err() {
          log::warn!("Could not publish native PDF source index.");
        }
        Ok::<_, crate::error::InfuError>(text)
      }
      .await;
      let _ = response.send(result);
    });
    drop(workers);
    timeout_at(deadline, receiver)
      .await
      .map_err(|_| "Native PDF extraction exceeded the fetch deadline.")?
      .map_err(|_| "Native PDF extraction worker stopped.")?
  }

  async fn extract_inner(&self, bytes: Bytes, deadline: Instant) -> InfuResult<NativeText> {
    if !is_pdf(&bytes) {
      return Err("The response claims to be a PDF but has no PDF signature.".into());
    }
    if bytes.len() > self.config.max_pdf_bytes {
      return Err("PDF exceeds its download byte limit.".into());
    }
    let client = Client::builder()
      .no_proxy()
      .redirect(reqwest::redirect::Policy::none())
      .connect_timeout(Duration::from_secs(10))
      .build()
      .map_err(|_| "Could not prepare native PDF service client.")?;
    let endpoint = self.endpoint(&client, deadline).await?;
    // Reserve time for bounded response transfer/validation. The absolute
    // expiry is not reset by upload, gateway queueing or worker queueing.
    let budget = deadline.saturating_duration_since(Instant::now()).saturating_sub(Duration::from_secs(2));
    if budget < Duration::from_secs(1) {
      return Err("Insufficient fetch time remaining for native PDF conversion.".into());
    }
    let expires =
      SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "System clock precedes Unix epoch.")?.as_millis()
        + budget.as_millis();
    let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::from(bytes.clone()), bytes.len() as u64)
      .file_name("document.pdf")
      .mime_str("application/pdf")
      .map_err(|_| "Could not encode PDF upload.")?;
    let response = client
      .post(endpoint)
      .header(DEADLINE_HEADER, expires.to_string())
      .header("x-pdf-conversion-timeout-secs", format!("{:.3}", budget.as_secs_f64()))
      .timeout(deadline.saturating_duration_since(Instant::now()))
      .multipart(reqwest::multipart::Form::new().part("file", part))
      .send()
      .await
      .map_err(|_| "Native PDF service request failed or timed out.")?;
    let status = response.status();
    let body = bounded_body(response, self.config.max_pdf_response_bytes).await?;
    if !status.is_success() {
      if status.is_server_error() {
        self.readiness.store(2, Ordering::Relaxed);
      }
      if status.as_u16() == 422 {
        let error: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let code = error["error_code"]
          .as_str()
          .filter(|code| code.len() <= 80 && code.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_'))
          .unwrap_or("pdf_native_text_unavailable");
        return Err(format!("Native PDF extraction rejected the document ({code}); OCR is prohibited.").into());
      }
      return Err(format!("Native PDF service returned HTTP {status}; no fallback was attempted.").into());
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| "Native PDF service returned invalid JSON.")?;
    if value["success"] != true {
      return Err("Native PDF service did not report success.".into());
    }
    let result = NativeText {
      markdown: value["markdown"].as_str().ok_or("Native PDF service returned no Markdown.")?.to_owned(),
      metadata: value["metadata"].clone(),
    };
    result.validate()?;
    self.readiness.store(1, Ordering::Relaxed);
    Ok(result)
  }

  async fn endpoint(&self, client: &Client, deadline: Instant) -> InfuResult<Url> {
    let base = self
      .config
      .gpu_tools_url
      .as_ref()
      .ok_or("PDF extraction requires WEB_FETCH_GPU_TOOLS_URL; OCR is prohibited.")?;
    let mut cached = self.discovery.lock().await;
    if let Some((at, result)) = cached.as_ref()
      && at.elapsed() < Duration::from_secs(60)
    {
      return result.clone().map_err(Into::into);
    }
    let result = async {
      let mut url = base.clone();
      url.set_path(&format!("{}/gpu-tools", base.path().trim_end_matches('/')));
      let response = client
        .get(url)
        .timeout(deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(10)))
        .send()
        .await
        .map_err(|_| "Could not discover native PDF service capabilities.")?;
      if !response.status().is_success() {
        return Err("Native PDF discovery failed; redirects are not accepted.".into());
      }
      let body = bounded_body(response, 128 * 1024).await?;
      let discovery: Discovery =
        serde_json::from_slice(&body).map_err(|_| "Invalid GPU service discovery document.")?;
      if discovery.schema_version != 1 {
        return Err("Unsupported GPU service discovery schema.".into());
      }
      let endpoint = discovery
        .endpoints
        .iter()
        .find(|endpoint| endpoint.id == "pdf_extract_native")
        .ok_or("GPU service does not advertise pdf_extract_native; OCR-capable endpoints are not accepted.")?;
      if endpoint.method.as_deref() != Some("POST")
        || endpoint.path != "/pdf-extract-native"
        || endpoint.policy.as_deref() != Some("native_only")
        || endpoint.policy_version != Some(POLICY_VERSION)
        || endpoint.request_deadline_header.as_deref() != Some(DEADLINE_HEADER)
      {
        return Err(
          "GPU service lacks the required native-only policy/deadline protocol. Update the GPU services.".into(),
        );
      }
      // Construct a fixed path on the configured origin; discovery cannot
      // select another host, absolute URI, query, credentials or path escape.
      let mut url = base.clone();
      url.set_path(&format!("{}/pdf-extract-native", base.path().trim_end_matches('/')));
      Ok(url)
    }
    .await;
    self.readiness.store(if result.is_ok() { 1 } else { 2 }, Ordering::Relaxed);
    *cached = Some((Instant::now(), result.as_ref().map(Clone::clone).map_err(ToString::to_string)));
    result
  }
}

pub(super) async fn bounded_body(response: Response, limit: usize) -> InfuResult<Vec<u8>> {
  if response.content_length().is_some_and(|size| size > limit as u64) {
    return Err("HTTP response exceeds its configured byte limit.".into());
  }
  let mut bytes = Vec::new();
  let mut chunks = response.bytes_stream();
  while let Some(chunk) = chunks.next().await {
    let chunk = chunk.map_err(|_| "Could not read bounded HTTP response.")?;
    if chunk.len() > limit.saturating_sub(bytes.len()) {
      return Err("HTTP response exceeds its configured byte limit.".into());
    }
    bytes.extend_from_slice(&chunk);
  }
  Ok(bytes)
}
