use std::sync::Arc;
use std::time::Duration;

use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::{debug, warn};
use reqwest::multipart::{Form, Part};
use serde::Deserialize;

use crate::ai::user_id_for_log;
use crate::storage::object::{self as storage_object, ObjectStore};

use super::super::{FragmentBuildOutcome, FragmentInput};
use super::{FragmentSource, FragmentSourceKind, write_fragment_source_artifact};

mod blocks;
mod chunking;
mod loader;
mod pages;
mod rendering;
mod splitting;
mod types;

use chunking::build_pdf_fragment_inputs;
use loader::load_pdf_markdown_artifact;

pub(super) const PDF_FRAGMENT_MIN_CHARS: usize = 500;
pub(super) const PDF_FRAGMENT_SOFT_LIMIT_CHARS: usize = 1400;
pub(super) const PDF_FRAGMENT_HARD_LIMIT_CHARS: usize = 1900;
pub(super) const PDF_FRAGMENT_SOFT_LIMIT_TOKENS: usize = 380;
pub(super) const PDF_FRAGMENT_HARD_LIMIT_TOKENS: usize = 440;
pub(super) const PDF_PAGE_BREAK_MIN_DASH_COUNT: usize = 8;
const PDF_CAPTION_REQUEST_TIMEOUT_SECS: u64 = 30 * 60;
const PDF_SOURCE_MIME_TYPE: &str = "application/pdf";

pub struct PdfFragmentBuildResult {
  pub outcome: FragmentBuildOutcome,
}

#[derive(Deserialize)]
struct PdfCaptionResponse {
  detailed_caption: Option<String>,
}

pub async fn pdf_fragment_source_for_item(data_dir: &str, item: &Item) -> InfuResult<Option<FragmentSource>> {
  let Some(markdown) = load_pdf_markdown_artifact(data_dir, &item.owner_id, &item.id).await? else {
    return Ok(None);
  };

  Ok(markdown_fragment_source(FragmentSourceKind::PdfMarkdown, &markdown))
}

pub async fn build_pdf_fragment_artifact(
  data_dir: &str,
  object_store: Arc<ObjectStore>,
  item: &Item,
  object_encryption_key: Option<&str>,
  pdf_caption_url: Option<&str>,
) -> InfuResult<PdfFragmentBuildResult> {
  let fragment_source = match pdf_fragment_source_for_item(data_dir, item).await? {
    Some(fragment_source) => Some(fragment_source),
    None => {
      pdf_first_page_caption_fragment_source_for_item(object_store, item, object_encryption_key, pdf_caption_url)
        .await?
    }
  };
  let outcome = write_fragment_source_artifact(data_dir, item, fragment_source).await?;
  Ok(PdfFragmentBuildResult { outcome })
}

pub(super) fn markdown_fragment_source(source_kind: FragmentSourceKind, markdown: &str) -> Option<FragmentSource> {
  let fragments = build_pdf_fragment_inputs(markdown);
  if fragments.is_empty() {
    return None;
  }

  Some(FragmentSource { source_kind, fragments })
}

async fn pdf_first_page_caption_fragment_source_for_item(
  object_store: Arc<ObjectStore>,
  item: &Item,
  object_encryption_key: Option<&str>,
  pdf_caption_url: Option<&str>,
) -> InfuResult<Option<FragmentSource>> {
  let Some(pdf_caption_url) = pdf_caption_url else {
    return Ok(None);
  };
  let Some(object_encryption_key) = object_encryption_key else {
    warn!(
      "PDF '{}' (user {}) had no markdown fragments, but no object encryption key was available for first-page caption fallback.",
      item.id,
      user_id_for_log(&item.owner_id)
    );
    return Ok(None);
  };

  let file_bytes =
    match storage_object::get(object_store, item.owner_id.clone(), item.id.clone(), object_encryption_key).await {
      Ok(bytes) => bytes,
      Err(e) => {
        warn!(
          "Could not read source PDF object for first-page caption fallback for '{}' (user {}): {}",
          item.id,
          user_id_for_log(&item.owner_id),
          e
        );
        return Ok(None);
      }
    };

  debug!(
    "Sending PDF '{}' (user {}) to first-page caption fallback endpoint '{}' ({} bytes).",
    item.id,
    user_id_for_log(&item.owner_id),
    pdf_caption_url,
    file_bytes.len()
  );

  match request_pdf_first_page_caption(pdf_caption_url, file_bytes).await {
    Ok(Some(caption)) => {
      debug!(
        "Built first-page caption fallback fragment for PDF '{}' (user {}).",
        item.id,
        user_id_for_log(&item.owner_id)
      );
      Ok(pdf_first_page_caption_fragment_source(&caption))
    }
    Ok(None) => {
      warn!(
        "PDF first-page caption fallback returned no caption for '{}' (user {}).",
        item.id,
        user_id_for_log(&item.owner_id)
      );
      Ok(None)
    }
    Err(e) => {
      warn!(
        "PDF first-page caption fallback failed for '{}' (user {}) using '{}': {}",
        item.id,
        user_id_for_log(&item.owner_id),
        pdf_caption_url,
        e
      );
      Ok(None)
    }
  }
}

async fn request_pdf_first_page_caption(pdf_caption_url: &str, file_bytes: Vec<u8>) -> Result<Option<String>, String> {
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(PDF_CAPTION_REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build HTTP client: {}", e))?;
  let part = Part::bytes(file_bytes)
    .mime_str(PDF_SOURCE_MIME_TYPE)
    .map_err(|e| format!("Could not build multipart upload: {}", e))?;
  let form = Form::new().part("file", part);

  let response =
    client.post(pdf_caption_url).multipart(form).send().await.map_err(|e| format!("Request failed: {}", e))?;
  let status = response.status();
  let body = response.text().await.map_err(|e| format!("Could not read response body: {}", e))?;
  if !status.is_success() {
    return Err(format!("HTTP {}: {}", status, body));
  }

  let parsed: PdfCaptionResponse =
    serde_json::from_str(&body).map_err(|e| format!("Could not parse success response: {}", e))?;
  Ok(normalized_caption(parsed.detailed_caption.as_deref()))
}

fn pdf_first_page_caption_fragment_source(caption: &str) -> Option<FragmentSource> {
  let caption = normalized_caption(Some(caption))?;
  let text = format!("First-page visual summary: {}", caption);
  Some(FragmentSource {
    source_kind: FragmentSourceKind::PdfFirstPageCaption,
    fragments: vec![FragmentInput::new(text).with_page_range(Some(1), Some(1))],
  })
}

fn normalized_caption(value: Option<&str>) -> Option<String> {
  let value = value?;
  let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
  if normalized.is_empty() { None } else { Some(normalized) }
}
