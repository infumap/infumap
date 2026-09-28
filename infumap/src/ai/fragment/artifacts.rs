use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::debug;
use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::ai::artifact_io::{atomic_write, file_sha256, sha256};
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

pub struct ItemFragmentMetadata {
  pub source_kind: String,
  pub fragment_count: usize,
}

#[derive(Deserialize, Serialize)]
struct FragmentsManifest {
  schema_version: u32,
  fragmenter_version: u32,
  source_kind: String,
  source_text_sha256: String,
  #[serde(default)]
  input_sha256: Option<String>,
  #[serde(default)]
  output_sha256: Option<String>,
  generated_at_unix_secs: i64,
  fragment_count: usize,
}

pub async fn write_item_fragments(
  data_dir: &str,
  item: &Item,
  source_kind: FragmentSourceKind,
  fragments: Vec<FragmentInput>,
  input_sha256: Option<String>,
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

  let item_dir = item_fragments_dir(data_dir, &item.owner_id, &item.id)?;
  let fragments_path = item_fragments_path(data_dir, &item.owner_id, &item.id)?;
  let manifest_path = item_fragments_manifest_path(data_dir, &item.owner_id, &item.id)?;

  let source_text_sha256 =
    sha256(fragments.iter().map(|fragment| fragment.text.as_str()).collect::<Vec<_>>().join("\n\n").as_bytes());
  let source_kind_str = source_kind.as_str();
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
  let output_sha256 = sha256(&serialized);
  if existing_fragments_are_current(
    &fragments_path,
    &manifest_path,
    source_kind_str,
    &source_text_sha256,
    fragments.len(),
    input_sha256.as_deref(),
    &output_sha256,
  )
  .await?
  {
    return Ok(FragmentBuildOutcome::default());
  }
  ensure_user_fragments_dir(data_dir, &item.owner_id).await?;
  fs::create_dir_all(&item_dir).await?;
  atomic_write(&fragments_path, &serialized).await?;

  let manifest = FragmentsManifest {
    schema_version: FRAGMENTS_SCHEMA_VERSION,
    fragmenter_version: FRAGMENTER_VERSION,
    source_kind: source_kind_str.to_owned(),
    source_text_sha256,
    input_sha256,
    output_sha256: Some(output_sha256),
    generated_at_unix_secs: unix_now_secs()?,
    fragment_count: fragments.len(),
  };
  atomic_write(&manifest_path, &serde_json::to_vec_pretty(&manifest)?).await?;

  Ok(FragmentBuildOutcome { wrote_fragments: true, fragment_count: fragments.len(), cleared_existing_fragments: false })
}

pub async fn read_item_fragments(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<ItemFragments> {
  let fragments_path = item_fragments_path(data_dir, user_id, item_id)?;
  let manifest_path = item_fragments_manifest_path(data_dir, user_id, item_id)?;
  let manifest = read_fragments_manifest_if_present(&fragments_path, &manifest_path)
    .await?
    .ok_or("Fragment manifest is missing or invalid; regenerate fragments.")?;
  if manifest.schema_version != FRAGMENTS_SCHEMA_VERSION || manifest.source_kind.trim().is_empty() {
    return Err("Fragment manifest has an unsupported schema or missing source kind.".into());
  }
  let expected_output = manifest.output_sha256;
  let expected_count = manifest.fragment_count;
  let source_kind = manifest.source_kind;
  let contents = fs::read_to_string(&fragments_path)
    .await
    .map_err(|e| format!("Could not read fragments file '{}': {}", fragments_path.display(), e))?;
  if expected_output.as_deref().is_some_and(|expected| sha256(contents.as_bytes()) != expected) {
    return Err("Fragment contents changed or publication was interrupted; regenerate fragments.".into());
  }
  let records = parse_item_fragment_records(&contents)?;
  if expected_count != records.len() {
    return Err("Fragment count does not match its manifest; regenerate fragments.".into());
  }
  Ok(ItemFragments { source_kind, records })
}

/// Inspect the manifest and verify the output fingerprint when available.
pub async fn read_item_fragment_metadata(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Option<ItemFragmentMetadata>> {
  let fragments_path = item_fragments_path(data_dir, user_id, item_id)?;
  let manifest_path = item_fragments_manifest_path(data_dir, user_id, item_id)?;
  let Some(manifest) = read_fragments_manifest_if_present(&fragments_path, &manifest_path).await? else {
    return Ok(None);
  };
  if manifest.schema_version != FRAGMENTS_SCHEMA_VERSION
    || manifest.fragment_count == 0
    || manifest.source_kind.trim().is_empty()
    || (manifest.output_sha256.is_some() && file_sha256(&fragments_path).await? != manifest.output_sha256)
  {
    return Ok(None);
  }
  Ok(Some(ItemFragmentMetadata { source_kind: manifest.source_kind, fragment_count: manifest.fragment_count }))
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
  let Some(manifest) = read_fragments_manifest_if_present(&fragments_path, &manifest_path).await? else {
    return Ok(false);
  };
  if manifest.schema_version != FRAGMENTS_SCHEMA_VERSION || manifest.fragmenter_version != FRAGMENTER_VERSION {
    return Ok(false);
  }
  // Legacy manifests remain readable, but cannot establish an empty success.
  if manifest.output_sha256.is_none() && manifest.fragment_count == 0 {
    return Ok(false);
  }
  Ok(read_item_fragments(data_dir, user_id, item_id).await.is_ok())
}

/// Missing fingerprints on old manifests mean unknown, not current. A rebuild
/// upgrades them without requiring another GPU extraction.
#[allow(dead_code)]
pub async fn fragment_inputs_are_current(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
  input: &str,
) -> InfuResult<bool> {
  let path = item_fragments_path(data_dir, user_id, item_id)?;
  let manifest_path = item_fragments_manifest_path(data_dir, user_id, item_id)?;
  let Some(manifest) = read_fragments_manifest_if_present(&path, &manifest_path).await? else {
    return Ok(false);
  };
  Ok(
    manifest.input_sha256.as_deref() == Some(input)
      && manifest.output_sha256.is_some()
      && item_fragment_artifact_files_exist(data_dir, user_id, item_id).await?,
  )
}

async fn existing_fragments_are_current(
  fragments_path: &PathBuf,
  manifest_path: &PathBuf,
  source_kind: &str,
  source_text_sha256: &str,
  fragment_count: usize,
  input_sha256: Option<&str>,
  output_sha256: &str,
) -> InfuResult<bool> {
  let Some(manifest) = read_fragments_manifest_if_present(fragments_path, manifest_path).await? else {
    return Ok(false);
  };

  Ok(
    manifest.schema_version == FRAGMENTS_SCHEMA_VERSION
      && manifest.fragmenter_version == FRAGMENTER_VERSION
      && manifest.source_kind == source_kind
      && manifest.source_text_sha256 == source_text_sha256
      && manifest.fragment_count == fragment_count
      && manifest.input_sha256.as_deref() == input_sha256
      && manifest.output_sha256.as_deref() == Some(output_sha256)
      && file_sha256(fragments_path).await?.as_deref() == Some(output_sha256),
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
