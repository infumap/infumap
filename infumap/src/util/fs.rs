// Copyright (C) The Infumap Authors
// This file is part of Infumap.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use std::path::{Path, PathBuf};
use infusdk::util::{infu::InfuResult, uid::uid_chars};
use log::warn;
use tokio::fs;


pub async fn path_exists(path: &PathBuf) -> bool {
  tokio::fs::metadata(path).await.is_ok()
}

/// Taken from: https://stackoverflow.com/questions/54267608/expand-tilde-in-rust-path-idiomatically
pub fn expand_tilde<P: AsRef<Path>>(path_user_input: P) -> Option<PathBuf> {
  let p = path_user_input.as_ref();
  if !p.starts_with("~") {
    return Some(p.to_path_buf());
  }
  if p == Path::new("~") {
    return dirs::home_dir();
  }
  dirs::home_dir().map(|mut h| {
    if h == Path::new("/") {
      // Corner case: `h` root directory;
      // don't prepend extra `/`, just drop the tilde.
      p.strip_prefix("~").unwrap().to_path_buf()
    } else {
      h.push(p.strip_prefix("~/").unwrap());
      h
    }
  })
}


pub async fn expand_tilde_path_exists<P: AsRef<Path>>(path: P) -> bool {
  match expand_tilde(path) {
    None => false,
    Some(pb) => { path_exists(&pb).await }
  }
}


pub async fn ensure_256_subdirs(path: &PathBuf) -> InfuResult<usize> {
  let mut num_created = 0;
  let mut path = path.clone();
  for i in 0..uid_chars().len() {
    for j in 0..uid_chars().len() {
      path.push(format!("{}{}", uid_chars().get(i).unwrap(), uid_chars().get(j).unwrap()));
      if !path_exists(&path).await {
        std::fs::create_dir(&path)?;
        num_created += 1;
      }
      path.pop();
    }
  }

  let mut iter = fs::read_dir(&path).await?;
  while let Some(entry) = iter.next_entry().await? {
    if !entry.file_type().await?.is_dir() {
      warn!("Cache directory should only contain directories, but a file was found: '{}'", path.display());
      continue;
    }

    fn unexpected(path: &PathBuf) {
      warn!("Unexpected directory in cache directory: '{}'", path.display());
    }

    if let Some(dirname) = entry.file_name().to_str() {
      if dirname.len() != 2 {
        unexpected(&entry.path()); continue;
      }
      if !uid_chars().contains(&dirname.chars().nth(0).unwrap().to_string().as_str()) {
        unexpected(&entry.path()); continue;
      }
      if !uid_chars().contains(&dirname.chars().nth(1).unwrap().to_string().as_str()) {
        unexpected(&entry.path()); continue;
      }
    } else {
      unexpected(&entry.path());
    }
  }

  Ok(num_created)
}


pub fn construct_file_subpath(store_dir: &PathBuf, filename: &str) -> InfuResult<PathBuf> {
  if filename.len() < 2 {
    return Err(format!("Filename '{}' is too short to store.", filename).into());
  }

  let c1 = &filename[..1];
  let c2 = &filename[1..2];
  if !uid_chars().contains(&c1) || !uid_chars().contains(&c2) {
    return Err(format!("Filename '{}' must start with two hex chars.", filename).into());
  }

  let mut path = store_dir.clone();
  path.push(&filename[..2]);
  path.push(&filename);
  Ok(path)
}

pub async fn write_last_backup_filename(data_dir: &str, user_id: &str, filename: &str) -> InfuResult<()> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("last_backup.txt");

  fs::write(&path, filename).await
    .map_err(|e| format!("Failed to write last backup filename for user '{}': {}", user_id, e))?;

  Ok(())
}

pub async fn read_last_backup_filename(data_dir: &str, user_id: &str) -> InfuResult<Option<String>> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("last_backup.txt");

  if !path_exists(&path).await {
    return Ok(None);
  }

  let content = fs::read_to_string(&path).await
    .map_err(|e| format!("Failed to read last backup filename for user '{}': {}", user_id, e))?;

  Ok(Some(content.trim().to_string()))
}
