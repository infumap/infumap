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

//! Private native-only PDF artifacts, atomic indexes and bounded disk use.
//! Locks use fixed stripes and are never unlinked while another process may
//! hold the inode. A cancelled caller cannot publish a partial artifact.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use super::config::FetchConfig;
use super::http::Validators;
use super::pdf::{NativeText, POLICY_VERSION};
use crate::error::InfuResult;

pub(super) fn digest(bytes: &[u8]) -> String {
  format!("{:x}", Sha256::digest(bytes))
}
fn now() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

#[derive(Clone)]
pub(super) struct PdfCache {
  config: FetchConfig,
  readers: Arc<Semaphore>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Source {
  pub url: String,
  pub final_url: String,
  pub validators: Validators,
  pub content_hash: String,
  pub checked_at: u64,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
  schema: u32,
  policy: u32,
  content_hash: String,
  markdown_hash: String,
  created_at: u64,
  metadata: serde_json::Value,
}

pub(super) struct CachedPdf {
  pub source: Source,
  pub text: NativeText,
  pub bytes: Bytes,
  pub fresh: bool,
}

pub(super) struct FileLock(std::fs::File);

#[cfg(unix)]
impl Drop for FileLock {
  fn drop(&mut self) {
    use std::os::fd::AsRawFd;
    // SAFETY: this guard owns this open file description.
    unsafe {
      libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
    }
  }
}

pub(super) async fn lock_file(path: &Path, deadline: Instant) -> InfuResult<FileLock> {
  #[cfg(not(unix))]
  {
    let _ = (path, deadline);
    Err("Shared cache/install locking is unsupported on this platform.".into())
  }
  #[cfg(unix)]
  {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let path = path.to_owned();
    let file = tokio::task::spawn_blocking(move || {
      std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(path)
    })
    .await
    .map_err(|_| "Could not open cache/install lock.")?
    .map_err(|error| format!("Could not open lock: {error}"))?;
    loop {
      if Instant::now() >= deadline {
        return Err("Deadline expired while waiting for cache/install lock.".into());
      }
      // SAFETY: valid descriptor; nonblocking operation never holds up Tokio.
      if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(FileLock(file));
      }
      let error = std::io::Error::last_os_error();
      if error.kind() != std::io::ErrorKind::WouldBlock && error.kind() != std::io::ErrorKind::Interrupted {
        return Err(format!("Could not acquire lock: {error}").into());
      }
      tokio::time::sleep(Duration::from_millis(25)).await;
    }
  }
}

impl PdfCache {
  pub fn new(config: FetchConfig) -> Self {
    Self { config, readers: Arc::new(Semaphore::new(2)) }
  }
  pub fn enabled(&self) -> bool {
    self.config.cache_dir.is_some()
  }

  async fn root(&self) -> InfuResult<PathBuf> {
    let root = self.config.cache_dir.clone().ok_or("PDF cache disabled.")?;
    private_directory(&root).await?;
    for directory in ["locks", "objects", "indexes", "sources", "staging"] {
      private_directory(&root.join(directory)).await?;
    }
    Ok(root)
  }

  pub async fn lock(&self, namespace: &str, key: &str, deadline: Instant) -> InfuResult<Option<FileLock>> {
    if !self.enabled() {
      return Ok(None);
    }
    let root = self.root().await?;
    Ok(Some(lock_file(&root.join("locks").join(format!("{namespace}-{}", &key[..2])), deadline).await?))
  }

  pub async fn lookup(&self, url: &str) -> InfuResult<Option<CachedPdf>> {
    if !self.enabled() || self.config.pdf_refresh {
      return Ok(None);
    }
    let root = self.root().await?;
    let source = read_limited(root.join("sources").join(digest(url.as_bytes())), 16 * 1024).await?;
    let Some(source) = source.and_then(|data| serde_json::from_slice::<Source>(&data).ok()) else { return Ok(None) };
    if source.url != url || !valid_hash(&source.content_hash) {
      return Ok(None);
    }
    let Some((text, bytes, _created)) = self.load(&root, &source.content_hash).await? else { return Ok(None) };
    let fresh = now().saturating_sub(source.checked_at) < self.config.cache_ttl.as_secs();
    Ok(Some(CachedPdf { source, text, bytes, fresh }))
  }

  pub async fn content(&self, hash: &str) -> InfuResult<Option<NativeText>> {
    if !self.enabled() || self.config.pdf_refresh {
      return Ok(None);
    }
    let root = self.root().await?;
    Ok(self.load(&root, hash).await?.map(|(text, _, _)| text))
  }

