#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use infusdk::util::infu::InfuResult;
use tokio::fs;

use crate::util::fs::{expand_tilde, path_exists};

pub mod sqlite_vec;

pub const USER_INDEX_DIR_NAME: &str = "indexes";
pub const FRAGMENT_VECTOR_DB_FILENAME: &str = "fragments.sqlite3";
pub const FRAGMENT_VECTOR_DB_TEMP_FILENAME: &str = "fragments.sqlite3.tmp";

#[derive(Clone, Debug, PartialEq)]
pub struct EmbeddedFragment {
  pub item_id: String,
  pub ordinal: usize,
  pub source_kind: String,
  pub text: String,
  pub page_start: Option<usize>,
  pub page_end: Option<usize>,
  pub embedding: Vec<f32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FragmentVectorHit {
  pub item_id: String,
  pub ordinal: usize,
  pub source_kind: String,
  pub distance: f32,
  pub text: String,
  pub page_start: Option<usize>,
  pub page_end: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct FragmentVectorDbFragmentKey {
  pub item_id: String,
  pub ordinal: usize,
  pub text_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FragmentVectorDbRebuildMetadata {
  pub source_digest: String,
  pub expected_fragment_count: usize,
  pub model: String,
  pub embedding_dimensions: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FragmentVectorDbRebuildStatus {
  pub source_digest: String,
  pub expected_fragment_count: usize,
  pub model: String,
  pub embedding_dimensions: usize,
  pub embedded_fragment_count: usize,
  pub embedding_row_count: usize,
  pub complete: bool,
}

#[async_trait]
pub trait FragmentVectorDb: Send + Sync {
  async fn rebuild_status(&self) -> InfuResult<Option<FragmentVectorDbRebuildStatus>>;

  async fn begin_rebuild(
    &self,
    metadata: &FragmentVectorDbRebuildMetadata,
    resume: bool,
  ) -> InfuResult<FragmentVectorDbRebuildStatus>;

  async fn embedded_fragment_keys(&self) -> InfuResult<HashSet<FragmentVectorDbFragmentKey>>;

  async fn embedded_fragments_for_keys(
    &self,
    keys: &HashSet<FragmentVectorDbFragmentKey>,
  ) -> InfuResult<Vec<EmbeddedFragment>>;

  async fn insert_embedded_fragments(&self, fragments: &[EmbeddedFragment]) -> InfuResult<()>;

  async fn delete_item_fragments(&self, item_id: &str) -> InfuResult<usize>;

  async fn finish_rebuild(
    &self,
    metadata: &FragmentVectorDbRebuildMetadata,
  ) -> InfuResult<FragmentVectorDbRebuildStatus>;

  async fn search(&self, query_embedding: &[f32], limit: usize) -> InfuResult<Vec<FragmentVectorHit>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FragmentVectorDbBackend {
  SqliteVec,
}

pub fn open_fragment_vector_db(backend: FragmentVectorDbBackend, db_path: PathBuf) -> Box<dyn FragmentVectorDb> {
  match backend {
    FragmentVectorDbBackend::SqliteVec => Box::new(sqlite_vec::SqliteVecFragmentVectorDb::new(db_path)),
  }
}

// sqlite-vec operations use short-lived connections, so serialize same-process access per DB path.
static FRAGMENT_VECTOR_DB_OPERATION_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
  OnceLock::new();

pub fn fragment_vector_db_operation_lock(db_path: &Path) -> Arc<tokio::sync::Mutex<()>> {
  let locks = FRAGMENT_VECTOR_DB_OPERATION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
  let mut locks = match locks.lock() {
    Ok(locks) => locks,
    Err(poisoned) => poisoned.into_inner(),
  };
  locks.entry(db_path.to_path_buf()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
}

pub fn user_index_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push(USER_INDEX_DIR_NAME);
  Ok(path)
}

pub async fn ensure_user_index_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let index_dir = user_index_dir(data_dir, user_id)?;
  if !path_exists(&index_dir).await {
    fs::create_dir_all(&index_dir).await?;
  }
  Ok(index_dir)
}

pub fn fragment_vector_db_path(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = user_index_dir(data_dir, user_id)?;
  path.push(FRAGMENT_VECTOR_DB_FILENAME);
  Ok(path)
}

pub fn fragment_vector_db_temp_path(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = user_index_dir(data_dir, user_id)?;
  path.push(FRAGMENT_VECTOR_DB_TEMP_FILENAME);
  Ok(path)
}

pub async fn user_fragment_vector_db_exists(data_dir: &str, user_id: &str) -> InfuResult<bool> {
  let path = fragment_vector_db_path(data_dir, user_id)?;
  match fs::metadata(&path).await {
    Ok(metadata) => Ok(metadata.is_file()),
    Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
    Err(e) => Err(format!("Could not inspect fragment vector DB '{}': {}", path.display(), e).into()),
  }
}

pub fn open_user_fragment_vector_db(
  data_dir: &str,
  user_id: &str,
  backend: FragmentVectorDbBackend,
) -> InfuResult<Box<dyn FragmentVectorDb>> {
  Ok(open_fragment_vector_db(backend, fragment_vector_db_path(data_dir, user_id)?))
}
