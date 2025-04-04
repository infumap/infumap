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

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, Arc};
use async_trait::async_trait;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::{uid_chars, Uid};
use tokio::fs;

use log::{info, warn};

use crate::util::fs::{expand_tilde, construct_file_subpath, ensure_256_subdirs, path_exists};

use super::db::item_db::ItemAndUserId;
use super::object::IndividualObjectStore;


pub struct FileStore {
  data_dir: PathBuf,
  user_existence_checked: HashSet<String>,
}

impl FileStore {
  fn new(data_dir: &str) -> InfuResult<FileStore> {
    let data_dir = expand_tilde(data_dir).ok_or(format!("Data path '{}' is not valid.", data_dir))?;
    Ok(FileStore { data_dir, user_existence_checked: HashSet::new() })
  }
}


/// Create a new FileStore instance.
/// One instance is designed to manage files on disk for all users.
/// Assumes the mandated data folder hierarchy.
/// Not thread safe, on a per item basis.
pub fn new(data_dir: &str) -> InfuResult<Arc<Mutex<FileStore>>> {
  Ok(Arc::new(Mutex::new(FileStore::new(data_dir)?)))
}


/// Get data associated with the specified item for the specified user.
pub async fn get(file_store: Arc<Mutex<FileStore>>, user_id: Uid, item_id: Uid) -> InfuResult<Vec<u8>> {
  let files_dir = ensure_files_dir(file_store, &user_id).await?;
  let path = construct_file_subpath(&files_dir, &item_id)?;
  let buffer = tokio::fs::read(&path).await?;
  Ok(buffer)
}


/// Set data for the specified item for the specified user.
pub async fn put(file_store: Arc<Mutex<FileStore>>, user_id: Uid, item_id: Uid, val: Arc<Vec<u8>>) -> InfuResult<()> {
  let files_dir = ensure_files_dir(file_store, &user_id).await?;
  let path = construct_file_subpath(&files_dir, &item_id)?;
  let contents = &*val;
  tokio::fs::write(&path, contents).await?;
  Ok(())
}


/// Delete data for the specified item for the specified user.
pub async fn delete(file_store: Arc<Mutex<FileStore>>, user_id: Uid, item_id: Uid) -> InfuResult<()> {
  let files_dir = ensure_files_dir(file_store, &user_id).await?;
  tokio::fs::remove_file(construct_file_subpath(&files_dir, &item_id)?).await?;
  Ok(())
}


/// List the ids of all items with stored data for the specified user.
pub async fn list(file_store: Arc<Mutex<FileStore>>, user_id: &Uid) -> InfuResult<Vec<String>> {
  let mut path = file_store.lock().unwrap().data_dir.clone();

  path.push(format!("{}{}", String::from("user_"), user_id));
  path.push("files");

  let mut result = vec![];
  for i in 0..uid_chars().len() {
    for j in 0..uid_chars().len() {
      path.push(format!("{}{}", uid_chars().get(i).unwrap(), uid_chars().get(j).unwrap()));
      if !path_exists(&path).await {
        return Err(format!("Files directory for user {} does not contain all expected subdirs.", user_id).into());
      }
      let mut iter = fs::read_dir(&path).await?;
      while let Some(entry) = iter.next_entry().await? {
        if !entry.file_type().await?.is_file() {
          return Err(format!("File directory should only contain files: '{}'", path.display()).into());
        }
        if let Some(filename) = entry.file_name().to_str() {
          result.push(String::from(filename));
        } else {
          return Err(format!("Unexpected file: {:?}", entry.file_name()).into())
        }
      }
      path.pop();
    }
  }
  Ok(result)
}


async fn ensure_files_dir(file_store: Arc<Mutex<FileStore>>, user_id: &Uid) -> InfuResult<PathBuf> {
  let files_dir = {
    let mut file_store = file_store.lock().unwrap();
    let mut path = file_store.data_dir.clone();
    path.push(format!("{}{}", String::from("user_"), user_id));
    path.push("files");
    if file_store.user_existence_checked.contains(user_id) {
      return Ok(path);
    }
    file_store.user_existence_checked.insert(String::from(user_id));
    path
  };

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

  Ok(files_dir)
}


async fn all_user_data_dirs(path: PathBuf) -> InfuResult<Vec<String>> {
  let mut result = vec![];
  let mut iter = tokio::fs::read_dir(&path).await?;
  while let Some(entry) = iter.next_entry().await? {
    if !entry.file_type().await?.is_dir() {
      // pending users log is in the data directory as well.
      continue;
    }

    if let Some(dirname) = entry.file_name().to_str() {
      let parts = dirname.split('_').collect::<Vec<&str>>();
      if parts.len() != 2 {
        warn!("Unexpected directory in data directory: '{}'.", dirname);
        continue;
      }
      let dir_userid = *parts.get(1).unwrap();
      result.push(dir_userid.to_owned());
    }
  }

  Ok(result)
}


#[async_trait]
impl IndividualObjectStore for Arc<Mutex<FileStore>> {
  async fn get(&self, user_id: Uid, item_id: Uid) -> InfuResult<Vec<u8>> {
    get(self.clone(), user_id, item_id).await
  }

  async fn put(&self, user_id: Uid, item_id: Uid, val: Arc<Vec<u8>>) -> InfuResult<()> {
    put(self.clone(), user_id, item_id, val).await
  }

  async fn list(&self) -> InfuResult<Vec<ItemAndUserId>> {
    let path = {
      let file_store = self.lock().unwrap();
      file_store.data_dir.clone()
    };

    let all_users = all_user_data_dirs(path).await?;
    let mut result = vec![];
    for user_id in all_users {
      let files = list(self.clone(), &user_id).await?;
      for item_id in &files {
        result.push(ItemAndUserId { user_id: user_id.clone(), item_id: item_id.clone() });
      }
    }
    Ok(result)
  }
}
