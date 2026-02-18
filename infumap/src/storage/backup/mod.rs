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

use infusdk::util::{infu::InfuResult, uid::Uid};
use s3::Bucket;

use super::s3::init_bucket;


pub struct BackupStore {
  bucket: Bucket
}

impl BackupStore {
  fn new(
      s3_region: Option<&String>, s3_endpoint: Option<&String>, s3_bucket: &String,
      s3_key: &String, s3_secret: &String) -> InfuResult<BackupStore> {
    Ok(BackupStore { bucket: init_bucket(s3_region, s3_endpoint, s3_bucket, s3_key, s3_secret)? })
  }
}


pub fn new(s3_region: Option<&String>, s3_endpoint: Option<&String>, s3_bucket: &String, s3_key: &String, s3_secret: &String) -> InfuResult<Arc<BackupStore>> {
  Ok(Arc::new(BackupStore::new(s3_region, s3_endpoint, s3_bucket, s3_key, s3_secret)?))
}


pub fn format_backup_filename(user_id: &str, timestamp: u64) -> String {
  format!("{}_{}", user_id, timestamp)
}


pub async fn put(backup_store: Arc<BackupStore>, backup_filename: &str, backup_bytes: Vec<u8>) -> InfuResult<()> {
  let result = backup_store.bucket.put_object(backup_filename, &backup_bytes.as_slice()).await
    .map_err(|e| format!("Error occurred putting backup in S3: {}", e))?;
  if result.status_code() != 200 {
    return Err(format!("Unexpected status code putting backup in S3: {}", result.status_code()).into());
  }
  Ok(())
}

pub async fn get(backup_store: Arc<BackupStore>, user_id: &str, timestamp: u64) -> InfuResult<Vec<u8>> {
  let s3_path = format_backup_filename(user_id, timestamp);
  let result = backup_store.bucket.get_object(s3_path.clone()).await
    .map_err(|e| format!("Error occurred getting backup from S3: {}", e))?;
  if result.status_code() != 200 {
    return Err(format!("Unexpected status code getting backup from S3: {}", result.status_code()).into());
  }
  Ok(result.bytes().to_vec())
}

pub async fn delete(backup_store: Arc<BackupStore>, user_id: &str, timestamp: u64) -> InfuResult<()> {
  let s3_path = format_backup_filename(user_id, timestamp);
  let result = backup_store.bucket.delete_object(s3_path).await
    .map_err(|e| format!("Error occurred deleting backup S3 object: {}", e))?;
  if result.status_code() != 204 {
    return Err(format!("Unexpected status code deleting backup S3 object: {}.", result.status_code()).into());
  }
  Ok(())
}


/// List all backups in the backup store.
///
/// Returns an ordered list of backup timestamps per user.
pub async fn list(backup_store: Arc<BackupStore>) -> InfuResult<HashMap<Uid, Vec<u64>>> {
  let mut result = HashMap::new();
  let mut lb_rs = backup_store.bucket.list_page("".to_owned(), None, None, None, None).await
    .map_err(|e| format!("Backup S3 list_page server request failed: {}", e))?;
  if lb_rs.1 != 200 { // status code.
    return Err(format!("Expected backup list_page status code to be 200, not {}.", lb_rs.1).into());
  }
  loop {
    for c in lb_rs.0.contents {
      let mut parts = c.key.split("_");
      let user_id = parts.next().ok_or(format!("Unexpected backup object filename {}.", c.key))?;
      let timestamp_str = parts.next().ok_or(format!("Unexpected backup object filename {}.", c.key))?;
      if parts.next().is_some() { return Err(format!("Unexpected backup object filename {}.", c.key).into()); }
      if !result.contains_key(user_id) {
        result.insert(Uid::from(user_id), vec![]);
      }
      result.get_mut(user_id).unwrap().push(timestamp_str.parse::<u64>()?);
    }
    if let Some(ct) = lb_rs.0.next_continuation_token {
      lb_rs = backup_store.bucket.list_page("".to_owned(), None, Some(ct), None, None).await
        .map_err(|e| format!("Backup S3 list_page server request (continuation) failed: {}", e))?;
      if lb_rs.1 != 200 { // status code.
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

pub async fn get_latest_backup_filename_for_user(backup_store: Arc<BackupStore>, user_id: &str) -> InfuResult<Option<String>> {
  let backups = list(backup_store).await?;
  if let Some(timestamps) = backups.get(user_id) {
    if let Some(latest_timestamp) = timestamps.last() {
      return Ok(Some(format_backup_filename(user_id, *latest_timestamp)));
    }
  }
  Ok(None)
}
