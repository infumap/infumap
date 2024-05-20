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

use std::collections::HashMap;
use std::path::PathBuf;
use infusdk::db::kv_store::KVStore;
use infusdk::db::kv_store::JsonLogSerializable;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::{is_uid, Uid};
use log::{warn, debug};
use tokio::fs::File;
use tokio::io::{BufReader, AsyncReadExt};

use crate::util::fs::expand_tilde;
use super::user::User;

pub const CURRENT_USER_LOG_VERSION: i64 = 4;


/// Db for managing User instances, assuming the mandated data folder hierarchy.
/// Not threadsafe.
pub struct UserDb {
  data_dir: PathBuf,
  store_by_id: HashMap<Uid, KVStore<User>>,
  id_by_lowercase_username: HashMap<String, Uid>,
}

impl UserDb {
  pub async fn init(data_dir: &str) -> InfuResult<UserDb> {
    let mut user_id_by_username = HashMap::new();
    let mut store_by_user_id = HashMap::new();

    let expanded_data_path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
    let mut iter = tokio::fs::read_dir(&expanded_data_path).await?;
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

        if !is_uid(dir_userid) {
          warn!("Unexpected directory in data directory: '{}'.", dirname);
          continue;
        }

        let mut log_path = expanded_data_path.clone();
        log_path.push(dirname);
        log_path.push("user.json");
        let log_path_str = log_path.as_path().to_str().unwrap();
        let store: KVStore<User> = KVStore::init(&log_path_str, CURRENT_USER_LOG_VERSION).await?;
        let mut iter = store.get_iter();
        let username;
        match iter.next() {
          None => {
            warn!("User store {} contains no users, one expected.", log_path_str);
            continue;
          },
          Some((uid, user)) => {
            if uid != dir_userid {
              warn!("Unexpected user '{}' encountered in log: '{}'. Ignoring.", uid, log_path_str);
              continue;
            }
            username = user.username.clone();
            user_id_by_username.insert(username.clone(), uid.clone());
          }
        }
        if iter.next().is_some() {
          warn!("User store {} contains more than one user, one expected. Ignoring all of them.", log_path_str);
          user_id_by_username.remove(&username);
          continue;
        }

        store_by_user_id.insert(String::from(dir_userid), store);
      } else {
        warn!("Unexpected directory in store directory: '{}'.", entry.path().display());
        continue;
      }
    }
    
    Ok(UserDb {
      data_dir: expanded_data_path,
      store_by_id: store_by_user_id,
      id_by_lowercase_username: user_id_by_username
    })
  }

  pub async fn add(&mut self, user: User) -> InfuResult<()> {
    if self.id_by_lowercase_username.contains_key(&user.username.to_lowercase()) {
      return Err(format!("User with username '{}' already exists.", user.username).into());
    }
    if is_uid(&user.username) {
      return Err(format!("User has username '{}' which is a uid.", user.username).into());
    }

    self.id_by_lowercase_username.insert(user.username.to_ascii_lowercase(), String::from(&user.id));

    let mut dir = self.data_dir.clone();
    dir.push(format!("{}{}", String::from("user_"), &user.id));
    tokio::fs::create_dir(&dir).await?;

    dir.push("user.json");
    let log_path_str = dir.as_path().to_str().unwrap();
    let mut store: KVStore<User> = KVStore::init(&log_path_str, CURRENT_USER_LOG_VERSION).await?;

    let user_id = user.id.clone();
    store.add(user).await?;
    self.store_by_id.insert(user_id, store);

    Ok(())
  }

  pub fn get_by_username_case_insensitive(&self, username: &str) -> Option<&User> {
    match self.id_by_lowercase_username.get(&username.to_lowercase()) {
      None => None,
      Some(uid) => {
        match self.store_by_id.get(uid) {
          None => None,
          Some(store) => {
            store.get(uid)
          }
        }
      }
    }
  }

  pub fn get(&self, uid: &Uid) -> Option<&User> {
    match self.store_by_id.get(uid) {
      None => None,
      Some(store) => {
        store.get(uid)
      }
    }
  }

  pub async fn update(&mut self, user: &User) -> InfuResult<()> {
    let old_user = self.get(&user.id)
      .ok_or(format!("Request was made to update user with id '{}', but such a user does not exist.", user.id))?.clone();

    let update_json_map = User::create_json_update(&old_user, user)?;
    if update_json_map.len() == 2 {
      // "__recordType" and "id" and nothing else.
      debug!("Request was made to update user '{}', but nothing has changed.", user.id);
      return Ok(());
    }

    if update_json_map.len() != 3 || !update_json_map.contains_key("totpSecret") {
      warn!("Currently, only updating user totp secret is supported.");
      return Err("Currently, only updating user totp secret is supported.".into());
    }

    let store = self.store_by_id.get_mut(&user.id).ok_or("unknown user")?;

    store.update(user.clone()).await
  }

  pub fn all_user_ids(&self) -> Vec<String> {
    self.store_by_id.iter().map(|u| u.0.clone()).collect::<Vec<String>>()
  }

  pub async fn get_log_size_bytes_for_user(&self, user_id: &str) -> InfuResult<u32> {
    let log_path = self.log_path(user_id)?;
    Ok(tokio::fs::metadata(log_path).await?.len() as u32)
  }

  pub async fn backup_user(&self, user_id: &str, buf: &mut [u8]) -> InfuResult<()> {
    let log_path = self.log_path(user_id)?;
    let mut f = BufReader::new(File::open(&log_path).await?);
    f.read_exact(buf).await?;
    Ok(())
  }

  fn log_path(&self, user_id: &str) -> InfuResult<PathBuf> {
    let mut log_path = expand_tilde(&self.data_dir).ok_or("Could not interpret path.")?;
    log_path.push(String::from("user_") + user_id);
    log_path.push("user.json");
    Ok(log_path)
  }
}
