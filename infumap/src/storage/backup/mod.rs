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

use std::{collections::HashMap, sync::Arc};

use infusdk::util::{
  infu::InfuResult,
  time::unix_now_secs_u64,
  uid::{Uid, is_uid, new_uid},
};
use log::info;
use s3::Bucket;
use std::path::Path;
use tokio::fs::File;
use tokio::io::AsyncReadExt;
use tokio::task::spawn_blocking;

use super::s3::{delete_object_with_retry, init_bucket, put_object_with_retry};
use crate::util::crypto::encrypt_file_data;

const MIGRATION_BACKUP_PREFIX: &str = "maintenance-migration_";
const COMPACTION_BACKUP_PREFIX: &str = "maintenance-compaction_";

#[derive(Clone, Copy)]
pub enum MaintenanceBackupKind {
  Migration,
  Compaction,
}

impl MaintenanceBackupKind {
  fn prefix(self) -> &'static str {
    match self {
      Self::Migration => MIGRATION_BACKUP_PREFIX,
      Self::Compaction => COMPACTION_BACKUP_PREFIX,
    }
  }
}

fn is_maintenance_backup(filename: &str) -> bool {
  [MaintenanceBackupKind::Migration, MaintenanceBackupKind::Compaction]
    .into_iter()
    .any(|kind| filename.starts_with(kind.prefix()))
}

/// Accept ordinary and maintenance archives without changing the filename used for authentication.
pub fn parse_backup_filename(filename: &str) -> InfuResult<(&str, u64)> {
  let parts = filename.split('_').collect::<Vec<_>>();
  let invalid = || format!("Invalid backup filename: '{}'.", filename);
  let (user_id, timestamp) = if is_maintenance_backup(filename) {
    match parts.as_slice() {
      [_, user_id, timestamp, suffix] if is_uid(user_id) && suffix.strip_suffix(".infu").is_some_and(is_uid) => {
        (*user_id, *timestamp)
      }
      _ => return Err(invalid().into()),
    }
  } else {
    match parts.as_slice() {
      [user_id, timestamp] => (*user_id, *timestamp),
      _ => return Err(invalid().into()),
    }
  };
  let timestamp = timestamp.parse::<u64>().map_err(|e| format!("{} {}", invalid(), e))?;
  Ok((user_id, timestamp))
}

/// Keep the existing IMZ1/zstd payload shared by periodic and permanent maintenance backups.
pub fn compress_backup(raw: &[u8]) -> InfuResult<Vec<u8>> {
  let mut compressed = b"IMZ1".to_vec();
  compressed.extend_from_slice(&zstd::stream::encode_all(raw, 3)?);
  Ok(compressed)
}

/// Upload the unchanged account pair. Callers must await success before modifying either source log.
/// This deliberately does not update last_backup.txt or periodic-backup status.
pub async fn put_maintenance_backup(
  backup_store: Arc<BackupStore>,
  kind: MaintenanceBackupKind,
  user_id: &str,
  items_path: &Path,
  user_path: &Path,
  encryption_key: &str,
) -> InfuResult<String> {
  let started = std::time::Instant::now();
  if !is_uid(user_id) {
    return Err(format!("Invalid account id for maintenance backup: '{}'.", user_id).into());
  }
  let filename = format!("{}{}_{}_{}.infu", kind.prefix(), user_id, unix_now_secs_u64()?, new_uid());
  info!(
    "Preparing permanent archive '{}' for account '{}': items '{}', user '{}'.",
    filename,
    user_id,
    items_path.display(),
    user_path.display()
  );
  let raw = create_raw_backup(items_path, user_path)
    .await
    .map_err(|e| format!("Cannot read sources for maintenance archive '{}': {}", filename, e))?;
  let raw_bytes = raw.len();
  let encryption_key = encryption_key.to_owned();
  let authenticated_filename = filename.clone();
  let encrypted = spawn_blocking(move || {
    let compressed = compress_backup(&raw)?;
    encrypt_file_data(&encryption_key, &compressed, &authenticated_filename)
  })
  .await
  .map_err(|e| format!("Maintenance backup preparation task failed for '{}': {}", filename, e))?
  .map_err(|e| format!("Failed to prepare maintenance backup '{}': {}", filename, e))?;
  let encrypted_bytes = encrypted.len();
  // Generate the name and ciphertext once: the existing S3 retry must resend the same object and bytes.
  put(backup_store, &filename, encrypted)
    .await
    .map_err(|e| format!("Failed to upload maintenance archive '{}': {}", filename, e))?;
  info!(
    "Archived account '{}' logs to permanent backup '{}': {} raw payload bytes -> {} encrypted bytes; elapsed {:?}.",
    user_id,
    filename,
    raw_bytes,
    encrypted_bytes,
    started.elapsed()
  );
  Ok(filename)
}

