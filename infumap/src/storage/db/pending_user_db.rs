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

use std::collections::HashMap;
use std::collections::hash_map::Iter;

use serde_json::{Map, Value};

use crate::util::fs::expand_tilde;
use crate::util::infu::InfuResult;
use crate::util::json;
use super::kv_store::KVStore;
use super::user::User;
use super::kv_store::JsonLogSerializable;


const CURRENT_USER_LOG_VERSION: i64 = 2;


/// Db for User instances.
/// Not threadsafe.
pub struct PendingUserDb {
  store: KVStore<User>,
  id_by_username: HashMap<String, String>
}

impl PendingUserDb {
  pub async fn init(db_dir: &str) -> InfuResult<PendingUserDb> {
    let mut log_path = expand_tilde(db_dir).ok_or("Could not interpret path.")?;
    log_path.push("pending_users.json");

    let store: KVStore<User> = KVStore::init(log_path.as_path().to_str().unwrap(), CURRENT_USER_LOG_VERSION).await?;
    let mut id_by_username = HashMap::new();
    for (id, user) in store.get_iter() {
      id_by_username.insert(user.username.clone(), id.clone());
    }
    Ok(PendingUserDb { store, id_by_username })
  }

  pub async fn add(&mut self, user: User) -> InfuResult<()> {
    if self.id_by_username.contains_key(&user.username) {
      return Err(format!("User with username '{}' already exists.", user.username).into());
    } else {
      self.id_by_username.insert(String::from(&user.username), String::from(&user.id));
    }
    self.store.add(user).await
  }

  pub fn _get_iter(&self) -> Iter<String, User> {
    self.store.get_iter()
  }

  pub fn _get_by_id(&self, id: &str) -> Option<&User> {
    self.store.get(id)
  }

  pub fn get_by_username(&self, username: &str) -> Option<&User> {
    match self.id_by_username.get(username) {
      None => None,
      Some(id) => self.store.get(id)
    }
  }
}


pub fn migrate_record_v1_to_v2(kvs: &Map<String, Value>) -> InfuResult<Map<String, Value>> {
  match json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str() {
    "descriptor" => {
      let descriptor_version = json::get_integer_field(kvs, "version")?.ok_or("Descriptor 'version' field is not present.")?;
      if descriptor_version != 1 {
        return Err(format!("Descriptor version is {}, but 1 was expected.", descriptor_version).into());
      }
      let value_type = json::get_string_field(kvs, "valueType")?.ok_or("Descriptor 'valueType' field is not present.")?;
      if value_type != User::value_type_identifier() {
        return Err(format!("Descriptor value_type is '{}', expecting '{}'.", &value_type, User::value_type_identifier()).into());
      }
      let mut result = kvs.clone();
      result.insert(String::from("version"), Value::Number((2 as i64).into()));
      return Ok(result);
    },

    "entry" => {
      let mut result = kvs.clone();
      result.remove(&String::from("__version"));
      return Ok(result);
    },

    "update" => {
      let mut result = kvs.clone();
      result.remove(&String::from("__version"));
      return Ok(result);
    },

    "delete" => {
      let mut result = kvs.clone();
      result.remove(&String::from("__version"));
      return Ok(result);
    },

    unexpected_record_type => {
      return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
    }
  }
}
