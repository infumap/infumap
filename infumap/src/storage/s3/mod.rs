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

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use infusdk::util::infu::{InfuError, InfuResult};
use infusdk::util::uid::Uid;
use log::{debug, info, warn};
use s3::creds::Credentials;
use s3::error::S3Error;
use s3::request::ResponseData;
use s3::{Bucket, Region};
use tokio_stream::StreamExt;

use crate::storage::db::item_db::ItemAndUserId;

use super::object::IndividualObjectStore;

/// Timeout for receiving the first byte from S3. If no data is received within this
/// duration, the request is considered failed (likely a connectivity/routing issue).
const FIRST_BYTE_TIMEOUT_SECS: u64 = 10;

/// Total timeout for each S3 HTTP request attempt, including its response body.
/// Also bounds the wait for subsequent download chunks after the first byte.
const FULL_TRANSFER_TIMEOUT_SECS: u64 = 120;

/// A PUT's time limit is extended for a file too big to send within FULL_TRANSFER_TIMEOUT_SECS at this rate. A fixed
/// limit can never succeed for a large file on a slow uplink, however many times it is retried. The rate is low because
/// the uplink may be shared with other uploads.
const MIN_PUT_BYTES_PER_SEC: u64 = 128 * 1024;

/// A couple of quick retries absorb transient transport issues without adding
/// much latency before the object layer falls back to the secondary store.
const GET_MAX_ATTEMPTS: usize = 3;
const GET_RETRY_DELAYS_MILLIS: [u64; GET_MAX_ATTEMPTS - 1] = [250, 1000];

fn validate_endpoint(endpoint: &str) -> InfuResult<String> {
  let endpoint = endpoint.trim();
  if endpoint.is_empty() {
    return Err("S3 endpoint must not be empty.".into());
  }

  if let Some((scheme, _)) = endpoint.split_once("://") {
    let scheme_lc = scheme.to_ascii_lowercase();
    if scheme_lc != "https" {
      return Err(
        format!(
          "S3 endpoint '{}' uses insecure or unsupported scheme '{}'. Only 'https' is allowed.",
          endpoint, scheme
        )
        .into(),
      );
    }
  }

  Ok(endpoint.to_owned())
}

pub fn init_bucket(
  region: Option<&String>,
  endpoint: Option<&String>,
  bucket: &str,
  key: &str,
  secret: &str,
) -> InfuResult<Bucket> {
  let credentials = Credentials::new(Some(key), Some(secret), None, None, None)
    .map_err(|e| format!("Could not initialize S3 credentials: {}", e))?;
  let mut bucket = *Bucket::new(
    bucket,
    if let Some(endpoint) = endpoint {
      let endpoint = validate_endpoint(endpoint)?;
      Region::Custom {
        region: if let Some(region) = region { region.to_owned() } else { "global".to_owned() },
        endpoint,
      }
    } else {
      match region {
        Some(region) => region.parse().map_err(|e| format!("Could not parse S3 region: {}", e))?,
        None => return Err("region expected".into()),
      }
    },
    credentials,
  )
  .map_err(|e| format!("Could not construct S3 bucket instance: {}", e))?;
  bucket.set_request_timeout(Some(Duration::from_secs(FULL_TRANSFER_TIMEOUT_SECS)));
  Ok(bucket)
}

pub struct S3Store {
  bucket: Bucket,
}

impl S3Store {
  fn new(
    region: Option<&String>,
    endpoint: Option<&String>,
    bucket: &str,
    key: &str,
    secret: &str,
  ) -> InfuResult<S3Store> {
    Ok(S3Store { bucket: init_bucket(region, endpoint, bucket, key, secret)? })
  }
}

pub fn new(
  region: Option<&String>,
  endpoint: Option<&String>,
  bucket: &str,
  key: &str,
  secret: &str,
) -> InfuResult<Arc<S3Store>> {
  Ok(Arc::new(S3Store::new(region, endpoint, bucket, key, secret)?))
}

