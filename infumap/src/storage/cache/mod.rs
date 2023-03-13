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
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use filetime::{set_file_atime, FileTime};
use log::{warn, info, debug};
use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

use crate::util::fs::{expand_tilde, ensure_256_subdirs, construct_file_subpath};
use crate::util::infu::InfuResult;
use crate::util::uid::{uid_chars, Uid};


const ONE_MEGABYTE: u64 = 1024*1024;


#[derive(Debug,Clone)]
struct FileInfo {
  pub size_bytes: usize,
  pub last_accessed: u64,
}


/// Enumeration to represent an image size - either
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


/// A simple filesystem based cache for images.
pub struct ImageCache {
  cache_dir: PathBuf,
  max_mb: usize,
  current_total_bytes: u64,
  fileinfo_by_filename: HashMap<String, FileInfo>,
  filenames_by_item_id: HashMap<String, Vec<String>>,
}


impl ImageCache {
  async fn new(cache_dir: &str, max_mb: usize) -> InfuResult<ImageCache> {
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

    info!("Image cache '{}' state initialized. There are {} files totalling {} bytes.",
          cache_dir.display(), fileinfo_by_filename.len(), current_total_bytes);
    Ok(ImageCache { cache_dir, max_mb, current_total_bytes, fileinfo_by_filename, filenames_by_item_id })
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
            last_accessed: md.accessed()?.duration_since(UNIX_EPOCH)?.as_secs()
          };
          cache.insert(filename, file_info);
        }
        path.pop();
      }
    }

    Ok(cache)
  }
}


/// Instantiate an image cache instance.
pub async fn new(cache_dir: &str, max_mb: usize) -> InfuResult<Arc<Mutex<ImageCache>>> {
  Ok(Arc::new(Mutex::new(ImageCache::new(cache_dir, max_mb).await?)))
}


/// Get the cached image specified by key and updates it's last access time.
///
/// user_id is not required to disambiguate, but is supplied as a paranoid safety mechanism
/// to be extra sure items for one user are not returned to another.
pub async fn get(image_cache: Arc<Mutex<ImageCache>>, user_id: &Uid, key: ImageCacheKey) -> InfuResult<Option<Vec<u8>>> {
  let filename = format!("{}_{}_{}", key.item_id, key.size, &user_id[..8]);

  let cache_dir;
  let file_info;
  {
    let mut image_cache = image_cache.lock().unwrap();
    cache_dir = image_cache.cache_dir.clone();
    if let Some(fi) = image_cache.fileinfo_by_filename.get(&filename) {
      file_info = fi.clone();
      image_cache.fileinfo_by_filename.insert(filename.clone(),
        FileInfo { size_bytes: file_info.size_bytes, last_accessed: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() });
    } else {
      return Ok(None);
    }
  }

  let p = construct_file_subpath(&cache_dir, &filename)?;
  // Setting the atime on every access is generally unnecessarily inefficient (given it's
  // never used most of the time), so is disabled by default on most modern systems. Hence
  // we make sure to do it explicitly.
  set_file_atime(&p, FileTime::now())?;
  let mut f = File::open(p).await?;
  let mut buffer = vec![0; file_info.size_bytes];
  f.read_exact(&mut buffer).await?;
  return Ok(Some(buffer))
}


/// Get keys for all cached images corresponding to item_id.
///
/// user_id is not required to disambiguate, but is supplied as a paranoid safety mechanism
/// to be extra sure items for one user are not returned to another.
pub fn keys_for_item_id(image_cache: Arc<Mutex<ImageCache>>, user_id: &Uid, item_id: &str) -> InfuResult<Option<Vec<ImageCacheKey>>> {
  keys_for_item_id_impl(&image_cache.lock().unwrap(), user_id, item_id)
}

