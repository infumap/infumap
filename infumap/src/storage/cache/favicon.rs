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

use filetime::{FileTime, set_file_atime};
use infusdk::util::infu::InfuResult;
use infusdk::util::time::unix_now_secs_u64;
use infusdk::util::uid::{Uid, uid_chars};
use log::{debug, info, warn};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::util::fs::{construct_file_subpath, ensure_256_subdirs, expand_tilde};

const ONE_MEGABYTE: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
struct FileInfo {
  pub size_bytes: usize,
  pub last_accessed: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct FaviconCacheKey {
  pub item_id: Uid,
  pub url_hash: String,
}

impl FaviconCacheKey {
  pub fn for_url(item_id: Uid, url: &str) -> FaviconCacheKey {
    FaviconCacheKey { item_id, url_hash: hash_url(url) }
  }
}

pub struct FaviconCache {
  cache_dir: PathBuf,
  max_mb: usize,
  current_total_bytes: u64,
  fileinfo_by_filename: HashMap<String, FileInfo>,
  filenames_by_item_id: HashMap<String, Vec<String>>,
}

impl FaviconCache {
  async fn new(cache_dir: &str, max_mb: usize) -> InfuResult<FaviconCache> {
    let cache_dir = favicon_cache_dir(cache_dir)?;
    tokio::fs::create_dir_all(&cache_dir).await?;

    let fileinfo_by_filename = Self::traverse_files(&cache_dir).await?;
    let current_total_bytes = fileinfo_by_filename.iter().fold(0, |a, (_k, v)| a + v.size_bytes) as u64;
    if current_total_bytes > max_mb as u64 * ONE_MEGABYTE {
      warn!("Total size of cached favicons {} exceeds maximum {}.", current_total_bytes, max_mb as u64 * ONE_MEGABYTE);
    }

    let mut filenames_by_item_id = HashMap::new();
    for (filename, _) in &fileinfo_by_filename {
      let item_id = item_id_from_filename(filename)?;
      if !filenames_by_item_id.contains_key(item_id) {
        filenames_by_item_id.insert(String::from(item_id), vec![]);
      }
      filenames_by_item_id.get_mut(item_id).unwrap().push(filename.clone());
    }

    info!(
      "Favicon cache '{}' state initialized. There are {} files totalling {} bytes.",
      cache_dir.display(),
      fileinfo_by_filename.len(),
      current_total_bytes
    );
    Ok(FaviconCache { cache_dir, max_mb, current_total_bytes, fileinfo_by_filename, filenames_by_item_id })
  }

