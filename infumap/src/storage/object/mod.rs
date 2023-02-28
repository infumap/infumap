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


use core::panic;
use crate::util::crypto::{encrypt_file_data, decrypt_file_data};
use crate::util::infu::InfuResult;
use crate::util::uid::Uid;
use crate::storage::file::FileStore;
use super::s3::S3Store;


pub struct ObjectStore {
  file_store: Option<FileStore>,
  s3_1_store: Option<S3Store>,
  s3_2_store: Option<S3Store>,
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
        Ok(file_store) => file_store,
        Err(e) => {
          println!("Failed to initialize file store: {}", e);
          panic!();
        }
      })
    } else {
      None
    };

    let s3_1_store = if enable_s3_1_object_storage {
      let s3_1_key = s3_1_key.ok_or("s3_1_key field is required when primary s3 store is enabled.")?;
      let s3_1_secret = s3_1_secret.ok_or("s3_1_secret field is required when primary s3 store is enabled.")?;
      let s3_1_bucket = s3_1_bucket.ok_or("s3_1_bucket field is required when primary s3 store is enabled.")?;
      Some(match S3Store::new(&s3_1_region, &s3_1_endpoint, &s3_1_bucket, &s3_1_key, &s3_1_secret) {
        Ok(s3_store) => s3_store,
        Err(e) => {
          println!("Failed to initialize primary s3 store: {}", e);
          panic!();
        }
      })
    } else {
      None
    };

    let s3_2_store = if enable_s3_2_object_storage {
      let s3_2_key = s3_2_key.ok_or("s3_2_key field is required when secondary s3 store is enabled.")?;
      let s3_2_secret = s3_2_secret.ok_or("s3_2_secret field is required when secondary s3 store is enabled.")?;
      let s3_2_bucket = s3_2_bucket.ok_or("s3_2_bucket field is required when primary s3 store is enabled.")?;
      Some(match S3Store::new(&s3_2_region, &s3_2_endpoint, &s3_2_bucket, &s3_2_key, &s3_2_secret) {
        Ok(s3_store) => s3_store,
        Err(e) => {
          println!("Failed to initialize secondary s3 store: {}", e);
          panic!();
        }
      })
    } else {
      None
    };

    Ok(ObjectStore { file_store, s3_1_store, s3_2_store })
  }

  fn filename(user_id: &Uid, id: &Uid) -> String {
    format!("{}_{}", user_id, id)
  }

  pub fn get(&mut self, user_id: &Uid, id: &Uid, encryption_key: &str) -> InfuResult<Vec<u8>> {
    if let Some(fs) = &mut self.file_store {
      return fs.get(user_id, id);
    }
    // if let Some(s3_1_store) = &mut self.s3_1_store {
    //   let ciphertext = s3_1_store.get(user_id, id)?;
    //   return Ok(decrypt_file_data(encryption_key, ciphertext.as_slice(), Self::filename(user_id, id).as_str())?);
    // }
    panic!();
  }

  pub fn put(&mut self, user_id: &Uid, id: &Uid, val: &Vec<u8>, encryption_key: &str) -> InfuResult<()> {
    if let Some(fs) = &mut self.file_store {
      fs.put(user_id, id, val)?;
    }
    // if self.s3_1_store.is_some() || self.s3_2_store.is_some() {
    //   let encrypted_val = encrypt_file_data(encryption_key, val, Self::filename(user_id, id).as_str())?;
    //   if let Some(s3_1_store) = &mut self.s3_1_store {
    //     s3_1_store.put(user_id, id, &encrypted_val)?;
    //   }
    //   if let Some(s3_2_store) = &mut self.s3_2_store {
    //     s3_2_store.put(user_id, id, &encrypted_val)?;
    //   }
    // }
    Ok(())
  }

  pub fn delete(&mut self, user_id: &Uid, id: &Uid) -> InfuResult<()> {
    if let Some(fs) = &mut self.file_store {
      return fs.delete(user_id, id);
    }
    // if let Some(s3_1_store) = &mut self.s3_1_store {
    //   s3_1_store.delete(user_id, id)?;
    // }
    // if let Some(s3_2_store) = &mut self.s3_2_store {
    //   s3_2_store.delete(user_id, id)?;
    // }
    Ok(())
  }
}
