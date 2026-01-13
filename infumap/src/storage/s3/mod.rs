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

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::Uid;
use log::debug;
use s3::creds::Credentials;
use s3::{Bucket, Region};
use tokio_stream::StreamExt;

use crate::storage::db::item_db::ItemAndUserId;

use super::object::IndividualObjectStore;

/// Timeout for receiving the first byte from S3. If no data is received within this
/// duration, the request is considered failed (likely a connectivity/routing issue).
const FIRST_BYTE_TIMEOUT_SECS: u64 = 10;

/// Timeout for receiving subsequent chunks after the first byte. This is more generous
/// since we know the connection is working at that point.
const FULL_TRANSFER_TIMEOUT_SECS: u64 = 120;


pub fn init_bucket(region: Option<&String>, endpoint: Option<&String>, bucket: &str, key: &str, secret: &str) -> InfuResult<Bucket> {
  let credentials = Credentials::new(Some(key), Some(secret), None, None, None)
    .map_err(|e| format!("Could not initialize S3 credentials: {}", e))?;
  let mut bucket = *Bucket::new(
    bucket,
    if let Some(endpoint) = endpoint {
      Region::Custom {
        region: if let Some(region) = region { region.to_owned() } else { "global".to_owned() },
        endpoint: endpoint.clone()
      }
    } else {
      match region {
        Some(region) => region.parse().map_err(|e| format!("Could not parse S3 region: {}", e))?,
        None => return Err("region expected".into())
      }
    },
    credentials
  ).map_err(|e| format!("Could not construct S3 bucket instance: {}", e))?;
  bucket.set_request_timeout(Some(Duration::from_secs(FULL_TRANSFER_TIMEOUT_SECS)));
  Ok(bucket)
}


pub struct S3Store {
  bucket: Bucket
}

impl S3Store {
  fn new(region: Option<&String>, endpoint: Option<&String>, bucket: &str, key: &str, secret: &str) -> InfuResult<S3Store> {
    Ok(S3Store { bucket: init_bucket(region, endpoint, bucket, key, secret)? })
  }
}


pub fn new(region: Option<&String>, endpoint: Option<&String>, bucket: &str, key: &str, secret: &str) -> InfuResult<Arc<S3Store>> {
  Ok(Arc::new(S3Store::new(region, endpoint, bucket, key, secret)?))
}


/// Fetches an object from S3 using streaming with first-byte timeout detection.
/// This allows detecting connectivity issues quickly (within FIRST_BYTE_TIMEOUT_SECS)
/// while still allowing large files to complete with the full timeout.
pub async fn get_streaming(s3_store: Arc<S3Store>, user_id: Uid, id: Uid) -> InfuResult<Vec<u8>> {
  let s3_path = format!("{}_{}", user_id, id);

  // Get the stream with a timeout on initiating the connection
  let response_stream = tokio::time::timeout(
    Duration::from_secs(FIRST_BYTE_TIMEOUT_SECS),
    s3_store.bucket.get_object_stream(&s3_path)
  ).await
    .map_err(|_| format!("Timeout waiting for S3 stream to start for '{}'", s3_path))?
    .map_err(|e| format!("Error getting S3 object stream for '{}': {}", s3_path, e))?;

  // Check status code
  if response_stream.status_code != 200 {
    return Err(format!("Unexpected status code getting S3 object '{}': {}", s3_path, response_stream.status_code).into());
  }

  let mut stream = response_stream.bytes;
  let mut buffer = Vec::new();
  let mut first_chunk_received = false;

  loop {
    // Use short timeout for first chunk, longer timeout for subsequent chunks
    let timeout_duration = if first_chunk_received {
      Duration::from_secs(FULL_TRANSFER_TIMEOUT_SECS)
    } else {
      Duration::from_secs(FIRST_BYTE_TIMEOUT_SECS)
    };

    match tokio::time::timeout(timeout_duration, stream.next()).await {
      Ok(Some(chunk_result)) => {
        let chunk = chunk_result
          .map_err(|e| format!("Error reading S3 stream chunk for '{}': {}", s3_path, e))?;
        if !first_chunk_received {
          debug!("First chunk received for S3 object '{}'", s3_path);
          first_chunk_received = true;
        }
        buffer.extend_from_slice(&chunk);
      },
      Ok(None) => {
        // Stream ended
        break;
      },
      Err(_) => {
        if first_chunk_received {
          return Err(format!("Timeout during S3 transfer for '{}' (received {} bytes before timeout)", s3_path, buffer.len()).into());
        } else {
          return Err(format!("Timeout waiting for first byte from S3 for '{}'", s3_path).into());
        }
      }
    }
  }

  Ok(buffer)
}


