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

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use async_trait::async_trait;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::Uid;
use log::{info, warn};
use tokio::task::JoinSet;

use crate::storage::file as storage_file;
use crate::storage::s3 as storage_s3;
use crate::util::crypto::{decrypt_file_data, encrypt_file_data};

use super::db::item_db::ItemAndUserId;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ObjectStoreName {
  S3_1,
  S3_2,
  Local,
}

impl ObjectStoreName {
  pub fn as_str(&self) -> &'static str {
    match self {
      ObjectStoreName::S3_1 => "s3_1",
      ObjectStoreName::S3_2 => "s3_2",
      ObjectStoreName::Local => "local",
    }
  }

  pub fn from_str(s: &str) -> InfuResult<ObjectStoreName> {
    match s {
      "s3_1" => Ok(ObjectStoreName::S3_1),
      "s3_2" => Ok(ObjectStoreName::S3_2),
      "local" => Ok(ObjectStoreName::Local),
      other => Err(format!("Unknown object store '{}', expected one of: local, s3_1, s3_2.", other).into()),
    }
  }
}

pub struct ObjectStore {
  file_store: Option<Arc<Mutex<storage_file::FileStore>>>,
  s3_1_data_store: Option<Arc<storage_s3::S3Store>>,
  s3_2_data_store: Option<Arc<storage_s3::S3Store>>,
  read_from: Vec<ObjectStoreName>,
  next_read: AtomicUsize,
}

impl ObjectStore {
  fn new(
    data_dir: &str,
    enable_local_object_storage: bool,
    enable_s3_1_object_storage: bool,
    s3_1_region: Option<String>,
    s3_1_endpoint: Option<String>,
    s3_1_bucket: Option<String>,
    s3_1_key: Option<String>,
    s3_1_secret: Option<String>,
    enable_s3_2_object_storage: bool,
    s3_2_region: Option<String>,
    s3_2_endpoint: Option<String>,
    s3_2_bucket: Option<String>,
    s3_2_key: Option<String>,
    s3_2_secret: Option<String>,
    read_from: Option<String>,
  ) -> InfuResult<ObjectStore> {
    let file_store = if enable_local_object_storage {
      Some(match storage_file::new(&data_dir) {
        Ok(file_store) => file_store,
        Err(e) => {
          return Err(e);
        }
      })
    } else {
      None
    };

    let s3_1_data_store = if enable_s3_1_object_storage {
      let s3_1_key = s3_1_key.as_ref().ok_or("s3_1_key field is required when primary s3 store is enabled.")?.clone();
      let s3_1_secret =
        s3_1_secret.as_ref().ok_or("s3_1_secret field is required when primary s3 store is enabled.")?.clone();
      let s3_1_bucket = s3_1_bucket.ok_or("s3_1_bucket field is required when primary s3 store is enabled.")?;
      Some(
        match storage_s3::new(
          "s3_1",
          s3_1_region.as_ref(),
          s3_1_endpoint.as_ref(),
          &s3_1_bucket,
          &s3_1_key,
          &s3_1_secret,
        ) {
          Ok(s3_store) => s3_store,
          Err(e) => {
            return Err(e);
          }
        },
      )
    } else {
      None
    };

    let s3_2_data_store = if enable_s3_2_object_storage {
      let s3_2_key = s3_2_key.as_ref().ok_or("s3_2_key field is required when secondary s3 store is enabled.")?.clone();
      let s3_2_secret =
        s3_2_secret.as_ref().ok_or("s3_2_secret field is required when secondary s3 store is enabled.")?.clone();
      let s3_2_bucket = s3_2_bucket.ok_or("s3_2_bucket field is required when secondary s3 store is enabled.")?;
      Some(
        match storage_s3::new(
          "s3_2",
          s3_2_region.as_ref(),
          s3_2_endpoint.as_ref(),
          &s3_2_bucket,
          &s3_2_key,
          &s3_2_secret,
        ) {
          Ok(s3_store) => s3_store,
          Err(e) => {
            return Err(e);
          }
        },
      )
    } else {
      None
    };

    let mut object_store =
      ObjectStore { file_store, s3_1_data_store, s3_2_data_store, read_from: vec![], next_read: AtomicUsize::new(0) };
    object_store.read_from = object_store.parse_read_from(read_from.as_deref())?;
    Ok(object_store)
  }