  async fn load(&self, root: &Path, hash: &str) -> InfuResult<Option<(NativeText, Bytes, u64)>> {
    if !valid_hash(hash) {
      return Ok(None);
    }
    let permit = self.readers.clone().acquire_owned().await.map_err(|_| "PDF cache read queue closed.")?;
    let Some(index) = read_limited(root.join("indexes").join(hash), 256).await? else { return Ok(None) };
    let Ok(name) = String::from_utf8(index) else { return Ok(None) };
    if !name.starts_with(&format!("{hash}-")) || name.bytes().any(|byte| !byte.is_ascii_alphanumeric() && byte != b'-')
    {
      return Ok(None);
    }
    let object = root.join("objects").join(name);
    let Some(manifest) = read_limited(object.join("manifest.json"), self.config.max_pdf_response_bytes).await? else {
      return Ok(None);
    };
    let Ok(manifest) = serde_json::from_slice::<Manifest>(&manifest) else { return Ok(None) };
    if manifest.schema != 1 || manifest.policy != POLICY_VERSION || manifest.content_hash != hash {
      return Ok(None);
    }
    let Some(markdown) = read_limited(object.join("text.md"), self.config.max_pdf_response_bytes).await? else {
      return Ok(None);
    };
    let Some(pdf) = read_limited(object.join("document.pdf"), self.config.max_pdf_bytes).await? else {
      return Ok(None);
    };
    let expected = hash.to_owned();
    tokio::task::spawn_blocking(move || {
      let _permit = permit;
      if digest(&pdf) != expected || digest(&markdown) != manifest.markdown_hash || !super::http::is_pdf(&pdf) {
        return None;
      }
      let markdown = String::from_utf8(markdown).ok()?;
      let text = NativeText { markdown, metadata: manifest.metadata };
      text.validate().ok()?;
      Some((text, Bytes::from(pdf), manifest.created_at))
    })
    .await
    .map_err(|_| "PDF cache validation worker stopped.".into())
  }

  pub async fn remember(&self, mut source: Source, deadline: Instant) -> InfuResult<()> {
    if !self.enabled() {
      return Ok(());
    }
    let root = self.root().await?;
    source.checked_at = now();
    if serde_json::to_vec(&source).map_err(|_| "Could not encode PDF source index.")?.len() > 16 * 1024 {
      return Err("PDF source index exceeds its metadata limit.".into());
    }
    let _maintenance = lock_file(&root.join("locks/maintenance"), deadline).await?;
    atomic_json(root.join("sources").join(digest(source.url.as_bytes())), &source).await?;
    prune_small_files(&root.join("sources"), 4096).await?;
    Ok(())
  }

  pub async fn publish(&self, hash: &str, bytes: Bytes, text: &NativeText, deadline: Instant) -> InfuResult<()> {
    if !self.enabled() {
      return Ok(());
    }
    text.validate()?;
    let root = self.root().await?;
    let manifest = Manifest {
      schema: 1,
      policy: POLICY_VERSION,
      content_hash: hash.to_owned(),
      markdown_hash: digest(text.markdown.as_bytes()),
      created_at: now(),
      metadata: text.metadata.clone(),
    };
    let json = serde_json::to_vec(&manifest).map_err(|_| "Could not encode native PDF cache manifest.")?;
    let size = bytes.len() as u64 + text.markdown.len() as u64 + json.len() as u64;
    if size > self.config.cache_max_bytes {
      return Ok(());
    }
    let _maintenance = lock_file(&root.join("locks/maintenance"), deadline).await?;
    self.prune(&root, size).await?;
    let stage = tempfile::Builder::new()
      .prefix("artifact-")
      .tempdir_in(root.join("staging"))
      .map_err(|_| "Could not stage PDF cache artifact.")?;
    tokio::fs::write(stage.path().join("document.pdf"), bytes).await.map_err(|_| "Could not cache PDF bytes.")?;
    tokio::fs::write(stage.path().join("text.md"), &text.markdown)
      .await
      .map_err(|_| "Could not cache PDF Markdown.")?;
    tokio::fs::write(stage.path().join("manifest.json"), json).await.map_err(|_| "Could not cache PDF metadata.")?;
    let name = format!("{hash}-{:016x}", rand::random::<u64>());
    tokio::fs::rename(stage.path(), root.join("objects").join(&name))
      .await
      .map_err(|_| "Could not publish PDF artifact.")?;
    atomic_bytes(root.join("indexes").join(hash), name.into_bytes()).await?;
    prune_small_files(&root.join("indexes"), 4096).await?;
    Ok(())
  }

