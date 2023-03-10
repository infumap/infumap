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

use std::sync::Arc;
use std::sync::Mutex;

use tokio::task::JoinSet;

use crate::util::crypto::{encrypt_file_data, decrypt_file_data};
use crate::util::infu::InfuResult;
use crate::util::uid::Uid;
use crate::storage::file as storage_file;
use crate::storage::s3 as storage_s3;


pub struct ObjectStore {
  file_store: Option<Arc<Mutex<storage_file::FileStore>>>,
  s3_1_store: Option<Arc<Mutex<storage_s3::S3Store>>>,
  s3_2_store: Option<Arc<Mutex<storage_s3::S3Store>>>,
}

impl ObjectStore {
  pub fn new(
      data_dir: &str, enable_local_object_storage: bool,
      enable_s3_1_object_storage: bool,
      s3_1_region: Option<String>, s3_1_endpoint: Option<String>,
      s3_1_bucket: Option<String>,
      s3_1_key: Option<String>, s3_1_secret: Option<String>,
      enable_s3_2_object_storage: bool,
      s3_2_region: Option<String>, s3_2_endpoint: Option<String>,
      s3_2_bucket: Option<String>,
      s3_2_key: Option<String>, s3_2_secret: Option<String>) -> InfuResult<ObjectStore> {

    let file_store = if enable_local_object_storage {
      Some(match storage_file::FileStore::new(&data_dir) {
        Ok(file_store) => Arc::new(Mutex::new(file_store)),
        Err(e) => { return Err(e); }
      })
    } else {
      None
    };

    let s3_1_store = if enable_s3_1_object_storage {
      let s3_1_key = s3_1_key.ok_or("s3_1_key field is required when primary s3 store is enabled.")?;
      let s3_1_secret = s3_1_secret.ok_or("s3_1_secret field is required when primary s3 store is enabled.")?;
      let s3_1_bucket = s3_1_bucket.ok_or("s3_1_bucket field is required when primary s3 store is enabled.")?;
      Some(match storage_s3::S3Store::new(&s3_1_region, &s3_1_endpoint, &s3_1_bucket, &s3_1_key, &s3_1_secret) {
        Ok(s3_store) => Arc::new(Mutex::new(s3_store)),
        Err(e) => { return Err(e); }
      })
    } else {
      None
    };

    let s3_2_store = if enable_s3_2_object_storage {
      let s3_2_key = s3_2_key.ok_or("s3_2_key field is required when secondary s3 store is enabled.")?;
      let s3_2_secret = s3_2_secret.ok_or("s3_2_secret field is required when secondary s3 store is enabled.")?;
      let s3_2_bucket = s3_2_bucket.ok_or("s3_2_bucket field is required when secondary s3 store is enabled.")?;
      Some(match storage_s3::S3Store::new(&s3_2_region, &s3_2_endpoint, &s3_2_bucket, &s3_2_key, &s3_2_secret) {
        Ok(s3_store) => Arc::new(Mutex::new(s3_store)),
        Err(e) => { return Err(e); }
      })
    } else {
      None
    };

    Ok(ObjectStore { file_store, s3_1_store, s3_2_store })
  }
}


pub async fn get(object_store: Arc<ObjectStore>, user_id: &Uid, id: &Uid, encryption_key: &str) -> InfuResult<Vec<u8>> {
  // If there is a problem reading from any one of the sources, take the view (for the moment)
  // that it is better to error out than try from another source so as to alert the user there
  // is a problem. TODO (MEDIUM): probably something else is better.
  if let Some(file_store) = &object_store.file_store {
    return storage_file::get(file_store.clone(), user_id, id).await;
  }
  // Assume that store #1 is the most cost effective to read from, and always use it in preference
  // to store #2 if available.
  if let Some(s3_1_store) = &object_store.s3_1_store {
    let ciphertext = storage_s3::get(s3_1_store.clone(), user_id, id).await?;
    return Ok(decrypt_file_data(encryption_key, ciphertext.as_slice(), filename(user_id, id).as_str())?);
  }
  if let Some(s3_2_store) = &object_store.s3_2_store {
    let ciphertext = storage_s3::get(s3_2_store.clone(), user_id, id).await?;
    return Ok(decrypt_file_data(encryption_key, ciphertext.as_slice(), filename(user_id, id).as_str())?);
  }
  Err("No object store configured".into())
}


pub async fn put(object_store: Arc<ObjectStore>, user_id: &Uid, id: &Uid, val: &Vec<u8>, encryption_key: &str) -> InfuResult<()> {
  let mut set = JoinSet::new();

  if let Some(file_store) = &object_store.file_store {
    async fn fs_put(file_store: Arc<Mutex<storage_file::FileStore>>, user_id: Uid, id: Uid, val: Vec<u8>) -> InfuResult<()> {
      storage_file::put(file_store, user_id.clone(), id.clone(), val.clone()).await
    }
    set.spawn(fs_put(file_store.clone(), user_id.clone(), id.clone(), val.clone()));
  }

  let encrypted_val = Arc::new(if object_store.s3_1_store.is_some() || object_store.s3_2_store.is_some() {
    encrypt_file_data(encryption_key, val, filename(user_id, id).as_str())?
  } else {
    vec![]
  });

  if let Some(s3_1_store) = &object_store.s3_1_store {
    set.spawn(storage_s3::put(s3_1_store.clone(), user_id.clone(), id.clone(), encrypted_val.clone()));
  }

  if let Some(s3_2_store) = &object_store.s3_2_store {
    set.spawn(storage_s3::put(s3_2_store.clone(), user_id.clone(), id.clone(), encrypted_val.clone()));
  }

  let mut errors = vec![];
  while let Some(res) = set.join_next().await {
    let res = res.map_err(|e| format!("Async join error: {}", e))?;
    match res {
      Err(e) => errors.push(e),
      Ok(_) => {}
    };
  }

  if errors.len() == 0 { Ok(()) }
  else {
    Err(errors.iter()
      .map(|e| format!("{}", e))
      .collect::<Vec<String>>()
      .join(", ").into())
  }
}


pub async fn delete(object_store: Arc<ObjectStore>, user_id: &Uid, id: &Uid) -> InfuResult<()> {
  let mut set = JoinSet::new();

  if let Some(file_store) = &object_store.file_store {
    set.spawn(storage_file::delete(file_store.clone(), user_id.clone(), id.clone()));
  }

  if let Some(s3_1_store) = &object_store.s3_1_store {
    set.spawn(storage_s3::delete(s3_1_store.clone(), user_id.clone(), id.clone()));
  }

  if let Some(s3_2_store) = &object_store.s3_2_store {
    set.spawn(storage_s3::delete(s3_2_store.clone(), user_id.clone(), id.clone()));
  }

  let mut errors = vec![];
  while let Some(res) = set.join_next().await {
    let res = res.map_err(|e| format!("Async join error: {}", e))?;
    match res {
      Err(e) => errors.push(e),
      Ok(_) => {}
    };
  }

  if errors.len() == 0 { Ok(()) }
  else {
    Err(errors.iter()
      .map(|e| format!("{}", e))
      .collect::<Vec<String>>()
      .join(", ").into())
  }
}


fn filename(user_id: &Uid, id: &Uid) -> String {
  format!("{}_{}", user_id, id)
}
