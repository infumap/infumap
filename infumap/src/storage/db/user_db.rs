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

use infusdk::db::kv_store::JsonLogSerializable;
use infusdk::db::kv_store::KVStore;
use infusdk::util::infu::InfuResult;
use infusdk::util::json;
use infusdk::util::uid::{Uid, is_uid};
use log::{debug, warn};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::path::PathBuf;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, BufReader};

use super::user::User;
use crate::util::fs::expand_tilde;

pub const CURRENT_USER_LOG_VERSION: i64 = 8;

/// Usernames are case insensitive: they are indexed and looked up by this key.
pub fn username_key(username: &str) -> String {
  username.to_lowercase()
}

/// Builds a username index from (username, id) pairs loaded from a log. Earlier versions could
/// create users whose names differ only by case, and only one of them can be found by name. An
/// already lowercase name is preferred so the outcome doesn't depend on directory iteration order.
pub(super) fn build_username_index(mut usernames: Vec<(String, Uid)>) -> HashMap<String, Uid> {
  usernames.sort_by_key(|(username, id)| (*username != username_key(username), id.clone()));
  let mut index = HashMap::new();
  for (username, id) in usernames {
    match index.entry(username_key(&username)) {
      Entry::Vacant(e) => {
        e.insert(id);
      }
      Entry::Occupied(e) => warn!(
        "Username '{}' (user '{}') differs only by case from that of user '{}'. It cannot be looked up by name.",
        username,
        id,
        e.get()
      ),
    }
  }
  index
}

/// Db for managing User instances, assuming the mandated data folder hierarchy.
/// Not thread safe.
pub struct UserDb {
  data_dir: PathBuf,
  store_by_id: HashMap<Uid, KVStore<User>>,
  id_by_lowercase_username: HashMap<String, Uid>,
}

impl UserDb {
  pub async fn init(data_dir: &str) -> InfuResult<UserDb> {
    let mut usernames = vec![];
    let mut store_by_user_id = HashMap::new();

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
      log_path.push("user.json");
      let log_path_str = log_path.as_path().to_str().unwrap();
      let store: KVStore<User> = KVStore::init(&log_path_str, CURRENT_USER_LOG_VERSION).await?;
      let mut iter = store.get_iter();
      let username;
      match iter.next() {
        None => {
          warn!("User store {} contains no users, one expected.", log_path_str);
          continue;
        }
        Some((uid, user)) => {
          if uid != dir_userid {
            warn!("Unexpected user '{}' encountered in log: '{}'. Ignoring.", uid, log_path_str);
            continue;
          }
          username = user.username.clone();
        }
      }
      if iter.next().is_some() {
        warn!("User store {} contains more than one user, one expected. Ignoring all of them.", log_path_str);
        continue;
      }

      usernames.push((username, String::from(dir_userid)));
      store_by_user_id.insert(String::from(dir_userid), store);
    }

