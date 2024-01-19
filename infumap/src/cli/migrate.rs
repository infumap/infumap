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
use std::path::PathBuf;
use serde_json::de::IoRead;
use serde_json::{Map, Value, StreamDeserializer};
use clap::{ArgMatches, App, Arg};
use tokio::fs::rename;
use crate::storage::db::item::Item;
use crate::storage::db::item_db::CURRENT_ITEM_LOG_VERSION;
use crate::storage::db::kv_store::JsonLogSerializable;
use crate::storage::db::user::User;
use crate::storage::db::user_db::CURRENT_USER_LOG_VERSION;
use crate::util::fs::{expand_tilde, path_exists};
use crate::util::infu::InfuResult;
use crate::util::json;
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use serde_json::Value::Object;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("migrate")
    .about("Migrates a single user or item log file to the next version, if it is not already at the latest. The existing log is retained with a postfix .vX where X is the existing version number. Note that generally it should not be necessary to migrate log files by hand, because this is done automatically on web server startup (TODO).")
    .arg(Arg::new("log_path")
      .short('p')
      .long("log-path")
      .help(concat!("Path to the user or item log file to migrate."))
      .takes_value(true)
      .multiple_values(false)
      .required(true))
}


pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let log_path = sub_matches.value_of("log_path").map(|a| a.to_string()).ok_or("log path not specified.")?;
  migrate_log(&log_path).await
}


async fn migrate_log(log_path: &str) -> InfuResult<()> {
  let expanded_log_path = expand_tilde(log_path).ok_or("Could not interpret log path.")?;

  let from_version = {
    let f = BufReader::new(File::open(&expanded_log_path)?);
    let deserializer = serde_json::Deserializer::from_reader(f);
    let mut iterator = deserializer.into_iter::<serde_json::Value>();
    let first = iterator.next().ok_or("Log has no records.")??;
    let (from_version, value_type, updated_descriptor) = match first {
      Object(kvs) => {
        process_descriptor(&kvs)?
      },
      unexpected_type => {
        return Err(format!("Descriptor log record has JSON type '{:?}', but 'Object' was expected.", unexpected_type.type_id()).into());
      }
    };

    // TODO (LOW): it would be better if the two migrate log functions were consolidated.
    if value_type == Item::value_type_identifier() {
      migrate_item_log(&expanded_log_path, from_version, updated_descriptor, &mut iterator)?
    } else if value_type == User::value_type_identifier() {
      migrate_user_log(&expanded_log_path, from_version, updated_descriptor, &mut iterator)?
    } else {
      return Err(format!("Unexpected value type {}", value_type).into());
    };

    from_version
  };

  if path_exists(&expanded_log_path.with_extension(format!("v{}", from_version))).await {
    return Err(format!("Log file already migrated to version {}.", from_version).into());
  }

  rename(&expanded_log_path, &expanded_log_path.with_extension(format!("v{}", from_version))).await?;
  rename(&expanded_log_path.with_extension("new"), &expanded_log_path).await?;

  Ok(())
}


