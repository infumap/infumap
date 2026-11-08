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

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use infusdk::db::kv_store::JsonLogSerializable;
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use infusdk::util::json;
use infusdk::util::uid::{Uid, is_uid};
use log::warn;
use serde_json::Value;

use super::db::item_db::CURRENT_ITEM_LOG_VERSION;
use super::db::user::User;
use super::db::user_db::CURRENT_USER_LOG_VERSION;
use crate::util::fs::expand_tilde;

mod migration;
mod replacement;
pub use migration::migrate_log_step;
pub use replacement::{create_log_temporary, discard_log_temporaries, install_log_candidate};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogKind {
  User,
  Item,
}

impl LogKind {
  fn value_type(self) -> &'static str {
    match self {
      Self::User => User::value_type_identifier(),
      Self::Item => Item::value_type_identifier(),
    }
  }

  pub fn current_version(self) -> i64 {
    match self {
      Self::User => CURRENT_USER_LOG_VERSION,
      Self::Item => CURRENT_ITEM_LOG_VERSION,
    }
  }
}

#[derive(Clone, Copy, Debug)]
pub struct LogDescriptor {
  pub kind: LogKind,
  pub version: i64,
}

pub struct AccountLogs {
  pub user_id: Uid,
  pub user_log: PathBuf,
  pub item_log: PathBuf,
  pub user_descriptor: LogDescriptor,
  pub item_descriptor: LogDescriptor,
}

/// Discard owned scratch files and inspect account logs without opening a database or creating missing files.
pub fn inspect_startup_logs(data_dir: &str) -> InfuResult<Vec<AccountLogs>> {
  let data_dir = expand_tilde(data_dir).ok_or("Could not interpret data directory.")?;
  discard_log_temporaries(&data_dir.join("pending_users.json"))?;
  let mut accounts = Vec::new();
  for entry in std::fs::read_dir(&data_dir)? {
    let entry = entry?;
    if !entry.file_type()?.is_dir() {
      continue;
    }
    let name = entry.file_name();
    if name == "search_processing" {
      continue;
    }
    let Some(user_id) = name.to_str().and_then(|name| name.strip_prefix("user_")).filter(|id| is_uid(id)) else {
      warn!("Unexpected directory in data directory: '{}'.", entry.path().display());
      continue;
    };
    let user_log = entry.path().join("user.json");
    let item_log = entry.path().join("items.json");
    let user_descriptor = inspect_account_log(&user_log, LogKind::User)?;
    let item_descriptor = inspect_account_log(&item_log, LogKind::Item)?;
    accounts.push(AccountLogs { user_id: user_id.to_owned(), user_log, item_log, user_descriptor, item_descriptor });
  }
  accounts.sort_by(|a, b| a.user_id.cmp(&b.user_id));
  Ok(accounts)
}

fn inspect_account_log(path: &Path, expected: LogKind) -> InfuResult<LogDescriptor> {
  if !std::fs::metadata(path)
    .map_err(|e| format!("Incomplete account: cannot read '{}': {}", path.display(), e))?
    .is_file()
  {
    return Err(format!("Account log '{}' is not a file.", path.display()).into());
  }
  discard_log_temporaries(path)?;
  let descriptor = read_log_descriptor(path)?;
  if descriptor.kind != expected {
    return Err(format!("Account log '{}' must contain {} records.", path.display(), expected.value_type()).into());
  }
  migration::validate_source_version(descriptor)
    .map_err(|e| format!("Cannot maintain log '{}': {}", path.display(), e))?;
  Ok(descriptor)
}

/// Inspect only the descriptor; replaying old records with current types would require migration first.
pub fn read_log_descriptor(path: &Path) -> InfuResult<LogDescriptor> {
  let file = File::open(path).map_err(|e| format!("Cannot open log '{}': {}", path.display(), e))?;
  let mut records = serde_json::Deserializer::from_reader(BufReader::new(file)).into_iter::<Value>();
  let first = records.next().ok_or_else(|| format!("Log '{}' has no descriptor.", path.display()))??;
  parse_descriptor(&first).map_err(|e| format!("Invalid descriptor in '{}': {}", path.display(), e).into())
}

fn parse_descriptor(record: &Value) -> InfuResult<LogDescriptor> {
  let record = record.as_object().ok_or("Log descriptor must be a JSON object.")?;
  if json::get_string_field(record, "__recordType")?.as_deref() != Some("descriptor") {
    return Err("First log record must be a descriptor.".into());
  }
  let version = json::get_integer_field(record, "version")?.ok_or("Log descriptor is missing 'version'.")?;
  let value_type = json::get_string_field(record, "valueType")?.ok_or("Log descriptor is missing 'valueType'.")?;
  let kind = if value_type == LogKind::User.value_type() {
    LogKind::User
  } else if value_type == LogKind::Item.value_type() {
    LogKind::Item
  } else {
    return Err(format!("Unsupported log value type '{}'.", value_type).into());
  };
  if version < 1 || version > kind.current_version() {
    return Err(
      format!("Unsupported {} log version {}; latest supported is {}.", value_type, version, kind.current_version())
        .into(),
    );
  }
  Ok(LogDescriptor { kind, version })
}
