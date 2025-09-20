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

use std::any::Any;
use std::collections::HashMap;
use std::collections::hash_map::Iter;
use crate::util::infu::{InfuError, InfuResult};
use crate::util::uid::Uid;
use tokio::fs::{File, OpenOptions};

use serde::ser::SerializeStruct;
use serde::Serialize;
use serde_json::{self, Value, Map};
use serde_json::Value::Object;
use tokio::io::{BufWriter, BufReader, AsyncBufReadExt};
use tokio::io::AsyncWriteExt;



pub trait JsonLogSerializable<T> {
  fn value_type_identifier() -> &'static str;

  fn get_id(&self) -> &Uid;

  fn to_json(&self) -> InfuResult<Map<String, Value>>;
  fn from_json(map: &Map<String, Value>) -> InfuResult<T>;

  fn create_json_update(old: &T, new: &T) -> InfuResult<Map<String, Value>>;
  fn apply_json_update(&mut self, map: &Map<String, Value>) -> InfuResult<()>;
}


struct DescriptorRecord {
  version: i64,
  value_type: String
}

impl Serialize for DescriptorRecord {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error> where S: serde::Serializer {
    const NUM_FIELDS: usize = 3;
    let mut state = serializer.serialize_struct("Descriptor", NUM_FIELDS)?;
    state.serialize_field("__recordType", "descriptor")?;
    state.serialize_field("version", &self.version)?;
    state.serialize_field("valueType", &self.value_type)?;
    state.end()
  }
}


struct DeleteRecord {
  id: String
}

impl Serialize for DeleteRecord {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error> where S: serde::Serializer {
    const NUM_FIELDS: usize = 2;
    let mut state = serializer.serialize_struct("DeleteRecord", NUM_FIELDS)?;
    state.serialize_field("__recordType", "delete")?;
    state.serialize_field("id", &self.id)?;
    state.end()
  }
}


/// A pretty naive KV store implementation, but it'll probably be good enough indefinitely.
/// TODO (MEDIUM): Lock mechanism to ensure only one KVStore instance is accessing files at any given time.
pub struct KVStore<T> where T: JsonLogSerializable<T> {
  log_path: String,
  map: HashMap<String, T>
}

impl<T> KVStore<T> where T: JsonLogSerializable<T> {
  pub async fn init(path: &str, version: i64) -> InfuResult<KVStore<T>> {
    if !std::path::Path::new(path).exists() {
      let file = File::create(path).await?;
      let mut writer = BufWriter::new(file);
      let descriptor = DescriptorRecord { value_type: String::from(T::value_type_identifier()), version };
      writer.write_all(serde_json::to_string(&descriptor)?.as_bytes()).await?;
      writer.write_all("\n".as_bytes()).await?;
      writer.flush().await?;
    }
    let map = Self::read_log(path, version).await?;
    Ok(Self { log_path: String::from(path), map })
  }

  pub async fn add(&mut self, entry: T) -> InfuResult<()> {
    if self.map.contains_key(entry.get_id()) {
      return Err(format!("Entry with id {} already exists.", entry.get_id()).into());
    }
    let file = OpenOptions::new().append(true).open(&self.log_path).await?;
    let mut writer = BufWriter::new(file);
    writer.write_all(serde_json::to_string(&entry.to_json()?)?.as_bytes()).await?;
    writer.write_all("\n".as_bytes()).await?;
    writer.flush().await?;
    self.map.insert(entry.get_id().clone(), entry);
    Ok(())
  }

  pub async fn remove(&mut self, id: &str) -> InfuResult<T> {
    let itm = self.map.remove(id).ok_or(format!("Entry with id {} does not exist.", id))?;
    let file = OpenOptions::new().append(true).open(&self.log_path).await?;
    let mut writer = BufWriter::new(file);
    let delete_record = DeleteRecord { id: String::from(id) };
    writer.write_all(serde_json::to_string(&delete_record)?.as_bytes()).await?;
    writer.write_all("\n".as_bytes()).await?;
    writer.flush().await?;
    Ok(itm)
  }

