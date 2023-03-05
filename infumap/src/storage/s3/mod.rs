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

use s3::creds::Credentials;
use s3::{Bucket, Region};

use crate::util::infu::InfuResult;
use crate::util::uid::Uid;


pub struct S3Store {
  bucket: Bucket
}

impl S3Store {
  pub fn new(region: &Option<String>, endpoint: &Option<String>, bucket: &str, key: &str, secret: &str) -> InfuResult<S3Store> {
    let credentials = Credentials::new(Some(key), Some(secret), None, None, None)
      .map_err(|e| format!("Could not initialize S3 credentials: {}", e))?;
    let bucket = Bucket::new(
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
    Ok(S3Store { bucket })
  }

  pub async fn get(&mut self, user_id: &Uid, id: &Uid) -> InfuResult<Vec<u8>> {
    let s3_path = format!("{}_{}", user_id, id);
    let result = self.bucket.get_object(s3_path).await
      .map_err(|e| format!("Error occured getting S3 object: {}", e))?;
    if result.status_code() != 200 {
      return Err(format!("Unexpected status code getting S3 object: {}", result.status_code()).into());
    }
    Ok(result.into())
  }

  pub async fn put(&mut self, user_id: Uid, id: Uid, val: Vec<u8>) -> InfuResult<()> {
    let s3_path = format!("{}_{}", user_id, id);
    let result = self.bucket.put_object(s3_path, val.as_slice()).await
      .map_err(|e| format!("Error occured putting S3 object: {}", e))?;
    if result.status_code() != 200 {
      return Err(format!("Unexpected status code putting S3 object: {}", result.status_code()).into());
    }
    Ok(())
  }

  pub async fn delete(&mut self, user_id: Uid, id: Uid) -> InfuResult<()> {
    let s3_path = format!("{}_{}", user_id, id);
    let result = self.bucket.delete_object(s3_path).await
      .map_err(|e| format!("Error occured deleting S3 object: {}", e))?;
    if result.status_code() != 204 {
      return Err(format!("Unexpected status code deleting S3 object: {}", result.status_code()).into());
    }
    Ok(())
  }

  pub async fn list(&mut self) -> Vec<String> {
    // let lbr = self.bucket.list("".to_owned(), None).await.unwrap();
    // let a = lbr.first().unwrap();
    vec![]
  }
}
