use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::debug;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::fs;

use crate::ai::artifact_paths::{
  item_fragments_dir, item_fragments_manifest_path, item_fragments_path, user_fragments_dir,
};
use crate::ai::user_id_for_log;
use crate::util::fs::{ensure_256_subdirs, path_exists};

use super::types::{FragmentBuildOutcome, FragmentInput, FragmentSourceKind};

const FRAGMENTS_SCHEMA_VERSION: u32 = 1;
const FRAGMENTER_VERSION: u32 = 15;
static ENSURED_USER_FRAGMENT_DIRS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

#[allow(dead_code)]
fn item_fragment_id(item_id: &str, fragmenter_version: u32, ordinal: usize) -> String {
  format!("{}:{}:{}", item_id, fragmenter_version, ordinal)
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ItemFragmentRecord {
  pub ordinal: usize,
  pub text: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub page_start: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub page_end: Option<usize>,
}

pub struct ItemFragments {
  pub source_kind: String,
  pub records: Vec<ItemFragmentRecord>,
}

#[derive(Deserialize, Serialize)]
struct FragmentsManifest {
  schema_version: u32,
  fragmenter_version: u32,
  source_kind: String,
  source_text_sha256: String,
  generated_at_unix_secs: i64,
  fragment_count: usize,
}

#[allow(dead_code)]
async fn write_item_fragment_text(
  data_dir: &str,
  item: &Item,
  source_kind: FragmentSourceKind,
  source_text: &str,
  container_title: Option<String>,
) -> InfuResult<FragmentBuildOutcome> {
  let source_text = source_text.trim();
  let container_title = container_title.map(|title| title.trim().to_owned()).filter(|title| !title.is_empty());
  if source_text.is_empty() && container_title.is_none() {
    let cleared = clear_item_fragments_dir(data_dir, &item.owner_id, &item.id).await?;
    return Ok(FragmentBuildOutcome { cleared_existing_fragments: cleared, ..Default::default() });
  }
  let fragment_text = match container_title.as_deref() {
    Some(container_title) if source_text.is_empty() => format!("## {}", container_title),
    Some(container_title) => format!("## {}\n\n{}", container_title, source_text),
    None => source_text.to_owned(),
  };

  write_item_fragments(data_dir, item, source_kind, vec![FragmentInput::new(fragment_text)]).await
}

pub async fn write_item_fragments(
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
    let cleared = clear_item_fragments_dir(data_dir, &item.owner_id, &item.id).await?;
    return Ok(FragmentBuildOutcome { cleared_existing_fragments: cleared, ..Default::default() });
  }

  let item_dir = item_fragments_dir(data_dir, &item.owner_id, &item.id)?;
  let fragments_path = item_fragments_path(data_dir, &item.owner_id, &item.id)?;
  let manifest_path = item_fragments_manifest_path(data_dir, &item.owner_id, &item.id)?;

  let source_text_sha256 =
    sha256_hex(&fragments.iter().map(|fragment| fragment.text.as_str()).collect::<Vec<_>>().join("\n\n"));
  let source_kind_str = source_kind.as_str();
  if existing_fragments_are_current(
    &fragments_path,
    &manifest_path,
    source_kind_str,
    &source_text_sha256,
    fragments.len(),
  )
  .await?
  {
    return Ok(FragmentBuildOutcome::default());
  }

  ensure_user_fragments_dir(data_dir, &item.owner_id).await?;
  fs::create_dir_all(&item_dir).await?;

  let mut serialized = Vec::new();
  for (ordinal, fragment) in fragments.iter().enumerate() {
    let record = ItemFragmentRecord {
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
    source_kind: source_kind_str.to_owned(),
    source_text_sha256,
    generated_at_unix_secs: unix_now_secs()?,
    fragment_count: fragments.len(),
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;

  Ok(FragmentBuildOutcome { wrote_fragments: true, fragment_count: fragments.len(), cleared_existing_fragments: false })
}

pub async fn read_item_fragments(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<ItemFragments> {
  let fragments_path = item_fragments_path(data_dir, user_id, item_id)?;
  let manifest_path = item_fragments_manifest_path(data_dir, user_id, item_id)?;
  let manifest = read_fragments_manifest_if_present(&fragments_path, &manifest_path).await?;
  let source_kind = manifest
    .map(|manifest| manifest.source_kind)
    .filter(|source_kind| !source_kind.trim().is_empty())
    .unwrap_or_else(|| "unknown".to_owned());
  let contents = fs::read_to_string(&fragments_path)
    .await
    .map_err(|e| format!("Could not read fragments file '{}': {}", fragments_path.display(), e))?;
  let records = parse_item_fragment_records(&contents)?;
  Ok(ItemFragments { source_kind, records })
}

fn parse_item_fragment_records(contents: &str) -> InfuResult<Vec<ItemFragmentRecord>> {
  let mut out = Vec::new();

  for (line_number, line) in contents.lines().enumerate() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    let record: ItemFragmentRecord = serde_json::from_str(trimmed)
      .map_err(|e| format!("Could not parse fragment record on line {} of fragments.jsonl: {}", line_number + 1, e))?;
    if !record.text.trim().is_empty() {
      out.push(record);
    }
  }

  Ok(out)
}

pub async fn clear_item_fragments(data_dir: &str, item: &Item) -> InfuResult<FragmentBuildOutcome> {
  let cleared = clear_item_fragments_dir(data_dir, &item.owner_id, &item.id).await?;
  Ok(FragmentBuildOutcome { cleared_existing_fragments: cleared, ..Default::default() })
}

pub async fn delete_item_fragment_artifacts(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<bool> {
  clear_item_fragments_dir(data_dir, user_id, item_id).await
}

pub async fn item_fragment_artifact_files_exist(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<bool> {
  let fragments_path = item_fragments_path(data_dir, user_id, item_id)?;
  let manifest_path = item_fragments_manifest_path(data_dir, user_id, item_id)?;
  Ok(path_exists(&fragments_path).await && path_exists(&manifest_path).await)
}

fn sha256_hex(text: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(text.as_bytes());
  format!("{:x}", hasher.finalize())
}

async fn existing_fragments_are_current(
  fragments_path: &PathBuf,
  manifest_path: &PathBuf,
  source_kind: &str,
  source_text_sha256: &str,
  fragment_count: usize,
) -> InfuResult<bool> {
  let Some(manifest) = read_fragments_manifest_if_present(fragments_path, manifest_path).await? else {
    return Ok(false);
  };

  Ok(
    manifest.schema_version == FRAGMENTS_SCHEMA_VERSION
      && manifest.fragmenter_version == FRAGMENTER_VERSION
      && manifest.source_kind == source_kind
      && manifest.source_text_sha256 == source_text_sha256
      && manifest.fragment_count == fragment_count,
  )
}

async fn read_fragments_manifest_if_present(
  fragments_path: &PathBuf,
  manifest_path: &PathBuf,
) -> InfuResult<Option<FragmentsManifest>> {
  if !path_exists(fragments_path).await || !path_exists(manifest_path).await {
    return Ok(None);
  }

  let manifest_bytes = fs::read(manifest_path)
    .await
    .map_err(|e| format!("Could not read fragments manifest '{}': {}", manifest_path.display(), e))?;
  Ok(serde_json::from_slice::<FragmentsManifest>(&manifest_bytes).ok())
}

async fn clear_item_fragments_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<bool> {
  let dir = item_fragments_dir(data_dir, user_id, item_id)?;
  if !path_exists(&dir).await {
    return Ok(false);
  }
  fs::remove_dir_all(&dir).await?;
  Ok(true)
}

async fn ensure_user_fragments_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let fragments_dir = user_fragments_dir(data_dir, user_id)?;
  if was_user_fragments_dir_ensured(&fragments_dir)? {
    return Ok(fragments_dir);
  }

  debug!("Checking fragment shards for user {}: {}.", user_id_for_log(user_id), fragments_dir.display());
  if !path_exists(&fragments_dir).await {
    fs::create_dir_all(&fragments_dir).await?;
  }
  let created = ensure_256_subdirs(&fragments_dir).await?;
  if created > 0 {
    debug!(
      "Initialized fragments shard directory '{}' for user '{}' with {} missing shard dir(s).",
      fragments_dir.display(),
      user_id_for_log(user_id),
      created
    );
  } else {
    debug!("Fragments shard directory '{}' for user '{}' is ready.", fragments_dir.display(), user_id_for_log(user_id));
  }
  mark_user_fragments_dir_ensured(&fragments_dir)?;
  Ok(fragments_dir)
}

fn ensured_user_fragment_dirs() -> &'static Mutex<HashSet<PathBuf>> {
  ENSURED_USER_FRAGMENT_DIRS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn was_user_fragments_dir_ensured(path: &PathBuf) -> InfuResult<bool> {
  let dirs = ensured_user_fragment_dirs()
    .lock()
    .map_err(|_| "Could not lock fragment directory cache because it is poisoned.")?;
  Ok(dirs.contains(path))
}

fn mark_user_fragments_dir_ensured(path: &PathBuf) -> InfuResult<()> {
  let mut dirs = ensured_user_fragment_dirs()
    .lock()
    .map_err(|_| "Could not lock fragment directory cache because it is poisoned.")?;
  dirs.insert(path.clone());
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
