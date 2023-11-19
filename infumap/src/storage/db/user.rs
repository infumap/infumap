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

use serde_json::{Map, Value, Number};
use sha2::{Sha256, Digest};

use crate::util::infu::InfuResult;
use crate::util::str::encode_hex;
use crate::util::uid::Uid;
use crate::util::json;
use super::kv_store::JsonLogSerializable;


pub const ROOT_USER_NAME: &'static str = "root";


const ALL_JSON_FIELDS: [&'static str; 12] = ["__recordType",
  "id", "username", "passwordHash", "passwordSalt", "totpSecret",
  "homePageId", "defaultPageWidthBl", "defaultPageNaturalAspect",
  "objectEncryptionKey", "trashPageId", "briefcasePageId"];

pub struct User {
  pub id: Uid,
  pub username: Uid,
  pub password_hash: String,
  pub password_salt: String,
  pub totp_secret: Option<String>,
  pub home_page_id: Uid,
  pub trash_page_id: Uid,
  pub briefcase_page_id: Uid,
  pub default_page_width_bl: i64,
  pub default_page_natural_aspect: f64,
  pub object_encryption_key: String,
}

impl User {
  pub fn compute_password_hash(password_salt: &str, password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}-{}", password, password_salt));
    encode_hex(hasher.finalize().as_slice())
  }
}

impl Clone for User {
  fn clone(&self) -> Self {
    Self {
      id: self.id.clone(),
      username: self.username.clone(),
      password_hash: self.password_hash.clone(),
      password_salt: self.password_salt.clone(),
      totp_secret: self.totp_secret.clone(),
      home_page_id: self.home_page_id.clone(),
      trash_page_id: self.trash_page_id.clone(),
      briefcase_page_id: self.briefcase_page_id.clone(),
      default_page_width_bl: self.default_page_width_bl,
      default_page_natural_aspect: self.default_page_natural_aspect,
      object_encryption_key: self.object_encryption_key.clone()
    }
  }
}

