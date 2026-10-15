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

//! Explicit browser setup. Server startup resolves local paths without network
//! access; run.sh invokes setup once, outside its restart loop.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::{Instant, timeout_at};

use super::cache::{lock_file, private_directory};
use super::config::cache_home;
use super::pdf::bounded_body;
use crate::error::InfuResult;

// Verified against Google's Stable metadata on 2026-10-15. Installation does
// not silently update this pin. --update-browser deliberately selects Stable.
pub(super) const PINNED_VERSION: &str = "155.0.8059.79";
const METADATA: &str = "https://googlechromelabs.github.io/chrome-for-testing";
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
const MAX_EXPANDED: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct Installation {
  schema: u32,
  version: String,
  platform: String,
  archive_sha256: String,
}

pub(super) fn platform() -> InfuResult<&'static str> {
  match (std::env::consts::OS, std::env::consts::ARCH) {
    ("linux", "x86_64") => Ok("linux64"),
    ("linux", "aarch64") => Ok("linux-arm64"),
    ("macos", "x86_64") => Ok("mac-x64"),
    ("macos", "aarch64") => Ok("mac-arm64"),
    _ => Err("Managed Chrome is unsupported on this OS/architecture; configure WEB_FETCH_BROWSER_PATH.".into()),
  }
}

fn root() -> InfuResult<PathBuf> {
  Ok(
    cache_home()
      .ok_or("Set an absolute XDG_CACHE_HOME or HOME for local browser installation.")?
      .join("infumap-web-search/browsers"),
  )
}

