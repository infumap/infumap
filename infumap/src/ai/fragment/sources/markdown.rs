use std::sync::Arc;

use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::debug;

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
  let Some(text) = normalize_plain_text_source(&file_bytes, &item.id) else {
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
  Ok(normalize_text_source(text))
}

fn normalize_plain_text_source(bytes: &[u8], item_id: &str) -> Option<String> {
  let decoded = decode_plain_text_bytes(bytes);
  if decoded.encoding != "utf-8" {
    debug!("Decoded text file '{}' as {} for fragmenting.", item_id, decoded.encoding);
  }
  normalize_text_source(&decoded.text)
}

fn normalize_text_source(text: &str) -> Option<String> {
  let normalized = text.replace("\r\n", "\n").replace('\r', "\n").replace('\0', "").trim().to_owned();
  if normalized.is_empty() { None } else { Some(normalized) }
}

fn decode_plain_text_bytes(bytes: &[u8]) -> DecodedText {
  if let Some(text) = decode_utf8_bytes(bytes) {
    return DecodedText { text, encoding: "utf-8" };
  }
  if let Some(text) = decode_utf16_bom(bytes) {
    return text;
  }
  if looks_like_utf16(bytes) {
    return decode_utf16_without_bom(bytes);
  }
  DecodedText { text: decode_windows_1252(bytes), encoding: "windows-1252" }
}

fn decode_utf8_bytes(bytes: &[u8]) -> Option<String> {
  let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
  std::str::from_utf8(bytes).ok().map(str::to_owned)
}

fn decode_utf16_bom(bytes: &[u8]) -> Option<DecodedText> {
  if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
    return Some(DecodedText { text: decode_utf16_units(rest, true), encoding: "utf-16le" });
  }
  if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
    return Some(DecodedText { text: decode_utf16_units(rest, false), encoding: "utf-16be" });
  }
  None
}

fn looks_like_utf16(bytes: &[u8]) -> bool {
  if bytes.len() < 4 {
    return false;
  }
  let sample_len = bytes.len().min(4096);
  let sample = &bytes[..sample_len];
  let even_nuls = sample.iter().step_by(2).filter(|&&byte| byte == 0).count();
  let odd_nuls = sample.iter().skip(1).step_by(2).filter(|&&byte| byte == 0).count();
  let pairs = sample_len / 2;
  pairs > 0 && (even_nuls * 100 / pairs >= 30 || odd_nuls * 100 / pairs >= 30)
}

fn decode_utf16_without_bom(bytes: &[u8]) -> DecodedText {
  let sample_len = bytes.len().min(4096);
  let sample = &bytes[..sample_len];
  let even_nuls = sample.iter().step_by(2).filter(|&&byte| byte == 0).count();
  let odd_nuls = sample.iter().skip(1).step_by(2).filter(|&&byte| byte == 0).count();
  if odd_nuls >= even_nuls {
    DecodedText { text: decode_utf16_units(bytes, true), encoding: "utf-16le" }
  } else {
    DecodedText { text: decode_utf16_units(bytes, false), encoding: "utf-16be" }
  }
}

fn decode_utf16_units(bytes: &[u8], little_endian: bool) -> String {
  let units = bytes.chunks_exact(2).map(|chunk| {
    if little_endian { u16::from_le_bytes([chunk[0], chunk[1]]) } else { u16::from_be_bytes([chunk[0], chunk[1]]) }
  });
  std::char::decode_utf16(units).map(|result| result.unwrap_or(char::REPLACEMENT_CHARACTER)).collect()
}

fn decode_windows_1252(bytes: &[u8]) -> String {
  bytes
    .iter()
    .map(|&byte| match byte {
      0x80 => '\u{20ac}',
      0x82 => '\u{201a}',
      0x83 => '\u{0192}',
      0x84 => '\u{201e}',
      0x85 => '\u{2026}',
      0x86 => '\u{2020}',
      0x87 => '\u{2021}',
      0x88 => '\u{02c6}',
      0x89 => '\u{2030}',
      0x8a => '\u{0160}',
      0x8b => '\u{2039}',
      0x8c => '\u{0152}',
      0x8e => '\u{017d}',
      0x91 => '\u{2018}',
      0x92 => '\u{2019}',
      0x93 => '\u{201c}',
      0x94 => '\u{201d}',
      0x95 => '\u{2022}',
      0x96 => '\u{2013}',
      0x97 => '\u{2014}',
      0x98 => '\u{02dc}',
      0x99 => '\u{2122}',
      0x9a => '\u{0161}',
      0x9b => '\u{203a}',
      0x9c => '\u{0153}',
      0x9e => '\u{017e}',
      0x9f => '\u{0178}',
      0x81 | 0x8d | 0x8f | 0x90 | 0x9d => char::REPLACEMENT_CHARACTER,
      _ => char::from(byte),
    })
    .collect()
}

struct DecodedText {
  text: String,
  encoding: &'static str,
}
