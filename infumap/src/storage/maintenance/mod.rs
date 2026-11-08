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
use std::sync::Arc;
use std::time::Instant;

use infusdk::db::kv_store::{JsonLogSerializable, KVStore};
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use infusdk::util::json;
use infusdk::util::uid::{Uid, is_uid};
use log::{info, warn};
use serde_json::Value;
use tokio::task::spawn_blocking;

use super::backup::{BackupStore, MaintenanceBackupKind, put_maintenance_backup};
use super::db::item_db::{CURRENT_ITEM_LOG_VERSION, validate_item_log};
use super::db::user::User;
use super::db::user_db::CURRENT_USER_LOG_VERSION;
use crate::util::fs::expand_tilde;

mod migration;
mod replacement;
pub use migration::{migrate_log_step, prepare_log_migration};
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

/// Recovery must discover accounts even when their logs cannot yet be opened with current schemas.
pub fn discover_account_ids(data_dir: &str) -> InfuResult<Vec<Uid>> {
  let data_dir = expand_tilde(data_dir).ok_or("Could not interpret data directory.")?;
  let mut user_ids = Vec::new();
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
    user_ids.push(user_id.to_owned());
  }
  user_ids.sort();
  Ok(user_ids)
}

/// Discard owned scratch files and inspect account logs without opening a database or creating missing files.
pub fn inspect_startup_logs(data_dir: &str, user_ids: &[Uid]) -> InfuResult<Vec<AccountLogs>> {
  let data_dir = expand_tilde(data_dir).ok_or("Could not interpret data directory.")?;
  let mut accounts = Vec::new();
  for user_id in user_ids {
    let directory = data_dir.join(format!("user_{}", user_id));
    let user_log = directory.join("user.json");
    let item_log = directory.join("items.json");
    let user_descriptor = inspect_existing_log(&user_log, LogKind::User)?;
    let item_descriptor = inspect_existing_log(&item_log, LogKind::Item)?;
    accounts.push(AccountLogs { user_id: user_id.to_owned(), user_log, item_log, user_descriptor, item_descriptor });
  }
  Ok(accounts)
}

/// Missing pending users is normal on a new instance; an existing file must be a supported user log.
pub fn inspect_pending_users(data_dir: &str) -> InfuResult<Option<LogDescriptor>> {
  let path = expand_tilde(data_dir).ok_or("Could not interpret data directory.")?.join("pending_users.json");
  if !path.try_exists()? {
    return Ok(None);
  }
  inspect_existing_log(&path, LogKind::User).map(Some)
}