  async fn traverse_files(cache_file_dir: &PathBuf) -> InfuResult<HashMap<String, FileInfo>> {
    let num_created = ensure_256_subdirs(&cache_file_dir).await?;
    if num_created > 0 {
      warn!(
        "Created {} missing favicon cache subdirectories in '{}'.",
        num_created,
        &cache_file_dir.as_path().display()
      );
    }

    let mut cache = HashMap::new();
    let mut path = cache_file_dir.clone();
    for i in 0..uid_chars().len() {
      for j in 0..uid_chars().len() {
        path.push(format!("{}{}", uid_chars().get(i).unwrap(), uid_chars().get(j).unwrap()));
        let mut iter = tokio::fs::read_dir(&path).await?;
        loop {
          let next_entry = iter.next_entry().await?;
          let Some(entry) = next_entry else {
            break;
          };
          let file_type = entry.file_type().await?;
          if !file_type.is_file() {
            warn!("'{}' in favicon cache is not a file.", entry.path().display());
            continue;
          }
          let md = entry.metadata().await?;
          let entry_name = entry.file_name();
          let filename =
            entry_name.to_str().ok_or(format!("Invalid cached favicon filename '{}'.", &path.display()))?.to_string();
          if filename.ends_with(".tmp") {
            warn!(
              "Deleting leftover temp favicon cache file '{}' (likely left by a previous crash).",
              entry.path().display()
            );
            if let Err(e) = tokio::fs::remove_file(entry.path()).await {
              warn!("Failed to delete leftover temp favicon cache file '{}': {}", entry.path().display(), e);
            }
            continue;
          }
          if md.len() == 0 {
            warn!(
              "Deleting zero-byte favicon cache file '{}' (likely left by a previous crash).",
              entry.path().display()
            );
            if let Err(e) = tokio::fs::remove_file(entry.path()).await {
              warn!("Failed to delete zero-byte favicon cache file '{}': {}", entry.path().display(), e);
            }
            continue;
          }
          item_id_from_filename(&filename)?;
          let file_info = FileInfo {
            size_bytes: md.len() as usize,
            last_accessed: md.accessed()?.duration_since(UNIX_EPOCH)?.as_secs(),
          };
          cache.insert(filename, file_info);
        }
        path.pop();
      }
    }

    Ok(cache)
  }
}

pub async fn new(cache_dir: &str, max_mb: usize) -> InfuResult<Arc<Mutex<FaviconCache>>> {
  Ok(Arc::new(Mutex::new(FaviconCache::new(cache_dir, max_mb).await?)))
}

pub async fn get(
  favicon_cache: Arc<Mutex<FaviconCache>>,
  user_id: &Uid,
  key: FaviconCacheKey,
) -> InfuResult<Option<Vec<u8>>> {
  let filename = filename_for_key(user_id, &key);

  let cache_dir;
  let file_info;
  {
    let mut favicon_cache = favicon_cache.lock().unwrap();
    cache_dir = favicon_cache.cache_dir.clone();
    if let Some(fi) = favicon_cache.fileinfo_by_filename.get(&filename) {
      file_info = fi.clone();
      favicon_cache.fileinfo_by_filename.insert(
        filename.clone(),
        FileInfo { size_bytes: file_info.size_bytes, last_accessed: unix_now_secs_u64().unwrap() },
      );
    } else {
      return Ok(None);
    }
  }

  let p = construct_file_subpath(&cache_dir, &filename)?;
  set_file_atime(&p, FileTime::now())?;
  let mut f = File::open(p).await?;
  let mut buffer = vec![0; file_info.size_bytes];
  f.read_exact(&mut buffer).await?;
  Ok(Some(buffer))
}

#[allow(dead_code)]
pub async fn put_if_not_exist(
  favicon_cache: Arc<Mutex<FaviconCache>>,
  user_id: &Uid,
  key: FaviconCacheKey,
  val: Vec<u8>,
) -> InfuResult<()> {
  if val.is_empty() {
    return Err("Cannot cache empty (zero-byte) favicon data.".into());
  }

  let filename = filename_for_key(user_id, &key);

  let cache_dir;
  {
    let mut favicon_cache = favicon_cache.lock().unwrap();
    if favicon_cache.fileinfo_by_filename.contains_key(&filename) {
      return Ok(());
    }
    cache_dir = favicon_cache.cache_dir.clone();
    if !favicon_cache.filenames_by_item_id.contains_key(&key.item_id) {
      favicon_cache.filenames_by_item_id.insert(String::from(&key.item_id), vec![]);
    }
    favicon_cache.filenames_by_item_id.get_mut(&key.item_id).unwrap().push(filename.clone());

    let file_info = FileInfo { size_bytes: val.len(), last_accessed: unix_now_secs_u64().unwrap() };
    favicon_cache.current_total_bytes += file_info.size_bytes as u64;
    favicon_cache.fileinfo_by_filename.insert(filename.clone(), file_info);
  }

  let path = construct_file_subpath(&cache_dir, &filename)?;
  let mut temp_path = path.clone();
  temp_path.set_file_name(format!("{}.tmp", filename));
  let mut file = OpenOptions::new()
    .create(true)
    .write(true)
    .truncate(true)
    .open(temp_path.clone())
    .await
    .map_err(|e| format!("Error opening temp favicon cache file {:?}: {}", temp_path, e))?;
  file.write_all(&val).await.map_err(|e| format!("Error writing to temp favicon cache file {:?}: {}", temp_path, e))?;
  file.flush().await?;
  drop(file);
  tokio::fs::rename(&temp_path, &path)
    .await
    .map_err(|e| format!("Error renaming temp favicon cache file {:?} to {:?}: {}", temp_path, path, e))?;

  purge_maybe(favicon_cache).await?;

  Ok(())
}

#[allow(dead_code)]
pub async fn delete_all(favicon_cache: Arc<Mutex<FaviconCache>>, user_id: &Uid, item_id: &str) -> InfuResult<usize> {
  let filenames;
  let cache_dir;
  {
    let mut favicon_cache = favicon_cache.lock().unwrap();
    cache_dir = favicon_cache.cache_dir.clone();
    filenames = if let Some(filenames) = favicon_cache.filenames_by_item_id.get(item_id) {
      filenames.clone()
    } else {
      return Ok(0);
    };

    for filename in &filenames {
      if !filename.ends_with(&user_id[..8]) {
        return Err(format!("User '{}' does not own cached favicon '{}'.", user_id, filename).into());
      }
      let file_info = favicon_cache
        .fileinfo_by_filename
        .remove(filename)
        .ok_or(format!("Favicon cache info for '{}' is missing.", filename))?;
      favicon_cache.current_total_bytes -= file_info.size_bytes as u64;
    }
    favicon_cache.filenames_by_item_id.remove(item_id);
  }

  for filename in &filenames {
    let path = construct_file_subpath(&cache_dir, filename)?;
    tokio::fs::remove_file(&path)
      .await
      .map_err(|e| format!("An error occurred removing file '{:?}' in favicon cache: {}", path, e))?;
  }

  Ok(filenames.len())
}

fn filename_for_key(user_id: &Uid, key: &FaviconCacheKey) -> String {
  format!("{}_{}_{}", key.item_id, key.url_hash, &user_id[..8])
}

fn item_id_from_filename(filename: &str) -> InfuResult<&str> {
  let parts = filename.split('_').collect::<Vec<&str>>();
  if parts.len() != 3 {
    return Err(format!("Invalid favicon cache filename '{}'.", filename).into());
  }
  if parts[0].len() != 32 || !parts[0].chars().all(|c| c.is_ascii_hexdigit()) {
    return Err(format!("Invalid item id in favicon cache filename '{}'.", filename).into());
  }
  if parts[1].len() != 64 || !parts[1].chars().all(|c| c.is_ascii_hexdigit()) {
    return Err(format!("Invalid url hash in favicon cache filename '{}'.", filename).into());
  }
  if parts[2].len() != 8 || !parts[2].chars().all(|c| c.is_ascii_hexdigit()) {
    return Err(format!("Invalid user id prefix in favicon cache filename '{}'.", filename).into());
  }
  Ok(parts[0])
}

fn hash_url(url: &str) -> String {
  let digest = Sha256::digest(url.trim().as_bytes());
  digest.iter().map(|b| format!("{:02x}", b)).collect()
}

fn favicon_cache_dir(cache_dir: &str) -> InfuResult<PathBuf> {
  let cache_path = expand_tilde(cache_dir).ok_or(format!("Favicon cache path '{}' is not valid.", cache_dir))?;
  let mut path = cache_path.parent().map(|parent| parent.to_path_buf()).unwrap_or_else(PathBuf::new);
  path.push("favicons-cache");
  Ok(path)
}

fn score(fi: &FileInfo) -> f64 {
  let size = if fi.size_bytes > 1000 { fi.size_bytes } else { 1000 };
  let size_factor = (size as f64 / 1000.0).powf(1.0 / 4.0);

  let now_unix = unix_now_secs_u64().unwrap();
  let seconds_ago = if now_unix < fi.last_accessed { 0 } else { now_unix - fi.last_accessed };
  let days_ago = seconds_ago as f64 / (24.0 * 60.0 * 60.0);

  size_factor * days_ago
}

async fn purge_maybe(favicon_cache: Arc<Mutex<FaviconCache>>) -> InfuResult<()> {
  let max_bytes = (favicon_cache.lock().unwrap().max_mb * (1024 * 1024)) as u64;
  if favicon_cache.lock().unwrap().current_total_bytes < max_bytes {
    return Ok(());
  }

  let start_time = SystemTime::now();
  let max_bytes = (favicon_cache.lock().unwrap().max_mb as f64 * ONE_MEGABYTE as f64 * 0.9) as u64;

  let mut ordered: Vec<(String, FileInfo)> = favicon_cache
    .lock()
    .unwrap()
    .fileinfo_by_filename
    .iter()
    .map(|v: (&String, &FileInfo)| (v.0.clone(), v.1.clone()))
    .collect();
  ordered.sort_by(|a, b| score(&a.1).partial_cmp(&score(&b.1)).unwrap());
  let mut i = 0;
  let mut accum = 0;
  let mut highest_score = 0.0;
  loop {
    if i >= ordered.len() {
      break;
    }
    let file_and_info = ordered.get(i).unwrap();
    if accum + file_and_info.1.size_bytes > max_bytes.try_into().unwrap() {
      break;
    }
    accum += file_and_info.1.size_bytes;
    i += 1;
    highest_score = score(&file_and_info.1);
  }

  let num_purged = ordered.len() - i;
  debug!("About to purge {} files from favicon cache.", num_purged);
  loop {
    if i >= ordered.len() {
      break;
    }
    let file_and_info = ordered.get(i).unwrap();
    delete_file(favicon_cache.clone(), &file_and_info.0).await?;
    i += 1;
    debug!("Purging favicon {} - {}", file_and_info.0, score(&file_and_info.1));
  }

  let end_time = SystemTime::now();
  {
    let favicon_cache = favicon_cache.lock().unwrap();
    match end_time.duration_since(start_time) {
      Ok(duration) => {
        info!(
          "Purged {} files from favicon cache in {:?} seconds. There are now {} files totalling {} bytes in the cache. Highest score of any remaining file: {}",
          num_purged,
          duration.as_secs(),
          favicon_cache.fileinfo_by_filename.len(),
          favicon_cache.current_total_bytes,
          highest_score
        );
      }
      Err(_) => {
        info!(
          "Purged {} files from favicon cache. System time went backwards from {:?} to {:?}! There are now {} files totalling {} bytes in the cache. Highest score of any remaining file: {}",
          num_purged,
          start_time,
          end_time,
          favicon_cache.fileinfo_by_filename.len(),
          favicon_cache.current_total_bytes,
          highest_score
        );
      }
    }
  }

  Ok(())
}

async fn delete_file(favicon_cache: Arc<Mutex<FaviconCache>>, filename: &str) -> InfuResult<()> {
  let path;
  {
    let mut favicon_cache = favicon_cache.lock().unwrap();
    let item_id = item_id_from_filename(filename)?;
    path = construct_file_subpath(&favicon_cache.cache_dir, filename)?;
    let fi = favicon_cache
      .fileinfo_by_filename
      .remove(filename)
      .ok_or(format!("Info for favicon cache file '{}' is expected, but not found.", filename))?;
    if let Some(filenames) = favicon_cache.filenames_by_item_id.get(item_id) {
      let filenames: Vec<String> = filenames.iter().filter(|f| f != &filename).map(|f| f.clone()).collect();
      favicon_cache.filenames_by_item_id.insert(String::from(item_id), filenames);
    }
    favicon_cache.current_total_bytes -= fi.size_bytes as u64;
  }

  tokio::fs::remove_file(&path)
    .await
    .map_err(|e| format!("An error occurred removing a single file '{:?}' in favicon cache: {}", path, e))?;

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn hash_url_trims_input() {
    assert_eq!(hash_url("https://example.com"), hash_url("  https://example.com  "));
  }

  #[test]
  fn validates_filename_shape() {
    let filename =
      "0123456789abcdef0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_01234567";
    assert_eq!(item_id_from_filename(filename).unwrap(), "0123456789abcdef0123456789abcdef");
    assert!(item_id_from_filename("bad").is_err());
  }

  #[test]
  fn places_favicon_cache_next_to_configured_cache_dir() {
    assert_eq!(favicon_cache_dir("/tmp/infumap/cache").unwrap(), PathBuf::from("/tmp/infumap/favicons-cache"));
    assert_eq!(favicon_cache_dir("cache").unwrap(), PathBuf::from("favicons-cache"));
  }
}
