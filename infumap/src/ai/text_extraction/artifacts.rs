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
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::sync::Mutex;

use crate::ai::artifact_paths::{ensure_user_text_dir, item_text_content_path, item_text_manifest_path};
use crate::ai::user_id_for_log;
use crate::storage::db::Db;
use crate::util::fs::path_exists;

use super::{PDF_SOURCE_MIME_TYPE, PdfCandidate, PdfToMdResponse};

const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MARKDOWN_CONTENT_MIME_TYPE: &str = "text/markdown";

#[derive(Clone)]
pub struct FailedPdfInfo {
  pub user_id: String,
  pub item_id: String,
  pub file_name: String,
  pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct TextManifest {
  schema_version: u32,
  status: String,
  source_mime_type: String,
  content_mime_type: String,
  extractor: TextManifestExtractor,
  error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct TextManifestExtractor {
  text_extraction_url: String,
  extracted_at_unix_secs: i64,
  duration_ms: Option<u64>,
}

pub(super) enum ManifestCheckResult {
  NeedsExtraction,
  AlreadySucceeded,
  AlreadyFailed,
}

pub async fn list_failed_pdfs(data_dir: &str, db: Arc<Mutex<Db>>) -> InfuResult<Vec<FailedPdfInfo>> {
  let mut out = vec![];
  let pdf_items: Vec<(String, String, String)> = {
    let db = db.lock().await;
    db.item
      .all_loaded_items()
      .into_iter()
      .filter_map(|iu| db.item.get(&iu.item_id).ok().map(|item| (iu.user_id.clone(), item)))
      .filter(|(_, item)| item.mime_type.as_deref() == Some(PDF_SOURCE_MIME_TYPE))
      .map(|(user_id, item)| {
        (user_id, item.id.clone(), item.title.clone().unwrap_or_else(|| format!("{}.pdf", item.id)))
      })
      .collect()
  };
  for (user_id, item_id, file_name) in pdf_items {
    let path = match item_text_manifest_path(data_dir, &user_id, &item_id) {
      Ok(p) => p,
      Err(e) => {
        debug!(
          "Skipping failed PDF listing for item '{}' (user '{}'): could not build manifest path: {}",
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
      Ok(b) => b,
      Err(e) => {
        debug!(
          "Skipping failed PDF listing for item '{}' (user '{}'): could not read manifest '{}': {}",
          item_id,
          user_id_for_log(&user_id),
          path.display(),
          e
        );
        continue;
      }
    };
    let manifest: TextManifest = match serde_json::from_slice(&bytes) {
      Ok(m) => m,
      Err(e) => {
        debug!(
          "Skipping failed PDF listing for item '{}' (user '{}'): could not parse manifest '{}': {}",
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
    out.push(FailedPdfInfo { user_id, item_id, file_name, error: manifest.error });
  }
  Ok(out)
}

pub async fn item_needs_text_extraction(data_dir: &str, db: Arc<Mutex<Db>>, item_id: &str) -> InfuResult<bool> {
  let candidate = {
    let db = db.lock().await;
    let id = item_id.to_string();
    let item = db.item.get(&id).map_err(|e| e.to_string())?;
    if item.mime_type.as_deref() != Some(PDF_SOURCE_MIME_TYPE) {
      return Err(format!("Item '{}' is not a PDF (mime_type: {:?}).", item_id, item.mime_type).into());
    }
    PdfCandidate::from_item(item)
  };
  Ok(matches!(manifest_check(data_dir, &candidate).await?, ManifestCheckResult::NeedsExtraction))
}

pub async fn delete_item_text_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<()> {
  clear_item_text_dir(data_dir, user_id, item_id).await
}

pub(super) async fn manifest_check(data_dir: &str, candidate: &PdfCandidate) -> InfuResult<ManifestCheckResult> {
  let manifest_path = item_text_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let text_path = item_text_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;

  if !path_exists(&manifest_path).await {
    return Ok(ManifestCheckResult::NeedsExtraction);
  }
  let manifest_bytes = fs::read(&manifest_path).await?;
  let manifest: TextManifest = match serde_json::from_slice(&manifest_bytes) {
    Ok(manifest) => manifest,
    Err(_) => return Ok(ManifestCheckResult::NeedsExtraction),
  };

  if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
    return Ok(ManifestCheckResult::NeedsExtraction);
  }

  if manifest.status == "succeeded" {
    if path_exists(&text_path).await {
      return Ok(ManifestCheckResult::AlreadySucceeded);
    }
    return Ok(ManifestCheckResult::NeedsExtraction);
  }

  if manifest.status == "failed" {
    return Ok(ManifestCheckResult::AlreadyFailed);
  }

  Ok(ManifestCheckResult::NeedsExtraction)
}

pub(super) async fn write_success_artifacts(
  data_dir: &str,
  text_extraction_url: &str,
  candidate: &PdfCandidate,
  response: PdfToMdResponse,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let text_path = item_text_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = item_text_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  fs::write(&text_path, response.markdown.as_bytes()).await?;
  let manifest = TextManifest {
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: "succeeded".to_owned(),
    source_mime_type: PDF_SOURCE_MIME_TYPE.to_owned(),
    content_mime_type: MARKDOWN_CONTENT_MIME_TYPE.to_owned(),
    extractor: TextManifestExtractor {
      text_extraction_url: text_extraction_url.to_owned(),
      extracted_at_unix_secs: unix_now_secs()?,
      duration_ms: Some(response.duration_ms),
    },
    error: None,
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  Ok(())
}

pub(super) async fn write_failed_manifest(
  data_dir: &str,
  text_extraction_url: &str,
  candidate: &PdfCandidate,
  error_message: &str,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let text_path = item_text_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = item_text_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  if path_exists(&text_path).await {
    fs::remove_file(&text_path).await?;
  }
  let manifest = TextManifest {
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: "failed".to_owned(),
    source_mime_type: PDF_SOURCE_MIME_TYPE.to_owned(),
    content_mime_type: MARKDOWN_CONTENT_MIME_TYPE.to_owned(),
    extractor: TextManifestExtractor {
      text_extraction_url: text_extraction_url.to_owned(),
      extracted_at_unix_secs: unix_now_secs()?,
      duration_ms: None,
    },
    error: Some(error_message.to_owned()),
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  Ok(())
}

pub(super) async fn clear_item_text_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<()> {
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

fn unix_now_secs() -> InfuResult<i64> {
  Ok(
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map_err(|e| format!("Could not determine current unix time: {}", e))?
      .as_secs() as i64,
  )
}
