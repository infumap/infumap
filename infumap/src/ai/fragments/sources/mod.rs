use std::io::ErrorKind;
use std::path::PathBuf;

use infusdk::util::infu::InfuResult;
use serde::de::DeserializeOwned;
use tokio::fs;

use super::{FragmentInput, FragmentSource, FragmentSourceKind};

mod content;
mod context;
mod image;
mod pdf;

pub use content::content_fragment_source_for_item;
pub use context::embedding_context_title_for_item;
pub use image::image_fragment_source_for_item;
pub use pdf::pdf_fragment_source_for_item;

fn single_fragment_source(source_kind: FragmentSourceKind, text: String) -> FragmentSource {
  FragmentSource { source_kind, fragments: vec![FragmentInput::new(text)] }
}

fn build_titled_fragment_text(source_text: String, container_title: Option<String>) -> String {
  let source_text = source_text.trim();
  let container_title = container_title.map(|title| title.trim().to_owned()).filter(|title| !title.is_empty());

  match container_title.as_deref() {
    Some(container_title) if source_text.is_empty() => format!("## {}", container_title),
    Some(container_title) => format!("## {}\n\n{}", container_title, source_text),
    None => source_text.to_owned(),
  }
}

async fn read_json_if_exists<T: DeserializeOwned>(path: &PathBuf, artifact_label: &str) -> InfuResult<Option<T>> {
  let bytes = match fs::read(path).await {
    Ok(bytes) => bytes,
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(format!("Could not read {} '{}': {}", artifact_label, path.display(), error).into()),
  };

  serde_json::from_slice(&bytes)
    .map(Some)
    .map_err(|error| format!("Could not parse {} '{}': {}", artifact_label, path.display(), error).into())
}

fn labeled_sentence(label: &str, value: &str) -> String {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return String::new();
  }
  match trimmed.chars().last() {
    Some('.' | '!' | '?') => format!("{label}: {trimmed}"),
    _ => format!("{label}: {trimmed}."),
  }
}

fn labeled_line(label: &str, value: &str) -> String {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return String::new();
  }
  format!("{label}: {trimmed}")
}

fn normalized_text(value: Option<&str>) -> Option<String> {
  let value = value?;
  let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
  if collapsed.is_empty() { None } else { Some(collapsed) }
}
