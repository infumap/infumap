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
use log::{debug, warn};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::sync::Mutex;

use crate::ai::artifact_io::{ArtifactProcessing, atomic_write};
use crate::ai::artifact_paths::{ensure_user_text_dir, item_text_content_path, item_text_manifest_path};
use crate::ai::user_id_for_log;
use crate::storage::db::Db;
use crate::util::fs::path_exists;

use super::{
  PDF_CONVERSION_TIMEOUT_ERROR_CODE, PDF_PASSWORD_REQUIRED_ERROR_CODE, PDF_SOURCE_MIME_TYPE, PdfCandidate,
  PdfToMdResponse,
};

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
  #[serde(default, skip_serializing_if = "ArtifactProcessing::is_empty")]
  processing: ArtifactProcessing,
  schema_version: u32,
  status: String,
  source_mime_type: String,
  content_mime_type: String,
  extractor: TextManifestExtractor,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  error_code: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct TextManifestExtractor {
  extracted_at_unix_secs: i64,
  duration_ms: Option<u64>,
  #[serde(flatten)]
  extraction: TextExtractionInfo,
}

/// How pdf_extract produced the text, from its `metadata.extraction` block.
/// Manifests written before pdf_extract reported this have none of these
/// fields, so their backend is unknown.
#[derive(Default, Debug, PartialEq, Serialize, Deserialize)]
struct TextExtractionInfo {
  /// `docling` (native text) or `docling_ocr`; `marker` in manifests written
  /// before Marker was removed from pdf_extract.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  backend: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  service_version: Option<String>,
  /// Why native text was not used, when the text came from OCR (or Marker).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  fallback_reason: Option<String>,
  /// Pages of the returned text that contribute little or none of their text.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  unusable_pages: Vec<u32>,
  /// Pages of the returned text where some native text may be missing.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  warning_pages: Vec<u32>,
}

impl TextExtractionInfo {
  /// Read the block leniently: a malformed block is recorded as unknown
  /// rather than failing an otherwise successful extraction.
  fn from_response_metadata(metadata: Option<&serde_json::Value>, candidate: &PdfCandidate) -> TextExtractionInfo {
    let Some(block) = metadata.and_then(|metadata| metadata.get("extraction")) else {
      return TextExtractionInfo::default();
    };
    serde_json::from_value(block.clone()).unwrap_or_else(|error| {
      warn!(
        "Ignoring malformed extraction metadata for PDF '{}' (user {}): {}",
        candidate.item_id,
        user_id_for_log(&candidate.user_id),
        error
      );
      TextExtractionInfo::default()
    })
  }
}

pub(super) enum ManifestCheckResult {
  NeedsExtraction,
  AlreadySucceeded,
  AlreadyFailed,
  /// Not retried automatically. A reason means the item needs attention.
  AlreadyBlocked {
    attention_reason: Option<String>,
  },
}

pub enum PdfTextArtifactState {
  Succeeded,
  Failed,
  Blocked,
  Pending,
}

pub async fn pdf_text_artifact_state(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PdfTextArtifactState> {
  let manifest_path = item_text_manifest_path(data_dir, user_id, item_id)?;
  let text_path = item_text_content_path(data_dir, user_id, item_id)?;

  if !path_exists(&manifest_path).await {
    return Ok(PdfTextArtifactState::Pending);
  }
  let manifest_bytes = fs::read(&manifest_path).await?;
  let manifest: TextManifest = match serde_json::from_slice(&manifest_bytes) {
    Ok(manifest) => manifest,
    Err(_) => return Ok(PdfTextArtifactState::Pending),
  };

  if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
    return Ok(PdfTextArtifactState::Pending);
  }

  if manifest.status == "succeeded" {
    if path_exists(&text_path).await {
      return Ok(PdfTextArtifactState::Succeeded);
    }
    return Ok(PdfTextArtifactState::Pending);
  }

  if manifest_is_blocked(&manifest) {
    return Ok(PdfTextArtifactState::Blocked);
  }

  if manifest.status == "failed" {
    return Ok(PdfTextArtifactState::Failed);
  }

  Ok(PdfTextArtifactState::Pending)
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
    if manifest.status != "failed" || manifest_is_blocked(&manifest) {
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

  if manifest_is_blocked(&manifest) {
    return Ok(ManifestCheckResult::AlreadyBlocked { attention_reason: blocked_attention_reason(&manifest) });
  }

  if manifest.status == "failed" {
    return Ok(ManifestCheckResult::AlreadyFailed);
  }

  Ok(ManifestCheckResult::NeedsExtraction)
}

/// Returns the backend that produced the text, when pdf_extract reported one.
pub(super) async fn write_success_artifacts(
  data_dir: &str,
  candidate: &PdfCandidate,
  response: PdfToMdResponse,
) -> InfuResult<Option<String>> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let text_path = item_text_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = item_text_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  atomic_write(&text_path, response.markdown.as_bytes()).await?;
  let extraction = TextExtractionInfo::from_response_metadata(response.metadata.as_ref(), candidate);
  let backend = extraction.backend.clone();
  let manifest = TextManifest {
    processing: ArtifactProcessing::default(),
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: "succeeded".to_owned(),
    source_mime_type: PDF_SOURCE_MIME_TYPE.to_owned(),
    content_mime_type: MARKDOWN_CONTENT_MIME_TYPE.to_owned(),
    extractor: TextManifestExtractor {
      extracted_at_unix_secs: unix_now_secs()?,
      duration_ms: Some(response.duration_ms),
      extraction,
    },
    error_code: None,
    error: None,
  };
  atomic_write(&manifest_path, &serde_json::to_vec_pretty(&manifest)?).await?;
  Ok(backend)
}

