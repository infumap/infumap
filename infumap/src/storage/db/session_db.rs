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

use infusdk::db::kv_store::KVStore;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::{Uid, is_uid, new_uid};
use log::{debug, info, warn};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::SystemTime;

use super::session::Session;
use crate::util::fs::{expand_tilde, path_exists};

pub const CURRENT_SESSIONS_LOG_VERSION: i64 = 1;
const SESSION_LOG_FILENAME: &str = "sessions.json";
pub const SESSION_LIFETIME_SECS: i64 = 60 * 60 * 24 * 30;
pub const SESSION_ROTATION_INTERVAL_SECS: i64 = 60 * 60 * 24;
const SESSION_ROTATION_GRACE_SECS: i64 = 60 * 2;

/// Db for managing Session instances, assuming the mandated data folder hierarchy.
/// Not thread safe.
pub struct SessionDb {
  data_dir: PathBuf,
  store_by_user_id: HashMap<Uid, KVStore<Session>>,
  user_id_by_session_id: HashMap<Uid, Uid>,
}

impl SessionDb {
  pub async fn init(data_dir: &str) -> InfuResult<SessionDb> {
    let mut store_by_user_id = HashMap::new();
    let mut user_id_by_session_id = HashMap::new();

    let expanded_data_path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
    let mut iter = tokio::fs::read_dir(&expanded_data_path).await?;
    loop {
      let next_entry = iter.next_entry().await?;
      let Some(entry) = next_entry else {
        break;
      };
      let file_type = entry.file_type().await?;
      if !file_type.is_dir() {
        // pending users log is in the data directory as well.
        continue;
      }

      let entry_name = entry.file_name();
      let Some(dirname) = entry_name.to_str() else {
        warn!("Unexpected directory in store directory: '{}'.", entry.path().display());
        continue;
      };
      // Ignore leftover metadata from the retired search processing store.
      if dirname == "search_processing" {
        continue;
      }
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
    }

    Ok(SessionDb { data_dir: expanded_data_path, store_by_user_id: store_by_user_id, user_id_by_session_id })
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
    let now_unix_secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_secs() as i64;
    let session = Session {
      id: new_uid(),
      user_id: String::from(user_id),
      expires: now_unix_secs + SESSION_LIFETIME_SECS,
      issued_at: now_unix_secs,
      username: String::from(username),
      successor_id: None,
      predecessor_id: None,
    };
    let store = self.store_by_user_id.get_mut(user_id).ok_or(format!("No session store for user '{}'.", user_id))?;
    store.add(session.clone()).await?;
    self.user_id_by_session_id.insert(session.id.clone(), String::from(user_id));
    Ok(session)
  }

  /// Called after each successful request authenticated with session `id`. Returns the session whose id the
  /// client should be sent (via cookie or header) in place of `id`, if any.
  ///
  /// Rotation is two-phase so that a client which never receives or never persists the new id (e.g. the
  /// response is lost when an iOS web app is suspended) isn't logged out: the prior session stays fully valid,
  /// and its successor keeps being re-sent, until the client first presents the successor. Only then does the
  /// prior session's short grace period start.
  pub async fn rotate_session_if_due(&mut self, id: &Uid, min_age_secs: i64) -> InfuResult<Option<Session>> {
    let user_id = match self.user_id_by_session_id.get(id) {
      Some(user_id) => user_id.clone(),
      None => return Ok(None),
    };

    let store = match self.store_by_user_id.get_mut(&user_id) {
      Some(store) => store,
      None => return Ok(None),
    };

    let existing = match store.get(id) {
      Some(s) => s.clone(),
      None => {
        self.user_id_by_session_id.remove(id);
        return Ok(None);
      }
    };

    let now_unix_secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_secs() as i64;
    if existing.expires <= now_unix_secs {
      self.user_id_by_session_id.remove(id);
      return Ok(None);
    }

    // Already rotated: keep re-sending the successor until the client uses it. Never issue a second one.
    if let Some(successor_id) = &existing.successor_id {
      return Ok(match store.get(successor_id) {
        Some(successor) if successor.expires > now_unix_secs => {
          debug!("Re-sending successor '{}' of session '{}'.", successor_id, id);
          Some(successor.clone())
        }
        _ => None,
      });
    }

    // First use of a rotated session confirms the client has it: start the predecessor's grace period, which
    // only remains so that in-flight parallel requests made with the prior cookie/header don't fail.
    if let Some(predecessor_id) = &existing.predecessor_id {
      if let Some(predecessor) = store.get(predecessor_id) {
        let grace_expires = now_unix_secs + SESSION_ROTATION_GRACE_SECS;
        if predecessor.expires > grace_expires {
          info!(
            "Session '{}' for user '{}' confirmed {}s after rotation; prior session '{}' expires in {}s.",
            id,
            user_id,
            now_unix_secs - existing.issued_at,
            predecessor_id,
            SESSION_ROTATION_GRACE_SECS
          );
          let mut predecessor = predecessor.clone();
          predecessor.expires = grace_expires;
          store.update(predecessor).await?;
        }
      }
    }

    if now_unix_secs - existing.issued_at < min_age_secs {
      return Ok(None);
    }

    let rotated = Session {
      id: new_uid(),
      user_id: existing.user_id.clone(),
      expires: existing.expires,
      issued_at: now_unix_secs,
      username: existing.username.clone(),
      successor_id: None,
      predecessor_id: Some(existing.id.clone()),
    };
    let mut rotated_existing = existing.clone();
    rotated_existing.successor_id = Some(rotated.id.clone());

    store.add(rotated.clone()).await?;
    store.update(rotated_existing).await?;
    self.user_id_by_session_id.insert(rotated.id.clone(), user_id.clone());
    info!("Rotated session '{}' for user '{}' to '{}'.", id, user_id, rotated.id);
    Ok(Some(rotated))
  }

