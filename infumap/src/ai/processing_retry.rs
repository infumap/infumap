//! Retry timing for existing in-memory queues. Restart recovery uses artifacts;
//! attempt counts may reset after a restart, which only repeats some work.
//!
//! Deliberate trade-off: there is no retry limit. Failures, including ones
//! unlikely to resolve themselves (e.g. password-protected PDFs), are retried
//! at most hourly forever, so unfinished work is never dropped. The occasional
//! wasted attempt is accepted. Queues and attempt counts are deliberately not
//! persisted; there is no processing database.
use std::collections::HashMap;
use std::hash::Hash;
use std::path::Path;
use std::time::{Duration, Instant};

use infusdk::util::{infu::InfuResult, time::unix_now_secs_i64};
use serde_json::Value;
use tokio::fs;

use super::artifact_io::atomic_write;

pub const INITIAL_RETRY_SECS: u64 = 300;
const MAX_RETRY_SECS: u64 = 3600;

pub struct RetrySchedule<K> {
  entries: HashMap<K, (u32, Instant)>,
}

impl<K> Default for RetrySchedule<K> {
  fn default() -> Self {
    Self { entries: HashMap::new() }
  }
}

impl<K: Eq + Hash> RetrySchedule<K> {
  pub fn ready(&self, key: &K) -> bool {
    self.entries.get(key).is_none_or(|(_, due)| Instant::now() >= *due)
  }

  /// Consecutive failures recorded for the key since it last succeeded.
  pub fn attempts(&self, key: &K) -> u32 {
    self.entries.get(key).map(|(attempts, _)| *attempts).unwrap_or(0)
  }

  pub fn clear(&mut self, key: &K) {
    self.entries.remove(key);
  }

  pub fn defer(&mut self, key: K, delay: Duration) {
    let entry = self.entries.entry(key).or_insert((0, Instant::now()));
    entry.1 = Instant::now() + delay;
  }

  pub fn failed(&mut self, key: K) -> Duration {
    let entry = self.entries.entry(key).or_insert((0, Instant::now()));
    let delay = Duration::from_secs((INITIAL_RETRY_SECS * (1 << entry.0.min(4))).min(MAX_RETRY_SECS));
    entry.0 = entry.0.saturating_add(1);
    entry.1 = Instant::now() + delay;
    delay
  }
}

/// Legacy manifests without a retry hint are eligible immediately.
pub async fn manifest_retry_delay(path: &Path) -> InfuResult<Duration> {
  let Some(manifest) = read_manifest(path).await? else { return Ok(Duration::ZERO) };
  let due = manifest.pointer("/processing/retry_at_unix_secs").and_then(Value::as_i64).unwrap_or(0);
  Ok(Duration::from_secs(due.saturating_sub(unix_now_secs_i64()?).clamp(0, MAX_RETRY_SECS as i64) as u64))
}

/// The failure recorded alongside a retry hint, for status reporting.
pub async fn manifest_retry_reason(path: &Path) -> InfuResult<Option<String>> {
  let Some(manifest) = read_manifest(path).await? else { return Ok(None) };
  Ok(manifest.get("error").and_then(Value::as_str).map(str::to_owned))
}

/// Preserve the failure reason. There is no new file for stages without a manifest.
pub async fn record_manifest_retry(path: &Path, delay: Duration) -> InfuResult<()> {
  let Some(mut manifest) = read_manifest(path).await? else { return Ok(()) };
  if manifest.get("schema_version").and_then(Value::as_u64) != Some(1) {
    return Ok(());
  }
  if matches!(manifest.get("status").and_then(Value::as_str), Some("succeeded" | "skipped")) {
    return Ok(());
  }
  let Some(fields) = manifest.as_object_mut() else { return Ok(()) };
  let processing = fields.entry("processing").or_insert_with(|| serde_json::json!({}));
  if !processing.is_object() {
    *processing = serde_json::json!({});
  }
  processing["retry_at_unix_secs"] = (unix_now_secs_i64()? + delay.as_secs() as i64).into();
  atomic_write(path, &serde_json::to_vec_pretty(&manifest)?).await
}

async fn read_manifest(path: &Path) -> InfuResult<Option<Value>> {
  match fs::read(path).await {
    Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(error) => Err(error.into()),
  }
}
