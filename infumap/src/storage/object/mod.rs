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

use tokio::sync::Mutex;
use tokio::task::JoinSet;

use crate::util::crypto::{encrypt_file_data, decrypt_file_data};
use crate::util::infu::InfuResult;
use crate::util::uid::Uid;
use crate::storage::file::FileStore;

use super::s3::S3Store;


pub struct ObjectStore {
  file_store: Option<Arc<Mutex<FileStore>>>,
  s3_1_store: Option<Arc<Mutex<S3Store>>>,
  s3_2_store: Option<Arc<Mutex<S3Store>>>,
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
      Some(match FileStore::new(&data_dir) {
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
      Some(match S3Store::new(&s3_1_region, &s3_1_endpoint, &s3_1_bucket, &s3_1_key, &s3_1_secret) {
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
      Some(match S3Store::new(&s3_2_region, &s3_2_endpoint, &s3_2_bucket, &s3_2_key, &s3_2_secret) {
        Ok(s3_store) => Arc::new(Mutex::new(s3_store)),
        Err(e) => { return Err(e); }
      })
    } else {
      None
    };

    Ok(ObjectStore { file_store, s3_1_store, s3_2_store })
  }

  fn filename(user_id: &Uid, id: &Uid) -> String {
    format!("{}_{}", user_id, id)
  }

  pub async fn get(&mut self, user_id: &Uid, id: &Uid, encryption_key: &str) -> InfuResult<Vec<u8>> {
    // If there is a problem reading from any one of the sources, take the view (for the moment)
    // that it is better to error out than try from another source so as to alert the user there
    // is a problem. TODO (MEDIUM): probably something else is better.
    if let Some(fs) = &mut self.file_store {
      let mut fs = fs.lock().await;
      return fs.get(user_id, id).await;
    }
    // Assume that store #1 is the most cost effective to read from, and always use it in preference
    // to store #2 if available.
    if let Some(s3_1_store) = &mut self.s3_1_store {
      let s3_1_store = s3_1_store.lock().await;
      let ciphertext = s3_1_store.get(user_id, id).await?;
      return Ok(decrypt_file_data(encryption_key, ciphertext.as_slice(), Self::filename(user_id, id).as_str())?);
    }
    if let Some(s3_2_store) = &mut self.s3_2_store {
      let s3_2_store = s3_2_store.lock().await;
      let ciphertext = s3_2_store.get(user_id, id).await?;
      return Ok(decrypt_file_data(encryption_key, ciphertext.as_slice(), Self::filename(user_id, id).as_str())?);
    }
    Err("No object store configured".into())
  }

  pub async fn put(&mut self, user_id: &Uid, id: &Uid, val: &Vec<u8>, encryption_key: &str) -> InfuResult<()> {
    let mut set = JoinSet::new();

    if let Some(fs) = &mut self.file_store {
      async fn fs_put(fs: Arc<Mutex<FileStore>>, user_id: Uid, id: Uid, val: Vec<u8>) -> InfuResult<()> {
        let mut fs = fs.lock().await;
        fs.put(user_id.clone(), id.clone(), val.clone()).await
      }
      set.spawn(fs_put(fs.clone(), user_id.clone(), id.clone(), val.clone()));
    }

    let encrypted_val = if self.s3_1_store.is_some() || self.s3_2_store.is_some() {
      encrypt_file_data(encryption_key, val, Self::filename(user_id, id).as_str())?
    } else {
      vec![]
    };

    async fn s3_put(fs: Arc<Mutex<S3Store>>, user_id: Uid, id: Uid, val: Vec<u8>) -> InfuResult<()> {
      let s3 = fs.lock().await;
      s3.put(user_id.clone(), id.clone(), val.clone()).await
    }

    if let Some(s3_1_store) = &mut self.s3_1_store {
      // TODO (LOW): Should be possible to avoid the val clone here.
      set.spawn(s3_put(s3_1_store.clone(), user_id.clone(), id.clone(), encrypted_val.clone()));
    }

    if let Some(s3_2_store) = &mut self.s3_2_store {
      set.spawn(s3_put(s3_2_store.clone(), user_id.clone(), id.clone(), encrypted_val));
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

  pub async fn delete(&mut self, user_id: &Uid, id: &Uid) -> InfuResult<()> {
    let mut set = JoinSet::new();

    if let Some(fs) = &mut self.file_store {
      async fn fs_delete(fs: Arc<Mutex<FileStore>>, user_id: Uid, id: Uid) -> InfuResult<()> {
        let mut fs = fs.lock().await;
        fs.delete(user_id.clone(), id.clone()).await
      }
      set.spawn(fs_delete(fs.clone(), user_id.clone(), id.clone()));
    }

    async fn s3_delete(fs: Arc<Mutex<S3Store>>, user_id: Uid, id: Uid) -> InfuResult<()> {
      let s3 = fs.lock().await;
      s3.delete(user_id.clone(), id.clone()).await
    }

    if let Some(s3_1_store) = &mut self.s3_1_store {
      set.spawn(s3_delete(s3_1_store.clone(), user_id.clone(), id.clone()));
    }

    if let Some(s3_2_store) = &mut self.s3_2_store {
      set.spawn(s3_delete(s3_2_store.clone(), user_id.clone(), id.clone()));
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
}
