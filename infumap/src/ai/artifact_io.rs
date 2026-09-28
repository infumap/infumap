//! Small helpers for disposable generated files and their existing manifests.
use std::path::Path;

use infusdk::util::{infu::InfuResult, time::unix_now_secs_i64, uid::new_uid};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{fs, io::AsyncWriteExt};

#[derive(Default, Deserialize, Serialize)]
pub struct ArtifactProcessing {
  /// Earliest background retry after failure; startup workers honor this hint.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub retry_at_unix_secs: Option<i64>,
}

impl ArtifactProcessing {
  pub fn failed() -> InfuResult<Self> {
    Ok(Self { retry_at_unix_secs: Some(unix_now_secs_i64()? + 300) })
  }

  /// Manifests omit the whole block when there is nothing to record.
  pub fn is_empty(&self) -> bool {
    self.retry_at_unix_secs.is_none()
  }
}

pub fn sha256(bytes: &[u8]) -> String {
  format!("{:x}", Sha256::digest(bytes))
}

pub async fn file_sha256(path: &Path) -> InfuResult<Option<String>> {
  match fs::read(path).await {
    Ok(bytes) => Ok(Some(sha256(&bytes))),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(error) => Err(error.into()),
  }
}

/// Publish one complete file. Output is published before its manifest; a crash
/// between the two leaves the previous manifest, or none, so the item is
/// re-processed or keeps its earlier state.
/// This deliberately is not a multi-file transaction or a processing database.
pub async fn atomic_write(path: &Path, bytes: &[u8]) -> InfuResult<()> {
  let parent = path.parent().ok_or("Artifact path has no parent directory.")?;
  fs::create_dir_all(parent).await?;
  let temporary = parent.join(format!(".artifact-{}.tmp", new_uid()));
  let result: InfuResult<()> = async {
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).await?;
    file.write_all(bytes).await?;
    file.sync_all().await?;
    drop(file);
    fs::rename(&temporary, path).await?;
    fs::File::open(parent).await?.sync_all().await?;
    Ok(())
  }
  .await;
  if result.is_err() {
    let _ = fs::remove_file(&temporary).await;
  }
  result
}

/// Publish one complete file without syncing it to disk, for derived files
/// that are cheap to rebuild. Readers still never see a partially written file.
///
/// Deliberate trade-off: syncing costs two disk flushes per file (file and
/// directory), which added up to about 1,000 per 500-item index commit. After a
/// power failure one of these files may be left empty or stale; that is
/// detected (fingerprints, parse failures, changed sizes and times) and the file
/// is rebuilt. Use `atomic_write` for GPU and location-service output and for
/// local text that is trusted without re-checking.
pub async fn atomic_write_unsynced(path: &Path, bytes: &[u8]) -> InfuResult<()> {
  let parent = path.parent().ok_or("Artifact path has no parent directory.")?;
  fs::create_dir_all(parent).await?;
  let temporary = parent.join(format!(".artifact-{}.tmp", new_uid()));
  let result: InfuResult<()> = async {
    fs::write(&temporary, bytes).await?;
    fs::rename(&temporary, path).await?;
    Ok(())
  }
  .await;
  if result.is_err() {
    let _ = fs::remove_file(&temporary).await;
  }
  result
}