fn migrate_item_log(log_path: &PathBuf, from_version: i64, updated_descriptor: Map<String, Value>, iterator: &mut StreamDeserializer<IoRead<BufReader<File>>, Value>) -> InfuResult<()> {
  if from_version == CURRENT_ITEM_LOG_VERSION {
    return Err("Item log is already at the latest version.".into());
  }
  if from_version > CURRENT_ITEM_LOG_VERSION {
    return Err(format!("Item log version {} is in the future - latest supported is {}.", from_version, CURRENT_ITEM_LOG_VERSION).into());
  }

  let file = File::create(log_path.with_extension("new"))?;
  let mut writer = BufWriter::new(file);

  writer.write_all(serde_json::to_string(&updated_descriptor)?.as_bytes())?;
  writer.write_all("\n".as_bytes())?;

  for item in iterator {
    match item? {
      Object(kvs) => {
        let migrated = match from_version {
          1 => crate::storage::db::item_db::migrate_record_v1_to_v2(&kvs)?,
          2 => crate::storage::db::item_db::migrate_record_v2_to_v3(&kvs)?,
          3 => crate::storage::db::item_db::migrate_record_v3_to_v4(&kvs)?,
          4 => crate::storage::db::item_db::migrate_record_v4_to_v5(&kvs)?,
          5 => crate::storage::db::item_db::migrate_record_v5_to_v6(&kvs)?,
          6 => crate::storage::db::item_db::migrate_record_v6_to_v7(&kvs)?,
          7 => crate::storage::db::item_db::migrate_record_v7_to_v8(&kvs)?,
          8 => crate::storage::db::item_db::migrate_record_v8_to_v9(&kvs)?,
          9 => crate::storage::db::item_db::migrate_record_v9_to_v10(&kvs)?,
          10 => crate::storage::db::item_db::migrate_record_v10_to_v11(&kvs)?,
          11 => crate::storage::db::item_db::migrate_record_v11_to_v12(&kvs)?,
          12 => crate::storage::db::item_db::migrate_record_v12_to_v13(&kvs)?,
          13 => crate::storage::db::item_db::migrate_record_v13_to_v14(&kvs)?,
          14 => crate::storage::db::item_db::migrate_record_v14_to_v15(&kvs)?,
          15 => crate::storage::db::item_db::migrate_record_v15_to_v16(&kvs)?,
          16 => crate::storage::db::item_db::migrate_record_v16_to_v17(&kvs)?,
          _ => { return Err(format!("Unexpected item log version: {}.", from_version).into()); }
        };
        writer.write_all(serde_json::to_string(&migrated)?.as_bytes())?;
        writer.write_all("\n".as_bytes())?;
      },
      unexpected_type => {
        return Err(format!("Log record has JSON type '{:?}', but 'Object' was expected.", unexpected_type.type_id()).into());
      }
    }
  }
  writer.flush()?;

  Ok(())
}


fn migrate_user_log(log_path: &PathBuf, from_version: i64, updated_descriptor: Map<String, Value>, iterator: &mut StreamDeserializer<IoRead<BufReader<File>>, Value>) -> InfuResult<()> {
  if from_version == CURRENT_USER_LOG_VERSION {
    return Err("User log is already at the latest version.".into());
  }
  if from_version > CURRENT_USER_LOG_VERSION {
    return Err(format!("User log version {} is in the future - latest supported is {}.", from_version, CURRENT_USER_LOG_VERSION).into());
  }

  let file = File::create(log_path.with_extension("new"))?;
  let mut writer = BufWriter::new(file);

  writer.write_all(serde_json::to_string(&updated_descriptor)?.as_bytes())?;
  writer.write_all("\n".as_bytes())?;

  for item in iterator {
    match item? {
      Object(kvs) => {
        let migrated = match from_version {
          1 => crate::storage::db::pending_user_db::migrate_record_v1_to_v2(&kvs)?,
          _ => { return Err(format!("Unexpected user log version: {}.", from_version).into()); }
        };
        writer.write_all(serde_json::to_string(&migrated)?.as_bytes())?;
        writer.write_all("\n".as_bytes())?;
      },
      unexpected_type => {
        return Err(format!("Log record has JSON type '{:?}', but 'Object' was expected.", unexpected_type.type_id()).into());
      }
    }
  }
  writer.flush()?;

  Ok(())
}


fn process_descriptor(kvs: &Map<String, Value>) -> InfuResult<(i64, String, Map<String, Value>)> {
  if json::get_string_field(kvs, "__recordType")?.ok_or("'__recordType' field is missing from log record.")?.as_str() != "descriptor" {
    return Err("First log record was not of type 'descriptor'.".into());
  }
  let descriptor_version = json::get_integer_field(kvs, "version")?.ok_or("Descriptor 'version' field is not present.")?;
  let value_type = json::get_string_field(kvs, "valueType")?.ok_or("Descriptor 'valueType' field is not present.")?;
  let mut updated_descriptor = kvs.clone();
  updated_descriptor.insert(String::from("version"), Value::Number(((descriptor_version + 1) as i64).into()));

  // TODO (LOW): Returning the migrated descriptor here smells bad.
  Ok((descriptor_version, value_type, updated_descriptor))
}
