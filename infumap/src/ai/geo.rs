use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use config::Config;
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::debug;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;
use tokio::time::{Instant as TokioInstant, sleep_until};

use crate::ai::artifact_paths::{
  ensure_user_text_dir, item_geo_content_path, item_geo_manifest_path, item_text_content_path,
};
use crate::ai::image_tagging::{image_tagging_manifest_is_successful, is_supported_image_tagging_mime_type};
use crate::ai::user_id_for_log;
use crate::config::{
  CONFIG_GEOAPIFY_API_KEY, CONFIG_GEOAPIFY_MAX_REQUESTS_PER_MINUTE, CONFIG_GEOAPIFY_URL, CONFIG_GEOAPIFY_URL_DEFAULT,
};
use crate::util::fs::path_exists;

const JSON_CONTENT_MIME_TYPE: &str = "application/json";
const GEO_MANIFEST_SCHEMA_VERSION: u32 = 1;
const GEOAPIFY_PROVIDER_NAME: &str = "geoapify";
const DEFAULT_GEOAPIFY_RATE_LIMIT_RETRY_SECS: u64 = 60;
const DEFAULT_GEOAPIFY_QUOTA_RETRY_SECS: u64 = 24 * 60 * 60;

#[derive(Clone)]
pub struct GeoCandidate {
  pub user_id: String,
  pub item_id: String,
  pub mime_type: String,
}

impl GeoCandidate {
  pub fn from_item(item: &Item) -> Option<GeoCandidate> {
    let mime_type = item.mime_type.as_deref()?;
    if !is_supported_image_tagging_mime_type(Some(mime_type)) {
      return None;
    }
    Some(GeoCandidate { user_id: item.owner_id.clone(), item_id: item.id.clone(), mime_type: mime_type.to_owned() })
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GeoDeferralReason {
  RateLimited,
  QuotaExhausted,
}

impl GeoDeferralReason {
  pub fn label(&self) -> &'static str {
    match self {
      GeoDeferralReason::RateLimited => "rate limited",
      GeoDeferralReason::QuotaExhausted => "quota exhausted",
    }
  }

  fn default_retry_after_secs(&self) -> u64 {
    match self {
      GeoDeferralReason::RateLimited => DEFAULT_GEOAPIFY_RATE_LIMIT_RETRY_SECS,
      GeoDeferralReason::QuotaExhausted => DEFAULT_GEOAPIFY_QUOTA_RETRY_SECS,
    }
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GeoProcessOutcome {
  Succeeded { cached: bool },
  Failed { external_request: bool },
  Deferred { reason: GeoDeferralReason, retry_after_secs: u64 },
  SkippedExisting,
  SkippedNoGps,
  SkippedWithoutImageTagOutput,
}

impl GeoProcessOutcome {
  pub fn sent_external_request(&self) -> bool {
    matches!(
      self,
      GeoProcessOutcome::Succeeded { cached: false }
        | GeoProcessOutcome::Failed { external_request: true }
        | GeoProcessOutcome::Deferred { .. }
    )
  }
}

#[derive(Debug)]
pub enum GeoRequestError {
  Deferred { reason: GeoDeferralReason, retry_after_secs: u64, status: u16, body: String },
  Other(String),
}

impl fmt::Display for GeoRequestError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      GeoRequestError::Deferred { reason, retry_after_secs, status, body } => write!(
        f,
        "Reverse geocoding service deferred request: {} (HTTP {}, retry after {}s): {}",
        reason.label(),
        status,
        retry_after_secs,
        truncate_for_log(body)
      ),
      GeoRequestError::Other(message) => f.write_str(message),
    }
  }
}

#[derive(Default)]
pub struct GeoRunSummary {
  pub succeeded: usize,
  pub failed: usize,
  pub skipped_existing: usize,
  pub skipped_no_gps: usize,
  pub skipped_without_image_tag_output: usize,
  pub deferred: usize,
  pub deferred_quota_exhausted: usize,
  pub deferred_rate_limited: usize,
  pub external_requests: usize,
  pub cache_hits: usize,
}