  fn is_enabled(&self, name: ObjectStoreName) -> bool {
    match name {
      ObjectStoreName::Local => self.file_store.is_some(),
      ObjectStoreName::S3_1 => self.s3_1_data_store.is_some(),
      ObjectStoreName::S3_2 => self.s3_2_data_store.is_some(),
    }
  }

  fn enabled_stores(&self) -> Vec<ObjectStoreName> {
    [ObjectStoreName::Local, ObjectStoreName::S3_1, ObjectStoreName::S3_2]
      .into_iter()
      .filter(|name| self.is_enabled(*name))
      .collect()
  }

  /// When not configured, reads go to the first enabled store in the order local, s3_1, s3_2, which is the policy that
  /// predates object_storage_read_from.
  fn parse_read_from(&self, read_from: Option<&str>) -> InfuResult<Vec<ObjectStoreName>> {
    let read_from = read_from.map(|v| v.trim()).unwrap_or("");
    if read_from.is_empty() {
      return Ok(self.enabled_stores().into_iter().take(1).collect());
    }
    let mut result = vec![];
    for part in read_from.split(',').map(|p| p.trim()).filter(|p| !p.is_empty()) {
      let name = ObjectStoreName::from_str(part)?;
      if !self.is_enabled(name) {
        return Err(
          format!("object_storage_read_from lists '{}', but that object store is not enabled.", name.as_str()).into(),
        );
      }
      if result.contains(&name) {
        return Err(format!("object_storage_read_from lists '{}' more than once.", name.as_str()).into());
      }
      result.push(name);
    }
    Ok(result)
  }

  /// The configured stores, rotated so successive reads start at successive stores, followed by any other enabled store
  /// as a last resort. Falling back to unlisted stores means a store missing an object costs egress elsewhere rather
  /// than failing the read.
  fn read_order(&self) -> Vec<ObjectStoreName> {
    let mut order = vec![];
    if !self.read_from.is_empty() {
      let start = self.next_read.fetch_add(1, Ordering::Relaxed) % self.read_from.len();
      order.extend_from_slice(&self.read_from[start..]);
      order.extend_from_slice(&self.read_from[..start]);
    }
    for name in self.enabled_stores() {
      if !order.contains(&name) {
        order.push(name);
      }
    }
    order
  }

  async fn get_ciphertext(&self, name: ObjectStoreName, user_id: Uid, id: Uid) -> InfuResult<Vec<u8>> {
    match name {
      ObjectStoreName::Local => match &self.file_store {
        Some(file_store) => storage_file::get(file_store.clone(), user_id, id).await,
        None => Err("Local object store is not enabled.".into()),
      },
      ObjectStoreName::S3_1 => match &self.s3_1_data_store {
        Some(s3_store) => storage_s3::get(s3_store.clone(), user_id, id).await,
        None => Err("s3_1 object store is not enabled.".into()),
      },
      ObjectStoreName::S3_2 => match &self.s3_2_data_store {
        Some(s3_store) => storage_s3::get(s3_store.clone(), user_id, id).await,
        None => Err("s3_2 object store is not enabled.".into()),
      },
    }
  }
}

pub fn new(
  data_dir: &str,
  enable_local_object_storage: bool,
  enable_s3_1_object_storage: bool,
  s3_1_region: Option<String>,
  s3_1_endpoint: Option<String>,
  s3_1_bucket: Option<String>,
  s3_1_key: Option<String>,
  s3_1_secret: Option<String>,
  enable_s3_2_object_storage: bool,
  s3_2_region: Option<String>,
  s3_2_endpoint: Option<String>,
  s3_2_bucket: Option<String>,
  s3_2_key: Option<String>,
  s3_2_secret: Option<String>,
  read_from: Option<String>,
) -> InfuResult<Arc<ObjectStore>> {
  Ok(Arc::new(ObjectStore::new(
    data_dir,
    enable_local_object_storage,
    enable_s3_1_object_storage,
    s3_1_region,
    s3_1_endpoint,
    s3_1_bucket,
    s3_1_key,
    s3_1_secret,
    enable_s3_2_object_storage,
    s3_2_region,
    s3_2_endpoint,
    s3_2_bucket,
    s3_2_key,
    s3_2_secret,
    read_from,
  )?))
}

