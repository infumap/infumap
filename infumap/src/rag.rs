use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::fs;

use crate::util::fs::{ensure_256_subdirs, expand_tilde, path_exists};

const FRAGMENTS_SCHEMA_VERSION: u32 = 1;
const FRAGMENTER_VERSION: u32 = 10;

#[derive(Clone, Copy)]
pub enum FragmentSourceKind {
  PageContents,
  TableContents,
  ImageContents,
  PdfMarkdown,
}

impl FragmentSourceKind {
  fn as_str(&self) -> &'static str {
    match self {
      FragmentSourceKind::PageContents => "page_contents",
      FragmentSourceKind::TableContents => "table_contents",
      FragmentSourceKind::ImageContents => "image_contents",
      FragmentSourceKind::PdfMarkdown => "pdf_markdown",
    }
  }
}

#[allow(dead_code)]
fn make_fragment_id(item_id: &str, fragmenter_version: u32, ordinal: usize) -> String {
  format!("{}:{}:{}", item_id, fragmenter_version, ordinal)
}

#[derive(Default)]
pub struct FragmentBuildOutcome {
  pub wrote_fragments: bool,
  pub fragment_count: usize,
  pub cleared_existing_fragments: bool,
}

pub struct FragmentInput {
  pub text: String,
  pub page_start: Option<usize>,
  pub page_end: Option<usize>,
}

impl FragmentInput {
  pub fn new(text: String) -> FragmentInput {
    FragmentInput { text, page_start: None, page_end: None }
  }

  pub fn with_page_range(mut self, page_start: Option<usize>, page_end: Option<usize>) -> FragmentInput {
    self.page_start = page_start;
    self.page_end = page_end;
    self
  }
}

#[derive(Serialize)]
struct FragmentRecord {
  ordinal: usize,
  text: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  page_start: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  page_end: Option<usize>,
}

#[derive(Serialize)]
struct FragmentsManifest {
  schema_version: u32,
  fragmenter_version: u32,
  source_kind: String,
  source_text_sha256: String,
  generated_at_unix_secs: i64,
  fragment_count: usize,
}

#[allow(dead_code)]
pub async fn build_fragments_for_item(
  data_dir: &str,
  item: &Item,
  source_kind: FragmentSourceKind,
  source_text: &str,
  container_title: Option<String>,
) -> InfuResult<FragmentBuildOutcome> {
  let source_text = source_text.trim();
  let container_title = container_title.map(|title| title.trim().to_owned()).filter(|title| !title.is_empty());
  if source_text.is_empty() && container_title.is_none() {
    let cleared = clear_item_rag_dir(data_dir, &item.owner_id, &item.id).await?;
    return Ok(FragmentBuildOutcome { cleared_existing_fragments: cleared, ..Default::default() });
  }
  let fragment_text = match container_title.as_deref() {
    Some(container_title) if source_text.is_empty() => format!("## {}", container_title),
    Some(container_title) => format!("## {}\n\n{}", container_title, source_text),
    None => source_text.to_owned(),
  };

  build_fragment_inputs_for_item(data_dir, item, source_kind, vec![FragmentInput::new(fragment_text)]).await
}

pub async fn build_fragment_inputs_for_item(
  data_dir: &str,
  item: &Item,
  source_kind: FragmentSourceKind,
  fragments: Vec<FragmentInput>,
) -> InfuResult<FragmentBuildOutcome> {
  let fragments = fragments
    .into_iter()
    .filter_map(|fragment| {
      let text = fragment.text.trim().to_owned();
      if text.is_empty() {
        None
      } else {
        Some(FragmentInput { text, page_start: fragment.page_start, page_end: fragment.page_end })
      }
    })
    .collect::<Vec<FragmentInput>>();

  if fragments.is_empty() {
    let cleared = clear_item_rag_dir(data_dir, &item.owner_id, &item.id).await?;
    return Ok(FragmentBuildOutcome { cleared_existing_fragments: cleared, ..Default::default() });
  }

  ensure_user_rag_dir(data_dir, &item.owner_id).await?;
  let item_dir = item_rag_dir(data_dir, &item.owner_id, &item.id)?;
  fs::create_dir_all(&item_dir).await?;
  let fragments_path = fragments_path(data_dir, &item.owner_id, &item.id)?;
  let manifest_path = fragments_manifest_path(data_dir, &item.owner_id, &item.id)?;

  let source_text_sha256 =
    sha256_hex(&fragments.iter().map(|fragment| fragment.text.as_str()).collect::<Vec<_>>().join("\n\n"));
  let mut serialized = Vec::new();
  for (ordinal, fragment) in fragments.iter().enumerate() {
    let record = FragmentRecord {
      ordinal,
      text: fragment.text.clone(),
      page_start: fragment.page_start,
      page_end: fragment.page_end,
    };
    let mut line = serde_json::to_vec(&record)?;
    line.push(b'\n');
    serialized.extend_from_slice(&line);
  }
  fs::write(&fragments_path, &serialized).await?;

  let manifest = FragmentsManifest {
    schema_version: FRAGMENTS_SCHEMA_VERSION,
    fragmenter_version: FRAGMENTER_VERSION,
    source_kind: source_kind.as_str().to_owned(),
    source_text_sha256,
    generated_at_unix_secs: unix_now_secs()?,
    fragment_count: fragments.len(),
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;

  Ok(FragmentBuildOutcome { wrote_fragments: true, fragment_count: fragments.len(), cleared_existing_fragments: false })
}

pub async fn clear_fragments_for_item(data_dir: &str, item: &Item) -> InfuResult<FragmentBuildOutcome> {
  let cleared = clear_item_rag_dir(data_dir, &item.owner_id, &item.id).await?;
  Ok(FragmentBuildOutcome { cleared_existing_fragments: cleared, ..Default::default() })
}

fn sha256_hex(text: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(text.as_bytes());
  format!("{:x}", hasher.finalize())
}

fn fragments_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = item_rag_dir(data_dir, user_id, item_id)?;
  path.push("fragments.jsonl");
  Ok(path)
}

fn fragments_manifest_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = item_rag_dir(data_dir, user_id, item_id)?;
  path.push("fragments_manifest.json");
  Ok(path)
}

fn item_rag_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut rag_dir = user_rag_dir(data_dir, user_id)?;
  rag_dir.push(&item_id[..2]);
  rag_dir.push(item_id);
  Ok(rag_dir)
}

async fn clear_item_rag_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<bool> {
  let dir = item_rag_dir(data_dir, user_id, item_id)?;
  if !path_exists(&dir).await {
    return Ok(false);
  }
  fs::remove_dir_all(&dir).await?;
  Ok(true)
}

fn user_rag_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("rag");
  Ok(path)
}

async fn ensure_user_rag_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let rag_dir = user_rag_dir(data_dir, user_id)?;
  if !path_exists(&rag_dir).await {
    fs::create_dir_all(&rag_dir).await?;
  }
  ensure_256_subdirs(&rag_dir).await?;
  Ok(rag_dir)
}

fn unix_now_secs() -> InfuResult<i64> {
  Ok(
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map_err(|e| format!("Could not determine current unix time: {}", e))?
      .as_secs() as i64,
  )
}
