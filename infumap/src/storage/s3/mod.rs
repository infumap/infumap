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

use std::time::Duration;

use s3::creds::Credentials;
use s3::{Bucket, Region};

use crate::util::infu::InfuResult;
use crate::util::uid::Uid;

use super::db::item_db::ItemAndUserId;


pub struct S3Store {
  bucket: Bucket
}

impl S3Store {
  pub fn new(region: &Option<String>, endpoint: &Option<String>, bucket: &str, key: &str, secret: &str) -> InfuResult<S3Store> {
    let credentials = Credentials::new(Some(key), Some(secret), None, None, None)
      .map_err(|e| format!("Could not initialize S3 credentials: {}", e))?;
    let mut bucket = Bucket::new(
      bucket, 
      if let Some(region) = region {
        region.parse().map_err(|e| format!("Could not parse S3 region: {}", e))?
      } else {
        Region::Custom {
          region: if let Some(region) = region { region.to_owned() } else { "global".to_owned() },
          endpoint: endpoint.clone().ok_or("Expecting S3 endpoint to be specified when S3 region is not specified.")?
        }
      },
      credentials
    ).map_err(|e| format!("Could not construct S3 bucket instance: {}", e))?;
    bucket.set_request_timeout(Some(Duration::from_secs(120)));
    Ok(S3Store { bucket })
  }

  pub async fn get(&self, user_id: &Uid, id: &Uid) -> InfuResult<Vec<u8>> {
    let s3_path = format!("{}_{}", user_id, id);
    let result = self.bucket.get_object(s3_path).await
      .map_err(|e| format!("Error occured getting S3 object: {}", e))?;
    if result.status_code() != 200 {
      return Err(format!("Unexpected status code getting S3 object: {}", result.status_code()).into());
    }
    Ok(result.into())
  }

  pub async fn put(&self, user_id: Uid, id: Uid, val: Vec<u8>) -> InfuResult<()> {
    let s3_path = format!("{}_{}", user_id, id);
    let result = self.bucket.put_object(s3_path, val.as_slice()).await
      .map_err(|e| format!("Error occured putting S3 object: {}", e))?;
    if result.status_code() != 200 {
      return Err(format!("Unexpected status code putting S3 object: {}", result.status_code()).into());
    }
    Ok(())
  }

  pub async fn delete(&self, user_id: Uid, id: Uid) -> InfuResult<()> {
    let s3_path = format!("{}_{}", user_id, id);
    let result = self.bucket.delete_object(s3_path).await
      .map_err(|e| format!("Error occured deleting S3 object: {}", e))?;
    if result.status_code() != 204 {
      return Err(format!("Unexpected status code deleting S3 object: {}", result.status_code()).into());
    }
    Ok(())
  }

  pub async fn list(&self) -> InfuResult<Vec<ItemAndUserId>> {
    let mut result = vec![];
    let mut lbrs = self.bucket.list_page("".to_owned(), None, None, None, None).await
      .map_err(|e| format!("S3 list_page server request failed: {}", e))?;
    if lbrs.1 != 200 { // status code.
      return Err(format!("Expected list_page status code to be 200, not {}", lbrs.1).into());
    }
    loop {
      for c in lbrs.0.contents {
        let mut parts = c.key.split("_");
        let user_id = parts.next().ok_or(format!("Unexpected object filename {}", c.key))?;
        let item_id = parts.next().ok_or(format!("Unexpected object filename {}", c.key))?;
        if parts.next().is_some() { return Err(format!("Unexpected object filename {}", c.key).into()); }
        result.push(
          ItemAndUserId {
            user_id: String::from(user_id),
            item_id: String::from(item_id)
          }
        );
      }
      if let Some(ct) = lbrs.0.next_continuation_token {
        lbrs = self.bucket.list_page("".to_owned(), None, Some(ct), None, None).await
          .map_err(|e| format!("S3 list_page server request (continuation) failed: {}", e))?;
        if lbrs.1 != 200 { // status code.
          return Err(format!("Expected list_page status code to be 200, not {}", lbrs.1).into());
        }
      } else {
        break;
      }
    }
    Ok(result)
  }
}
