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

use infusdk::{db::kv_store::JsonLogSerializable, util::{infu::InfuResult, json, uid::Uid}};
use serde_json::{Map, Value};


const ALL_JSON_FIELDS: [&'static str; 6] = ["__recordType", "id", "userId", "expires", "issuedAt", "username"];
const LEGACY_SESSION_LIFETIME_SECS: i64 = 60 * 60 * 24 * 30;

pub struct Session {
  pub id: Uid,
  pub user_id: Uid,
  pub expires: i64,
  pub issued_at: i64,
  pub username: String,
}

impl Clone for Session {
  fn clone(&self) -> Self {
    Self {
      id: self.id.clone(),
      user_id: self.user_id.clone(),
      expires: self.expires.clone(),
      issued_at: self.issued_at.clone(),
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
    result.insert(String::from("issuedAt"), Value::Number(self.issued_at.into()));
    result.insert(String::from("username"), Value::String(self.username.clone()));
    Ok(result)
  }

  fn from_json(map: &Map<String, Value>) -> InfuResult<Session> {
    json::validate_map_fields(map, &ALL_JSON_FIELDS)?;
    let id = json::get_string_field(map, "id")?.ok_or("'id' field was missing in a session entry record.")?;
    let expires = json::get_integer_field(map, "expires")?
      .ok_or(format!("'expires' field was missing in an entry for session '{}'.", id))?;
    let issued_at = json::get_integer_field(map, "issuedAt")?
      .unwrap_or((expires - LEGACY_SESSION_LIFETIME_SECS).max(0));

    Ok(Session {
      id: id.clone(),
      user_id: json::get_string_field(map, "userId")?
        .ok_or(format!("'userId' field was missing in an entry for session '{}'.", id))?,
      expires,
      issued_at,
      username: json::get_string_field(map, "username")?
        .ok_or(format!("'username' field was missing in an entry for session '{}'.", id))?,
    })
  }

  fn create_json_update(old: &Session, new: &Session) -> InfuResult<Map<String, Value>> {
    if old.id != new.id {
      return Err("Attempt was made to create a Session update record from instances with non-matching ids.".into());
    }
    if old.user_id != new.user_id {
      return Err(format!("Attempt was made to change user_id for session '{}', but this is not allowed.", old.id).into());
    }

    let mut result: Map<String, Value> = Map::new();
    result.insert(String::from("__recordType"), Value::String("update".to_string()));
    result.insert(String::from("id"), Value::String(new.id.clone()));

    if old.expires != new.expires {
      result.insert(String::from("expires"), Value::Number(new.expires.into()));
    }
    if old.issued_at != new.issued_at {
      result.insert(String::from("issuedAt"), Value::Number(new.issued_at.into()));
    }
    if old.username != new.username {
      result.insert(String::from("username"), Value::String(new.username.clone()));
    }

    Ok(result)
  }

  fn apply_json_update(&mut self, map: &Map<String, Value>) -> InfuResult<()> {
    json::validate_map_fields(map, &ALL_JSON_FIELDS)?;
    if let Some(user_id) = json::get_string_field(map, "userId")? {
      return Err(format!("Encountered an update record for session '{}' with user_id='{}', but this is not allowed.", self.id, user_id).into());
    }

    if let Some(expires) = json::get_integer_field(map, "expires")? { self.expires = expires; }
    if let Some(issued_at) = json::get_integer_field(map, "issuedAt")? { self.issued_at = issued_at; }
    if let Some(username) = json::get_string_field(map, "username")? { self.username = username; }
    Ok(())
  }
}
