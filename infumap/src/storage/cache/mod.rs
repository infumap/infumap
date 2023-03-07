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
use std::fmt::Display;
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


/// Enumeration representing an image size - either
/// "original", or a specific width.
pub enum ImageSize {
  Width(u32),
  Original
}

impl Display for ImageSize {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match &self {
      Self::Width(w) => f.write_str(&w.to_string()),
      Self::Original => f.write_str("original")
    }    
  }
}


/// Struct for the cache key, which is the item_id
/// of the image, together with the size.
pub struct ImageCacheKey {
  pub item_id: Uid,
  pub size: ImageSize,
}

impl Display for ImageCacheKey {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(format!("{}_{}", &self.item_id, self.size).as_str())
  }
}


/// Simple fs based image cache.
/// Work in progress.
/// TODO (MEDIUM):
///   - Expiry/eviction not implemented. This should employ a weighting algorithm that favors keeping
///     more smaller files around than slightly newer large files.
///   - When a user is resizing an image, it is not a good idea to create lots of different sized cached
///     images. Fix this on the FE.
pub struct ImageCache {
  cache_dir: PathBuf,
  _max_mb: usize,
  current_total_bytes: u64,
  fileinfo_by_filename: HashMap<String, FileInfo>,
  filenames_by_item_id: HashMap<String, Vec<String>>,
}


impl ImageCache {

  /// Instantiate an image cache instance.
  pub async fn new(cache_dir: &str, max_mb: usize) -> InfuResult<ImageCache> {
    let cache_dir = expand_tilde(cache_dir)
      .ok_or(format!("Image cache path '{}' is not valid.", cache_dir))?;

    let fileinfo_by_filename = Self::traverse_files(&cache_dir).await?;
    let current_total_bytes = fileinfo_by_filename.iter().fold(0, |a, (_k, v)| a + v.size_bytes) as u64;
    if current_total_bytes > max_mb as u64 * ONE_MEGABYTE {
      warn!("Total size of cached images {} exceeds maximum {}.", current_total_bytes, max_mb as u64 * ONE_MEGABYTE);
    }

    let mut filenames_by_item_id = HashMap::new();
    for (filename, _) in &fileinfo_by_filename {
      let item_id = filename.split("_").nth(0).ok_or(format!("Invalid image cache filename '{}'", filename))?;
      if !filenames_by_item_id.contains_key(item_id) {
        filenames_by_item_id.insert(String::from(item_id), vec![]);
      }
      filenames_by_item_id.get_mut(item_id).unwrap().push(filename.clone());
    }

    info!("Image cache '{}' state initialized. There are {} files totalling {} bytes.", cache_dir.display(), fileinfo_by_filename.len(), current_total_bytes);
    Ok(ImageCache { cache_dir, _max_mb: max_mb, current_total_bytes, fileinfo_by_filename, filenames_by_item_id })
  }


  /// Get the cached image specified by key.
  ///
  /// user_id is not required to disambiguate, but is supplied as a paranoid safety mechanism
  /// to be extra sure items for one user are not returned to another.
  pub async fn get(&self, user_id: &Uid, key: ImageCacheKey) -> InfuResult<Option<Vec<u8>>> {
    let filename = format!("{}_{}_{}", key.item_id, key.size, &user_id[..8]);
    if let Some(fi) = self.fileinfo_by_filename.get(&filename) {
      let mut f = File::open(construct_store_subpath(&self.cache_dir, &filename)?).await?;
      let mut buffer = vec![0; fi.size_bytes];
      f.read_exact(&mut buffer).await?;
      return Ok(Some(buffer))
    }
    Ok(None)
  }


  /// Get all cached images corresponding to item_id.
  ///
  /// user_id is not required to disambiguate, but is supplied as a paranoid safety mechanism
  /// to be extra sure items for one user are not returned to another.
  pub fn keys_for_item_id(&self, user_id: &Uid, item_id: &str) -> InfuResult<Option<Vec<ImageCacheKey>>> {
    match self.filenames_by_item_id.get(item_id) {
      None => Ok(None),
      Some(filenames) => {
        if filenames.iter().filter(|v| !v.ends_with(&user_id[..8])).collect::<Vec<&String>>().len() > 0 {
          return Err(format!("User '{}' does not own a cached file for item '{}'.", user_id, item_id).into());
        }
        let result = filenames.iter()
          .map(|v| String::from(&v[..(v.len()-9)]))
          .map(|v| {
            let parts = v.split("_").into_iter().map(|s| String::from(s)).collect::<Vec<String>>();
            if parts.len() != 2 { 
              return Err(format!("Unexpected image cache filename prefix '{}'.", v).into())
            }
            Ok(ImageCacheKey {
              item_id: parts.get(0).unwrap().clone(),
              size: if parts.get(1).unwrap() == "original" {
                ImageSize::Original
              } else {
                ImageSize::Width(parts.get(1).unwrap().parse::<u32>()?)
              }
            })
          })
          .collect::<InfuResult<Vec<ImageCacheKey>>>()?;
        Ok(if result.len() == 0 { None } else { Some(result) })
      }
    }
  }


  /// Put an image into the cache, corresponding to the provided key.
  ///
  /// user_id is not required to disambiguate, but is supplied as a paranoid safety mechanism
  /// to be extra sure items for one user are not returned to another.
  pub async fn put(&mut self, user_id: &Uid, key: ImageCacheKey, val: Vec<u8>) -> InfuResult<()> {
    let filename = format!("{}_{}_{}", key.item_id, key.size, &user_id[..8]);
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

    if !self.filenames_by_item_id.contains_key(&key.item_id) {
      self.filenames_by_item_id.insert(String::from(&key.item_id), vec![]);
    }
    self.filenames_by_item_id.get_mut(&key.item_id).unwrap().push(filename.clone());

    self.current_total_bytes += file_info.size_bytes as u64;
    self.fileinfo_by_filename.insert(filename, file_info);

    Ok(())
  }

  /// Delete all images in the cache corresponding to the given item_id.
  ///
  /// user_id is not required to disambiguate, but is supplied as a paranoid safety mechanism
  /// to be extra sure items for one user are not returned to another.
  pub async fn delete_all(&mut self, user_id: &Uid, item_id: &str) -> InfuResult<usize> {
    let keys =
      if let Some(keys_ref) = self.keys_for_item_id(user_id, item_id)? { keys_ref }
      else { return Ok(0) };

    for key in &keys {
      let filename = format!("{}_{}_{}", key.item_id, key.size, &user_id[..8]);
      let path = construct_store_subpath(&self.cache_dir, &filename)?;
      tokio::fs::remove_file(&path).await
        .map_err(|e| format!("An error occurred removing file '{:?}' in image cache: {}", path, e))?;
      let fi = self.fileinfo_by_filename.remove(&filename)
        .ok_or(format!("File info for '{}_{}' is expected, but not found.", key.item_id, key.size))?;
      self.current_total_bytes -= fi.size_bytes as u64;
    }

    self.filenames_by_item_id.remove(item_id)
      .ok_or(format!("Filenames collection for '{}' is missing from image cache.", item_id))?;

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
            warn!("'{}' in image cache is not a file.", entry.path().display());
            continue;
          }
          let md = entry.metadata().await?;
          let filename = entry.file_name().to_str()
            .ok_or(format!("Invalid cached image filename '{}'.", &path.display()))?.to_string();
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
