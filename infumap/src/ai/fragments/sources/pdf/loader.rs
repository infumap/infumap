use std::io::ErrorKind;

use infusdk::util::infu::InfuResult;
use serde::Deserialize;
use tokio::fs;

use crate::ai::artifact_paths::{item_text_content_path, item_text_manifest_path};

use super::super::read_json_if_exists;

const MARKDOWN_CONTENT_MIME_TYPE: &str = "text/markdown";

pub(super) async fn load_pdf_markdown_artifact(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Option<String>> {
  let Some(manifest) = load_pdf_text_manifest(data_dir, user_id, item_id).await? else {
    return Ok(None);
  };
  if manifest.status != "succeeded" || manifest.content_mime_type != MARKDOWN_CONTENT_MIME_TYPE {
    return Ok(None);
  }

  let path = item_text_content_path(data_dir, user_id, item_id)?;
  let text = match fs::read_to_string(&path).await {
    Ok(text) => text,
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(format!("Could not read extracted PDF markdown '{}': {}", path.display(), error).into()),
  };

  Ok(normalize_markdown_source(&text))
}

async fn load_pdf_text_manifest(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Option<StoredPdfTextManifest>> {
  let path = item_text_manifest_path(data_dir, user_id, item_id)?;
  read_json_if_exists(&path, "pdf text manifest").await
}

fn normalize_markdown_source(text: &str) -> Option<String> {
  let normalized = text.replace("\r\n", "\n").replace('\r', "\n").trim().to_owned();
  if normalized.is_empty() { None } else { Some(normalized) }
}

#[derive(Default, Deserialize)]
struct StoredPdfTextManifest {
  status: String,
  content_mime_type: String,
}
