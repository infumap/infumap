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

use infusdk::util::infu::InfuResult;
use log::debug;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::map::Map as JsonMap;
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::sync::Mutex;

use crate::ai::artifact_paths::{ensure_user_text_dir, item_text_content_path, item_text_manifest_path};
use crate::ai::user_id_for_log;
use crate::storage::db::Db;
use crate::util::fs::path_exists;
use crate::util::image::ImageMetadata;

use super::{ImageCandidate, should_tag_image_item};

const MANIFEST_SCHEMA_VERSION: u32 = 1;
const JSON_CONTENT_MIME_TYPE: &str = "application/json";

#[derive(Clone)]
pub struct FailedImageTagInfo {
  pub user_id: String,
  pub item_id: String,
  pub file_name: String,
  pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ImageTagManifest {
  schema_version: u32,
  status: String,
  source_mime_type: String,
  content_mime_type: String,
  extractor: ImageTagManifestExtractor,
  error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ImageTagManifestExtractor {
  image_tagging_url: String,
  tagged_at_unix_secs: i64,
  duration_ms: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  model_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  backend: Option<String>,
}

#[derive(Serialize, Default)]
pub(super) struct ImageTagArtifact {
  detailed_caption: Option<String>,
  scene: Option<String>,
  document_confidence: f64,
  face_recognition_candidate_confidence: f64,
  visible_face_count_estimate: Option<String>,
  tags: Vec<String>,
  ocr_text: Vec<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub(super) image_metadata: Option<ImageMetadata>,
  image_embedding: Vec<f32>,
  #[serde(skip)]
  model_id: Option<String>,
  #[serde(skip)]
  backend: Option<String>,
  #[serde(flatten)]
  extra: BTreeMap<String, Value>,
}

impl ImageTagArtifact {
  pub(super) fn from_value(value: Value) -> ImageTagArtifact {
    let mut map = match value {
      Value::Object(map) => map,
      _ => return ImageTagArtifact::default(),
    };
    let _ = map.remove("image_metadata");
    let _ = map.remove("location_type");

    ImageTagArtifact {
      detailed_caption: take_optional_string(&mut map, "detailed_caption"),
      scene: take_optional_string(&mut map, "scene"),
      document_confidence: take_f64(&mut map, "document_confidence"),
      face_recognition_candidate_confidence: take_f64(&mut map, "face_recognition_candidate_confidence"),
      visible_face_count_estimate: take_optional_string(&mut map, "visible_face_count_estimate"),
      tags: take_string_list(&mut map, "tags"),
      ocr_text: take_string_list(&mut map, "ocr_text"),
      image_metadata: None,
      image_embedding: take_f32_list(&mut map, "image_embedding"),
      model_id: take_optional_string(&mut map, "model_id"),
      backend: take_optional_string(&mut map, "backend"),
      extra: map.into_iter().collect(),
    }
  }

  pub(super) fn duration_ms(&self) -> Option<u64> {
    self.extra.get("duration_ms").and_then(value_as_u64)
  }
}

pub(super) enum ManifestCheckResult {
  NeedsTagging,
  AlreadySucceeded,
  AlreadyFailed,
  AlreadyUnsupported,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageTagManifestStatus {
  Succeeded,
  Failed,
}

#[derive(Clone, Debug)]
pub struct IncompleteImageTagArtifactInfo {
  pub paths: Vec<String>,
}

#[derive(Clone, Debug)]
pub enum ImageTagArtifactState {
  Empty,
  Succeeded,
  Failed,
  UnsupportedSchemaVersion { path: String, schema_version: u32 },
  Incomplete(IncompleteImageTagArtifactInfo),
}

pub async fn list_failed_images(data_dir: &str, db: Arc<Mutex<Db>>) -> InfuResult<Vec<FailedImageTagInfo>> {
  let mut out = vec![];
  let image_items: Vec<(String, String, String)> = {
    let db = db.lock().await;
    db.item
      .all_loaded_items()
      .into_iter()
      .filter_map(|iu| db.item.get(&iu.item_id).ok().map(|item| (iu.user_id.clone(), item)))
      .filter(|(_, item)| should_tag_image_item(item))
      .map(|(user_id, item)| {
        (user_id, item.id.clone(), item.title.clone().unwrap_or_else(|| format!("{}.bin", item.id)))
      })
      .collect()
  };
  for (user_id, item_id, file_name) in image_items {
    let path = match item_text_manifest_path(data_dir, &user_id, &item_id) {
      Ok(path) => path,
      Err(e) => {
        debug!(
          "Skipping failed image tag listing for item '{}' (user '{}'): could not build manifest path: {}",
          item_id,
          user_id_for_log(&user_id),
          e
        );
        continue;
      }
    };
    if !path_exists(&path).await {
      continue;
    }
    let bytes = match fs::read(&path).await {
      Ok(bytes) => bytes,
      Err(e) => {
        debug!(
          "Skipping failed image tag listing for item '{}' (user '{}'): could not read manifest '{}': {}",
          item_id,
          user_id_for_log(&user_id),
          path.display(),
          e
        );
        continue;
      }
    };
    let manifest: ImageTagManifest = match serde_json::from_slice(&bytes) {
      Ok(manifest) => manifest,
      Err(e) => {
        debug!(
          "Skipping failed image tag listing for item '{}' (user '{}'): could not parse manifest '{}': {}",
          item_id,
          user_id_for_log(&user_id),
          path.display(),
          e
        );
        continue;
      }
    };
    if manifest.status != "failed" {
      continue;
    }
    out.push(FailedImageTagInfo { user_id, item_id, file_name, error: manifest.error });
  }
  Ok(out)
}

pub async fn item_needs_image_tagging(data_dir: &str, db: Arc<Mutex<Db>>, item_id: &str) -> InfuResult<bool> {
  let candidate = {
    let db = db.lock().await;
    let id = item_id.to_string();
    let item = db.item.get(&id).map_err(|e| e.to_string())?;
    let Some(candidate) = ImageCandidate::from_item(item) else {
      return Err(format!("Item '{}' is not a supported taggable image.", item_id).into());
    };
    candidate
  };
  Ok(matches!(manifest_check(data_dir, &candidate).await?, ManifestCheckResult::NeedsTagging))
}

pub async fn image_tagging_manifest_is_successful(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<bool> {
  Ok(matches!(
    image_tagging_manifest_check_result(data_dir, user_id, item_id).await?,
    Some(ManifestCheckResult::AlreadySucceeded)
  ))
}

#[allow(dead_code)]
pub async fn image_tagging_manifest_status(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Option<ImageTagManifestStatus>> {
  Ok(match image_tagging_manifest_check_result(data_dir, user_id, item_id).await? {
    Some(ManifestCheckResult::AlreadySucceeded) => Some(ImageTagManifestStatus::Succeeded),
    Some(ManifestCheckResult::AlreadyFailed) => Some(ImageTagManifestStatus::Failed),
    Some(ManifestCheckResult::NeedsTagging) | Some(ManifestCheckResult::AlreadyUnsupported) | None => None,
  })
}

pub async fn image_tagging_artifact_state(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<ImageTagArtifactState> {
  let manifest_path = item_text_manifest_path(data_dir, user_id, item_id)?;
  let text_path = item_text_content_path(data_dir, user_id, item_id)?;
  let manifest_exists = path_exists(&manifest_path).await;
  let text_exists = path_exists(&text_path).await;

  if !manifest_exists && !text_exists {
    return Ok(ImageTagArtifactState::Empty);
  }

  let existing_path_bufs =
    existing_image_tag_artifact_path_bufs(&manifest_path, manifest_exists, &text_path, text_exists);
  let incomplete_info = || async {
    Ok(ImageTagArtifactState::Incomplete(IncompleteImageTagArtifactInfo {
      paths: existing_path_bufs.iter().map(|path| path.display().to_string()).collect(),
    }))
  };

  if !manifest_exists {
    return incomplete_info().await;
  }

  let manifest_bytes = match fs::read(&manifest_path).await {
    Ok(bytes) => bytes,
    Err(_) => return incomplete_info().await,
  };
  let manifest: ImageTagManifest = match serde_json::from_slice(&manifest_bytes) {
    Ok(manifest) => manifest,
    Err(_) => return incomplete_info().await,
  };
  if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
    return Ok(ImageTagArtifactState::UnsupportedSchemaVersion {
      path: manifest_path.display().to_string(),
      schema_version: manifest.schema_version,
    });
  }

  if manifest.status == "succeeded" {
    return if text_exists { Ok(ImageTagArtifactState::Succeeded) } else { incomplete_info().await };
  }

  if manifest.status == "failed" {
    return Ok(ImageTagArtifactState::Failed);
  }

  incomplete_info().await
}

async fn image_tagging_manifest_check_result(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Option<ManifestCheckResult>> {
  Ok(match image_tagging_artifact_state(data_dir, user_id, item_id).await? {
    ImageTagArtifactState::Succeeded => Some(ManifestCheckResult::AlreadySucceeded),
    ImageTagArtifactState::Failed => Some(ManifestCheckResult::AlreadyFailed),
    ImageTagArtifactState::UnsupportedSchemaVersion { .. } => Some(ManifestCheckResult::AlreadyUnsupported),
    ImageTagArtifactState::Empty | ImageTagArtifactState::Incomplete(_) => None,
  })
}

pub async fn delete_item_image_tag_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<()> {
  clear_item_image_tag_dir(data_dir, user_id, item_id).await
}

pub(super) async fn existing_image_tag_artifact_paths(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Vec<String>> {
  let manifest_path = item_text_manifest_path(data_dir, user_id, item_id)?;
  let text_path = item_text_content_path(data_dir, user_id, item_id)?;
  let mut paths = vec![];
  if path_exists(&text_path).await {
    paths.push(text_path.display().to_string());
  }
  if path_exists(&manifest_path).await {
    paths.push(manifest_path.display().to_string());
  }
  Ok(paths)
}

pub(super) async fn manifest_check(data_dir: &str, candidate: &ImageCandidate) -> InfuResult<ManifestCheckResult> {
  Ok(match image_tagging_artifact_state(data_dir, &candidate.user_id, &candidate.item_id).await? {
    ImageTagArtifactState::Succeeded => ManifestCheckResult::AlreadySucceeded,
    ImageTagArtifactState::Failed => ManifestCheckResult::AlreadyFailed,
    ImageTagArtifactState::UnsupportedSchemaVersion { .. } => ManifestCheckResult::AlreadyUnsupported,
    ImageTagArtifactState::Empty | ImageTagArtifactState::Incomplete(_) => ManifestCheckResult::NeedsTagging,
  })
}

pub(super) async fn write_success_artifacts(
  data_dir: &str,
  image_tagging_url: &str,
  candidate: &ImageCandidate,
  tag_data: &ImageTagArtifact,
  duration_ms: Option<u64>,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let text_path = item_text_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = item_text_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  fs::write(&text_path, serde_json::to_vec_pretty(tag_data)?).await?;
  let manifest = ImageTagManifest {
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: "succeeded".to_owned(),
    source_mime_type: candidate.mime_type.clone(),
    content_mime_type: JSON_CONTENT_MIME_TYPE.to_owned(),
    extractor: ImageTagManifestExtractor {
      image_tagging_url: image_tagging_url.to_owned(),
      tagged_at_unix_secs: unix_now_secs()?,
      duration_ms,
      model_id: tag_data.model_id.clone(),
      backend: tag_data.backend.clone(),
    },
    error: None,
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  Ok(())
}

pub(super) async fn write_failed_manifest(
  data_dir: &str,
  image_tagging_url: &str,
  candidate: &ImageCandidate,
  error_message: &str,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let text_path = item_text_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = item_text_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  if path_exists(&text_path).await {
    fs::remove_file(&text_path).await?;
  }
  let manifest = ImageTagManifest {
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: "failed".to_owned(),
    source_mime_type: candidate.mime_type.clone(),
    content_mime_type: JSON_CONTENT_MIME_TYPE.to_owned(),
    extractor: ImageTagManifestExtractor {
      image_tagging_url: image_tagging_url.to_owned(),
      tagged_at_unix_secs: unix_now_secs()?,
      duration_ms: None,
      model_id: None,
      backend: None,
    },
    error: Some(error_message.to_owned()),
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  Ok(())
}

pub(super) async fn clear_item_image_tag_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<()> {
  let manifest_path = item_text_manifest_path(data_dir, user_id, item_id)?;
  let text_path = item_text_content_path(data_dir, user_id, item_id)?;
  if path_exists(&manifest_path).await {
    fs::remove_file(&manifest_path).await?;
  }
  if path_exists(&text_path).await {
    fs::remove_file(&text_path).await?;
  }
  Ok(())
}

fn take_optional_string(map: &mut JsonMap<String, Value>, key: &str) -> Option<String> {
  map.remove(key).and_then(value_as_string)
}

fn existing_image_tag_artifact_path_bufs(
  manifest_path: &PathBuf,
  manifest_exists: bool,
  text_path: &PathBuf,
  text_exists: bool,
) -> Vec<PathBuf> {
  let mut paths = vec![];
  if text_exists {
    paths.push(text_path.clone());
  }
  if manifest_exists {
    paths.push(manifest_path.clone());
  }
  paths
}

fn take_string_list(map: &mut JsonMap<String, Value>, key: &str) -> Vec<String> {
  map.remove(key).map(value_as_string_list).unwrap_or_default()
}

fn take_f64(map: &mut JsonMap<String, Value>, key: &str) -> f64 {
  map.remove(key).and_then(value_as_f64).unwrap_or(0.0)
}

fn take_f32_list(map: &mut JsonMap<String, Value>, key: &str) -> Vec<f32> {
  map.remove(key).map(value_as_f32_list).unwrap_or_default()
}

fn value_as_string(value: Value) -> Option<String> {
  let text = match value {
    Value::Null => return None,
    Value::String(text) => text,
    other => other.to_string(),
  };
  let trimmed = text.trim();
  if trimmed.is_empty() { None } else { Some(trimmed.to_owned()) }
}

fn value_as_string_list(value: Value) -> Vec<String> {
  let mut out = Vec::new();
  let mut seen = HashSet::new();

  let raw_values = match value {
    Value::Null => return out,
    Value::Array(values) => values,
    other => vec![other],
  };

  for raw in raw_values {
    let Some(text) = value_as_string(raw) else {
      continue;
    };
    let lowered = text.to_lowercase();
    if seen.insert(lowered) {
      out.push(text);
    }
  }

  out
}

fn value_as_f64(value: Value) -> Option<f64> {
  match value {
    Value::Number(number) => number.as_f64(),
    Value::String(text) => text.trim().parse::<f64>().ok(),
    _ => None,
  }
}

fn value_as_u64(value: &Value) -> Option<u64> {
  match value {
    Value::Number(number) => number.as_u64(),
    Value::String(text) => text.trim().parse::<u64>().ok(),
    _ => None,
  }
}

fn value_as_f32_list(value: Value) -> Vec<f32> {
  let raw_values = match value {
    Value::Null => return vec![],
    Value::Array(values) => values,
    other => vec![other],
  };

  raw_values.into_iter().filter_map(value_as_f64).map(|value| value as f32).collect()
}

fn unix_now_secs() -> InfuResult<i64> {
  Ok(
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map_err(|e| format!("Could not determine current unix time: {}", e))?
      .as_secs() as i64,
  )
}
