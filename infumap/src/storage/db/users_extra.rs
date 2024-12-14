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
use infusdk::util::infu::InfuResult;
use infusdk::util::json;
use infusdk::util::uid::Uid;
use serde_json::{Map, Value};


const ALL_JSON_FIELDS: [&'static str; 4] = ["__recordType",
  "id", "lastBackupTime", "lastFailedBackupTime"];

#[derive(Debug, PartialEq)]
pub enum BackupStatus {
  Failed,
  Succeeded
}

pub struct UserExtra {
  pub id: Uid,
  pub last_backup_time: i64,
  pub last_failed_backup_time: i64,
}

impl UserExtra {
}

impl Clone for UserExtra {
  fn clone(&self) -> Self {
    Self {
      id: self.id.clone(),
      last_backup_time: self.last_backup_time,
      last_failed_backup_time: self.last_failed_backup_time,
    }
  }
}

impl JsonLogSerializable<UserExtra> for UserExtra {
  fn value_type_identifier() -> &'static str {
    "userExtra"
  }

  fn get_id(&self) -> &String {
    &self.id
  }

  fn to_json(&self) -> InfuResult<Map<String, Value>> {
    let mut result = Map::new();
    result.insert(String::from("__recordType"), Value::String(String::from("entry")));
    result.insert(String::from("id"), Value::String(self.id.clone()));
    result.insert(String::from("lastBackupTime"), Value::Number(self.last_backup_time.into()));
    result.insert(String::from("lastFailedBackupTime"), Value::Number(self.last_failed_backup_time.into()));
    Ok(result)
  }

  fn from_json(map: &Map<String, Value>) -> InfuResult<UserExtra> {
    json::validate_map_fields(map, &ALL_JSON_FIELDS)?;
    let id = json::get_string_field(map, "id")?.ok_or("'id' field was missing in a user_extra entry record.")?;

    Ok(UserExtra {
      id: id.clone(),
      last_backup_time: json::get_integer_field(map, "lastBackupTime")?
        .ok_or(format!("'lastBackupTime' field was missing in an entry for user '{}' in user_extra db.", id))?,
      last_failed_backup_time: json::get_integer_field(map, "lastFailedBackupTime")?
        .ok_or(format!("'lastFailedBackupTime' field was missing in an entry for user '{}' in user_extra db.", id))?,
    })
  }

  fn create_json_update(old: &UserExtra, new: &UserExtra) -> InfuResult<Map<String, Value>> {
    if old.id != new.id {
      return Err("Attempt was made to create a UserExtra update record from instances with non-matching ids.".into());
    }
    let mut result: Map<String, Value> = Map::new();
    result.insert(String::from("__recordType"), Value::String("update".to_string()));
    result.insert(String::from("id"), Value::String(new.id.clone()));
    if old.last_backup_time != new.last_backup_time {
      result.insert(String::from("lastBackupTime"), Value::Number(new.last_backup_time.into()));
    }
    if old.last_failed_backup_time != new.last_failed_backup_time {
      result.insert(String::from("lastFailedBackupTime"), Value::Number(new.last_failed_backup_time.into()));
    }
    Ok(result)
  }

  fn apply_json_update(&mut self, map: &Map<String, Value>) -> InfuResult<()> {
    json::validate_map_fields(map, &ALL_JSON_FIELDS)?;
    if let Some(u) = json::get_integer_field(map, "lastBackupTime")? { self.last_backup_time = u; }
    if let Some(u) = json::get_integer_field(map, "lastFailedBackupTime")? { self.last_failed_backup_time = u; }
    Ok(())
  }
}