pub async fn get(s3_store: Arc<S3Store>, user_id: Uid, id: Uid) -> InfuResult<Vec<u8>> {
  get_streaming(s3_store, user_id, id).await
}


pub async fn put(s3_store: Arc<S3Store>, user_id: Uid, id: Uid, val: Arc<Vec<u8>>) -> InfuResult<()> {
  let s3_path = format!("{}_{}", user_id, id);
  let result = s3_store.bucket.put_object(s3_path, val.as_slice()).await
    .map_err(|e| format!("Error occurred putting S3 object: {}", e))?;
  if result.status_code() != 200 {
    return Err(format!("Unexpected status code putting S3 object: {}.", result.status_code()).into());
  }
  Ok(())
}


pub async fn delete(s3_store: Arc<S3Store>, user_id: Uid, id: Uid) -> InfuResult<()> {
  let s3_path = format!("{}_{}", user_id, id);
  let result = s3_store.bucket.delete_object(s3_path).await
    .map_err(|e| format!("Error occurred deleting S3 object: {}", e))?;
  if result.status_code() != 204 {
    return Err(format!("Unexpected status code deleting S3 object: {}", result.status_code()).into());
  }
  Ok(())
}


pub async fn list(s3_store: Arc<S3Store>) -> InfuResult<Vec<ItemAndUserId>> {
  let mut result = vec![];
  let mut lb_rs = s3_store.bucket.list_page("".to_owned(), None, None, None, None).await
    .map_err(|e| format!("S3 list_page server request failed: {}", e))?;
  if lb_rs.1 != 200 { // status code.
    return Err(format!("Expected list_page status code to be 200, not {}", lb_rs.1).into());
  }
  loop {
    debug!("Retrieved {} filenames", lb_rs.0.contents.len());
    for c in lb_rs.0.contents {
      let mut parts = c.key.split("_");
      let user_id = parts.next().ok_or(format!("Unexpected object filename {}", c.key))?;
      let item_id = parts.next().ok_or(format!("Unexpected object filename {}", c.key))?;
      if parts.next().is_some() { return Err(format!("Unexpected object filename {}", c.key).into()); }
      result.push(
        ItemAndUserId {
          user_id: String::from(user_id),
          item_id: String::from(item_id)
        }
      );
    }
    if let Some(ct) = lb_rs.0.next_continuation_token {
      lb_rs = s3_store.bucket.list_page("".to_owned(), None, Some(ct), None, None).await
        .map_err(|e| format!("S3 list_page server request (continuation) failed: {}", e))?;
      if lb_rs.1 != 200 { // status code.
        return Err(format!("Expected list_page status code to be 200, not {}", lb_rs.1).into());
      }
    } else {
      break;
    }
  }
  Ok(result)
}


#[async_trait]
impl IndividualObjectStore for Arc<S3Store> {
  async fn get(&self, user_id: Uid, item_id: Uid) -> InfuResult<Vec<u8>> {
    get(self.clone(), user_id, item_id).await
  }
  async fn put(&self, user_id: Uid, item_id: Uid, val: Arc<Vec<u8>>) -> InfuResult<()> {
    put(self.clone(), user_id, item_id, val).await
  }
  async fn list(&self) -> InfuResult<Vec<ItemAndUserId>> {
    list(self.clone()).await
  }
}
