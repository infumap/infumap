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
use std::fs::{OpenOptions, File, self};
use std::io::{self, Read, Write};
use std::path::{PathBuf, Path};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::util::fs::{expand_tilde, ensure_256_subdirs, construct_store_subpath};
use crate::util::infu::InfuResult;
use crate::util::uid::{uid_chars, Uid};


const ONE_MEGABYTE: u64 = 1024*1024;

#[derive(Debug)]
struct FileInfo {
  pub size_bytes: usize,
  pub _last_accessed: u64,
}

/// Simple fs based cache.
/// Work in progress. Expiry/eviction not implemented.
pub struct FileCache {
  cache_dir: PathBuf,
  _max_mb: usize,
  current_total_bytes: u64,
  cache_file_info: HashMap<String, FileInfo>,
  by_prefix: HashMap<String, Vec<String>>,
}

impl FileCache {
  pub fn new(cache_dir: &str, max_mb: usize) -> InfuResult<FileCache> {
    let cache_dir = expand_tilde(cache_dir)
      .ok_or(format!("File cache path '{}' is not valid.", cache_dir))?;

    let cache = Self::traverse_files(&cache_dir)?;
    let current_total_bytes = cache.iter().fold(0, |a, (_k, v)| a + v.size_bytes) as u64;
    if current_total_bytes > max_mb as u64 * ONE_MEGABYTE {
      warn!("Total bytes in cache {} exceeds maximum {}.", current_total_bytes, max_mb as u64 * ONE_MEGABYTE);
    }

    let mut by_prefix = HashMap::new();
    for (k, _v) in &cache {
      let prefix = k.split("_").nth(0).unwrap();
      if !by_prefix.contains_key(prefix) {
        by_prefix.insert(String::from(prefix), vec![]);
      }
      by_prefix.get_mut(prefix).unwrap().push(k.clone());
    }

    info!("File cache '{}' state initialized. There are {} files with a total of {} bytes.", cache_dir.display(), cache.len(), current_total_bytes);
    Ok(FileCache { cache_dir, cache_file_info: cache, _max_mb: max_mb, current_total_bytes, by_prefix })
  }

  pub fn get(&self, user_id: &Uid, key: &str) -> InfuResult<Option<Vec<u8>>> {
    let filename = format!("{}_{}", key, &user_id[..8]);
    if let Some(fi) = self.cache_file_info.get(&filename) {
      let mut f = File::open(construct_store_subpath(&self.cache_dir, &filename)?)?;
      let mut buffer = vec![0; fi.size_bytes];
      f.read(&mut buffer)?;
      return Ok(Some(buffer))
    }
    Ok(None)
  }

  pub fn keys_with_prefix(&self, user_id: &Uid, prefix: &str) -> Option<Vec<String>> {
    match self.by_prefix.get(prefix) {
      None => None,
      Some(vs) => {
        let result = vs.iter()
          .filter(|v| v.ends_with(&user_id[..8]))
          .map(|v| String::from(&v[..(v.len()-9)]))
          .collect::<Vec<String>>();
        if result.len() == 0 { None } else { Some(result) }
      }
    }
  }

  pub fn put(&mut self, user_id: &Uid, key: &str, val: Vec<u8>) -> InfuResult<()> {
    let filename = format!("{}_{}", key, &user_id[..8]);
    let mut file = OpenOptions::new()
      .create_new(true)
      .write(true)
      .open(construct_store_subpath(&self.cache_dir, &filename)?)?;
    file.write_all(&val)?;

    let file_info = FileInfo {
      size_bytes: val.len(),
      _last_accessed: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
    };

    let prefix = key.split("_").nth(0).unwrap();
    if !self.by_prefix.contains_key(prefix) {
      self.by_prefix.insert(String::from(prefix), vec![]);
    }
    self.by_prefix.get_mut(prefix).unwrap().push(key.to_string());

    self.current_total_bytes += file_info.size_bytes as u64;
    self.cache_file_info.insert(key.to_string(), file_info);

    Ok(())
  }

  pub fn delete_all_with_prefix(&mut self, user_id: &Uid, prefix: &str) -> InfuResult<usize> {
    let keys = if let Some(keys_ref) = self.keys_with_prefix(user_id, prefix) {
      keys_ref.clone()
    } else {
      return Err(format!("no keys with prefix {}", prefix).into());
    };

    for key in &keys {
      fs::remove_file(construct_store_subpath(&self.cache_dir, &key)?)?;
      let fi = self.cache_file_info.remove(key).ok_or(format!("File info for '{}' is not cached.", key))?;
      self.current_total_bytes -= fi.size_bytes as u64;
    }
    self.by_prefix.remove(prefix).ok_or(format!("Files for prefix collection entry for '{}' is missing.", prefix))?;
    Ok(keys.len())
  }

  fn traverse_files(cache_file_dir: &PathBuf) -> InfuResult<HashMap<String, FileInfo>> {
    let num_created = ensure_256_subdirs(&cache_file_dir)?;
    if num_created > 0 {
      warn!("Created {} missing cache subdirectories in '{}'.", num_created, &cache_file_dir.as_path().display());
    }

    let mut cache = HashMap::new();
    let mut path = cache_file_dir.clone();
    for i in 0..uid_chars().len() {
      for j in 0..uid_chars().len() {
        path.push(format!("{}{}", uid_chars().get(i).unwrap(), uid_chars().get(j).unwrap()));
        for entry in fs::read_dir(&path)? {
          let entry = entry?;
          if !entry.file_type()?.is_file() {
            warn!("'{}' is not a file.", entry.path().display());
            continue;
          }
          let md = entry.metadata()?;
          let file_name = entry.file_name().to_str()
            .ok_or(format!("Invalid filename '{}' in cache", &path.display()))?.to_string();
          let file_info = FileInfo {
            size_bytes: md.len() as usize,
            _last_accessed: md.accessed()?.duration_since(UNIX_EPOCH)?.as_secs()
          };
          cache.insert(file_name, file_info);
        }
        path.pop();
      }
    }

    Ok(cache)
  }

}


// TODO (MEDIUM): required? accessed should be enough.
fn _touch_file(path: &Path) -> io::Result<()> {
  match OpenOptions::new().write(true).open(path) {
      Ok(_) => Ok(()),
      Err(e) => Err(e),
  }
}