    Ok(UserDb {
      data_dir: expanded_data_path,
      store_by_id: store_by_user_id,
      id_by_lowercase_username: build_username_index(usernames),
    })
  }

  pub async fn add(&mut self, user: User) -> InfuResult<()> {
    if self.id_by_lowercase_username.contains_key(&username_key(&user.username)) {
      return Err(format!("User with username '{}' already exists.", user.username).into());
    }
    if is_uid(&user.username) {
      return Err(format!("User has username '{}' which is a uid.", user.username).into());
    }

    self.id_by_lowercase_username.insert(username_key(&user.username), String::from(&user.id));

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
    match self.id_by_lowercase_username.get(&username_key(username)) {
      None => None,
      Some(uid) => match self.store_by_id.get(uid) {
        None => None,
        Some(store) => store.get(uid),
      },
    }
  }

  pub fn get(&self, uid: &Uid) -> Option<&User> {
    match self.store_by_id.get(uid) {
      None => None,
      Some(store) => store.get(uid),
    }
  }

  pub async fn update(&mut self, user: &User) -> InfuResult<()> {
    let old_user = self
      .get(&user.id)
      .ok_or(format!("Request was made to update user with id '{}', but such a user does not exist.", user.id))?
      .clone();

    let update_json_map = User::create_json_update(&old_user, user)?;
    if update_json_map.len() == 2 {
      // "__recordType" and "id" and nothing else.
      debug!("Request was made to update user '{}', but nothing has changed.", user.id);
      return Ok(());
    }

    if update_json_map.keys().any(|key| !matches!(key.as_str(), "__recordType" | "id" | "totpSecret" | "queryProfiles"))
    {
      warn!("Only updating user TOTP secret and query profiles is supported by this method.");
      return Err("Only updating user TOTP secret and query profiles is supported by this method.".into());
    }

    let store = self.store_by_id.get_mut(&user.id).ok_or("unknown user")?;

    store.update(user.clone()).await
  }

  pub async fn update_password_hash_and_salt(
    &mut self,
    user_id: &Uid,
    password_hash: &str,
    password_salt: &str,
  ) -> InfuResult<()> {
    let old_user = self
      .get(user_id)
      .ok_or(format!("Request was made to update password for user '{}', but such a user does not exist.", user_id))?
      .clone();

    let mut new_user = old_user.clone();
    new_user.password_hash = String::from(password_hash);
    new_user.password_salt = String::from(password_salt);

    let update_json_map = User::create_json_update(&old_user, &new_user)?;
    if update_json_map.len() == 2 {
      // "__recordType" and "id" and nothing else.
      debug!("Request was made to update password for user '{}', but nothing has changed.", user_id);
      return Ok(());
    }

    if update_json_map.len() != 4
      || !update_json_map.contains_key("passwordHash")
      || !update_json_map.contains_key("passwordSalt")
    {
      warn!("Currently, only updating user password hash and salt is supported by this method.");
      return Err("Currently, only updating user password hash and salt is supported by this method.".into());
    }

    let store = self.store_by_id.get_mut(user_id).ok_or("unknown user")?;

    store.update(new_user).await
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

pub fn migrate_record_v5_to_v6(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "descriptor" => {
      let descriptor_version =
        json::get_integer_field(kvs, "version")?.ok_or("Descriptor 'version' field is not present.")?;
      if descriptor_version != 5 {
        return Err(format!("Descriptor version is {}, but 5 was expected.", descriptor_version).into());
      }
      let value_type =
        json::get_string_field(kvs, "valueType")?.ok_or("Descriptor 'valueType' field is not present.")?;
      if value_type != User::value_type_identifier() {
        return Err(
          format!("Descriptor value_type is '{}', expecting '{}'.", &value_type, User::value_type_identifier()).into(),
        );
      }
      let mut result = kvs.clone();
      result.insert(String::from("version"), Value::Number((6 as i64).into()));
      Ok(result)
    }

    "entry" | "update" => {
      let mut result = kvs.clone();
      if let Some(queries_page_id) = result.remove("searchesPageId") {
        result.insert(String::from("queriesPageId"), queries_page_id);
      }
      Ok(result)
    }

    "delete" => Ok(kvs.clone()),

    unexpected_record_type => Err(format!("Unknown log record type '{}'.", unexpected_record_type).into()),
  }
}

/// Version 7 adds the optional queryProfiles field to user records. Existing records are unchanged.
pub fn migrate_record_v6_to_v7(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "entry" | "update" | "delete" => Ok(kvs.clone()),
    unexpected_record_type => Err(format!("Unknown log record type '{}'.", unexpected_record_type).into()),
  }
}