/// Fetches an object from S3 using streaming with first-byte timeout detection.
/// This allows detecting connectivity issues quickly (within FIRST_BYTE_TIMEOUT_SECS)
/// while still allowing large files to complete with the full timeout.
pub async fn get_streaming(s3_store: Arc<S3Store>, user_id: Uid, id: Uid) -> InfuResult<Vec<u8>> {
  let s3_path = format!("{}_{}", user_id, id);

  // Get the stream with a timeout on initiating the connection
  let response_stream =
    tokio::time::timeout(Duration::from_secs(FIRST_BYTE_TIMEOUT_SECS), s3_store.bucket.get_object_stream(&s3_path))
      .await
      .map_err(|_| format!("Timeout waiting for S3 stream to start for '{}'", s3_path))?
      .map_err(|e| format!("Error opening S3 response stream for '{}' before first chunk: {}", s3_path, e))?;

  // Check status code
  if response_stream.status_code != 200 {
    return Err(
      format!("Unexpected status code getting S3 object '{}': {}", s3_path, response_stream.status_code).into(),
    );
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

    let next_chunk_result = tokio::time::timeout(timeout_duration, stream.next()).await;
    match next_chunk_result {
      Ok(Some(chunk_result)) => {
        let chunk = chunk_result.map_err(|e| {
          format!("Error reading S3 stream chunk for '{}' after {} bytes: {}", s3_path, buffer.len(), e)
        })?;
        if !first_chunk_received {
          debug!("First chunk received for S3 object '{}'", s3_path);
          first_chunk_received = true;
        }
        buffer.extend_from_slice(&chunk);
      }
      Ok(None) => {
        // Stream ended
        break;
      }
      Err(_) => {
        if first_chunk_received {
          return Err(
            format!("Timeout during S3 transfer for '{}' (received {} bytes before timeout)", s3_path, buffer.len())
              .into(),
          );
        } else {
          return Err(format!("Timeout waiting for first byte from S3 for '{}'", s3_path).into());
        }
      }
    }
  }

  Ok(buffer)
}

pub async fn get(s3_store: Arc<S3Store>, user_id: Uid, id: Uid) -> InfuResult<Vec<u8>> {
  let s3_path = format!("{}_{}", user_id, id);

  for attempt in 0..GET_MAX_ATTEMPTS {
    match get_streaming(s3_store.clone(), user_id.clone(), id.clone()).await {
      Ok(bytes) => {
        if attempt > 0 {
          debug!("Recovered S3 object read for '{}' after {} attempt(s)", s3_path, attempt + 1);
        }
        return Ok(bytes);
      }
      Err(err) => {
        if !is_retryable_get_error(&err) || attempt + 1 == GET_MAX_ATTEMPTS {
          return Err(err);
        }

        let delay = Duration::from_millis(GET_RETRY_DELAYS_MILLIS[attempt]);
        debug!(
          "Retrying transient S3 read failure for '{}' after attempt {} of {}: {}",
          s3_path,
          attempt + 1,
          GET_MAX_ATTEMPTS,
          err
        );
        tokio::time::sleep(delay).await;
      }
    }
  }

  Err("S3 get retry loop exited unexpectedly".into())
}

fn is_retryable_get_error(err: &InfuError) -> bool {
  is_retryable_get_error_message(err.message())
}

fn is_retryable_get_error_message(message: &str) -> bool {
  if message.contains("Unexpected status code getting S3 object") {
    return ["408", "429", "500", "502", "503", "504"].iter().any(|status| message.contains(&format!(": {}", status)));
  }

  if message.contains("Timeout waiting for S3 stream to start")
    || message.contains("Timeout waiting for first byte from S3")
    || message.contains("Timeout during S3 transfer")
    || message.contains("Error opening S3 response stream")
    || message.contains("Error reading S3 stream chunk")
  {
    return true;
  }

  let lower = message.to_ascii_lowercase();
  lower.contains("connection closed before message completed")
    || lower.contains("connection reset")
    || lower.contains("unexpected eof")
    || lower.contains("broken pipe")
    || lower.contains("timed out")
}

/// The error and its underlying causes. reqwest's message alone is just "error sending request for url (...)", which
/// leaves out what actually went wrong (a timeout, a reset connection, a TLS failure, ...).
fn error_with_causes(error: &S3Error) -> String {
  let mut message = error.to_string();
  let mut source = std::error::Error::source(error);
  while let Some(cause) = source {
    let cause_message = cause.to_string();
    if !message.contains(&cause_message) {
      message = format!("{}: {}", message, cause_message);
    }
    source = cause.source();
  }
  message
}

// rust-s3 0.38 no longer retries ordinary PUTs or DELETEs. Preserve the previous
// single retry with the same key and bytes. A second failure must propagate through
// the normal command error response.
async fn retry_write_once<F, Fut>(operation_name: &str, path: &str, mut operation: F) -> Result<ResponseData, S3Error>
where
  F: FnMut() -> Fut,
  Fut: Future<Output = Result<ResponseData, S3Error>>,
{
  match operation().await {
    Ok(response) => Ok(response),
    Err(error) => {
      warn!("S3 {} for '{}' failed; retrying once in 1 second: {}", operation_name, path, error_with_causes(&error));
      tokio::time::sleep(Duration::from_secs(1)).await;
      let result = operation().await;
      if let Err(error) = &result {
        warn!("S3 {} for '{}' failed after two attempts: {}", operation_name, path, error_with_causes(error));
      }
      result
    }
  }
}

