// Copyright (C) 2023 The Infumap Authors
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

use std::collections::HashSet;
use std::path::PathBuf;
use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

use log::{info, warn};

use crate::util::infu::InfuResult;
use crate::util::uid::Uid;
use crate::util::fs::{expand_tilde, construct_store_subpath, ensure_256_subdirs, path_exists};


/// Manage files on disk for all users, assuming the mandated data folder hierarchy.
/// Not threadsafe.
pub struct FileStore {
  data_dir: PathBuf,
  user_existence_checked: HashSet<String>,
}

impl FileStore {
  pub fn new(data_dir: &str) -> InfuResult<FileStore> {
    let data_dir = expand_tilde(data_dir).ok_or(format!("Data path '{}' is not valid.", data_dir))?;
    Ok(FileStore { data_dir, user_existence_checked: HashSet::new() })
  }

  async fn ensure_files_dir(&mut self, user_id: &Uid) -> InfuResult<PathBuf> {
    let mut files_dir = self.data_dir.clone();
    files_dir.push(format!("{}{}", String::from("user_"), user_id));
    files_dir.push("files");

    if !self.user_existence_checked.contains(user_id) {
      if !path_exists(&files_dir).await {
        if let Err(e) = tokio::fs::create_dir(files_dir.as_path()).await {
          return Err(format!("Could not create files directory: '{e}'").into());
        } else {
          info!("Created file store directory: '{}',", files_dir.as_path().to_str().unwrap());
        }
      }
      let num_created = ensure_256_subdirs(&files_dir).await?;
      if num_created > 0 {
        warn!("Created {} file store sub directories", num_created);
      }
      self.user_existence_checked.insert(String::from(user_id));
    }

    Ok(files_dir)
  }

  pub async fn get(&mut self, user_id: &Uid, id: &Uid) -> InfuResult<Vec<u8>> {
    let path = construct_store_subpath(&self.ensure_files_dir(user_id).await?, id)?;
    let mut f = File::open(&path).await?;
    let mut buffer = vec![0; tokio::fs::metadata(&path).await?.len() as usize];
    f.read_exact(&mut buffer).await?;
    Ok(buffer)
  }

  pub async fn put(&mut self, user_id: Uid, id: Uid, val: Vec<u8>) -> InfuResult<()> {
    let mut file = OpenOptions::new()
      .create_new(true)
      .write(true)
      .open(
        construct_store_subpath(&self.ensure_files_dir(&user_id).await?, &id)?).await?;
    file.write_all(&val).await?;
    file.flush().await?;
    Ok(())
  }

  pub async fn delete(&mut self, user_id: Uid, id: Uid) -> InfuResult<()> {
    tokio::fs::remove_file(
      construct_store_subpath(&self.ensure_files_dir(&user_id).await?, &id)?).await?;
    Ok(())
  }
}