/// Version 8 adds the approval policy to every saved profile without relaxing existing approvals.
pub fn migrate_record_v7_to_v8(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str()
  {
    "entry" | "update" => {
      let mut result = kvs.clone();
      if let Some(collection) = result.get_mut("queryProfiles").filter(|collection| !collection.is_null()) {
        let profiles = collection.get_mut("profiles").and_then(Value::as_array_mut).ok_or("Invalid query profiles.")?;
        for profile in profiles {
          crate::query_configuration::upgrade_legacy_configuration(
            profile.get_mut("configuration").ok_or("Profile configuration is missing.")?,
          )?;
        }
      }
      Ok(result)
    }
    "delete" => Ok(kvs.clone()),
    unexpected_record_type => Err(format!("Unknown log record type '{}'.", unexpected_record_type).into()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::query_configuration::{QueryConfiguration, QueryProfile, QueryProfileCollection, QueryProfilePreferences};
  use crate::storage::db::pending_user_db::PendingUserDb;
  use crate::storage::db::user::User;
  use infusdk::db::kv_store::JsonLogSerializable;
  use infusdk::util::uid::new_uid;

  fn user() -> User {
    User {
      id: new_uid(),
      username: "test".to_owned(),
      password_hash: String::new(),
      password_salt: String::new(),
      totp_secret: None,
      home_page_id: new_uid(),
      trash_page_id: new_uid(),
      dock_page_id: new_uid(),
      queries_page_id: new_uid(),
      default_page_width_bl: 60,
      default_page_natural_aspect: 2.0,
      object_encryption_key: String::new(),
      query_profiles: None,
    }
  }

  fn profiles() -> QueryProfileCollection {
    let id = new_uid();
    QueryProfileCollection {
      revision: 3,
      profiles: vec![QueryProfile {
        id: id.clone(),
        name: "Default".to_owned(),
        configuration: QueryConfiguration {
          scope_id: None,
          model: None,
          capabilities: vec!["infumap_data".to_owned()],
          tool_approval: crate::query_configuration::ToolApproval::Automatic,
        },
      }],
      preferences: QueryProfilePreferences {
        default_profile_id: id.clone(),
        pinned_profile_ids: vec![id],
        model_favorites: vec![],
      },
    }
  }

  /// The user log is replayed from the start on every startup, so profile records must round trip exactly.
  #[test]
  fn query_profiles_round_trip_through_entry_and_update_records() {
    let without = user();
    let entry = without.to_json().unwrap();
    assert!(!entry.contains_key("queryProfiles"));
    assert!(User::from_json(&entry).unwrap().query_profiles.is_none());

    let mut with = without.clone();
    with.query_profiles = Some(profiles());
    let update = User::create_json_update(&without, &with).unwrap();
    assert_eq!(update.len(), 3);
    let mut replayed = User::from_json(&entry).unwrap();
    replayed.apply_json_update(&update).unwrap();
    assert_eq!(replayed.query_profiles, with.query_profiles);
    assert_eq!(User::from_json(&with.to_json().unwrap()).unwrap().query_profiles, with.query_profiles);
  }

  #[test]
  fn v6_records_migrate_unchanged() {
    let entry = user().to_json().unwrap();
    assert_eq!(migrate_record_v6_to_v7(&entry).unwrap(), entry);
    let mut descriptor = Map::new();
    descriptor.insert("__recordType".to_owned(), Value::String("descriptor".to_owned()));
    assert!(migrate_record_v6_to_v7(&descriptor).is_err());
  }

  struct TempDir(PathBuf);

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn temp_dir() -> TempDir {
    let dir = TempDir(std::env::temp_dir().join(format!("infumap-user-db-test-{}", new_uid())));
    std::fs::create_dir_all(&dir.0).unwrap();
    dir
  }

  fn user_named(username: &str) -> User {
    let mut u = user();
    u.username = username.to_owned();
    u
  }

  /// The index is rebuilt from the logs on every startup, so lookups must survive a reload.
  #[tokio::test]
  async fn mixed_case_username_is_found_case_insensitively_after_reload() {
    let dir = temp_dir();
    let path = dir.0.to_str().unwrap();
    let matt = user_named("Matt");
    UserDb::init(path).await.unwrap().add(matt.clone()).await.unwrap();

    let mut db = UserDb::init(path).await.unwrap();
    assert_eq!(db.get_by_username_case_insensitive("matt").unwrap().id, matt.id);
    assert_eq!(db.get_by_username_case_insensitive("MATT").unwrap().id, matt.id);
    assert!(db.add(user_named("matt")).await.is_err());
  }

  #[test]
  fn username_index_prefers_lowercase_name_on_collision() {
    let (upper, lower) = (new_uid(), new_uid());
    for order in [vec![("Matt", &upper), ("matt", &lower)], vec![("matt", &lower), ("Matt", &upper)]] {
      let index = build_username_index(order.into_iter().map(|(n, id)| (n.to_owned(), id.clone())).collect());
      assert_eq!(index.len(), 1);
      assert_eq!(index.get("matt"), Some(&lower));
    }
  }

  #[tokio::test]
  async fn mixed_case_pending_user_can_be_found_and_removed() {
    let dir = temp_dir();
    let path = dir.0.to_str().unwrap();

    // Removed in the same run as added.
    let mut db = PendingUserDb::init(path).await.unwrap();
    let first = user_named("Matt");
    db.add(first.clone()).await.unwrap();
    assert!(db.add(user_named("matt")).await.is_err());
    db.remove(&first.id).await.unwrap();
    assert!(db.get_by_username_case_insensitive("matt").is_none());

    // Removed after a reload.
    let second = user_named("Matt");
    db.add(second.clone()).await.unwrap();
    let mut db = PendingUserDb::init(path).await.unwrap();
    assert_eq!(db.get_by_username_case_insensitive("matt").unwrap().id, second.id);
    db.remove(&second.id).await.unwrap();
    assert!(db.get_by_username_case_insensitive("matt").is_none());
  }
}
