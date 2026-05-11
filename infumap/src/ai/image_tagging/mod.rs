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

use config::Config;
use infusdk::item::Item;
use infusdk::util::infu::{InfuError, InfuResult};
use log::{error, info, warn};
use reqwest::multipart::{Form, Part};
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::time;

use crate::config::CONFIG_IMAGE_TAGGING_URL;
use crate::storage::db::Db;
use crate::storage::object::{self as storage_object, ObjectStore};
use crate::util::image::extract_image_metadata;
use crate::util::retry::endpoint_retry_delay;

mod artifacts;

#[allow(unused_imports)]
pub use artifacts::FailedImageTagInfo;
pub use artifacts::ImageTagManifestStatus;
pub use artifacts::{delete_item_image_tag_dir, item_needs_image_tagging, list_failed_images};
pub use artifacts::{
  image_tagging_manifest_is_complete, image_tagging_manifest_is_successful, image_tagging_manifest_status,
};

use self::artifacts::{
  ImageTagArtifact, clear_item_image_tag_dir, existing_image_tag_artifact_paths, write_failed_manifest,
  write_success_artifacts,
};

const REQUEST_TIMEOUT_SECS: u64 = 30 * 60;
const MAX_RESPONSE_FORMAT_RETRY_ATTEMPTS: usize = 0;
const SUPPORTED_IMAGE_MIME_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/webp", "image/tiff"];
const CLI_FAILED_MANIFEST_EXTRACTOR_URL: &str = "manual://extract-cli";
const IMAGE_TAG_ARTIFACT_COLLISION_ERROR_PREFIX: &str = "Image tag artifact collision";

#[derive(Clone, Copy)]
pub(crate) enum ExistingImageTagArtifactAction {
  Skip,
  Abort,
}

#[derive(Clone, Copy)]
pub(crate) struct ImageTagArtifactPolicy {
  pub allow_initial_overwrite: bool,
  pub existing_artifact_action: ExistingImageTagArtifactAction,
}

impl ImageTagArtifactPolicy {
  pub(crate) fn web_background() -> ImageTagArtifactPolicy {
    ImageTagArtifactPolicy {
      allow_initial_overwrite: false,
      existing_artifact_action: ExistingImageTagArtifactAction::Skip,
    }
  }

  pub(crate) fn cli(overwrite_existing: bool) -> ImageTagArtifactPolicy {
    ImageTagArtifactPolicy {
      allow_initial_overwrite: overwrite_existing,
      existing_artifact_action: ExistingImageTagArtifactAction::Abort,
    }
  }
}

pub fn is_image_tag_artifact_collision_error(error: &InfuError) -> bool {
  error.message().starts_with(IMAGE_TAG_ARTIFACT_COLLISION_ERROR_PREFIX)
}

#[derive(Clone)]
struct ImageCandidate {
  user_id: String,
  item_id: String,
  mime_type: String,
  creation_date: i64,
  file_size_bytes: Option<i64>,
  last_modified_date: i64,
}

impl ImageCandidate {
  fn from_item(item: &Item) -> Option<ImageCandidate> {
    let mime_type = item.mime_type.as_deref()?;
    if !is_supported_image_tagging_mime_type(Some(mime_type)) {
      return None;
    }
    Some(ImageCandidate {
      user_id: item.owner_id.clone(),
      item_id: item.id.clone(),
      mime_type: mime_type.to_owned(),
      creation_date: item.creation_date,
      file_size_bytes: item.file_size_bytes,
      last_modified_date: item.last_modified_date,
    })
  }
}

pub(crate) struct LoadedImageTagging {
  candidate: ImageCandidate,
  file_bytes: Vec<u8>,
}

enum TagOutcome {
  Success(ImageTagArtifact, Option<u64>),
  DocumentFailed(String),
  ResponseFormatFailed(String),
  EndpointUnavailable(String),
}

pub fn is_supported_image_tagging_mime_type(mime_type: Option<&str>) -> bool {
  let Some(mime_type) = mime_type else {
    return false;
  };
  SUPPORTED_IMAGE_MIME_TYPES.contains(&mime_type)
}

pub fn should_tag_image_item(item: &Item) -> bool {
  is_supported_image_tagging_mime_type(item.mime_type.as_deref())
}