  /// Deletes the session along with any sessions linked to it by rotation, so that e.g. logging out with a
  /// prior session id doesn't leave its successor usable.
  pub async fn delete_session(&mut self, id: &str) -> InfuResult<String> {
    let user_id = self.user_id_by_session_id.get(id).ok_or(format!("Unknown session id '{}'.", id))?.clone();
    let store =
      &mut self.store_by_user_id.get_mut(&user_id).ok_or(format!("No session store for user '{}'.", user_id))?;
    let _session = store.get(id).ok_or(format!("Session '{}' does not exist.", id))?;
    if self.user_id_by_session_id.remove(id) == None {
      return Err(format!("Session '{}' has no user_id mapping to remove", id).into());
    }
    let removed = store.remove(id).await?;

    let mut linked_ids: Vec<Uid> = removed.successor_id.into_iter().chain(removed.predecessor_id).collect();
    while let Some(linked_id) = linked_ids.pop() {
      if store.get(&linked_id).is_none() {
        continue;
      }
      let linked = store.remove(&linked_id).await?;
      self.user_id_by_session_id.remove(&linked_id);
      linked_ids.extend(linked.successor_id.into_iter().chain(linked.predecessor_id));
    }

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
      }
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

#[cfg(test)]
mod tests {
  use super::*;

  struct TempDir(PathBuf);

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  async fn setup() -> (TempDir, SessionDb, Uid) {
    let dir = TempDir(std::env::temp_dir().join(format!("infumap-session-db-test-{}", new_uid())));
    let user_id = new_uid();
    std::fs::create_dir_all(dir.0.join(format!("user_{}", user_id))).unwrap();
    let db = SessionDb::init(dir.0.to_str().unwrap()).await.unwrap();
    (dir, db, user_id)
  }

  fn now() -> i64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64
  }

  #[tokio::test]
  async fn prior_session_stays_valid_until_successor_is_used() {
    let (_dir, mut db, user_id) = setup().await;
    let a = db.create_session(&user_id, "test").await.unwrap();

    let b = db.rotate_session_if_due(&a.id, 0).await.unwrap().unwrap();
    assert_ne!(b.id, a.id);

    // Client never received b: a keeps working, and b (not a new session) is re-sent.
    let resent = db.rotate_session_if_due(&a.id, 0).await.unwrap().unwrap();
    assert_eq!(resent.id, b.id);
    assert_eq!(db.get_session(&a.id).unwrap().unwrap().expires, a.expires);

    // Client uses b: a enters its grace period, b is not rotated again yet.
    assert!(db.rotate_session_if_due(&b.id, SESSION_ROTATION_INTERVAL_SECS).await.unwrap().is_none());
    let a_after = db.get_session(&a.id).unwrap().unwrap();
    assert!(a_after.expires <= now() + SESSION_ROTATION_GRACE_SECS);
    assert_eq!(db.get_session(&b.id).unwrap().unwrap().expires, a.expires);

    // In-flight requests with a during the grace period are still pointed at b.
    assert_eq!(db.rotate_session_if_due(&a.id, 0).await.unwrap().unwrap().id, b.id);
  }

  #[tokio::test]
  async fn deleting_either_session_deletes_both() {
    let (_dir, mut db, user_id) = setup().await;
    let a = db.create_session(&user_id, "test").await.unwrap();
    let b = db.rotate_session_if_due(&a.id, 0).await.unwrap().unwrap();
    db.delete_session(&a.id).await.unwrap();
    assert!(db.get_session(&b.id).unwrap().is_none());

    let c = db.create_session(&user_id, "test").await.unwrap();
    let d = db.rotate_session_if_due(&c.id, 0).await.unwrap().unwrap();
    db.delete_session(&d.id).await.unwrap();
    assert!(db.get_session(&c.id).unwrap().is_none());
  }

  #[tokio::test]
  async fn rotation_links_survive_reload() {
    let (dir, mut db, user_id) = setup().await;
    let a = db.create_session(&user_id, "test").await.unwrap();
    let b = db.rotate_session_if_due(&a.id, 0).await.unwrap().unwrap();
    drop(db);

    let mut db = SessionDb::init(dir.0.to_str().unwrap()).await.unwrap();
    assert_eq!(db.rotate_session_if_due(&a.id, 0).await.unwrap().unwrap().id, b.id);
    assert_eq!(db.get_session(&b.id).unwrap().unwrap().predecessor_id, Some(a.id.clone()));
  }
}
