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
use std::time::SystemTime;

use infusdk::db::kv_store::KVStore;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::{is_uid, Uid};
use log::{info, warn};

use crate::util::fs::{expand_tilde, path_exists};

use super::ingest_session::IngestSession;

pub const CURRENT_INGEST_SESSIONS_LOG_VERSION: i64 = 1;
const INGEST_SESSIONS_LOG_FILENAME: &str = "ingest_sessions.json";

/// Db for managing IngestSession instances, assuming the mandated data folder hierarchy.
/// Not thread safe.
pub struct IngestSessionDb {
  data_dir: PathBuf,
  store_by_user_id: HashMap<Uid, KVStore<IngestSession>>,
  user_id_by_session_id: HashMap<Uid, Uid>,
  session_id_by_access_hash: HashMap<String, Uid>,
  session_id_by_refresh_hash: HashMap<String, Uid>,
}

impl IngestSessionDb {
  pub async fn init(data_dir: &str) -> InfuResult<IngestSessionDb> {
    let mut store_by_user_id = HashMap::new();
    let mut user_id_by_session_id = HashMap::new();
    let mut session_id_by_access_hash = HashMap::new();
    let mut session_id_by_refresh_hash = HashMap::new();
    let now_unix_secs = Self::now_unix_secs()?;

    let expanded_data_path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
    let mut iter = tokio::fs::read_dir(&expanded_data_path).await?;
    while let Some(entry) = iter.next_entry().await? {
      if !entry.file_type().await?.is_dir() {
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
        log_path.push(INGEST_SESSIONS_LOG_FILENAME);
        let log_path_str = log_path.as_path().to_str().unwrap();
        let store: KVStore<IngestSession> = KVStore::init(&log_path_str, CURRENT_INGEST_SESSIONS_LOG_VERSION).await?;

        for (_, session) in store.get_iter() {
          user_id_by_session_id.insert(session.id.clone(), session.user_id.clone());
          if !session.revoked {
            if session.access_expires > now_unix_secs {
              session_id_by_access_hash.insert(session.access_token_hash.clone(), session.id.clone());
            }
            if session.refresh_expires > now_unix_secs {
              session_id_by_refresh_hash.insert(session.refresh_token_hash.clone(), session.id.clone());
            }
          }
        }

        store_by_user_id.insert(String::from(dir_userid), store);
      } else {
        warn!("Unexpected directory in store directory: '{}'.", entry.path().display());
      }
    }

    Ok(IngestSessionDb {
      data_dir: expanded_data_path,
      store_by_user_id,
      user_id_by_session_id,
      session_id_by_access_hash,
      session_id_by_refresh_hash,
    })
  }

  pub async fn create(&mut self, user_id: &str) -> InfuResult<()> {
    info!("Creating ingest session db for user {}.", user_id);

    let log_path = self.log_path(user_id)?;
    let log_path_str = log_path.as_path().to_str().unwrap();

    if path_exists(&log_path).await {
      return Err(format!("Ingest sessions log file '{}' already exists for user '{}'.", log_path_str, user_id).into());
    }

    let store: KVStore<IngestSession> = KVStore::init(log_path_str, CURRENT_INGEST_SESSIONS_LOG_VERSION).await?;
    self.store_by_user_id.insert(String::from(user_id), store);

    Ok(())
  }

  pub async fn add_session(&mut self, session: IngestSession) -> InfuResult<()> {
    self.ensure_store_for_user(&session.user_id).await?;
    let store = self.store_by_user_id.get_mut(&session.user_id).ok_or(format!("No ingest session store for user '{}'.", session.user_id))?;
    store.add(session.clone()).await?;
    self.user_id_by_session_id.insert(session.id.clone(), session.user_id.clone());
    self.add_indices_for_session(&session, Self::now_unix_secs()?);
    Ok(())
  }

  pub fn list_sessions_for_user(&self, user_id: &str) -> Vec<IngestSession> {
    match self.store_by_user_id.get(user_id) {
      None => vec![],
      Some(store) => store.get_iter().map(|(_, session)| session.clone()).collect(),
    }
  }

  pub fn get_session_by_id(&self, session_id: &str) -> Option<IngestSession> {
    let user_id = self.user_id_by_session_id.get(session_id)?;
    let store = self.store_by_user_id.get(user_id)?;
    store.get(session_id).map(|s| s.clone())
  }

  pub fn get_active_by_access_hash(&mut self, access_hash: &str) -> Option<IngestSession> {
    let session_id = self.session_id_by_access_hash.get(access_hash)?.clone();
    let session = self.get_session_by_id(&session_id)?;

    let now_unix_secs = match Self::now_unix_secs() {
      Ok(v) => v,
      Err(_) => {
        return None;
      }
    };

    if session.revoked || session.access_token_hash != access_hash || session.access_expires <= now_unix_secs {
      self.remove_access_index_if_matches(access_hash, &session_id);
      if session.revoked || session.refresh_expires <= now_unix_secs {
        self.remove_refresh_index_if_matches(&session.refresh_token_hash, &session_id);
      }
      return None;
    }

    if session.refresh_expires <= now_unix_secs {
      self.remove_refresh_index_if_matches(&session.refresh_token_hash, &session_id);
    }

    Some(session)
  }