fn keys_for_item_id_impl(image_cache: &MutexGuard<ImageCache>, user_id: &Uid, item_id: &str) -> InfuResult<Option<Vec<ImageCacheKey>>> {
  match image_cache.filenames_by_item_id.get(item_id) {
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
pub async fn put(image_cache: Arc<Mutex<ImageCache>>, user_id: &Uid, key: ImageCacheKey, val: Vec<u8>) -> InfuResult<()> {
  let filename = format!("{}_{}_{}", key.item_id, key.size, &user_id[..8]);

  let cache_dir;
  {
    let mut image_cache = image_cache.lock().unwrap();
    cache_dir = image_cache.cache_dir.clone();
    if !image_cache.filenames_by_item_id.contains_key(&key.item_id) {
      image_cache.filenames_by_item_id.insert(String::from(&key.item_id), vec![]);
    }
    image_cache.filenames_by_item_id.get_mut(&key.item_id).unwrap().push(filename.clone());

    let file_info = FileInfo {
      size_bytes: val.len(),
      last_accessed: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
    };
    image_cache.current_total_bytes += file_info.size_bytes as u64;
    image_cache.fileinfo_by_filename.insert(filename.clone(), file_info);
  }

  let mut file = OpenOptions::new()
    .create_new(true)
    .write(true)
    .open(construct_file_subpath(&cache_dir, &filename)?).await?;
  file.write_all(&val).await?;
  file.flush().await?;

  purge_maybe(image_cache).await?;

  Ok(())
}


/// Delete all images in the cache corresponding to the given item_id.
///
/// user_id is not required to disambiguate, but is supplied as a paranoid safety mechanism
/// to be extra sure items for one user are not returned to another.
pub async fn delete_all(image_cache: Arc<Mutex<ImageCache>>, user_id: &Uid, item_id: &str) -> InfuResult<usize> {
  let keys;
  {
    let mut image_cache = image_cache.lock().unwrap();
    keys =
      if let Some(keys_ref) = keys_for_item_id_impl(&image_cache, user_id, item_id)? { keys_ref }
      else { return Ok(0) };

    for key in &keys {
      let filename = format!("{}_{}_{}", key.item_id, key.size, &user_id[..8]);
      let file_info = image_cache.fileinfo_by_filename.remove(&filename)
        .ok_or(format!("File info for '{}_{}' is expected, but not found.", key.item_id, key.size))?;
      image_cache.current_total_bytes -= file_info.size_bytes as u64;
    }

    image_cache.filenames_by_item_id.remove(item_id)
      .ok_or(format!("Filenames collection for '{}' is missing from image cache.", item_id))?;
  }

  for key in &keys {
    let filename = format!("{}_{}_{}", key.item_id, key.size, &user_id[..8]);
    let path = construct_file_subpath(&image_cache.lock().unwrap().cache_dir, &filename)?;
    tokio::fs::remove_file(&path).await
      .map_err(|e| format!("An error occurred removing file '{:?}' in image cache: {}", path, e))?;
  }

  Ok(keys.len())
}


pub fn _print_summary(image_cache: Arc<Mutex<ImageCache>>) {
  let image_cache = image_cache.lock().unwrap();
  let mut ordered: Vec<(&std::string::String, &FileInfo)> = image_cache.fileinfo_by_filename.iter().collect();
  ordered.sort_by(|a, b| score(a.1).partial_cmp(&score(&b.1)).unwrap());
  for entry in ordered {
    println!("{} - {}", entry.0, score(entry.1));
  }
}


fn score(fi: &FileInfo) -> f64 {
  let size = if fi.size_bytes > 1000 { fi.size_bytes } else { 1000 };
  let size_factor = (size as f64 / 1000.0).powf(1.0/4.0);

  let now_unix = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs();
  let seconds_ago = if now_unix < fi.last_accessed { 0 } else { now_unix - fi.last_accessed };
  let days_ago = seconds_ago as f64 / (24.0*60.0*60.0);

  size_factor * days_ago
}


async fn purge_maybe(image_cache: Arc<Mutex<ImageCache>>) -> InfuResult<()> {
  let max_bytes = (image_cache.lock().unwrap().max_mb * (1024 * 1024)) as u64;
  if image_cache.lock().unwrap().current_total_bytes < max_bytes {
    return Ok(());
  }

  let start_time = SystemTime::now();

  // If maximum cached bytes has been exceeded, purge up to 10% below maximum.
  let max_bytes = (image_cache.lock().unwrap().max_mb as f64 * ONE_MEGABYTE as f64 * 0.9) as u64;

  let mut ordered: Vec<(std::string::String, FileInfo)> = image_cache.lock().unwrap().fileinfo_by_filename.iter()
    .map(|v: (&String, &FileInfo)| (v.0.clone(), v.1.clone()))
    .collect();
  ordered.sort_by(|a, b| score(&a.1).partial_cmp(&score(&b.1)).unwrap());
  let mut i = 0;
  let mut accum = 0;
  let mut highest_score = 0.0;
  loop {
    if i >= ordered.len() { break; }
    let file_and_info = ordered.get(i).unwrap();
    if accum + file_and_info.1.size_bytes > max_bytes.try_into().unwrap() {
      break;
    }
    accum += file_and_info.1.size_bytes;
    i += 1;
    highest_score = score(&file_and_info.1);
    // debug!("Keeping {} - {}", file_and_info.0, Self::score(&file_and_info.1));
  }

  let num_purged = ordered.len() - i;
  debug!("About to purge {} files from cache.", num_purged);
  loop {
    if i >= ordered.len() { break; }
    let file_and_info = ordered.get(i).unwrap();
    delete_file(image_cache.clone(), &file_and_info.0).await?;
    i += 1;
    debug!("Purging {} - {}", file_and_info.0, score(&file_and_info.1));
  }

  let end_time = SystemTime::now();
  {
    let image_cache = image_cache.lock().unwrap();
    match end_time.duration_since(start_time) {
      Ok(duration) => {
        info!("Purged {} files from cache in {:?} seconds. There are now {} files totalling {} bytes in the cache. Highest score of any remaining file: {}",
              num_purged, duration.as_secs(), image_cache.fileinfo_by_filename.len(), image_cache.current_total_bytes, highest_score);
      },
      Err(_) => {
        info!("Purged {} files from cache. System time went backwards from {:?} to {:?}! There are now {} files totalling {} bytes in the cache. Highest score of any remaining file: {}",
              num_purged, start_time, end_time, image_cache.fileinfo_by_filename.len(), image_cache.current_total_bytes, highest_score);
      }
    }
  }

  Ok(())
}


async fn delete_file(image_cache: Arc<Mutex<ImageCache>>, filename: &str) -> InfuResult<()> {
  let path;
  {
    let mut image_cache = image_cache.lock().unwrap();
    let item_id = filename.split('_').next().ok_or(format!("Unexpected image cache filename: {}.", filename))?;
    path = construct_file_subpath(&image_cache.cache_dir, &filename)?;
    let fi = image_cache.fileinfo_by_filename.remove(filename)
      .ok_or(format!("Info for file '{}' is expected, but not found.", filename))?;
    let filenames = image_cache.filenames_by_item_id.get(item_id)
      .ok_or(format!("Unexpected item_id deleting file from item cache: {}", item_id))?;
    let filenames: Vec<String> = filenames.iter().filter(|f| f != &filename).map(|f| f.clone()).collect();
    if image_cache.filenames_by_item_id.insert(String::from(item_id), filenames).is_none() {
      return Err(format!("No filenames for item_id {}, deleting file from image cache.", item_id).into());
    }
    image_cache.current_total_bytes -= fi.size_bytes as u64;
  }

  tokio::fs::remove_file(&path).await
    .map_err(|e| format!("An error occurred removing a single file '{:?}' in image cache: {}", path, e))?;

  Ok(())
}