pub async fn tag_single_item_no_retry(
  data_dir: &str,
  image_tagging_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  item_id: &str,
) -> InfuResult<()> {
  tag_single_item_inner(data_dir, image_tagging_url, db, object_store, item_id, false, true).await
}

async fn tag_single_item_inner(
  data_dir: &str,
  image_tagging_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  item_id: &str,
  retry_endpoint_unavailable: bool,
  overwrite_existing: bool,
) -> InfuResult<()> {
  let loaded = load_image_for_tagging(db.clone(), object_store, item_id).await?;
  process_loaded_image_tagging(
    data_dir,
    image_tagging_url,
    db,
    loaded,
    retry_endpoint_unavailable,
    ImageTagArtifactPolicy::cli(overwrite_existing),
  )
  .await
}

pub(crate) async fn load_image_for_tagging(
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  item_id: &str,
) -> InfuResult<LoadedImageTagging> {
  let (candidate, object_encryption_key) = {
    let db = db.lock().await;
    let id = item_id.to_string();
    let item = db.item.get(&id).map_err(|e| e.to_string())?;
    let Some(candidate) = ImageCandidate::from_item(item) else {
      return Err(format!("Item '{}' is not a supported taggable image.", item_id).into());
    };
    let key =
      db.user.get(&item.owner_id).ok_or(format!("User '{}' not loaded.", item.owner_id))?.object_encryption_key.clone();
    (candidate, key)
  };
  info!("Starting source object read/decrypt for image '{}' (user {}).", candidate.item_id, candidate.user_id);
  let object_read_started_at = Instant::now();
  let file_bytes = storage_object::get(
    object_store.clone(),
    candidate.user_id.clone(),
    candidate.item_id.clone(),
    &object_encryption_key,
  )
  .await;
  let file_bytes = match file_bytes {
    Ok(bytes) => bytes,
    Err(e) => {
      let elapsed = object_read_started_at.elapsed();
      let error_message = e.to_string();
      error!(
        "Could not read source image object for '{}' (user {}) after {}: {}",
        candidate.item_id,
        candidate.user_id,
        format_duration_for_log(elapsed),
        error_message
      );
      return Err(format!("Could not read source image object for '{}': {}", candidate.item_id, error_message).into());
    }
  };
  let object_read_elapsed = object_read_started_at.elapsed();
  info!(
    "Completed source object read/decrypt for image '{}' (user {}) in {} ({} bytes).",
    candidate.item_id,
    candidate.user_id,
    format_duration_for_log(object_read_elapsed),
    file_bytes.len()
  );
  Ok(LoadedImageTagging { candidate, file_bytes })
}

pub(crate) async fn process_loaded_image_tagging(
  data_dir: &str,
  image_tagging_url: &str,
  db: Arc<Mutex<Db>>,
  loaded: LoadedImageTagging,
  retry_endpoint_unavailable: bool,
  artifact_policy: ImageTagArtifactPolicy,
) -> InfuResult<()> {
  let LoadedImageTagging { candidate, file_bytes } = loaded;
  process_image_tagging_for_candidate_and_bytes(
    data_dir,
    image_tagging_url,
    db,
    candidate,
    &file_bytes,
    retry_endpoint_unavailable,
    artifact_policy,
  )
  .await
}

