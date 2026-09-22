use std::path::PathBuf;

use infusdk::util::infu::InfuResult;
use tokio::fs;

use crate::util::fs::{expand_tilde, path_exists};

pub const USER_INDEX_DIR_NAME: &str = "indexes";

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