pub(super) async fn write_failed_manifest(
  data_dir: &str,
  candidate: &PdfCandidate,
  error_message: &str,
) -> InfuResult<()> {
  write_terminal_manifest(data_dir, candidate, "failed", None, error_message).await
}

pub(super) async fn write_blocked_manifest(
  data_dir: &str,
  candidate: &PdfCandidate,
  error_code: &str,
  error_message: &str,
) -> InfuResult<()> {
  write_terminal_manifest(data_dir, candidate, "blocked", Some(error_code), error_message).await
}

async fn write_terminal_manifest(
  data_dir: &str,
  candidate: &PdfCandidate,
  status: &str,
  error_code: Option<&str>,
  error_message: &str,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let text_path = item_text_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = item_text_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  if path_exists(&text_path).await {
    fs::remove_file(&text_path).await?;
  }
  let manifest = TextManifest {
    processing: ArtifactProcessing::failed()?,
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: status.to_owned(),
    source_mime_type: PDF_SOURCE_MIME_TYPE.to_owned(),
    content_mime_type: MARKDOWN_CONTENT_MIME_TYPE.to_owned(),
    extractor: TextManifestExtractor {
      extracted_at_unix_secs: unix_now_secs()?,
      duration_ms: None,
      extraction: TextExtractionInfo::default(),
    },
    error_code: error_code.map(str::to_owned),
    error: Some(error_message.to_owned()),
  };
  atomic_write(&manifest_path, &serde_json::to_vec_pretty(&manifest)?).await?;
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

/// Blocked extraction is not retried automatically. Manifests written before an
/// error was classified as blocking were recorded as failed, so they are
/// recognised by their error text.
fn manifest_is_blocked(manifest: &TextManifest) -> bool {
  manifest.status == "blocked"
    || manifest_has_password_required_error(manifest)
    || manifest_has_conversion_timeout_error(manifest)
}

/// Password protected PDFs are expected and are not reported. Other blocked
/// PDFs need attention.
fn blocked_attention_reason(manifest: &TextManifest) -> Option<String> {
  if manifest_has_password_required_error(manifest) {
    return None;
  }
  Some(manifest.error.clone().unwrap_or_else(|| "PDF text extraction was stopped.".to_owned()))
}

fn manifest_has_conversion_timeout_error(manifest: &TextManifest) -> bool {
  manifest.error_code.as_deref() == Some(PDF_CONVERSION_TIMEOUT_ERROR_CODE)
    || manifest.error.as_deref().map(error_text_is_conversion_timeout).unwrap_or(false)
}

/// Matches the messages pdf_extract returns with `pdf_conversion_timeout`.
fn error_text_is_conversion_timeout(error: &str) -> bool {
  let normalized = error.to_ascii_lowercase();
  normalized.contains(PDF_CONVERSION_TIMEOUT_ERROR_CODE)
    || normalized.contains("pdf conversion exceeded the")
    || normalized.contains("pdf conversion deadline expired")
}

fn manifest_has_password_required_error(manifest: &TextManifest) -> bool {
  manifest.error_code.as_deref() == Some(PDF_PASSWORD_REQUIRED_ERROR_CODE)
    || manifest.error.as_deref().map(error_text_is_password_required).unwrap_or(false)
}

fn error_text_is_password_required(error: &str) -> bool {
  let normalized = error.to_ascii_lowercase();
  normalized.contains(PDF_PASSWORD_REQUIRED_ERROR_CODE)
    || (normalized.contains("password")
      && (normalized.contains("required")
        || normalized.contains("protected")
        || normalized.contains("encrypted")
        || normalized.contains("incorrect")
        || normalized.contains("password error")))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn candidate() -> PdfCandidate {
    PdfCandidate {
      user_id: "user".to_owned(),
      item_id: "item".to_owned(),
      file_size_bytes: None,
      creation_date: 0,
      last_modified_date: 0,
      conversion_timeout_secs: None,
    }
  }

  #[test]
  fn manifest_without_extraction_fields_reads_as_unknown() {
    let manifest: TextManifest = serde_json::from_value(serde_json::json!({
      "schema_version": 1,
      "status": "succeeded",
      "source_mime_type": "application/pdf",
      "content_mime_type": "text/markdown",
      "extractor": { "extracted_at_unix_secs": 1, "duration_ms": 5 },
      "error": null
    }))
    .unwrap();
    assert_eq!(manifest.extractor.extraction, TextExtractionInfo::default());
  }

  #[test]
  fn extraction_metadata_is_stored_in_extractor_section() {
    let metadata = serde_json::json!({
      "backend": "docling",
      "extraction": {
        "backend": "docling",
        "service_version": "0.2.0",
        "fallback_reason": null,
        "unusable_pages": [1],
        "warning_pages": [],
        "added_later": true
      }
    });
    let extraction = TextExtractionInfo::from_response_metadata(Some(&metadata), &candidate());
    let extractor = TextManifestExtractor { extracted_at_unix_secs: 1, duration_ms: Some(5), extraction };
    assert_eq!(
      serde_json::to_value(&extractor).unwrap(),
      serde_json::json!({
        "extracted_at_unix_secs": 1,
        "duration_ms": 5,
        "backend": "docling",
        "service_version": "0.2.0",
        "unusable_pages": [1]
      })
    );
  }

  #[test]
  fn processing_block_is_written_only_with_a_retry_hint() {
    let manifest = |processing| TextManifest {
      processing,
      schema_version: MANIFEST_SCHEMA_VERSION,
      status: "succeeded".to_owned(),
      source_mime_type: PDF_SOURCE_MIME_TYPE.to_owned(),
      content_mime_type: MARKDOWN_CONTENT_MIME_TYPE.to_owned(),
      extractor: TextManifestExtractor {
        extracted_at_unix_secs: 1,
        duration_ms: None,
        extraction: TextExtractionInfo::default(),
      },
      error_code: None,
      error: None,
    };
    let succeeded = serde_json::to_value(manifest(ArtifactProcessing::default())).unwrap();
    assert!(succeeded.get("processing").is_none());
    assert!(succeeded.get("error").is_none());
    let failed = serde_json::to_value(manifest(ArtifactProcessing { retry_at_unix_secs: Some(9) })).unwrap();
    assert_eq!(failed["processing"], serde_json::json!({ "retry_at_unix_secs": 9 }));
  }

  #[test]
  fn conversion_timeouts_are_blocked_and_need_attention() {
    let manifest = |status: &str, error_code: Option<&str>, error: &str| TextManifest {
      processing: ArtifactProcessing::default(),
      schema_version: MANIFEST_SCHEMA_VERSION,
      status: status.to_owned(),
      source_mime_type: PDF_SOURCE_MIME_TYPE.to_owned(),
      content_mime_type: MARKDOWN_CONTENT_MIME_TYPE.to_owned(),
      extractor: TextManifestExtractor {
        extracted_at_unix_secs: 1,
        duration_ms: None,
        extraction: TextExtractionInfo::default(),
      },
      error_code: error_code.map(str::to_owned),
      error: Some(error.to_owned()),
    };
    let timeout = manifest("blocked", Some(PDF_CONVERSION_TIMEOUT_ERROR_CODE), "PDF conversion exceeded the limit.");
    assert!(manifest_is_blocked(&timeout));
    assert_eq!(blocked_attention_reason(&timeout).as_deref(), Some("PDF conversion exceeded the limit."));

    let legacy_timeout = manifest(
      "failed",
      None,
      "HTTP 422 Unprocessable Entity: PDF conversion exceeded the 3600 second timeout. The PDF may be too large.",
    );
    assert!(manifest_is_blocked(&legacy_timeout));
    assert!(blocked_attention_reason(&legacy_timeout).is_some());

    let password = manifest("blocked", Some(PDF_PASSWORD_REQUIRED_ERROR_CODE), "Password required.");
    assert!(manifest_is_blocked(&password));
    assert!(blocked_attention_reason(&password).is_none());

    assert!(!manifest_is_blocked(&manifest("failed", None, "HTTP 422 Unprocessable Entity: corrupt PDF.")));
  }

  #[test]
  fn malformed_extraction_metadata_is_ignored() {
    let metadata = serde_json::json!({ "extraction": { "backend": 7, "unusable_pages": null } });
    assert_eq!(
      TextExtractionInfo::from_response_metadata(Some(&metadata), &candidate()),
      TextExtractionInfo::default()
    );
    assert_eq!(TextExtractionInfo::from_response_metadata(None, &candidate()), TextExtractionInfo::default());
  }
}
