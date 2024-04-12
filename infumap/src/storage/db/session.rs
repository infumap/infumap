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

use infusdk::util::{infu::InfuResult, uid::Uid};
use serde_json::{Map, Value};

use crate::util::json;
use super::kv_store::JsonLogSerializable;


const ALL_JSON_FIELDS: [&'static str; 5] = ["__recordType", "id", "userId", "expires", "username"];

pub struct Session {
  pub id: Uid,
  pub user_id: Uid,
  pub expires: i64,
  pub username: String,
}

impl Clone for Session {
  fn clone(&self) -> Self {
    Self {
      id: self.id.clone(),
      user_id: self.user_id.clone(),
      expires: self.expires.clone(),
      username: self.username.clone(),
    }
  }
}


impl JsonLogSerializable<Session> for Session {
  fn value_type_identifier() -> &'static str {
    "session"
  }

  fn get_id(&self) -> &String {
    &self.id
  }

  fn to_json(&self) -> InfuResult<Map<String, Value>> {
    let mut result = Map::new();
    result.insert(String::from("__recordType"), Value::String(String::from("entry")));
    result.insert(String::from("id"), Value::String(self.id.clone()));
    result.insert(String::from("userId"), Value::String(self.user_id.clone()));
    result.insert(String::from("expires"), Value::Number(self.expires.into()));
    result.insert(String::from("username"), Value::String(self.username.clone()));
    Ok(result)
  }

  fn from_json(map: &Map<String, Value>) -> InfuResult<Session> {
    json::validate_map_fields(map, &ALL_JSON_FIELDS)?;
    let id = json::get_string_field(map, "id")?.ok_or("'id' field was missing in a session entry record.")?;

    Ok(Session {
      id: id.clone(),
      user_id: json::get_string_field(map, "userId")?
        .ok_or(format!("'userId' field was missing in an entry for session '{}'.", id))?,
      expires: json::get_integer_field(map, "expires")?
        .ok_or(format!("'expires' field was missing in an entry for session '{}'.", id))?,
      username: json::get_string_field(map, "username")?
        .ok_or(format!("'username' field was missing in an entry for session '{}'.", id))?,
    })
  }

  fn create_json_update(_old: &Session, _new: &Session) -> InfuResult<Map<String, Value>> {
    return Err("Attempt was made to create a Session update record, but sessions cannot be updated.".into());
  }

  fn apply_json_update(&mut self, _map: &Map<String, Value>) -> InfuResult<()> {
    return Err("Attempt was made to update a Session, but sessions cannot be updated.".into());
  }
}