async fn process_image_tagging_for_candidate_and_bytes(
  data_dir: &str,
  image_tagging_url: &str,
  db: Arc<Mutex<Db>>,
  candidate: ImageCandidate,
  file_bytes: &[u8],
  retry_endpoint_unavailable: bool,
  artifact_policy: ImageTagArtifactPolicy,
) -> InfuResult<()> {
  if !candidate_still_current(db.clone(), &candidate).await? {
    return Err(format!("Item '{}' was deleted or replaced before tagging started.", candidate.item_id).into());
  }
  if artifact_policy.allow_initial_overwrite {
    clear_item_image_tag_dir(data_dir, &candidate.user_id, &candidate.item_id).await?;
  } else if !handle_existing_artifact_collision(data_dir, &candidate, artifact_policy, "before image tagging started")
    .await?
  {
    return Ok(());
  }
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build HTTP client: {}", e))?;
  info!(
    "Starting image tagging for image '{}' (user {}) using '{}' ({} bytes).",
    candidate.item_id,
    candidate.user_id,
    image_tagging_url,
    file_bytes.len()
  );
  let tagging_started_at = Instant::now();
  let outcome = if retry_endpoint_unavailable {
    request_image_tagging_with_retries(&client, image_tagging_url, &candidate, &file_bytes, None).await
  } else {
    request_image_tagging_once(&client, image_tagging_url, &candidate, &file_bytes).await
  };
  let tagging_elapsed = tagging_started_at.elapsed();
  if !candidate_still_current(db.clone(), &candidate).await? {
    return Err(format!("Item '{}' was deleted or replaced while tagging was in progress.", candidate.item_id).into());
  }
  match outcome {
    TagOutcome::Success(mut tag_data, duration_ms) => {
      tag_data.image_metadata = extract_image_metadata(file_bytes);
      if !handle_existing_artifact_collision(
        data_dir,
        &candidate,
        artifact_policy,
        "before writing image tag artifacts",
      )
      .await?
      {
        return Ok(());
      }
      write_success_artifacts(data_dir, image_tagging_url, &candidate, &tag_data, duration_ms).await?;
      info!(
        "Finished image tagging for image '{}' (user {}) in {}.",
        candidate.item_id,
        candidate.user_id,
        format_duration_for_log(tagging_elapsed)
      );
    }
    TagOutcome::DocumentFailed(msg) => {
      if !handle_existing_artifact_collision(
        data_dir,
        &candidate,
        artifact_policy,
        "before writing failed image tag manifest",
      )
      .await?
      {
        return Ok(());
      }
      write_failed_manifest(data_dir, image_tagging_url, &candidate, &msg).await?;
      info!(
        "Finished image tagging for image '{}' (user {}) with document failure after {}: {}",
        candidate.item_id,
        candidate.user_id,
        format_duration_for_log(tagging_elapsed),
        msg
      );
      return Err(format!("Image tagging failed for '{}': {}", candidate.item_id, msg).into());
    }
    TagOutcome::ResponseFormatFailed(msg) => {
      if !handle_existing_artifact_collision(
        data_dir,
        &candidate,
        artifact_policy,
        "before writing failed image tag manifest",
      )
      .await?
      {
        return Ok(());
      }
      write_failed_manifest(data_dir, image_tagging_url, &candidate, &msg).await?;
      info!(
        "Finished image tagging for image '{}' (user {}) with response-format failure after {}: {}",
        candidate.item_id,
        candidate.user_id,
        format_duration_for_log(tagging_elapsed),
        msg
      );
      return Err(format!("Image tagging failed for '{}': {}", candidate.item_id, msg).into());
    }
    TagOutcome::EndpointUnavailable(msg) => {
      info!(
        "Finished image tagging for image '{}' (user {}) with endpoint failure after {}: {}",
        candidate.item_id,
        candidate.user_id,
        format_duration_for_log(tagging_elapsed),
        msg
      );
      return Err(format!("Image tagging endpoint unavailable: {}", msg).into());
    }
  }
  Ok(())
}

async fn handle_existing_artifact_collision(
  data_dir: &str,
  candidate: &ImageCandidate,
  artifact_policy: ImageTagArtifactPolicy,
  phase: &str,
) -> InfuResult<bool> {
  let existing_paths = existing_image_tag_artifact_paths(data_dir, &candidate.user_id, &candidate.item_id).await?;
  if existing_paths.is_empty() {
    return Ok(true);
  }
  let message = format!(
    "{}: image '{}' (user {}) already has text artifact(s) {}. This usually means another CLI or web image tagging worker wrote the output {}.",
    IMAGE_TAG_ARTIFACT_COLLISION_ERROR_PREFIX,
    candidate.item_id,
    candidate.user_id,
    existing_paths.join(", "),
    phase
  );
  match artifact_policy.existing_artifact_action {
    ExistingImageTagArtifactAction::Skip => {
      warn!("{} Skipping this image tagging write.", message);
      Ok(false)
    }
    ExistingImageTagArtifactAction::Abort => Err(message.into()),
  }
}