  async fn prune(&self, root: &Path, incoming: u64) -> InfuResult<()> {
    let mut objects = Vec::new();
    let mut total = incoming;
    let mut directories =
      tokio::fs::read_dir(root.join("objects")).await.map_err(|_| "Could not inspect PDF cache.")?;
    while let Some(entry) = directories.next_entry().await.map_err(|_| "Could not inspect PDF cache entry.")? {
      if !entry.file_type().await.map_err(|_| "Could not inspect PDF cache type.")?.is_dir() {
        continue;
      }
      let mut size = 0;
      for file in ["document.pdf", "text.md", "manifest.json"] {
        size += tokio::fs::metadata(entry.path().join(file)).await.map(|metadata| metadata.len()).unwrap_or(0);
      }
      total += size;
      let age = entry.metadata().await.ok().and_then(|metadata| metadata.modified().ok()).unwrap_or(UNIX_EPOCH);
      objects.push((age, entry.path(), size));
    }
    objects.sort_by_key(|(age, _, _)| *age);
    let mut count = objects.len() + 1;
    for (age, path, size) in objects {
      let expired = age.elapsed().unwrap_or_default() > self.config.cache_ttl;
      if total <= self.config.cache_max_bytes && count <= 4096 && !expired {
        continue;
      }
      if tokio::fs::remove_dir_all(path).await.is_ok() {
        total = total.saturating_sub(size);
        count -= 1;
      }
    }
    if total > self.config.cache_max_bytes || count > 4096 {
      return Err("Could not reclaim enough PDF cache space.".into());
    }
    // Every publisher holds the same maintenance lock through staging and
    // publication. Leftover staging directories therefore have no live writer.
    let mut staging = tokio::fs::read_dir(root.join("staging")).await.map_err(|_| "Could not inspect PDF staging.")?;
    while let Some(entry) = staging.next_entry().await.map_err(|_| "Could not inspect PDF staging entry.")? {
      let _ = tokio::fs::remove_dir_all(entry.path()).await;
    }
    Ok(())
  }
}

pub(super) async fn private_directory(path: &Path) -> InfuResult<()> {
  tokio::fs::create_dir_all(path)
    .await
    .map_err(|error| format!("Could not create private cache directory: {error}"))?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
      .await
      .map_err(|_| "Could not protect cache directory.")?;
  }
  Ok(())
}

fn valid_hash(hash: &str) -> bool {
  hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

async fn read_limited(path: PathBuf, limit: usize) -> InfuResult<Option<Vec<u8>>> {
  use tokio::io::AsyncReadExt;
  let Ok(file) = tokio::fs::File::open(path).await else { return Ok(None) };
  let mut bytes = Vec::new();
  file.take(limit as u64 + 1).read_to_end(&mut bytes).await.map_err(|_| "Could not read PDF cache artifact.")?;
  Ok((bytes.len() <= limit).then_some(bytes))
}

async fn atomic_json(path: PathBuf, value: &impl Serialize) -> InfuResult<()> {
  atomic_bytes(path, serde_json::to_vec(value).map_err(|_| "Could not encode PDF source index.")?).await
}

async fn atomic_bytes(path: PathBuf, bytes: Vec<u8>) -> InfuResult<()> {
  tokio::task::spawn_blocking(move || {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid cache index path.")?)
      .map_err(|_| "Could not stage cache index.")?;
    file.write_all(&bytes).map_err(|_| "Could not write cache index.")?;
    file.persist(path).map_err(|_| "Could not publish cache index.")?;
    Ok::<_, crate::error::InfuError>(())
  })
  .await
  .map_err(|_| "PDF cache publication task stopped.")?
}

async fn prune_small_files(path: &Path, maximum: usize) -> InfuResult<()> {
  let mut files = Vec::new();
  let mut entries = tokio::fs::read_dir(path).await.map_err(|_| "Could not inspect PDF cache index.")?;
  while let Some(entry) = entries.next_entry().await.map_err(|_| "Could not inspect PDF index entry.")? {
    let age = entry.metadata().await.ok().and_then(|metadata| metadata.modified().ok()).unwrap_or(UNIX_EPOCH);
    files.push((age, entry.path()));
  }
  files.sort_by_key(|(age, _)| *age);
  for (_, file) in files.iter().take(files.len().saturating_sub(maximum)) {
    let _ = tokio::fs::remove_file(file).await;
  }
  Ok(())
}
