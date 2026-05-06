#![allow(dead_code)]

use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::PathBuf;

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

  async fn insert_embedded_fragments(&self, fragments: &[EmbeddedFragment]) -> InfuResult<()>;

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

#[cfg(test)]
mod tests {
  use std::path::PathBuf;

  use super::{
    FRAGMENT_VECTOR_DB_FILENAME, FRAGMENT_VECTOR_DB_TEMP_FILENAME, USER_INDEX_DIR_NAME, ensure_user_index_dir,
    fragment_vector_db_path, fragment_vector_db_temp_path, user_fragment_vector_db_exists, user_index_dir,
  };

  #[test]
  fn builds_user_index_paths_next_to_user_artifact_dirs() {
    let index_dir = user_index_dir("/data/infumap", "abc123").unwrap();
    assert_eq!(index_dir, PathBuf::from("/data/infumap/user_abc123").join(USER_INDEX_DIR_NAME));

    let db_path = fragment_vector_db_path("/data/infumap", "abc123").unwrap();
    assert_eq!(db_path, index_dir.join(FRAGMENT_VECTOR_DB_FILENAME));

    let temp_path = fragment_vector_db_temp_path("/data/infumap", "abc123").unwrap();
    assert_eq!(temp_path, index_dir.join(FRAGMENT_VECTOR_DB_TEMP_FILENAME));
  }

  #[tokio::test]
  async fn ensures_user_index_dir_exists() {
    let data_dir = std::env::temp_dir().join(format!("infumap-index-layout-test-{}", std::process::id()));
    if data_dir.exists() {
      std::fs::remove_dir_all(&data_dir).unwrap();
    }

    let index_dir = ensure_user_index_dir(data_dir.to_str().unwrap(), "abc123").await.unwrap();
    assert!(index_dir.is_dir());
    assert_eq!(index_dir, data_dir.join("user_abc123").join(USER_INDEX_DIR_NAME));

    std::fs::remove_dir_all(&data_dir).unwrap();
  }

  #[tokio::test]
  async fn checks_whether_user_fragment_vector_db_exists() {
    let data_dir = std::env::temp_dir().join(format!("infumap-index-exists-test-{}", std::process::id()));
    if data_dir.exists() {
      std::fs::remove_dir_all(&data_dir).unwrap();
    }
    let data_dir_str = data_dir.to_str().unwrap();

    assert!(!user_fragment_vector_db_exists(data_dir_str, "abc123").await.unwrap());

    let index_dir = ensure_user_index_dir(data_dir_str, "abc123").await.unwrap();
    assert!(!user_fragment_vector_db_exists(data_dir_str, "abc123").await.unwrap());

    let db_path = index_dir.join(FRAGMENT_VECTOR_DB_FILENAME);
    std::fs::write(db_path, b"placeholder").unwrap();
    assert!(user_fragment_vector_db_exists(data_dir_str, "abc123").await.unwrap());

    std::fs::remove_dir_all(&data_dir).unwrap();
  }
}
