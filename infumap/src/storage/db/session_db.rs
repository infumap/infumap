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

use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use std::collections::HashMap;
use infusdk::db::kv_store::KVStore;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::{is_uid, new_uid, Uid};
use log::{warn, info};

use crate::util::fs::{expand_tilde, path_exists};
use super::session::Session;

pub const CURRENT_SESSIONS_LOG_VERSION: i64 = 1;
const SESSION_LOG_FILENAME: &str = "sessions.json";


/// Db for managing Session instances, assuming the mandated data folder hierarchy.
/// Not thread safe.
pub struct SessionDb {
  data_dir: PathBuf,
  store_by_user_id: HashMap<Uid, KVStore<Session>>,
  user_id_by_session_id: HashMap<Uid, Uid>
}

impl SessionDb {
  pub async fn init(data_dir: &str) -> InfuResult<SessionDb> {
    let mut store_by_user_id = HashMap::new();
    let mut user_id_by_session_id = HashMap::new();

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
        log_path.push(SESSION_LOG_FILENAME);
        let log_path_str = log_path.as_path().to_str().unwrap();
        let store: KVStore<Session> = KVStore::init(&log_path_str, CURRENT_SESSIONS_LOG_VERSION).await?;

        for entry in store.get_iter() {
          user_id_by_session_id.insert(entry.0.clone(), entry.1.user_id.clone());
        }

        store_by_user_id.insert(String::from(dir_userid), store);

      } else {
        warn!("Unexpected directory in store directory: '{}'.", entry.path().display());
        continue;
      }
    }

    Ok(SessionDb {
      data_dir: expanded_data_path,
      store_by_user_id: store_by_user_id,
      user_id_by_session_id,
    })
  }

  pub async fn create(&mut self, user_id: &str) -> InfuResult<()> {
    info!("Creating session db for user {}.", user_id);

    let log_path = self.log_path(user_id)?;
    let log_path_str = log_path.as_path().to_str().unwrap();

    if path_exists(&log_path).await {
      return Err(format!("Session log file '{}' already exists for user '{}'.", log_path_str, user_id).into());
    }

    let store: KVStore<Session> = KVStore::init(log_path_str, CURRENT_SESSIONS_LOG_VERSION).await?;
    self.store_by_user_id.insert(String::from(user_id), store);

    Ok(())
  }

  pub async fn create_session(&mut self, user_id: &str, username: &str) -> InfuResult<Session> {
    const THIRTY_DAYS_AS_SECONDS: u64 = 60*60*24*30;
    let session = Session {
      id: new_uid(),
      user_id: String::from(user_id),
      expires: (SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)? + Duration::from_secs(THIRTY_DAYS_AS_SECONDS)).as_secs() as i64,
      username: String::from(username)
    };
    let store = self.store_by_user_id.get_mut(user_id).ok_or(format!("No session store for user '{}'.", user_id))?;
    store.add(session.clone()).await?;
    self.user_id_by_session_id.insert(session.id.clone(), String::from(user_id));
    Ok(session)
  }

  pub async fn delete_session(&mut self, id: &str) -> InfuResult<String> {
    let user_id = self.user_id_by_session_id.get(id).ok_or(format!("Unknown session id '{}'.", id))?.clone();
    let store = &mut self.store_by_user_id.get_mut(&user_id).ok_or(format!("No session store for user '{}'.", user_id))?;
    let _session = store.get(id).ok_or(format!("Session '{}' does not exist.", id))?;
    if self.user_id_by_session_id.remove(id) == None {
      return Err(format!("Session '{}' has no user_id mapping to remove", id).into());
    }
    store.remove(id).await?;
    Ok(user_id.clone())
  }

  pub fn get_session(&mut self, id: &Uid) -> InfuResult<Option<Session>> {
    let user_id = match self.user_id_by_session_id.get(id) {
      Some(user_id) => user_id.clone(),
      None => return Ok(None),
    };

    let store = match self.store_by_user_id.get_mut(&user_id) {
      Some(store) => store,
      None => return Ok(None),
    };

    match store.get(id) {
      None => {
        // Session record disappeared from the store. Keep indices consistent.
        self.user_id_by_session_id.remove(id);
        Ok(None)
      },
      Some(s) => {
        let now_unix_secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_secs() as i64;
        if s.expires <= now_unix_secs {
          // Expired sessions must not be considered valid.
          self.user_id_by_session_id.remove(id);
          return Ok(None);
        }
        Ok(Some(s.clone()))
      }
    }
  }

  fn log_path(&self, user_id: &str) -> InfuResult<PathBuf> {
    let mut log_path = expand_tilde(&self.data_dir).ok_or("Could not interpret path.")?;
    log_path.push(String::from("user_") + user_id);
    log_path.push(SESSION_LOG_FILENAME);
    Ok(log_path)
  }
}