  pub fn get_active_by_refresh_hash(&mut self, refresh_hash: &str) -> Option<IngestSession> {
    let session_id = self.session_id_by_refresh_hash.get(refresh_hash)?.clone();
    let session = self.get_session_by_id(&session_id)?;

    let now_unix_secs = match Self::now_unix_secs() {
      Ok(v) => v,
      Err(_) => {
        return None;
      }
    };

    if session.revoked || session.refresh_token_hash != refresh_hash || session.refresh_expires <= now_unix_secs {
      self.remove_refresh_index_if_matches(refresh_hash, &session_id);
      if session.revoked || session.access_expires <= now_unix_secs {
        self.remove_access_index_if_matches(&session.access_token_hash, &session_id);
      }
      return None;
    }

    if session.access_expires <= now_unix_secs {
      self.remove_access_index_if_matches(&session.access_token_hash, &session_id);
    }

    Some(session)
  }

  pub async fn update_session(&mut self, session: IngestSession) -> InfuResult<()> {
    let user_id = self.user_id_by_session_id.get(&session.id)
      .ok_or(format!("Unknown ingest session id '{}'.", session.id))?
      .clone();

    if user_id != session.user_id {
      return Err(format!(
        "User id mismatch for ingest session '{}': existing user '{}', incoming '{}'.",
        session.id, user_id, session.user_id).into());
    }

    let old_session = self.get_session_by_id(&session.id)
      .ok_or(format!("Ingest session '{}' does not exist.", session.id))?;
    self.remove_indices_for_session(&old_session);

    let store = self.store_by_user_id.get_mut(&session.user_id)
      .ok_or(format!("No ingest session store for user '{}'.", session.user_id))?;
    store.update(session.clone()).await?;

    self.add_indices_for_session(&session, Self::now_unix_secs()?);
    Ok(())
  }

  pub async fn revoke_session(&mut self, user_id: &str, session_id: &str) -> InfuResult<()> {
    let mut session = self.get_session_by_id(session_id)
      .ok_or(format!("Unknown ingest session id '{}'.", session_id))?;
    if session.user_id != user_id {
      return Err(format!("Ingest session '{}' does not belong to user '{}'.", session_id, user_id).into());
    }
    if session.revoked {
      return Ok(());
    }
    session.revoked = true;
    session.last_used_at = Self::now_unix_secs()?;
    self.update_session(session).await
  }

  async fn ensure_store_for_user(&mut self, user_id: &str) -> InfuResult<()> {
    if self.store_by_user_id.contains_key(user_id) {
      return Ok(());
    }

    let log_path = self.log_path(user_id)?;
    let log_path_str = log_path.as_path().to_str().unwrap();
    let store: KVStore<IngestSession> = KVStore::init(log_path_str, CURRENT_INGEST_SESSIONS_LOG_VERSION).await?;
    self.store_by_user_id.insert(String::from(user_id), store);
    Ok(())
  }

  fn add_indices_for_session(&mut self, session: &IngestSession, now_unix_secs: i64) {
    if session.revoked {
      return;
    }
    if session.access_expires > now_unix_secs {
      self.session_id_by_access_hash.insert(session.access_token_hash.clone(), session.id.clone());
    }
    if session.refresh_expires > now_unix_secs {
      self.session_id_by_refresh_hash.insert(session.refresh_token_hash.clone(), session.id.clone());
    }
  }

  fn remove_indices_for_session(&mut self, session: &IngestSession) {
    self.remove_access_index_if_matches(&session.access_token_hash, &session.id);
    self.remove_refresh_index_if_matches(&session.refresh_token_hash, &session.id);
  }

  fn remove_access_index_if_matches(&mut self, access_hash: &str, session_id: &str) {
    if let Some(mapped_session_id) = self.session_id_by_access_hash.get(access_hash) {
      if mapped_session_id == session_id {
        self.session_id_by_access_hash.remove(access_hash);
      }
    }
  }

  fn remove_refresh_index_if_matches(&mut self, refresh_hash: &str, session_id: &str) {
    if let Some(mapped_session_id) = self.session_id_by_refresh_hash.get(refresh_hash) {
      if mapped_session_id == session_id {
        self.session_id_by_refresh_hash.remove(refresh_hash);
      }
    }
  }

  fn now_unix_secs() -> InfuResult<i64> {
    Ok(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_secs() as i64)
  }

  fn log_path(&self, user_id: &str) -> InfuResult<PathBuf> {
    let mut log_path = expand_tilde(&self.data_dir).ok_or("Could not interpret path.")?;
    log_path.push(String::from("user_") + user_id);
    log_path.push(INGEST_SESSIONS_LOG_FILENAME);
    Ok(log_path)
  }
}