pub async fn get(object_store: Arc<ObjectStore>, user_id: Uid, id: Uid, encryption_key: &str) -> InfuResult<Vec<u8>> {
  // Any fetch failure (S3 first-byte timeout, error, missing object) moves on to the next store. A decryption failure
  // does not, as it more likely indicates a wrong key than a bad copy.
  let order = object_store.read_order();
  let mut last_err = None;
  for (i, name) in order.iter().enumerate() {
    match object_store.get_ciphertext(*name, user_id.clone(), id.clone()).await {
      Ok(ciphertext) => {
        return Ok(decrypt_file_data(encryption_key, ciphertext.as_slice(), filename(&user_id, &id).as_str())?);
      }
      Err(e) => {
        if let Some(next) = order.get(i + 1) {
          warn!("Object '{}' get from {} failed ({}), falling back to {}", id, name.as_str(), e, next.as_str());
        }
        last_err = Some(e);
      }
    }
  }
  Err(last_err.unwrap_or_else(|| "No object store configured".into()))
}

pub async fn put(
  object_store: Arc<ObjectStore>,
  user_id: &Uid,
  id: &Uid,
  val: &Vec<u8>,
  encryption_key: &str,
) -> InfuResult<()> {
  let put_started = Instant::now();
  let mut set = JoinSet::new();

  let encrypted_val = Arc::new(encrypt_file_data(encryption_key, val, filename(user_id, id).as_str())?);
  info!(
    "Object upload '{}' encrypted {} bytes in {} ms; stores: local={}, s3_1={}, s3_2={}",
    id,
    val.len(),
    put_started.elapsed().as_millis(),
    object_store.file_store.is_some(),
    object_store.s3_1_data_store.is_some(),
    object_store.s3_2_data_store.is_some()
  );

  if let Some(file_store) = &object_store.file_store {
    let (file_store, user_id, id, encrypted_val) =
      (file_store.clone(), user_id.clone(), id.clone(), encrypted_val.clone());
    set.spawn(async move {
      let started = Instant::now();
      let result = storage_file::put(file_store, user_id, id, encrypted_val).await;
      (ObjectStoreName::Local, started.elapsed(), result)
    });
  }

  if let Some(s3_1_store) = &object_store.s3_1_data_store {
    let (s3_store, user_id, id, encrypted_val) =
      (s3_1_store.clone(), user_id.clone(), id.clone(), encrypted_val.clone());
    set.spawn(async move {
      let started = Instant::now();
      let result = storage_s3::put(s3_store, user_id, id, encrypted_val).await;
      (ObjectStoreName::S3_1, started.elapsed(), result)
    });
  }

  if let Some(s3_2_store) = &object_store.s3_2_data_store {
    let (s3_store, user_id, id, encrypted_val) =
      (s3_2_store.clone(), user_id.clone(), id.clone(), encrypted_val.clone());
    set.spawn(async move {
      let started = Instant::now();
      let result = storage_s3::put(s3_store, user_id, id, encrypted_val).await;
      (ObjectStoreName::S3_2, started.elapsed(), result)
    });
  }

  let mut errors = vec![];
  let mut succeeded = vec![];
  loop {
    let next_result = set.join_next().await;
    let Some(res) = next_result else {
      break;
    };
    let res = res.map_err(|e| format!("Async join error: {}", e))?;
    let (store_name, elapsed, result) = res;
    match result {
      Err(e) => {
        warn!("Object upload '{}' to {} failed after {} ms: {}", id, store_name.as_str(), elapsed.as_millis(), e);
        errors.push(e);
      }
      Ok(()) => {
        info!("Object upload '{}' to {} completed in {} ms", id, store_name.as_str(), elapsed.as_millis());
        succeeded.push(store_name);
      }
    }
  }

  if errors.len() == 0 {
    return Ok(());
  }

  // The item is not added when any store fails, so the copies that did land would otherwise be orphaned: a retry
  // uploads under a new id. Only the stores that reported success are cleaned up. A PUT that failed on a timeout may
  // still land at the provider after this, and deleting there could race it, so that case is left to
  // `reconcile orphaned`. A failed cleanup is logged and doesn't replace the upload error the caller reports.
  for store_name in succeeded {
    if let Err(e) = delete_from(&object_store, store_name, user_id, id).await {
      warn!("Could not remove orphaned object '{}' from {} after a failed upload: {}", id, store_name.as_str(), e);
    } else {
      info!("Removed object '{}' from {} after a failed upload", id, store_name.as_str());
    }
  }

  Err(errors.iter().map(|e| format!("{}", e)).collect::<Vec<String>>().join(", ").into())
}