impl JsonLogSerializable<User> for User {
  fn value_type_identifier() -> &'static str {
    "user"
  }

  fn get_id(&self) -> &String {
    &self.id
  }

  fn to_json(&self) -> InfuResult<Map<String, Value>> {
    let mut result = Map::new();
    result.insert(String::from("__recordType"), Value::String(String::from("entry")));
    result.insert(String::from("id"), Value::String(self.id.clone()));
    result.insert(String::from("username"), Value::String(self.username.clone()));
    result.insert(String::from("passwordHash"), Value::String(self.password_hash.clone()));
    result.insert(String::from("passwordSalt"), Value::String(self.password_salt.clone()));
    if let Some(totp_secret) = &self.totp_secret {
      result.insert(String::from("totpSecret"), Value::String(totp_secret.clone()));
    }
    result.insert(String::from("homePageId"), Value::String(self.home_page_id.clone()));
    result.insert(String::from("trashPageId"), Value::String(self.trash_page_id.clone()));
    result.insert(String::from("briefcasePageId"), Value::String(self.briefcase_page_id.clone()));
    result.insert(String::from("defaultPageWidthBl"), Value::Number(self.default_page_width_bl.into()));
    result.insert(
      String::from("defaultPageNaturalAspect"),
      Value::Number(Number::from_f64(self.default_page_natural_aspect)
        .ok_or(format!("default_page_natural_aspect for user '{}' is not a number", self.id))?));
    result.insert(String::from("objectEncryptionKey"), Value::String(self.object_encryption_key.clone()));
    Ok(result)
  }

  fn from_json(map: &Map<String, Value>) -> InfuResult<User> {
    json::validate_map_fields(map, &ALL_JSON_FIELDS)?;
    let id = json::get_string_field(map, "id")?.ok_or("'id' field was missing in a user entry record.")?;

    Ok(User {
      id: id.clone(),
      username: json::get_string_field(map, "username")?
        .ok_or(format!("'username' field was missing in an entry for user '{}'.", id))?,
      password_hash: json::get_string_field(map, "passwordHash")?
        .ok_or(format!("'passwordHash' field was missing in an entry for user '{}'.", id))?,
      password_salt: json::get_string_field(map, "passwordSalt")?
        .ok_or(format!("'passwordSalt' field was missing in an entry for user '{}'.", id))?,
      totp_secret: json::get_string_field(map, "totpSecret")?,
      home_page_id: json::get_string_field(map, "homePageId")?
        .ok_or(format!("'homePageId' field was missing in an entry for user '{}'.", id))?,
      trash_page_id: json::get_string_field(map, "trashPageId")?
        .ok_or(format!("'trashPageId' field was missing in an entry for user '{}'.", id))?,
      briefcase_page_id: json::get_string_field(map, "briefcasePageId")?
        .ok_or(format!("'briefcasePageId' field was missing in an entry for user '{}'.", id))?,
      default_page_width_bl: json::get_integer_field(map, "defaultPageWidthBl")?
        .ok_or(format!("'defaultPageWidthBl' field was missing in an entry for user '{}'.", id))?,
      default_page_natural_aspect: json::get_float_field(map, "defaultPageNaturalAspect")?
        .ok_or(format!("'defaultPageNaturalAspect' field was missing in an entry for user '{}'.", id))?,
      object_encryption_key: json::get_string_field(map, "objectEncryptionKey")?
        .ok_or(format!("'objectEncryptionKey' was missing in entry for user '{}'.", id))?
    })
  }

  fn create_json_update(old: &User, new: &User) -> InfuResult<Map<String, Value>> {
    if old.id != new.id {
      return Err("Attempt was made to create a User update record from instances with non-matching ids.".into());
    }
    let mut result: Map<String, Value> = Map::new();
    result.insert(String::from("__recordType"), Value::String("update".to_string()));
    result.insert(String::from("id"), Value::String(new.id.clone()));

    if old.password_hash != new.password_hash {
      result.insert(String::from("passwordHash"), Value::String(new.password_hash.to_string()));
    }
    if old.password_salt != new.password_salt {
      result.insert(String::from("passwordSalt"), Value::String(new.password_salt.to_string()));
    }
    if let Some(new_totp_secret) = &new.totp_secret {
      if match &old.totp_secret { Some(o) => o != new_totp_secret, None => { true } } {
        result.insert(String::from("totpSecret"), Value::String(new_totp_secret.clone()));
      }
    } else {
      if old.totp_secret.is_some() {
        result.insert(String::from("totpSecret"), Value::Null);
      }
    }
    if old.home_page_id != new.home_page_id {
      result.insert(String::from("homePageId"), Value::String(new.home_page_id.to_string()));
    }
    if old.trash_page_id != new.trash_page_id {
      result.insert(String::from("trashPageId"), Value::String(new.trash_page_id.to_string()));
    }
    if old.briefcase_page_id != new.briefcase_page_id {
      result.insert(String::from("briefcasePageId"), Value::String(new.briefcase_page_id.to_string()));
    }
    if old.default_page_width_bl != new.default_page_width_bl {
      result.insert(String::from("defaultPageWidthBl"), Value::Number(new.default_page_width_bl.into()));
    }
    if old.default_page_natural_aspect != new.default_page_natural_aspect {
      result.insert(String::from("defaultPageNaturalAspect"), Value::Number(new.default_page_width_bl.into()));
    }
    if old.object_encryption_key != new.object_encryption_key {
      return Err(format!("Attempt was made to update ojbect encryption key for item '{}', but this is not allowed.", old.id).into());
    }
    Ok(result)
  }

  fn apply_json_update(&mut self, map: &Map<String, Value>) -> InfuResult<()> {
    json::validate_map_fields(map, &ALL_JSON_FIELDS)?;
    if let Some(u) = json::get_string_field(map, "username")? { self.username = u; }
    if let Some(u) = json::get_string_field(map, "passwordHash")? { self.password_hash = u; }
    if let Some(u) = json::get_string_field(map, "passwordSalt")? { self.password_salt = u; }
    self.totp_secret = json::get_string_field(map, "totpSecret")?;
    if let Some(u) = json::get_string_field(map, "homePageId")? { self.home_page_id = u; }
    if let Some(u) = json::get_string_field(map, "trashPageId")? { self.trash_page_id = u; }
    if let Some(u) = json::get_string_field(map, "briefcasePageId")? { self.briefcase_page_id = u; }
    if let Some(u) = json::get_integer_field(map, "defaultPageWidthBl")? { self.default_page_width_bl = u; }
    if let Some(u) = json::get_float_field(map, "defaultPageNaturalAspect")? { self.default_page_natural_aspect = u; }
    if let Some(_) = json::get_string_field(map, "objectEncryptionKey")? {
      return Err(format!("Encounterd an update record for user '{}' with an object encryption key specified, but this is not allowed.", self.id).into());
    }
    Ok(())
  }
}
