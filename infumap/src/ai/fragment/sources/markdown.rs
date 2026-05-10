use std::sync::Arc;

use infusdk::item::Item;
use infusdk::util::infu::InfuResult;

use crate::storage::object::{self as storage_object, ObjectStore};

use super::pdf::markdown_fragment_source;
use super::{FragmentSource, FragmentSourceKind};

pub async fn markdown_fragment_source_for_item(
  object_store: Arc<ObjectStore>,
  item: &Item,
  object_encryption_key: &str,
  context_title: Option<String>,
) -> InfuResult<Option<FragmentSource>> {
  let file_bytes = storage_object::get(object_store, item.owner_id.clone(), item.id.clone(), object_encryption_key)
    .await
    .map_err(|e| format!("Could not read source markdown object for '{}': {}", item.id, e))?;
  let Some(markdown) = normalize_utf8_text_source(&file_bytes, &item.id, "Markdown file")? else {
    return Ok(None);
  };

  Ok(markdown_fragment_source(FragmentSourceKind::Markdown, item.title.as_deref(), context_title.as_deref(), &markdown))
}

pub async fn text_fragment_source_for_item(
  object_store: Arc<ObjectStore>,
  item: &Item,
  object_encryption_key: &str,
  context_title: Option<String>,
) -> InfuResult<Option<FragmentSource>> {
  let file_bytes = storage_object::get(object_store, item.owner_id.clone(), item.id.clone(), object_encryption_key)
    .await
    .map_err(|e| format!("Could not read source text object for '{}': {}", item.id, e))?;
  let Some(text) = normalize_utf8_text_source(&file_bytes, &item.id, "Text file")? else {
    return Ok(None);
  };

  Ok(markdown_fragment_source(FragmentSourceKind::Text, item.title.as_deref(), context_title.as_deref(), &text))
}

fn normalize_utf8_text_source(bytes: &[u8], item_id: &str, source_label: &str) -> InfuResult<Option<String>> {
  let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
  let text =
    std::str::from_utf8(bytes).map_err(|e| format!("{} '{}' is not valid UTF-8: {}", source_label, item_id, e))?;
  let normalized = text.replace("\r\n", "\n").replace('\r', "\n").trim().to_owned();
  if normalized.is_empty() { Ok(None) } else { Ok(Some(normalized)) }
}