impl GeoRunSummary {
  pub fn record(&mut self, outcome: &GeoProcessOutcome) {
    match outcome {
      GeoProcessOutcome::Succeeded { cached } => {
        self.succeeded += 1;
        if *cached {
          self.cache_hits += 1;
        } else {
          self.external_requests += 1;
        }
      }
      GeoProcessOutcome::Failed { external_request } => {
        self.failed += 1;
        if *external_request {
          self.external_requests += 1;
        }
      }
      GeoProcessOutcome::Deferred { reason, .. } => {
        self.deferred += 1;
        self.external_requests += 1;
        match reason {
          GeoDeferralReason::RateLimited => {
            self.deferred_rate_limited += 1;
          }
          GeoDeferralReason::QuotaExhausted => {
            self.deferred_quota_exhausted += 1;
          }
        }
      }
      GeoProcessOutcome::SkippedExisting => {
        self.skipped_existing += 1;
      }
      GeoProcessOutcome::SkippedNoGps => {
        self.skipped_no_gps += 1;
      }
      GeoProcessOutcome::SkippedWithoutImageTagOutput => {
        self.skipped_without_image_tag_output += 1;
      }
    }
  }
}

#[derive(Deserialize)]
struct StoredImageTagArtifact {
  image_metadata: Option<StoredImageMetadata>,
}

#[derive(Deserialize)]
struct StoredImageMetadata {
  gps_latitude: Option<f64>,
  gps_longitude: Option<f64>,
}

#[derive(Deserialize)]
struct GeoManifestSummary {
  #[serde(default)]
  status: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GeoManifestStatus {
  Succeeded,
  Failed,
  Skipped,
}

#[derive(Serialize, Deserialize)]
struct GeoManifest {
  schema_version: u32,
  status: String,
  source_mime_type: String,
  content_mime_type: String,
  extractor: GeoManifestExtractor,
  error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct GeoManifestExtractor {
  provider: String,
  service_url: String,
  reverse_geocoded_at_unix_secs: i64,
  duration_ms: Option<u64>,
  query_latitude: Option<f64>,
  query_longitude: Option<f64>,
  cached: bool,
}

pub fn geoapify_api_key_from_config(config: &Config) -> InfuResult<Option<String>> {
  match config.get_string(CONFIG_GEOAPIFY_API_KEY) {
    Ok(value) => {
      let trimmed = value.trim();
      if trimmed.is_empty() { Ok(None) } else { Ok(Some(trimmed.to_owned())) }
    }
    Err(_) => Ok(None),
  }
}

pub fn geoapify_url_from_config(config: &Config) -> InfuResult<String> {
  let value = match config.get_string(CONFIG_GEOAPIFY_URL) {
    Ok(value) => value,
    Err(_) => CONFIG_GEOAPIFY_URL_DEFAULT.to_owned(),
  };
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return Err(format!("{} must not be empty.", CONFIG_GEOAPIFY_URL).into());
  }
  Ok(trimmed.to_owned())
}

pub fn resolve_geoapify_api_key(config: &Config) -> InfuResult<String> {
  geoapify_api_key_from_config(config)?.ok_or(format!("{} must be configured.", CONFIG_GEOAPIFY_API_KEY).into())
}

pub fn geoapify_max_requests_per_minute_from_config(config: &Config) -> InfuResult<u64> {
  let value = config.get_int(CONFIG_GEOAPIFY_MAX_REQUESTS_PER_MINUTE).map_err(|e| e.to_string())?;
  if value <= 0 {
    return Err(format!("{} must be greater than zero.", CONFIG_GEOAPIFY_MAX_REQUESTS_PER_MINUTE).into());
  }
  u64::try_from(value).map_err(|e| format!("Could not parse {}: {}", CONFIG_GEOAPIFY_MAX_REQUESTS_PER_MINUTE, e).into())
}

pub struct GeoRequestThrottle {
  min_interval: Duration,
  next_request_at: Option<TokioInstant>,
}

impl GeoRequestThrottle {
  pub fn new(max_requests_per_minute: u64) -> GeoRequestThrottle {
    let min_interval_secs = 60.0 / (max_requests_per_minute.max(1) as f64);
    GeoRequestThrottle { min_interval: Duration::from_secs_f64(min_interval_secs), next_request_at: None }
  }

