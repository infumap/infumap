use std::path::PathBuf;

use infusdk::util::infu::InfuResult;
use tokio::fs;

use crate::util::fs::{ensure_256_subdirs, expand_tilde, path_exists};

pub const TEXT_CONTENT_SUFFIX: &str = "_text";
pub const TEXT_MANIFEST_SUFFIX: &str = "_manifest.json";
pub const GEO_CONTENT_SUFFIX: &str = "_geo.json";
pub const GEO_MANIFEST_SUFFIX: &str = "_geo_manifest.json";
pub const FRAGMENTS_FILENAME: &str = "fragments.jsonl";
pub const FRAGMENTS_MANIFEST_FILENAME: &str = "fragments_manifest.json";

pub fn user_text_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("text");
  Ok(path)
}

pub fn item_text_shard_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut text_dir = user_text_dir(data_dir, user_id)?;
  text_dir.push(&item_id[..2]);
  Ok(text_dir)
}

pub async fn ensure_user_text_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let text_dir = user_text_dir(data_dir, user_id)?;
  if !path_exists(&text_dir).await {
    fs::create_dir_all(&text_dir).await?;
  }
  ensure_256_subdirs(&text_dir).await?;
  Ok(text_dir)
}

pub fn item_text_artifact_path(data_dir: &str, user_id: &str, item_id: &str, suffix: &str) -> InfuResult<PathBuf> {
  let mut path = item_text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}{}", item_id, suffix));
  Ok(path)
}

pub fn item_text_artifact_paths(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
  manifest_suffix: &str,
  content_suffix: &str,
) -> InfuResult<(PathBuf, PathBuf)> {
  Ok((
    item_text_artifact_path(data_dir, user_id, item_id, manifest_suffix)?,
    item_text_artifact_path(data_dir, user_id, item_id, content_suffix)?,
  ))
}

pub fn item_text_content_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  item_text_artifact_path(data_dir, user_id, item_id, TEXT_CONTENT_SUFFIX)
}

pub fn item_text_manifest_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  item_text_artifact_path(data_dir, user_id, item_id, TEXT_MANIFEST_SUFFIX)
}

pub fn item_geo_content_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  item_text_artifact_path(data_dir, user_id, item_id, GEO_CONTENT_SUFFIX)
}

pub fn item_geo_manifest_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  item_text_artifact_path(data_dir, user_id, item_id, GEO_MANIFEST_SUFFIX)
}

pub fn user_fragments_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("fragments");
  Ok(path)
}

pub fn item_fragments_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut fragments_dir = user_fragments_dir(data_dir, user_id)?;
  fragments_dir.push(&item_id[..2]);
  fragments_dir.push(item_id);
  Ok(fragments_dir)
}

pub fn item_fragments_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = item_fragments_dir(data_dir, user_id, item_id)?;
  path.push(FRAGMENTS_FILENAME);
  Ok(path)
}

pub fn item_fragments_manifest_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = item_fragments_dir(data_dir, user_id, item_id)?;
  path.push(FRAGMENTS_MANIFEST_FILENAME);
  Ok(path)
}

#[cfg(test)]
mod tests {
  use super::{
    item_fragments_manifest_path, item_fragments_path, item_geo_content_path, item_geo_manifest_path,
    item_text_content_path, item_text_manifest_path,
  };

  #[test]
  fn builds_text_artifact_paths() {
    assert_eq!(
      item_text_content_path("/data/infumap", "user123", "abcdef").unwrap().to_string_lossy(),
      "/data/infumap/user_user123/text/ab/abcdef_text"
    );
    assert_eq!(
      item_text_manifest_path("/data/infumap", "user123", "abcdef").unwrap().to_string_lossy(),
      "/data/infumap/user_user123/text/ab/abcdef_manifest.json"
    );
  }

  #[test]
  fn builds_geo_artifact_paths() {
    assert_eq!(
      item_geo_content_path("/data/infumap", "user123", "abcdef").unwrap().to_string_lossy(),
      "/data/infumap/user_user123/text/ab/abcdef_geo.json"
    );
    assert_eq!(
      item_geo_manifest_path("/data/infumap", "user123", "abcdef").unwrap().to_string_lossy(),
      "/data/infumap/user_user123/text/ab/abcdef_geo_manifest.json"
    );
  }

  #[test]
  fn builds_fragment_artifact_paths() {
    assert_eq!(
      item_fragments_path("/data/infumap", "user123", "abcdef").unwrap().to_string_lossy(),
      "/data/infumap/user_user123/fragments/ab/abcdef/fragments.jsonl"
    );
    assert_eq!(
      item_fragments_manifest_path("/data/infumap", "user123", "abcdef").unwrap().to_string_lossy(),
      "/data/infumap/user_user123/fragments/ab/abcdef/fragments_manifest.json"
    );
  }
}
