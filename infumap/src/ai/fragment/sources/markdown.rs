use std::sync::Arc;

use infusdk::item::Item;
use infusdk::util::infu::InfuResult;

use crate::storage::object::{self as storage_object, ObjectStore};

use super::pdf::markdown_fragment_source;
use super::{FragmentSource, FragmentSourceKind, write_fragment_source_artifact};
use crate::ai::fragment::FragmentBuildOutcome;

pub struct ObjectTextFragmentBuildResult {
  pub had_fragment_source: bool,
  pub outcome: FragmentBuildOutcome,
}

pub async fn markdown_fragment_source_for_item(
  object_store: Arc<ObjectStore>,
  item: &Item,
  object_encryption_key: &str,
) -> InfuResult<Option<FragmentSource>> {
  let file_bytes = storage_object::get(object_store, item.owner_id.clone(), item.id.clone(), object_encryption_key)
    .await
    .map_err(|e| format!("Could not read source markdown object for '{}': {}", item.id, e))?;
  let Some(markdown) = normalize_utf8_text_source(&file_bytes, &item.id, "Markdown file")? else {
    return Ok(None);
  };

  Ok(markdown_fragment_source(FragmentSourceKind::Markdown, &markdown))
}

pub async fn text_fragment_source_for_item(
  object_store: Arc<ObjectStore>,
  item: &Item,
  object_encryption_key: &str,
) -> InfuResult<Option<FragmentSource>> {
  let file_bytes = storage_object::get(object_store, item.owner_id.clone(), item.id.clone(), object_encryption_key)
    .await
    .map_err(|e| format!("Could not read source text object for '{}': {}", item.id, e))?;
  let Some(text) = normalize_utf8_text_source(&file_bytes, &item.id, "Text file")? else {
    return Ok(None);
  };

  Ok(markdown_fragment_source(FragmentSourceKind::Text, &text))
}

pub async fn build_markdown_fragment_artifact(
  data_dir: &str,
  object_store: Arc<ObjectStore>,
  item: &Item,
  object_encryption_key: &str,
) -> InfuResult<ObjectTextFragmentBuildResult> {
  let fragment_source = markdown_fragment_source_for_item(object_store, item, object_encryption_key).await?;
  let had_fragment_source = fragment_source.is_some();
  let outcome = write_fragment_source_artifact(data_dir, item, fragment_source).await?;
  Ok(ObjectTextFragmentBuildResult { had_fragment_source, outcome })
}

pub async fn build_text_fragment_artifact(
  data_dir: &str,
  object_store: Arc<ObjectStore>,
  item: &Item,
  object_encryption_key: &str,
) -> InfuResult<ObjectTextFragmentBuildResult> {
  let fragment_source = text_fragment_source_for_item(object_store, item, object_encryption_key).await?;
  let had_fragment_source = fragment_source.is_some();
  let outcome = write_fragment_source_artifact(data_dir, item, fragment_source).await?;
  Ok(ObjectTextFragmentBuildResult { had_fragment_source, outcome })
}

fn normalize_utf8_text_source(bytes: &[u8], item_id: &str, source_label: &str) -> InfuResult<Option<String>> {
  let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
  let text =
    std::str::from_utf8(bytes).map_err(|e| format!("{} '{}' is not valid UTF-8: {}", source_label, item_id, e))?;
  let normalized = text.replace("\r\n", "\n").replace('\r', "\n").trim().to_owned();
  if normalized.is_empty() { Ok(None) } else { Ok(Some(normalized)) }
}