  pub async fn wait_for_next_request(&mut self) {
    if let Some(next_request_at) = self.next_request_at {
      sleep_until(next_request_at).await;
    }
    self.next_request_at = Some(TokioInstant::now() + self.min_interval);
  }
}

pub async fn reverse_geocode_candidate_if_needed(
  data_dir: &str,
  client: &reqwest::Client,
  service_url: &str,
  api_key: &str,
  candidate: &GeoCandidate,
  overwrite: bool,
  cache: &mut HashMap<String, Value>,
  throttle: Option<&mut GeoRequestThrottle>,
) -> InfuResult<GeoProcessOutcome> {
  let geo_manifest_path = item_geo_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  if !overwrite && existing_geo_manifest_should_skip(&geo_manifest_path).await? {
    return Ok(GeoProcessOutcome::SkippedExisting);
  }

  let coords = match load_geo_query_coordinates(data_dir, candidate).await? {
    GeoCoordinateLoad::MissingImageTagOutput => {
      return Ok(GeoProcessOutcome::SkippedWithoutImageTagOutput);
    }
    GeoCoordinateLoad::InvalidMetadataOutput(error_message) => {
      write_failed_geo_manifest(data_dir, candidate, service_url, None, None, false, None, &error_message).await?;
      return Ok(GeoProcessOutcome::Failed { external_request: false });
    }
    GeoCoordinateLoad::Loaded(coords) => coords,
  };

  let Some((lat, lon)) = coords else {
    write_skipped_geo_manifest(data_dir, candidate, service_url, None, None, false, "missing GPS").await?;
    return Ok(GeoProcessOutcome::SkippedNoGps);
  };

  let cache_key = format!("{lat:.7},{lon:.7}");
  if let Some(cached_response) = cache.get(&cache_key) {
    write_success_geo_artifacts(data_dir, candidate, service_url, lat, lon, true, Some(0), cached_response).await?;
    return Ok(GeoProcessOutcome::Succeeded { cached: true });
  }

  if let Some(throttle) = throttle {
    throttle.wait_for_next_request().await;
  }

  let request_started_at = Instant::now();
  match reverse_geocode(client, service_url, api_key, lat, lon).await {
    Ok(response_json) => {
      let duration_ms = elapsed_millis(request_started_at.elapsed());
      cache.insert(cache_key, response_json.clone());
      write_success_geo_artifacts(data_dir, candidate, service_url, lat, lon, false, Some(duration_ms), &response_json)
        .await?;
      Ok(GeoProcessOutcome::Succeeded { cached: false })
    }
    Err(e) => match e {
      GeoRequestError::Deferred { reason, retry_after_secs, .. } => {
        Ok(GeoProcessOutcome::Deferred { reason, retry_after_secs })
      }
      GeoRequestError::Other(error_message) => {
        let duration_ms = elapsed_millis(request_started_at.elapsed());
        write_failed_geo_manifest(
          data_dir,
          candidate,
          service_url,
          Some(lat),
          Some(lon),
          false,
          Some(duration_ms),
          &error_message,
        )
        .await?;
        Ok(GeoProcessOutcome::Failed { external_request: true })
      }
    },
  }
}

pub async fn existing_geo_manifest_should_skip(path: &PathBuf) -> InfuResult<bool> {
  if !path_exists(path).await {
    return Ok(false);
  }
  let bytes = fs::read(path).await?;
  let manifest = match serde_json::from_slice::<GeoManifestSummary>(&bytes) {
    Ok(manifest) => manifest,
    Err(_) => return Ok(false),
  };
  Ok(matches!(manifest.status.as_str(), "succeeded" | "failed" | "skipped"))
}

pub async fn geo_manifest_status(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Option<GeoManifestStatus>> {
  let manifest_path = item_geo_manifest_path(data_dir, user_id, item_id)?;
  if !path_exists(&manifest_path).await {
    return Ok(None);
  }
  let bytes = fs::read(&manifest_path).await?;
  let manifest = match serde_json::from_slice::<GeoManifestSummary>(&bytes) {
    Ok(manifest) => manifest,
    Err(_) => return Ok(None),
  };
  Ok(match manifest.status.as_str() {
    "succeeded" => Some(GeoManifestStatus::Succeeded),
    "failed" => Some(GeoManifestStatus::Failed),
    "skipped" => Some(GeoManifestStatus::Skipped),
    _ => None,
  })
}

pub async fn geo_manifest_is_complete(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<bool> {
  let manifest_path = item_geo_manifest_path(data_dir, user_id, item_id)?;
  existing_geo_manifest_should_skip(&manifest_path).await
}

pub async fn delete_item_geo_artifacts(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<()> {
  let manifest_path = item_geo_manifest_path(data_dir, user_id, item_id)?;
  let content_path = item_geo_content_path(data_dir, user_id, item_id)?;
  if path_exists(&manifest_path).await {
    fs::remove_file(&manifest_path).await?;
  }
  if path_exists(&content_path).await {
    fs::remove_file(&content_path).await?;
  }
  Ok(())
}

pub fn extract_geo_query_coordinates(bytes: &[u8]) -> InfuResult<Option<(f64, f64)>> {
  let artifact: StoredImageTagArtifact = serde_json::from_slice(bytes)
    .map_err(|e| format!("Could not parse image tag output JSON while looking for GPS coordinates: {}", e))?;
  let Some(metadata) = artifact.image_metadata else {
    return Ok(None);
  };
  match (metadata.gps_latitude, metadata.gps_longitude) {
    (Some(lat), Some(lon)) => Ok(Some((lat, lon))),
    _ => Ok(None),
  }
}

enum GeoCoordinateLoad {
  MissingImageTagOutput,
  InvalidMetadataOutput(String),
  Loaded(Option<(f64, f64)>),
}

async fn load_geo_query_coordinates(data_dir: &str, candidate: &GeoCandidate) -> InfuResult<GeoCoordinateLoad> {
  if !image_tagging_manifest_is_successful(data_dir, &candidate.user_id, &candidate.item_id).await? {
    return Ok(GeoCoordinateLoad::MissingImageTagOutput);
  }
  let image_tag_path = item_text_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  if !path_exists(&image_tag_path).await {
    return Ok(GeoCoordinateLoad::MissingImageTagOutput);
  }
  let bytes = match fs::read(&image_tag_path).await {
    Ok(bytes) => bytes,
    Err(e) => {
      return Ok(GeoCoordinateLoad::InvalidMetadataOutput(format!(
        "Could not read image tag output '{}': {}",
        image_tag_path.display(),
        e
      )));
    }
  };
  match extract_geo_query_coordinates(&bytes) {
    Ok(coords) => Ok(GeoCoordinateLoad::Loaded(coords)),
    Err(e) => Ok(GeoCoordinateLoad::InvalidMetadataOutput(e.to_string())),
  }
}

pub async fn reverse_geocode(
  client: &reqwest::Client,
  service_url: &str,
  api_key: &str,
  lat: f64,
  lon: f64,
) -> Result<Value, GeoRequestError> {
  let response = client
    .get(service_url)
    .query(&[
      ("lat", lat.to_string()),
      ("lon", lon.to_string()),
      ("format", "json".to_owned()),
      ("apiKey", api_key.to_owned()),
    ])
    .send()
    .await
    .map_err(|e| GeoRequestError::Other(format!("Reverse geocoding request failed: {}", e)))?;

  let status = response.status();
  let retry_after_secs = response
    .headers()
    .get(reqwest::header::RETRY_AFTER)
    .and_then(|value| value.to_str().ok())
    .and_then(parse_retry_after_secs);
  let body = response
    .text()
    .await
    .map_err(|e| GeoRequestError::Other(format!("Could not read reverse geocoding response body: {}", e)))?;
  if !status.is_success() {
    if let Some(reason) = classify_geoapify_deferral(status.as_u16(), &body) {
      return Err(GeoRequestError::Deferred {
        retry_after_secs: retry_after_secs.unwrap_or_else(|| reason.default_retry_after_secs()),
        reason,
        status: status.as_u16(),
        body,
      });
    }
    return Err(GeoRequestError::Other(format!("Reverse geocoding service returned HTTP {}: {}", status, body)));
  }

  let parsed: Value = serde_json::from_str(&body)
    .map_err(|e| GeoRequestError::Other(format!("Could not parse reverse geocoding JSON response: {}", e)))?;
  if let Some(reason) = classify_geoapify_success_error_payload(&parsed) {
    let retry_after_secs = reason.default_retry_after_secs();
    return Err(GeoRequestError::Deferred { reason, retry_after_secs, status: status.as_u16(), body });
  }
  Ok(parsed)
}

async fn write_success_geo_artifacts(
  data_dir: &str,
  candidate: &GeoCandidate,
  service_url: &str,
  lat: f64,
  lon: f64,
  cached: bool,
  duration_ms: Option<u64>,
  response_json: &Value,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let content_path = item_geo_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = item_geo_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  fs::write(&content_path, serde_json::to_vec_pretty(response_json)?).await?;
  let manifest = GeoManifest {
    schema_version: GEO_MANIFEST_SCHEMA_VERSION,
    status: "succeeded".to_owned(),
    source_mime_type: candidate.mime_type.clone(),
    content_mime_type: JSON_CONTENT_MIME_TYPE.to_owned(),
    extractor: GeoManifestExtractor {
      provider: GEOAPIFY_PROVIDER_NAME.to_owned(),
      service_url: service_url.to_owned(),
      reverse_geocoded_at_unix_secs: unix_now_secs()?,
      duration_ms,
      query_latitude: Some(lat),
      query_longitude: Some(lon),
      cached,
    },
    error: None,
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  debug!(
    "Reverse geocoded image '{}' (user {}){}.",
    candidate.item_id,
    user_id_for_log(&candidate.user_id),
    if cached { " using in-memory cache" } else { "" }
  );
  Ok(())
}

async fn write_failed_geo_manifest(
  data_dir: &str,
  candidate: &GeoCandidate,
  service_url: &str,
  lat: Option<f64>,
  lon: Option<f64>,
  cached: bool,
  duration_ms: Option<u64>,
  error_message: &str,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let content_path = item_geo_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = item_geo_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  if path_exists(&content_path).await {
    fs::remove_file(&content_path).await?;
  }
  let manifest = GeoManifest {
    schema_version: GEO_MANIFEST_SCHEMA_VERSION,
    status: "failed".to_owned(),
    source_mime_type: candidate.mime_type.clone(),
    content_mime_type: JSON_CONTENT_MIME_TYPE.to_owned(),
    extractor: GeoManifestExtractor {
      provider: GEOAPIFY_PROVIDER_NAME.to_owned(),
      service_url: service_url.to_owned(),
      reverse_geocoded_at_unix_secs: unix_now_secs()?,
      duration_ms,
      query_latitude: lat,
      query_longitude: lon,
      cached,
    },
    error: Some(error_message.to_owned()),
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  debug!(
    "Reverse geocoding failed for image '{}' (user {}): {}",
    candidate.item_id,
    user_id_for_log(&candidate.user_id),
    error_message
  );
  Ok(())
}

async fn write_skipped_geo_manifest(
  data_dir: &str,
  candidate: &GeoCandidate,
  service_url: &str,
  lat: Option<f64>,
  lon: Option<f64>,
  cached: bool,
  reason: &str,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let content_path = item_geo_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = item_geo_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  if path_exists(&content_path).await {
    fs::remove_file(&content_path).await?;
  }
  let manifest = GeoManifest {
    schema_version: GEO_MANIFEST_SCHEMA_VERSION,
    status: "skipped".to_owned(),
    source_mime_type: candidate.mime_type.clone(),
    content_mime_type: JSON_CONTENT_MIME_TYPE.to_owned(),
    extractor: GeoManifestExtractor {
      provider: GEOAPIFY_PROVIDER_NAME.to_owned(),
      service_url: service_url.to_owned(),
      reverse_geocoded_at_unix_secs: unix_now_secs()?,
      duration_ms: None,
      query_latitude: lat,
      query_longitude: lon,
      cached,
    },
    error: Some(reason.to_owned()),
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  debug!(
    "Skipping reverse geocoding for image '{}' (user {}): {}",
    candidate.item_id,
    user_id_for_log(&candidate.user_id),
    reason
  );
  Ok(())
}

fn unix_now_secs() -> InfuResult<i64> {
  Ok(
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map_err(|e| format!("Could not determine current unix time: {}", e))?
      .as_secs() as i64,
  )
}

fn elapsed_millis(duration: Duration) -> u64 {
  duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn parse_retry_after_secs(value: &str) -> Option<u64> {
  value.trim().parse::<u64>().ok().filter(|value| *value > 0)
}

fn classify_geoapify_deferral(status: u16, body: &str) -> Option<GeoDeferralReason> {
  let normalized = body.to_ascii_lowercase();
  if status == 402 || status == 403 || status == 429 {
    if text_mentions_quota_exhaustion(&normalized) {
      return Some(GeoDeferralReason::QuotaExhausted);
    }
  }
  if status == 429 {
    return Some(GeoDeferralReason::RateLimited);
  }
  None
}

fn classify_geoapify_success_error_payload(value: &Value) -> Option<GeoDeferralReason> {
  let messages = ["error", "message", "status", "error_description"]
    .into_iter()
    .filter_map(|key| value.get(key).and_then(Value::as_str))
    .map(str::to_ascii_lowercase)
    .collect::<Vec<_>>();

  if messages.iter().any(|message| text_mentions_quota_exhaustion(message)) {
    return Some(GeoDeferralReason::QuotaExhausted);
  }
  if messages.iter().any(|message| message.contains("rate limit") || message.contains("too many requests")) {
    return Some(GeoDeferralReason::RateLimited);
  }
  None
}

fn text_mentions_quota_exhaustion(value: &str) -> bool {
  (value.contains("quota")
    || value.contains("credit")
    || value.contains("daily limit")
    || value.contains("usage limit"))
    && (value.contains("exceed")
      || value.contains("exhaust")
      || value.contains("out of")
      || value.contains("used")
      || value.contains("limit"))
}

fn truncate_for_log(value: &str) -> String {
  const MAX_CHARS: usize = 500;
  let trimmed = value.trim();
  if trimmed.chars().count() <= MAX_CHARS {
    return trimmed.to_owned();
  }
  format!("{}...", trimmed.chars().take(MAX_CHARS).collect::<String>())
}