pub async fn mark_item_image_tagging_failed(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  item_id: &str,
  reason_maybe: Option<&str>,
) -> InfuResult<()> {
  let candidate = {
    let db = db.lock().await;
    let id = item_id.to_string();
    let item = db.item.get(&id).map_err(|e| e.to_string())?;
    let Some(candidate) = ImageCandidate::from_item(item) else {
      return Err(format!("Item '{}' is not a supported taggable image.", item_id).into());
    };
    candidate
  };
  clear_item_image_tag_dir(data_dir, &candidate.user_id, &candidate.item_id).await?;
  let error_message = match reason_maybe.map(|reason| reason.trim()).filter(|reason| !reason.is_empty()) {
    Some(reason) => format!("Marked failed via CLI: {}", reason),
    None => "Marked failed via CLI.".to_owned(),
  };
  write_failed_manifest(data_dir, CLI_FAILED_MANIFEST_EXTRACTOR_URL, &candidate, &error_message).await?;
  info!("Marked image '{}' (user {}) as failed for image tagging via CLI.", candidate.item_id, candidate.user_id);
  Ok(())
}

pub fn image_tagging_url_from_config(config: &Config) -> InfuResult<Option<String>> {
  match config.get_string(CONFIG_IMAGE_TAGGING_URL) {
    Ok(url) if !url.trim().is_empty() => Ok(Some(url)),
    Ok(_) => Ok(None),
    Err(_) => Ok(None),
  }
}

fn format_duration_for_log(duration: Duration) -> String {
  if duration.subsec_nanos() == 0 {
    let secs = duration.as_secs();
    if secs >= 60 && secs % 60 == 0 {
      let minutes = secs / 60;
      return if minutes == 1 { "1 minute".to_owned() } else { format!("{} minutes", minutes) };
    }
    return if secs == 1 { "1 second".to_owned() } else { format!("{} seconds", secs) };
  }
  format!("{:.3} seconds", duration.as_secs_f64())
}

async fn request_image_tagging_with_retries(
  client: &reqwest::Client,
  image_tagging_url: &str,
  candidate: &ImageCandidate,
  file_bytes: &[u8],
  worker_id_maybe: Option<usize>,
) -> TagOutcome {
  let mut unavailable_attempt = 0usize;
  let mut response_format_attempt = 0usize;

  loop {
    let outcome = request_image_tagging(client, image_tagging_url, &candidate.mime_type, file_bytes.to_vec()).await;
    match outcome {
      TagOutcome::ResponseFormatFailed(message) => {
        if response_format_attempt >= MAX_RESPONSE_FORMAT_RETRY_ATTEMPTS {
          return TagOutcome::DocumentFailed(format!(
            "Image tagging service repeatedly returned malformed structured output after {} attempt(s): {}",
            response_format_attempt + 1,
            message
          ));
        }

        response_format_attempt += 1;
        match worker_id_maybe {
          Some(worker_id) => {
            info!(
              "Worker {}: image tagging endpoint '{}' returned malformed structured output for '{}' (user {}) ({}). Retrying immediately.",
              worker_id, image_tagging_url, candidate.item_id, candidate.user_id, message
            );
          }
          None => {
            info!(
              "Image tagging endpoint '{}' returned malformed structured output for '{}' (user {}) ({}). Retrying immediately.",
              image_tagging_url, candidate.item_id, candidate.user_id, message
            );
          }
        }
      }
      TagOutcome::EndpointUnavailable(message) => {
        let delay = endpoint_retry_delay(unavailable_attempt);
        unavailable_attempt += 1;
        match worker_id_maybe {
          Some(worker_id) => {
            info!(
              "Worker {}: image tagging endpoint '{}' is unavailable for '{}' (user {}) ({}). Retrying in {}.",
              worker_id,
              image_tagging_url,
              candidate.item_id,
              candidate.user_id,
              message,
              format_duration_for_log(delay)
            );
          }
          None => {
            info!(
              "Image tagging endpoint '{}' is unavailable for '{}' (user {}) ({}). Retrying in {}.",
              image_tagging_url,
              candidate.item_id,
              candidate.user_id,
              message,
              format_duration_for_log(delay)
            );
          }
        }
        time::sleep(delay).await;
      }
      other => {
        if unavailable_attempt > 0 || response_format_attempt > 0 {
          match worker_id_maybe {
            Some(worker_id) => {
              info!(
                "Worker {}: image tagging endpoint '{}' accepted requests again for '{}' (user {}) after {} unavailable attempt(s) and {} malformed-response attempt(s).",
                worker_id,
                image_tagging_url,
                candidate.item_id,
                candidate.user_id,
                unavailable_attempt,
                response_format_attempt
              );
            }
            None => {
              info!(
                "Image tagging endpoint '{}' accepted requests again for '{}' (user {}) after {} unavailable attempt(s) and {} malformed-response attempt(s).",
                image_tagging_url, candidate.item_id, candidate.user_id, unavailable_attempt, response_format_attempt
              );
            }
          }
        }
        return other;
      }
    }
  }
}