  pub fn get_iter(&self) -> Iter<'_, String, T> {
    self.map.iter()
  }

  pub fn get(&self, id: &str) -> Option<&T> {
    self.map.get(id)
  }

  pub async fn update(&mut self, updated: T) -> InfuResult<()> {
    let old = self.map.get(updated.get_id()).ok_or(format!("Entry with id {} does not exist.", updated.get_id()))?;
    let update_record = T::create_json_update(old, &updated)?;
    let file = OpenOptions::new().append(true).open(&self.log_path).await?;
    let mut writer = BufWriter::new(file);
    writer.write_all(serde_json::to_string(&update_record)?.as_bytes()).await?;
    writer.write_all("\n".as_bytes()).await?;
    writer.flush().await?;
    self.map.insert(updated.get_id().clone(), updated);
    Ok(())
  }

  fn read_log_record(result: &mut HashMap<String, T>, kvs: &Map<String, Value>, expected_version: i64) -> InfuResult<()> {
    let record_type = kvs
      .get("__recordType")
      .ok_or(InfuError::new("Log record is missing field __recordType."))?
      .as_str()
      .ok_or(InfuError::new("Log record type field is not of type 'string'."))?;

    match record_type {
      "descriptor" => {
        // Subsequent records in the log conform to this descriptor.
        let descriptor_version = kvs
          .get("version")
          .ok_or(InfuError::new("Descriptor log record does not specify a version."))?
          .as_i64()
          .ok_or(InfuError::new("Descriptor version does not have type 'number'."))?;
        if descriptor_version != expected_version {
          return Err(format!("Descriptor version is {}, but {} was expected.", descriptor_version, expected_version).into());
        }
        let value_type = kvs
          .get("valueType")
          .ok_or(InfuError::new("Descriptor log record does not specify a value type."))?
          .as_str()
          .ok_or(InfuError::new("Descriptor value_type field is not of type 'string'."))?;
        if value_type != T::value_type_identifier() {
          return Err(format!("Descriptor value_type is '{}', expecting '{}'.", value_type, T::value_type_identifier()).into());
        }
      },

      "entry" => {
        // Log record is a full specification of an entry value.
        let u = T::from_json(&kvs)?;
        if result.contains_key(u.get_id()) {
          return Err(format!("Entry log record has id '{}', but an entry with this id already exists.", u.get_id()).into());
        }
        result.insert(u.get_id().clone(), u);
      },

      "update" => {
        // Log record specifies an update to an entry value.
        let id = kvs
          .get("id")
          .ok_or(InfuError::new("Update log record does not specify an entry id."))?
          .as_str()
          .ok_or(InfuError::new("Update log record id does not have type 'string'."))?;
        let u = result
          .get_mut(&String::from(id))
          .ok_or(InfuError::new(&format!("Update record has id '{}', but this is unknown.", id)))?;
        u.apply_json_update(&kvs)?;
      },

      "delete" => {
        // Log record specifies that the entry with the given id should be deleted.
        let id = kvs
          .get("id")
          .ok_or(InfuError::new("Delete log record does not specify an entry id."))?
          .as_str()
          .ok_or(InfuError::new("Delete log record id does not have type 'string'."))?;
        if !result.contains_key(&String::from(id)) {
          return Err(format!("Delete record has id '{}', but this is unknown.", id).into());
        }
        result.remove(&String::from(id));
      },

      unexpected_record_type => {
        return Err(format!("Unknown log record type '{}'.", unexpected_record_type).into());
      }
    }

    Ok(())
  }

  async fn read_log(path: &str, expected_version: i64) -> InfuResult<HashMap<String, T>> {
    let mut result: HashMap<String, T> = HashMap::new();

    let f = BufReader::new(File::open(path).await?);
    let mut lines = f.lines();
    while let Some(line) = lines.next_line().await? {
      let item = serde_json::from_str::<serde_json::Value>(&line);
      match item? {
        Object(kvs) => { Self::read_log_record(&mut result, &kvs, expected_version)?; },
        unexpected_type => {
          return Err(format!("Log record has JSON type '{:?}', but 'Object' was expected.", unexpected_type.type_id()).into());
        }
      }
    }

    Ok(result)
  }
}