/// Build the existing two-log payload directly from files, including logs too old for current DB types.
pub async fn create_raw_backup(items_path: &Path, user_path: &Path) -> InfuResult<Vec<u8>> {
  let mut items =
    File::open(items_path).await.map_err(|e| format!("Cannot back up '{}': {}", items_path.display(), e))?;
  let mut user = File::open(user_path).await.map_err(|e| format!("Cannot back up '{}': {}", user_path.display(), e))?;
  let items_len = items.metadata().await?.len();
  let user_len = user.metadata().await?.len();
  let items_size = usize::try_from(items_len)?;
  let user_size = usize::try_from(user_len)?;
  let size = items_size
    .checked_add(user_size)
    .and_then(|size| size.checked_add(16))
    .ok_or("Account backup is too large for this platform.")?;
  let mut bytes = Vec::new();
  bytes.try_reserve_exact(size).map_err(|e| format!("Cannot allocate account backup: {}", e))?;
  bytes.resize(size, 0);
  bytes[..8].copy_from_slice(&items_len.to_be_bytes());
  items
    .read_exact(&mut bytes[8..8 + items_size])
    .await
    .map_err(|e| format!("Cannot read backup source '{}': {}", items_path.display(), e))?;
  bytes[8 + items_size..16 + items_size].copy_from_slice(&user_len.to_be_bytes());
  user
    .read_exact(&mut bytes[16 + items_size..])
    .await
    .map_err(|e| format!("Cannot read backup source '{}': {}", user_path.display(), e))?;
  Ok(bytes)
}

pub struct BackupStore {
  bucket: Bucket,
}

impl BackupStore {
  fn new(
    s3_region: Option<&String>,
    s3_endpoint: Option<&String>,
    s3_bucket: &String,
    s3_key: &String,
    s3_secret: &String,
  ) -> InfuResult<BackupStore> {
    Ok(BackupStore { bucket: init_bucket(s3_region, s3_endpoint, s3_bucket, s3_key, s3_secret)? })
  }
}

pub fn new(
  s3_region: Option<&String>,
  s3_endpoint: Option<&String>,
  s3_bucket: &String,
  s3_key: &String,
  s3_secret: &String,
) -> InfuResult<Arc<BackupStore>> {
  Ok(Arc::new(BackupStore::new(s3_region, s3_endpoint, s3_bucket, s3_key, s3_secret)?))
}

pub fn format_backup_filename(user_id: &str, timestamp: u64) -> String {
  format!("{}_{}", user_id, timestamp)
}

pub async fn put(backup_store: Arc<BackupStore>, backup_filename: &str, backup_bytes: Vec<u8>) -> InfuResult<()> {
  let result = put_object_with_retry(&backup_store.bucket, backup_filename, backup_bytes.as_slice())
    .await
    .map_err(|e| format!("Error occurred putting backup in S3: {}", e))?;
  if result.status_code() != 200 {
    return Err(format!("Unexpected status code putting backup in S3: {}", result.status_code()).into());
  }
  Ok(())
}

pub async fn get(backup_store: Arc<BackupStore>, user_id: &str, timestamp: u64) -> InfuResult<Vec<u8>> {
  let s3_path = format_backup_filename(user_id, timestamp);
  let result = backup_store
    .bucket
    .get_object(s3_path.clone())
    .await
    .map_err(|e| format!("Error occurred getting backup from S3: {}", e))?;
  if result.status_code() != 200 {
    return Err(format!("Unexpected status code getting backup from S3: {}", result.status_code()).into());
  }
  Ok(result.bytes().to_vec())
}

pub async fn delete(backup_store: Arc<BackupStore>, user_id: &str, timestamp: u64) -> InfuResult<()> {
  let s3_path = format_backup_filename(user_id, timestamp);
  if is_maintenance_backup(&s3_path) {
    return Err("Maintenance backups cannot be deleted by regular backup cleanup.".into());
  }
  let result = delete_object_with_retry(&backup_store.bucket, &s3_path)
    .await
    .map_err(|e| format!("Error occurred deleting backup S3 object: {}", e))?;
  if result.status_code() != 204 {
    return Err(format!("Unexpected status code deleting backup S3 object: {}.", result.status_code()).into());
  }
  Ok(())
}

/// List regular backups only; maintenance archives are never retention or automatic recovery candidates.
///
/// Returns an ordered list of backup timestamps per user.
pub async fn list(backup_store: Arc<BackupStore>) -> InfuResult<HashMap<Uid, Vec<u64>>> {
  let mut result = HashMap::new();
  let mut lb_rs = backup_store
    .bucket
    .list_page("".to_owned(), None, None, None, None)
    .await
    .map_err(|e| format!("Backup S3 list_page server request failed: {}", e))?;
  if lb_rs.1 != 200 {
    // status code.
    return Err(format!("Expected backup list_page status code to be 200, not {}.", lb_rs.1).into());
  }
  loop {
    for c in lb_rs.0.contents {
      // Exclude the whole reserved namespace, including incomplete names, on every page before regular parsing.
      if is_maintenance_backup(&c.key) {
        continue;
      }
      let (user_id, timestamp) = parse_backup_filename(&c.key)?;
      result.entry(Uid::from(user_id)).or_insert_with(Vec::new).push(timestamp);
    }
    if let Some(ct) = lb_rs.0.next_continuation_token {
      lb_rs = backup_store
        .bucket
        .list_page("".to_owned(), None, Some(ct), None, None)
        .await
        .map_err(|e| format!("Backup S3 list_page server request (continuation) failed: {}", e))?;
      if lb_rs.1 != 200 {
        // status code.
        return Err(format!("Expected backup list_page status code to be 200, not {}", lb_rs.1).into());
      }
    } else {
      break;
    }
  }
  for (_, timestamps) in result.iter_mut() {
    timestamps.sort();
  }
  Ok(result)
}

pub async fn get_latest_backup_filename_for_user(
  backup_store: Arc<BackupStore>,
  user_id: &str,
) -> InfuResult<Option<String>> {
  let backups = list(backup_store).await?;
  if let Some(timestamps) = backups.get(user_id) {
    if let Some(latest_timestamp) = timestamps.last() {
      return Ok(Some(format_backup_filename(user_id, *latest_timestamp)));
    }
  }
  Ok(None)
}
