// Copyright (C) 2023 The Infumap Authors
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

use std::{sync::Arc, time::{SystemTime, UNIX_EPOCH}};

use s3::Bucket;

use crate::util::infu::InfuResult;
use super::s3::create_bucket;


pub struct BackupStore {
  bucket: Bucket
}

impl BackupStore {
  fn new(
      s3_region: Option<String>, s3_endpoint: Option<String>, s3_bucket: String,
      s3_key: String, s3_secret: String) -> InfuResult<BackupStore> {
    Ok(BackupStore { bucket: create_bucket(&s3_region, &s3_endpoint, &s3_bucket, &s3_key, &s3_secret)? })
  }
}


pub fn new(s3_region: Option<String>, s3_endpoint: Option<String>, s3_bucket: String, s3_key: String, s3_secret: String) -> InfuResult<Arc<BackupStore>> {
  Ok(Arc::new(BackupStore::new(s3_region, s3_endpoint, s3_bucket, s3_key, s3_secret)?))
}

pub async fn put(backup_store: Arc<BackupStore>, user_id: &str, backup_bytes: Vec<u8>) -> InfuResult<String> {
  let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
  let s3_path = format!("{}_{}", user_id, timestamp);
  let result = backup_store.bucket.put_object(s3_path.clone(), &backup_bytes.as_slice()).await
    .map_err(|e| format!("Error occured putting backup in S3: {}", e))?;
  if result.status_code() != 200 {
    return Err(format!("Unexpected status code putting backup in S3: {}", result.status_code()).into());
  }
  Ok(s3_path)
}
