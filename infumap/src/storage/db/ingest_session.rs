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


const ALL_JSON_FIELDS: [&'static str; 11] = [
  "__recordType",
  "id",
  "userId",
  "deviceName",
  "accessTokenHash",
  "accessExpires",
  "refreshTokenHash",
  "refreshExpires",
  "createdAt",
  "lastUsedAt",
  "revoked",
];

pub struct IngestSession {
  pub id: Uid,
  pub user_id: Uid,
  pub device_name: String,
  pub access_token_hash: String,
  pub access_expires: i64,
  pub refresh_token_hash: String,
  pub refresh_expires: i64,
  pub created_at: i64,
  pub last_used_at: i64,
  pub revoked: bool,
}

impl Clone for IngestSession {
  fn clone(&self) -> Self {
    Self {
      id: self.id.clone(),
      user_id: self.user_id.clone(),
      device_name: self.device_name.clone(),
      access_token_hash: self.access_token_hash.clone(),
      access_expires: self.access_expires,
      refresh_token_hash: self.refresh_token_hash.clone(),
      refresh_expires: self.refresh_expires,
      created_at: self.created_at,
      last_used_at: self.last_used_at,
      revoked: self.revoked,
    }
  }
}

impl JsonLogSerializable<IngestSession> for IngestSession {
  fn value_type_identifier() -> &'static str {
    "ingestSession"
  }

  fn get_id(&self) -> &String {
    &self.id
  }

  fn to_json(&self) -> InfuResult<Map<String, Value>> {
    let mut result = Map::new();
    result.insert(String::from("__recordType"), Value::String(String::from("entry")));
    result.insert(String::from("id"), Value::String(self.id.clone()));
    result.insert(String::from("userId"), Value::String(self.user_id.clone()));
    result.insert(String::from("deviceName"), Value::String(self.device_name.clone()));
    result.insert(String::from("accessTokenHash"), Value::String(self.access_token_hash.clone()));
    result.insert(String::from("accessExpires"), Value::Number(self.access_expires.into()));
    result.insert(String::from("refreshTokenHash"), Value::String(self.refresh_token_hash.clone()));
    result.insert(String::from("refreshExpires"), Value::Number(self.refresh_expires.into()));
    result.insert(String::from("createdAt"), Value::Number(self.created_at.into()));
    result.insert(String::from("lastUsedAt"), Value::Number(self.last_used_at.into()));
    result.insert(String::from("revoked"), Value::Bool(self.revoked));
    Ok(result)
  }

  fn from_json(map: &Map<String, Value>) -> InfuResult<IngestSession> {
    json::validate_map_fields(map, &ALL_JSON_FIELDS)?;
    let id = json::get_string_field(map, "id")?.ok_or("'id' field was missing in an ingest session entry record.")?;

    Ok(IngestSession {
      id: id.clone(),
      user_id: json::get_string_field(map, "userId")?
        .ok_or(format!("'userId' field was missing in an entry for ingest session '{}'.", id))?,
      device_name: json::get_string_field(map, "deviceName")?
        .ok_or(format!("'deviceName' field was missing in an entry for ingest session '{}'.", id))?,
      access_token_hash: json::get_string_field(map, "accessTokenHash")?
        .ok_or(format!("'accessTokenHash' field was missing in an entry for ingest session '{}'.", id))?,
      access_expires: json::get_integer_field(map, "accessExpires")?
        .ok_or(format!("'accessExpires' field was missing in an entry for ingest session '{}'.", id))?,
      refresh_token_hash: json::get_string_field(map, "refreshTokenHash")?
        .ok_or(format!("'refreshTokenHash' field was missing in an entry for ingest session '{}'.", id))?,
      refresh_expires: json::get_integer_field(map, "refreshExpires")?
        .ok_or(format!("'refreshExpires' field was missing in an entry for ingest session '{}'.", id))?,
      created_at: json::get_integer_field(map, "createdAt")?
        .ok_or(format!("'createdAt' field was missing in an entry for ingest session '{}'.", id))?,
      last_used_at: json::get_integer_field(map, "lastUsedAt")?
        .ok_or(format!("'lastUsedAt' field was missing in an entry for ingest session '{}'.", id))?,
      revoked: json::_get_bool_field(map, "revoked")?
        .ok_or(format!("'revoked' field was missing in an entry for ingest session '{}'.", id))?,
    })
  }

  fn create_json_update(old: &IngestSession, new: &IngestSession) -> InfuResult<Map<String, Value>> {
    if old.id != new.id {
      return Err("Attempt was made to create a IngestSession update record from instances with non-matching ids.".into());
    }
    if old.user_id != new.user_id {
      return Err(format!("Attempt was made to change user_id for ingest session '{}', but this is not allowed.", old.id).into());
    }
    if old.created_at != new.created_at {
      return Err(format!("Attempt was made to change created_at for ingest session '{}', but this is not allowed.", old.id).into());
    }

    let mut result: Map<String, Value> = Map::new();
    result.insert(String::from("__recordType"), Value::String("update".to_string()));
    result.insert(String::from("id"), Value::String(new.id.clone()));

    if old.device_name != new.device_name {
      result.insert(String::from("deviceName"), Value::String(new.device_name.clone()));
    }
    if old.access_token_hash != new.access_token_hash {
      result.insert(String::from("accessTokenHash"), Value::String(new.access_token_hash.clone()));
    }
    if old.access_expires != new.access_expires {
      result.insert(String::from("accessExpires"), Value::Number(new.access_expires.into()));
    }
    if old.refresh_token_hash != new.refresh_token_hash {
      result.insert(String::from("refreshTokenHash"), Value::String(new.refresh_token_hash.clone()));
    }
    if old.refresh_expires != new.refresh_expires {
      result.insert(String::from("refreshExpires"), Value::Number(new.refresh_expires.into()));
    }
    if old.last_used_at != new.last_used_at {
      result.insert(String::from("lastUsedAt"), Value::Number(new.last_used_at.into()));
    }
    if old.revoked != new.revoked {
      result.insert(String::from("revoked"), Value::Bool(new.revoked));
    }

    Ok(result)
  }

  fn apply_json_update(&mut self, map: &Map<String, Value>) -> InfuResult<()> {
    json::validate_map_fields(map, &ALL_JSON_FIELDS)?;

    if let Some(_) = json::get_string_field(map, "userId")? {
      return Err(format!("Encountered an update record for ingest session '{}' with user_id specified, but this is not allowed.", self.id).into());
    }
    if let Some(_) = json::get_integer_field(map, "createdAt")? {
      return Err(format!("Encountered an update record for ingest session '{}' with created_at specified, but this is not allowed.", self.id).into());
    }

    if let Some(v) = json::get_string_field(map, "deviceName")? { self.device_name = v; }
    if let Some(v) = json::get_string_field(map, "accessTokenHash")? { self.access_token_hash = v; }
    if let Some(v) = json::get_integer_field(map, "accessExpires")? { self.access_expires = v; }
    if let Some(v) = json::get_string_field(map, "refreshTokenHash")? { self.refresh_token_hash = v; }
    if let Some(v) = json::get_integer_field(map, "refreshExpires")? { self.refresh_expires = v; }
    if let Some(v) = json::get_integer_field(map, "lastUsedAt")? { self.last_used_at = v; }
    if let Some(v) = json::_get_bool_field(map, "revoked")? { self.revoked = v; }

    Ok(())
  }
}