fn put_timeout_secs(num_bytes: usize) -> u64 {
  FULL_TRANSFER_TIMEOUT_SECS.max(num_bytes as u64 / MIN_PUT_BYTES_PER_SEC)
}

pub(super) async fn put_object_with_retry(bucket: &Bucket, path: &str, val: &[u8]) -> Result<ResponseData, S3Error> {
  let bucket = bucket.with_request_timeout(Duration::from_secs(put_timeout_secs(val.len())))?;
  retry_write_once("PUT", path, || bucket.put_object(path, val)).await
}

pub(super) async fn delete_object_with_retry(bucket: &Bucket, path: &str) -> Result<ResponseData, S3Error> {
  retry_write_once("DELETE", path, || bucket.delete_object(path)).await
}

pub async fn put(s3_store: Arc<S3Store>, user_id: Uid, id: Uid, val: Arc<Vec<u8>>) -> InfuResult<()> {
  let s3_path = format!("{}_{}", user_id, id);
  let result = put_object_with_retry(&s3_store.bucket, &s3_path, val.as_slice())
    .await
    .map_err(|e| format!("Error occurred putting S3 object: {}", error_with_causes(&e)))?;
  if result.status_code() != 200 {
    return Err(format!("Unexpected status code putting S3 object: {}.", result.status_code()).into());
  }
  Ok(())
}

pub async fn delete(s3_store: Arc<S3Store>, user_id: Uid, id: Uid) -> InfuResult<()> {
  let s3_path = format!("{}_{}", user_id, id);
  let result = delete_object_with_retry(&s3_store.bucket, &s3_path)
    .await
    .map_err(|e| format!("Error occurred deleting S3 object: {}", e))?;
  if result.status_code() != 204 {
    return Err(format!("Unexpected status code deleting S3 object: {}", result.status_code()).into());
  }
  Ok(())
}

pub async fn list(s3_store: Arc<S3Store>) -> InfuResult<Vec<ItemAndUserId>> {
  let mut result = vec![];
  let mut lb_rs = s3_store
    .bucket
    .list_page("".to_owned(), None, None, None, None)
    .await
    .map_err(|e| format!("S3 list_page server request failed: {}", e))?;
  if lb_rs.1 != 200 {
    // status code.
    return Err(format!("Expected list_page status code to be 200, not {}", lb_rs.1).into());
  }
  loop {
    for c in lb_rs.0.contents {
      let mut parts = c.key.split("_");
      let user_id = parts.next().ok_or(format!("Unexpected object filename {}", c.key))?;
      let item_id = parts.next().ok_or(format!("Unexpected object filename {}", c.key))?;
      if parts.next().is_some() {
        return Err(format!("Unexpected object filename {}", c.key).into());
      }
      result.push(ItemAndUserId { user_id: String::from(user_id), item_id: String::from(item_id) });
    }
    // Listing a large bucket takes minutes (one request per 1000 objects), so report progress.
    info!("Listed {} objects so far.", result.len());
    if let Some(ct) = lb_rs.0.next_continuation_token {
      lb_rs = s3_store
        .bucket
        .list_page("".to_owned(), None, Some(ct), None, None)
        .await
        .map_err(|e| format!("S3 list_page server request (continuation) failed: {}", e))?;
      if lb_rs.1 != 200 {
        // status code.
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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn put_timeout_only_grows_for_files_too_big_for_the_base_limit() {
    assert_eq!(put_timeout_secs(0), FULL_TRANSFER_TIMEOUT_SECS);
    assert_eq!(put_timeout_secs(10 * 1024 * 1024), FULL_TRANSFER_TIMEOUT_SECS);
    // The file that failed: at 4 Mbit/s it takes about 144 seconds to send.
    assert_eq!(put_timeout_secs(71_835_413), 548);
    assert_eq!(put_timeout_secs(300 * 1024 * 1024), 2400);
  }

  #[tokio::test]
  async fn error_with_causes_includes_what_reqwest_leaves_out_of_its_message() {
    // Nothing listens on port 1, so this fails with a connection error.
    let error = reqwest::get("http://127.0.0.1:1/").await.unwrap_err();
    let reqwest_message = error.to_string();

    let message = error_with_causes(&S3Error::Reqwest(error));

    assert!(message.contains(&reqwest_message));
    assert!(message.len() > reqwest_message.len() + "reqwest: ".len(), "{}", message);
  }
}
