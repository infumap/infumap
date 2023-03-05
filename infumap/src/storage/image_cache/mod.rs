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

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use log::{warn, info};
use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

use crate::util::fs::{expand_tilde, ensure_256_subdirs, construct_store_subpath};
use crate::util::infu::InfuResult;
use crate::util::uid::{uid_chars, Uid};


const ONE_MEGABYTE: u64 = 1024*1024;

#[derive(Debug)]
struct FileInfo {
  pub size_bytes: usize,
  pub _last_accessed: u64,
}

/// Simple fs based image cache.
/// Work in progress. Expiry/eviction not implemented.
pub struct ImageCache {
  cache_dir: PathBuf,
  _max_mb: usize,
  current_total_bytes: u64,
  fileinfo_by_filename: HashMap<String, FileInfo>,
  filenames_by_item_id: HashMap<String, Vec<String>>,
}

impl ImageCache {
  pub async fn new(cache_dir: &str, max_mb: usize) -> InfuResult<ImageCache> {
    let cache_dir = expand_tilde(cache_dir)
      .ok_or(format!("Image cache path '{}' is not valid.", cache_dir))?;

    let fileinfo_by_filename = Self::traverse_files(&cache_dir).await?;
    let current_total_bytes = fileinfo_by_filename.iter().fold(0, |a, (_k, v)| a + v.size_bytes) as u64;
    if current_total_bytes > max_mb as u64 * ONE_MEGABYTE {
      warn!("Total bytes in image cache {} exceeds maximum {}.", current_total_bytes, max_mb as u64 * ONE_MEGABYTE);
    }

    let mut filenames_by_item_id = HashMap::new();
    for (filename, _v) in &fileinfo_by_filename {
      let item_id = filename.split("_").nth(0).ok_or(format!("Invalid image cache filename '{}'", filename))?;
      if !filenames_by_item_id.contains_key(item_id) {
        filenames_by_item_id.insert(String::from(item_id), vec![]);
      }
      filenames_by_item_id.get_mut(item_id).unwrap().push(filename.clone());
    }

    info!("Image cache '{}' state initialized. There are {} files with a total of {} bytes.", cache_dir.display(), fileinfo_by_filename.len(), current_total_bytes);
    Ok(ImageCache { cache_dir, _max_mb: max_mb, current_total_bytes, fileinfo_by_filename, filenames_by_item_id })
  }

  /**
   * key: is of the form {item_id}_{size}
   */
  pub async fn get(&self, user_id: &Uid, key: &str) -> InfuResult<Option<Vec<u8>>> {
    let filename = format!("{}_{}", key, &user_id[..8]);
    if let Some(fi) = self.fileinfo_by_filename.get(&filename) {
      let mut f = File::open(construct_store_subpath(&self.cache_dir, &filename)?).await?;
      let mut buffer = vec![0; fi.size_bytes];
      f.read_exact(&mut buffer).await?;
      return Ok(Some(buffer))
    }
    Ok(None)
  }

  pub fn keys_for_item_id(&self, user_id: &Uid, item_id: &str) -> InfuResult<Option<Vec<String>>> {
    match self.filenames_by_item_id.get(item_id) {
      None => Ok(None),
      Some(vs) => {
        if vs.iter().filter(|v| !v.ends_with(&user_id[..8])).collect::<Vec<&String>>().len() > 0 {
          return Err(format!("User '{}' does not own a cached file for item '{}'.", user_id, item_id).into());
        }
        let result = vs.iter()
          .map(|v| String::from(&v[..(v.len()-9)]))
          .collect::<Vec<String>>();
        Ok(if result.len() == 0 { None } else { Some(result) })
      }
    }
  }

  /**
   * key: is of the form {item_id}_{size}
   */
  pub async fn put(&mut self, user_id: &Uid, key: &str, val: Vec<u8>) -> InfuResult<()> {
    let filename = format!("{}_{}", key, &user_id[..8]);
    let mut file = OpenOptions::new()
      .create_new(true)
      .write(true)
      .open(construct_store_subpath(&self.cache_dir, &filename)?).await?;
    file.write_all(&val).await?;
    file.flush().await?;

    let file_info = FileInfo {
      size_bytes: val.len(),
      _last_accessed: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
    };

    let item_id = key.split("_").nth(0).ok_or(format!("Invalid key '{}'.", key))?;
    if !self.filenames_by_item_id.contains_key(item_id) {
      self.filenames_by_item_id.insert(String::from(item_id), vec![]);
    }
    self.filenames_by_item_id.get_mut(item_id).unwrap().push(filename.clone());

    self.current_total_bytes += file_info.size_bytes as u64;
    self.fileinfo_by_filename.insert(filename, file_info);

    Ok(())
  }

  pub async fn delete_all(&mut self, user_id: &Uid, item_id: &str) -> InfuResult<usize> {
    let keys = if let Some(keys_ref) = self.keys_for_item_id(user_id, item_id)? {
      keys_ref.clone()
    } else {
      return Err(format!("No keys for item_id '{}' in cache.", item_id).into());
    };

    for key in &keys {
      let filename = format!("{}_{}", key, &user_id[..8]);
      let path = construct_store_subpath(&self.cache_dir, &filename)?;
      tokio::fs::remove_file(&path).await
        .map_err(|e| format!("An error occurred removing image cache file '{:?}': {}", path, e))?;
      let fi = self.fileinfo_by_filename.remove(&filename)
        .ok_or(format!("File info for '{}' is not cached.", key))?;
      self.current_total_bytes -= fi.size_bytes as u64;
    }
    self.filenames_by_item_id.remove(item_id).ok_or(format!("Files for prefix collection entry for '{}' is missing.", item_id))?;
    Ok(keys.len())
  }

  async fn traverse_files(cache_file_dir: &PathBuf) -> InfuResult<HashMap<String, FileInfo>> {
    let num_created = ensure_256_subdirs(&cache_file_dir).await?;
    if num_created > 0 {
      warn!("Created {} missing image cache subdirectories in '{}'.", num_created, &cache_file_dir.as_path().display());
    }

    let mut cache = HashMap::new();
    let mut path = cache_file_dir.clone();
    for i in 0..uid_chars().len() {
      for j in 0..uid_chars().len() {
        path.push(format!("{}{}", uid_chars().get(i).unwrap(), uid_chars().get(j).unwrap()));
        let mut iter = tokio::fs::read_dir(&path).await?;
        while let Some(entry) = iter.next_entry().await? {
          if !entry.file_type().await?.is_file() {
            warn!("'{}' is not a file.", entry.path().display());
            continue;
          }
          let md = entry.metadata().await?;
          let filename = entry.file_name().to_str()
            .ok_or(format!("Invalid cached item filename '{}'.", &path.display()))?.to_string();
          let file_info = FileInfo {
            size_bytes: md.len() as usize,
            _last_accessed: md.accessed()?.duration_since(UNIX_EPOCH)?.as_secs()
          };
          cache.insert(filename, file_info);
        }
        path.pop();
      }
    }

    Ok(cache)
  }

}


// TODO (MEDIUM): required? accessed should be enough.
// fn async _touch_file(path: &Path) -> io::Result<()> {
//   match OpenOptions::new().write(true).open(path) {
//       Ok(_) => Ok(()),
//       Err(e) => Err(e),
//   }
// }