async fn delete_from(object_store: &ObjectStore, name: ObjectStoreName, user_id: &Uid, id: &Uid) -> InfuResult<()> {
  match name {
    ObjectStoreName::Local => match &object_store.file_store {
      Some(file_store) => storage_file::delete(file_store.clone(), user_id.clone(), id.clone()).await,
      None => Err("Local object store is not enabled.".into()),
    },
    ObjectStoreName::S3_1 => match &object_store.s3_1_data_store {
      Some(s3_store) => storage_s3::delete(s3_store.clone(), user_id.clone(), id.clone()).await,
      None => Err("s3_1 object store is not enabled.".into()),
    },
    ObjectStoreName::S3_2 => match &object_store.s3_2_data_store {
      Some(s3_store) => storage_s3::delete(s3_store.clone(), user_id.clone(), id.clone()).await,
      None => Err("s3_2 object store is not enabled.".into()),
    },
  }
}

pub async fn delete(object_store: Arc<ObjectStore>, user_id: &Uid, id: &Uid) -> InfuResult<()> {
  let mut set = JoinSet::new();

  if let Some(file_store) = &object_store.file_store {
    set.spawn(storage_file::delete(file_store.clone(), user_id.clone(), id.clone()));
  }

  if let Some(s3_1_store) = &object_store.s3_1_data_store {
    set.spawn(storage_s3::delete(s3_1_store.clone(), user_id.clone(), id.clone()));
  }

  if let Some(s3_2_store) = &object_store.s3_2_data_store {
    set.spawn(storage_s3::delete(s3_2_store.clone(), user_id.clone(), id.clone()));
  }

  let mut errors = vec![];
  loop {
    let next_result = set.join_next().await;
    let Some(res) = next_result else {
      break;
    };
    let res = res.map_err(|e| format!("Async join error: {}", e))?;
    match res {
      Err(e) => errors.push(e),
      Ok(_) => {}
    };
  }

  if errors.len() == 0 {
    Ok(())
  } else {
    Err(errors.iter().map(|e| format!("{}", e)).collect::<Vec<String>>().join(", ").into())
  }
}

pub fn filename(user_id: &Uid, id: &Uid) -> String {
  format!("{}_{}", user_id, id)
}

#[async_trait]
pub trait IndividualObjectStore {
  async fn get(&self, user_id: Uid, item_id: Uid) -> InfuResult<Vec<u8>>;
  async fn put(&self, user_id: Uid, item_id: Uid, val: Arc<Vec<u8>>) -> InfuResult<()>;
  async fn list(&self) -> InfuResult<Vec<ItemAndUserId>>;
}

#[cfg(test)]
mod tests {
  use super::*;
  use ObjectStoreName::{S3_1, S3_2};

  fn s3_only_store(read_from: Option<&str>) -> InfuResult<ObjectStore> {
    let s3 =
      || (None, Some("s3.example.com".to_owned()), Some("b".to_owned()), Some("k".to_owned()), Some("s".to_owned()));
    let (r1, e1, b1, k1, s1) = s3();
    let (r2, e2, b2, k2, s2) = s3();
    ObjectStore::new("", false, true, r1, e1, b1, k1, s1, true, r2, e2, b2, k2, s2, read_from.map(|v| v.to_owned()))
  }

  #[test]
  fn unset_read_from_keeps_primary_then_secondary() {
    let store = s3_only_store(None).unwrap();
    assert_eq!(store.read_order(), vec![S3_1, S3_2]);
    assert_eq!(store.read_order(), vec![S3_1, S3_2]);
  }

  #[test]
  fn listed_stores_rotate_and_fall_back_to_unlisted() {
    let store = s3_only_store(Some(" s3_1, s3_2 ")).unwrap();
    assert_eq!(store.read_order(), vec![S3_1, S3_2]);
    assert_eq!(store.read_order(), vec![S3_2, S3_1]);
    assert_eq!(store.read_order(), vec![S3_1, S3_2]);

    let store = s3_only_store(Some("s3_2")).unwrap();
    assert_eq!(store.read_order(), vec![S3_2, S3_1]);
    assert_eq!(store.read_order(), vec![S3_2, S3_1]);
  }

  #[test]
  fn read_from_rejects_unknown_disabled_and_duplicate_stores() {
    assert!(s3_only_store(Some("s3_3")).is_err());
    assert!(s3_only_store(Some("local")).is_err());
    assert!(s3_only_store(Some("s3_1,s3_1")).is_err());
  }
}