async fn request_image_tagging_once(
  client: &reqwest::Client,
  image_tagging_url: &str,
  candidate: &ImageCandidate,
  file_bytes: &[u8],
) -> TagOutcome {
  request_image_tagging(client, image_tagging_url, &candidate.mime_type, file_bytes.to_vec()).await
}

async fn candidate_still_current(db: Arc<Mutex<Db>>, candidate: &ImageCandidate) -> InfuResult<bool> {
  let db = db.lock().await;
  let item = match db.item.get(&candidate.item_id) {
    Ok(item) => item,
    Err(_) => return Ok(false),
  };
  Ok(
    item.owner_id == candidate.user_id
      && item.creation_date == candidate.creation_date
      && item.mime_type.as_deref() == Some(candidate.mime_type.as_str())
      && item.file_size_bytes == candidate.file_size_bytes
      && item.last_modified_date == candidate.last_modified_date
      && is_supported_image_tagging_mime_type(item.mime_type.as_deref()),
  )
}

async fn request_image_tagging(
  client: &reqwest::Client,
  image_tagging_url: &str,
  mime_type: &str,
  file_bytes: Vec<u8>,
) -> TagOutcome {
  let part = match Part::bytes(file_bytes).mime_str(mime_type) {
    Ok(part) => part,
    Err(e) => return TagOutcome::EndpointUnavailable(format!("Could not build multipart upload: {}", e)),
  };
  let form = Form::new().part("file", part);

  let response = match client.post(image_tagging_url).multipart(form).send().await {
    Ok(response) => response,
    Err(e) => return TagOutcome::EndpointUnavailable(e.to_string()),
  };

  let status = response.status();
  let body = match response.text().await {
    Ok(body) => body,
    Err(e) => return TagOutcome::EndpointUnavailable(format!("Could not read response body: {}", e)),
  };

  if status.is_success() {
    let parsed: Value = match serde_json::from_str(&body) {
      Ok(parsed) => parsed,
      Err(e) => return TagOutcome::EndpointUnavailable(format!("Could not parse success response: {}", e)),
    };
    let tag_data = ImageTagArtifact::from_value(parsed);
    let duration_ms = tag_data.duration_ms();
    return TagOutcome::Success(tag_data, duration_ms);
  }

  if is_terminal_document_response(status) {
    return TagOutcome::DocumentFailed(format!("HTTP {}: {}", status, body));
  }

  if let Some(message) = classify_malformed_structured_output_response(status, &body) {
    return TagOutcome::ResponseFormatFailed(format!("HTTP {}: {}", status, message));
  }

  TagOutcome::EndpointUnavailable(format!("HTTP {}: {}", status, body))
}

fn is_terminal_document_response(status: reqwest::StatusCode) -> bool {
  matches!(status, reqwest::StatusCode::UNPROCESSABLE_ENTITY | reqwest::StatusCode::PAYLOAD_TOO_LARGE)
}

fn classify_malformed_structured_output_response(status: reqwest::StatusCode, body: &str) -> Option<String> {
  if status != reqwest::StatusCode::INTERNAL_SERVER_ERROR {
    return None;
  }

  let detail = extract_response_detail(body).unwrap_or_else(|| body.trim().to_owned());
  if is_malformed_structured_output_detail(&detail) { Some(detail) } else { None }
}

fn extract_response_detail(body: &str) -> Option<String> {
  let parsed: Value = serde_json::from_str(body).ok()?;
  let detail = parsed.get("detail")?.as_str()?.trim();
  if detail.is_empty() { None } else { Some(detail.to_owned()) }
}

fn is_malformed_structured_output_detail(detail: &str) -> bool {
  let lowered = detail.trim().to_ascii_lowercase();
  if lowered.starts_with("model output ") {
    return true;
  }

  let looks_like_json_decode_error = (lowered.contains("expecting ") || lowered.contains("unterminated "))
    && lowered.contains(" line ")
    && lowered.contains(" column ");

  looks_like_json_decode_error
    || lowered.contains("invalid control character")
    || lowered.contains("extra data")
    || lowered.contains("json object")
    || lowered.contains("json root")
}