/// Archive the unchanged pair, then stage and validate both chains before replacing either active file.
pub async fn migrate_account_logs(account: &AccountLogs, backup: Option<(&Arc<BackupStore>, &str)>) -> InfuResult<()> {
  let logs = [(&account.user_log, account.user_descriptor), (&account.item_log, account.item_descriptor)];
  if logs.iter().all(|(_, descriptor)| descriptor.version == descriptor.kind.current_version()) {
    return Ok(());
  }
  let started = Instant::now();
  if let Some((store, encryption_key)) = backup {
    // Old schemas cannot be replayed with current Rust types. Snapshot the raw pair before any conversion.
    put_maintenance_backup(
      store.clone(),
      MaintenanceBackupKind::Migration,
      &account.user_id,
      &account.item_log,
      &account.user_log,
      encryption_key,
    )
    .await
    .map_err(|e| {
      format!("Cannot archive account '{}' before migration; no conversion started: {}", account.user_id, e)
    })?;
  }

  let mut candidates = Vec::new();
  let result: InfuResult<()> = async {
    for (source, descriptor) in logs {
      if descriptor.version == descriptor.kind.current_version() {
        continue;
      }
      let prepare_source = source.clone();
      let candidate = spawn_blocking(move || prepare_log_migration(&prepare_source))
        .await
        .map_err(|e| format!("Migration preparation task failed for '{}': {}", source.display(), e))?
        .map_err(|e| format!("Cannot migrate '{}': {}", source.display(), e))?;
      candidates.push((source, candidate, descriptor));
      let candidate = &candidates.last().unwrap().1;
      let candidate_path = candidate.to_str().ok_or("Migration candidate path must be valid UTF-8.")?;
      let replay: InfuResult<()> = match descriptor.kind {
        LogKind::User => KVStore::<User>::init(candidate_path, CURRENT_USER_LOG_VERSION).await.map(|_| ()),
        LogKind::Item => validate_item_log(candidate_path).await,
      };
      replay.map_err(|e| format!("Cannot replay migrated log '{}': {}", source.display(), e))?;
    }

    // Preparing both first keeps both originals intact on conversion/replay failure. Installation is per-file:
    // if a later installation fails, stop startup and let the next run migrate the remaining old log.
    for (original_source, candidate, descriptor) in &candidates {
      let source = (*original_source).clone();
      let candidate = candidate.clone();
      let descriptor = *descriptor;
      spawn_blocking(move || -> InfuResult<()> {
        let filename = source.file_name().and_then(|name| name.to_str()).ok_or("Log filename must be valid UTF-8.")?;
        let previous = source.with_file_name(format!("{}.previous", filename));
        let input_bytes = std::fs::metadata(&source)?.len();
        let output_bytes = std::fs::metadata(&candidate)?.len();
        install_log_candidate(&source, &candidate, &previous, true, |path| {
          let migrated = read_log_descriptor(path)?;
          if migrated.kind != descriptor.kind || migrated.version != descriptor.kind.current_version() {
            return Err("Migration candidate has an unexpected schema.".into());
          }
          Ok(())
        })
        .map_err(|e| format!("Cannot install migrated log '{}': {}", source.display(), e))?;
        info!(
          "Migrated '{}' from v{} to v{} ({} -> {} bytes); retained original '{}'.",
          source.display(),
          descriptor.version,
          descriptor.kind.current_version(),
          input_bytes,
          output_bytes,
          previous.display()
        );
        Ok(())
      })
      .await
      .map_err(|e| format!("Migration installation task failed for '{}': {}", original_source.display(), e))??;
    }
    Ok(())
  }
  .await;
  for (_, candidate, _) in candidates {
    replacement::discard_temporary(&candidate);
  }
  result?;
  info!("Account '{}' startup migration completed in {:?}.", account.user_id, started.elapsed());
  Ok(())
}

/// Pending users are local-only and must be migrated before Db::new opens their store.
pub async fn migrate_pending_users(data_dir: &str, descriptor: Option<LogDescriptor>) -> InfuResult<()> {
  let Some(descriptor) = descriptor else {
    return Ok(());
  };
  if descriptor.version == CURRENT_USER_LOG_VERSION {
    return Ok(());
  }
  let source = expand_tilde(data_dir).ok_or("Could not interpret data directory.")?.join("pending_users.json");
  let prepare_source = source.clone();
  let candidate = spawn_blocking(move || prepare_log_migration(&prepare_source))
    .await
    .map_err(|e| format!("Failed to prepare pending-user migration: {}", e))??;
  let result = async {
    // Pending users may contain multiple User records, so replay without per-account single-user checks.
    KVStore::<User>::init(
      candidate.to_str().ok_or("Pending-user log path must be valid UTF-8.")?,
      CURRENT_USER_LOG_VERSION,
    )
    .await?;
    let install_source = source.clone();
    let install_candidate = candidate.clone();
    spawn_blocking(move || {
      let previous = install_source.with_file_name("pending_users.json.previous");
      install_log_candidate(&install_source, &install_candidate, &previous, true, |path| {
        let descriptor = read_log_descriptor(path)?;
        if descriptor.kind != LogKind::User || descriptor.version != CURRENT_USER_LOG_VERSION {
          return Err("Pending-user migration did not produce the current user-log schema.".into());
        }
        Ok(())
      })
    })
    .await
    .map_err(|e| format!("Failed to install pending-user migration: {}", e))?
  }
  .await;
  replacement::discard_temporary(&candidate);
  result?;
  info!(
    "Migrated '{}' from v{} to v{}; retained its local previous copy.",
    source.display(),
    descriptor.version,
    CURRENT_USER_LOG_VERSION
  );
  Ok(())
}

fn inspect_existing_log(path: &Path, expected: LogKind) -> InfuResult<LogDescriptor> {
  if !std::fs::metadata(path).map_err(|e| format!("Cannot inspect existing log '{}': {}", path.display(), e))?.is_file()
  {
    return Err(format!("Log '{}' is not a file.", path.display()).into());
  }
  discard_log_temporaries(path)?;
  let descriptor = read_log_descriptor(path)?;
  if descriptor.kind != expected {
    return Err(format!("Log '{}' must contain {} records.", path.display(), expected.value_type()).into());
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