fn executable(platform: &str) -> PathBuf {
  let directory = PathBuf::from(format!("chrome-{platform}"));
  if platform.starts_with("mac-") {
    directory.join("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
  } else {
    directory.join("chrome")
  }
}

fn valid_version(version: &str) -> bool {
  version.len() < 64
    && version.split('.').count() == 4
    && version.split('.').all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

pub(super) fn resolve(explicit: Option<&Path>) -> InfuResult<PathBuf> {
  if let Some(path) = explicit {
    return if suitable(path) {
      Ok(path.to_owned())
    } else {
      Err("WEB_FETCH_BROWSER_PATH is not an executable for this host. Correct the path or rerun browser setup.".into())
    };
  }
  if let (Ok(root), Ok(platform)) = (root(), platform())
    && let Ok(file) = std::fs::File::open(root.join("active.json"))
    && let Ok(info) = serde_json::from_reader::<_, Installation>(file.take(8192))
    && info.schema == 1
    && info.platform == platform
    && valid_version(&info.version)
  {
    let path = root.join(format!("{}-{platform}", info.version)).join(executable(platform));
    if suitable(&path) {
      return Ok(path);
    }
  }
  if let Ok(path) = chromiumoxide::detection::default_executable(Default::default())
    && suitable(&path)
  {
    return Ok(path);
  }
  Err("No suitable browser found. Run tools/mcp/web-search/run.sh or set WEB_FETCH_BROWSER_PATH.".into())
}

/// Static checks only: do not launch an unconfined browser as a readiness
/// probe. Host library/sandbox readiness is established by an actual fetch.
fn suitable(path: &Path) -> bool {
  if !path.is_absolute() || !path.is_file() {
    return false;
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    if std::fs::metadata(path).ok().is_none_or(|metadata| metadata.permissions().mode() & 0o111 == 0) {
      return false;
    }
  }
  let Ok(mut file) = std::fs::File::open(path) else { return false };
  let mut header = [0_u8; 32];
  let Ok(length) = file.read(&mut header) else { return false };
  if length < 4 {
    return false;
  }
  if header.starts_with(b"#!") {
    return true;
  } // Trusted operator/system wrappers.
  if header.starts_with(b"\x7fELF") {
    if length < 20 || header[4] != 2 {
      return false;
    }
    let machine = if header[5] == 1 {
      u16::from_le_bytes([header[18], header[19]])
    } else {
      u16::from_be_bytes([header[18], header[19]])
    };
    return machine == if cfg!(target_arch = "aarch64") { 183 } else { 62 };
  }
  #[cfg(target_os = "macos")]
  {
    let magic = u32::from_be_bytes(header[..4].try_into().expect("four bytes"));
    // Universal binaries and native Mach-O images; dyld checks their slices.
    return matches!(magic, 0xcafebabe | 0xbebafeca | 0xcafebabf | 0xbfbafeca | 0xfeedfacf | 0xcffaedfe);
  }
  #[cfg(not(target_os = "macos"))]
  false
}

pub(super) async fn command(update: bool) -> InfuResult<PathBuf> {
  let explicit = std::env::var_os("WEB_FETCH_BROWSER_PATH").filter(|value| !value.is_empty()).map(PathBuf::from);
  if !update {
    if explicit.is_some() {
      return resolve(explicit.as_deref());
    }
    if let Ok(path) = resolve(None) {
      return Ok(path);
    }
  }
  let deadline = Instant::now() + Duration::from_secs(300);
  timeout_at(deadline, install(update, deadline)).await.map_err(|_| "Browser installation exceeded five minutes.")?
}

async fn install(update: bool, deadline: Instant) -> InfuResult<PathBuf> {
  let root = root()?;
  private_directory(&root).await?;
  let lock = lock_file(&root.join("install.lock"), deadline).await?;
  // No installer can still own these staging paths after we hold this lock.
  let mut leftovers = tokio::fs::read_dir(&root).await.map_err(|_| "Could not inspect browser staging.")?;
  while let Some(entry) = leftovers.next_entry().await.map_err(|_| "Could not inspect browser staging entry.")? {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    if ["download-", "install-", "active-"].iter().any(|prefix| name.starts_with(prefix)) {
      if entry.file_type().await.map_err(|_| "Could not inspect browser staging type.")?.is_dir() {
        let _ = tokio::fs::remove_dir_all(entry.path()).await;
      } else {
        let _ = tokio::fs::remove_file(entry.path()).await;
      }
    }
  }
  if !update && let Ok(path) = resolve(None) {
    return Ok(path);
  }
  let platform = platform()?;
  let client = reqwest::Client::builder()
    .no_proxy()
    .redirect(reqwest::redirect::Policy::none())
    .connect_timeout(Duration::from_secs(15))
    .build()
    .map_err(|_| "Could not create browser download client.")?;
  let version = if update {
    let value = metadata(&client, &format!("{METADATA}/last-known-good-versions.json")).await?;
    value["channels"]["Stable"]["version"]
      .as_str()
      .ok_or("Official metadata has no Stable browser version.")?
      .to_owned()
  } else {
    PINNED_VERSION.to_owned()
  };
  if !valid_version(&version) {
    return Err("Official metadata returned an invalid browser version.".into());
  }
  let value = metadata(&client, &format!("{METADATA}/{version}.json")).await?;
  if value["version"] != version {
    return Err("Official browser metadata version mismatch.".into());
  }
  let expected =
    format!("https://storage.googleapis.com/chrome-for-testing-public/{version}/{platform}/chrome-{platform}.zip");
  let advertised = value["downloads"]["chrome"]
    .as_array()
    .and_then(|downloads| downloads.iter().find(|download| download["platform"] == platform))
    .and_then(|download| download["url"].as_str());
  if advertised != Some(expected.as_str()) {
    return Err("No official Chrome artifact for this version/platform.".into());
  }
  let directory = root.join(format!("{version}-{platform}"));
  if suitable(&directory.join(executable(platform))) {
    let info = Installation { schema: 1, version, platform: platform.into(), archive_sha256: String::new() };
    publish_active(&root, &info)?;
    return Ok(directory.join(executable(platform)));
  }
  eprintln!("Installing official Chrome for Testing {version} ({platform}) in the user cache.");
  let archive = tempfile::Builder::new()
    .prefix("download-")
    .suffix(".zip")
    .tempfile_in(&root)
    .map_err(|_| "Could not stage browser download.")?;
  let mut output = tokio::fs::File::from_std(archive.reopen().map_err(|_| "Could not open browser download file.")?);
  let response = client
    .get(expected)
    .timeout(Duration::from_secs(180))
    .send()
    .await
    .map_err(|_| "Could not download official Chrome archive. Configure an installed browser for offline use.")?;
  if !response.status().is_success() || response.content_length().is_some_and(|size| size > MAX_ARCHIVE) {
    return Err("Chrome download failed or exceeds its 512 MiB limit.".into());
  }
  let mut chunks = response.bytes_stream();
  let mut downloaded = 0_u64;
  use tokio::io::AsyncWriteExt;
  while let Some(chunk) = chunks.next().await {
    let chunk = chunk.map_err(|_| "Browser archive download was interrupted.")?;
    downloaded += chunk.len() as u64;
    if downloaded > MAX_ARCHIVE {
      return Err("Chrome archive exceeds 512 MiB.".into());
    }
    output.write_all(&chunk).await.map_err(|_| "Could not write browser archive.")?;
  }
  output.flush().await.map_err(|_| "Could not finish browser archive.")?;
  drop(output);
  // The blocking installer owns the lock and staging guards through cleanup,
  // including if its async caller stops waiting at the overall deadline.
  tokio::task::spawn_blocking(move || {
    let _lock = lock;
    let stage =
      tempfile::Builder::new().prefix("install-").tempdir_in(&root).map_err(|_| "Could not stage browser files.")?;
    let sha256 = archive_digest(archive.path(), deadline)?;
    unpack(archive.path(), stage.path(), deadline)?;
    let binary = stage.path().join(executable(platform));
    if !suitable(&binary) {
      return Err("Downloaded Chrome is not executable on this host.".into());
    }
    if directory.exists() {
      // Keep a failed prior installation available for inspection; never remove
      // an unrelated/global browser or scan other user profiles.
      std::fs::rename(&directory, root.join(format!("broken-{:016x}", rand::random::<u64>())))
        .map_err(|_| "Could not preserve prior incomplete browser installation.")?;
    }
    std::fs::rename(stage.path(), &directory).map_err(|_| "Could not publish browser installation.")?;
    let info = Installation { schema: 1, version, platform: platform.into(), archive_sha256: sha256 };
    publish_active(&root, &info)?;
    Ok(directory.join(executable(platform)))
  })
  .await
  .map_err(|_| "Browser installation worker stopped.")?
}

async fn metadata(client: &reqwest::Client, url: &str) -> InfuResult<Value> {
  let response = client
    .get(url)
    .timeout(Duration::from_secs(15))
    .send()
    .await
    .map_err(|_| "Official browser metadata is unavailable.")?;
  if !response.status().is_success() {
    return Err("Official browser metadata returned an error; redirects are rejected.".into());
  }
  serde_json::from_slice(&bounded_body(response, 1024 * 1024).await?)
    .map_err(|_| "Invalid official browser metadata.".into())
}

fn publish_active(root: &Path, installation: &Installation) -> InfuResult<()> {
  let mut file = tempfile::Builder::new()
    .prefix("active-")
    .tempfile_in(root)
    .map_err(|_| "Could not stage browser installation index.")?;
  serde_json::to_writer(&mut file, installation).map_err(|_| "Could not encode browser installation index.")?;
  file.persist(root.join("active.json")).map_err(|_| "Could not publish browser installation index.")?;
  Ok(())
}

fn unpack(archive: &Path, root: &Path, deadline: Instant) -> InfuResult<()> {
  let mut zip = zip::ZipArchive::new(std::fs::File::open(archive).map_err(|_| "Could not read browser ZIP.")?)
    .map_err(|_| "Invalid browser ZIP archive.")?;
  if zip.len() > 30000 {
    return Err("Browser ZIP contains too many files.".into());
  }
  let mut paths = HashSet::new();
  let mut links = Vec::new();
  let mut expanded = 0_u64;
  for index in 0..zip.len() {
    if Instant::now() >= deadline {
      return Err("Browser extraction deadline expired.".into());
    }
    let mut file = zip.by_index(index).map_err(|_| "Could not read browser ZIP entry.")?;
    let name = file.enclosed_name().ok_or("Unsafe browser ZIP path.")?;
    if name.components().any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
      || name.as_os_str().to_string_lossy().contains(['\\', ':'])
      || !paths.insert(name.clone())
    {
      return Err("Unsafe or duplicate browser ZIP path.".into());
    }
    expanded = expanded.checked_add(file.size()).ok_or("Browser ZIP size overflow.")?;
    if expanded > MAX_EXPANDED || file.size() > MAX_ARCHIVE {
      return Err("Expanded browser ZIP exceeds its limit.".into());
    }
    let destination = root.join(&name);
    let mode = file.unix_mode().unwrap_or(0);
    if file.is_symlink() {
      let mut target = String::new();
      file.take(4097).read_to_string(&mut target).map_err(|_| "Invalid browser symlink.")?;
      if target.len() > 4096 || target.contains(['\\', ':']) || Path::new(&target).is_absolute() {
        return Err("Unsafe browser symlink target.".into());
      }
      let mut resolved = name.parent().unwrap_or(Path::new("")).to_path_buf();
      for part in Path::new(&target).components() {
        match part {
          Component::Normal(part) => resolved.push(part),
          Component::CurDir => {}
          Component::ParentDir if resolved.pop() => {}
          _ => return Err("Browser symlink escapes installation.".into()),
        }
      }
      links.push((name, target));
    } else if file.is_dir() {
      std::fs::create_dir_all(destination).map_err(|_| "Could not create browser directory.")?;
    } else {
      if mode & 0o170000 != 0 && mode & 0o170000 != 0o100000 {
        return Err("Browser ZIP contains a special file.".into());
      }
      if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Could not create browser parent directory.")?;
      }
      let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|_| "Could not create browser file.")?;
      let mut copied = 0_u64;
      let mut buffer = [0_u8; 65536];
      loop {
        if Instant::now() >= deadline {
          return Err("Browser extraction deadline expired.".into());
        }
        let count = file.read(&mut buffer).map_err(|_| "Browser ZIP integrity check failed.")?;
        if count == 0 {
          break;
        }
        copied += count as u64;
        if copied > MAX_ARCHIVE || copied > file.size() {
          return Err("Browser ZIP entry exceeds its limit.".into());
        }
        output.write_all(&buffer[..count]).map_err(|_| "Could not write browser file.")?;
      }
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        output
          .set_permissions(std::fs::Permissions::from_mode(if mode & 0o111 != 0 { 0o755 } else { 0o644 }))
          .map_err(|_| "Could not set browser file permissions.")?;
      }
    }
  }
  // No ZIP entry may be written under a symlink, even a deferred symlink.
  // This prevents parent-link traversal when creating other links.
  for (name, _) in &links {
    if paths.iter().any(|path| path != name && path.starts_with(name)) {
      return Err("Browser ZIP nests entries beneath a symlink.".into());
    }
  }
  #[cfg(unix)]
  for (name, target) in &links {
    let destination = root.join(name);
    if let Some(parent) = destination.parent() {
      std::fs::create_dir_all(parent).map_err(|_| "Could not create symlink parent.")?;
    }
    std::os::unix::fs::symlink(target, destination).map_err(|_| "Could not create browser symlink.")?;
  }
  let canonical_root = root.canonicalize().map_err(|_| "Could not resolve browser installation.")?;
  for (name, _) in links {
    if !root
      .join(name)
      .canonicalize()
      .map_err(|_| "Browser ZIP contains a dangling/cyclic symlink.")?
      .starts_with(&canonical_root)
    {
      return Err("Browser symlink escapes its installation.".into());
    }
  }
  Ok(())
}

fn archive_digest(path: &Path, deadline: Instant) -> InfuResult<String> {
  use sha2::{Digest, Sha256};
  let mut file = std::fs::File::open(path).map_err(|_| "Could not hash browser archive.")?;
  let mut hash = Sha256::new();
  let mut buffer = [0_u8; 65536];
  loop {
    if Instant::now() >= deadline {
      return Err("Browser installation deadline expired.".into());
    }
    let count = file.read(&mut buffer).map_err(|_| "Could not hash browser archive.")?;
    if count == 0 {
      break;
    }
    hash.update(&buffer[..count]);
  }
  Ok(format!("{:x}", hash.finalize()))
}
