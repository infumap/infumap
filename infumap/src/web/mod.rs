// Copyright (C) 2022-2023 The Infumap Authors
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

mod dist_handlers;
mod prometheus;
mod serve;

pub mod cookie;
pub mod routes;
pub mod session;

use clap::ArgMatches;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use log::info;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;

use crate::config::*;
use crate::storage::db::Db;
use crate::storage::cache::ImageCache;
use crate::setup::init_fs_and_config;
use crate::storage::object::ObjectStore;
use crate::util::infu::InfuResult;

use self::serve::http_serve;


pub async fn execute<'a>(arg_matches: &ArgMatches) -> InfuResult<()> {
  let config = init_fs_and_config(
    arg_matches.value_of("settings_path").map(|a| a.to_string())).await?;

  let data_dir = config.get_string(CONFIG_DATA_DIR)?;
  let db = Arc::new(tokio::sync::Mutex::new(
    match Db::new( &data_dir).await {
      Ok(db) => db,
      Err(e) => {
        return Err(format!("Failed to initialize database: {}", e).into());
      }
    }
  ));

  let data_dir = config.get_string(CONFIG_DATA_DIR)?;
  let enable_local_object_storage = config.get_bool(CONFIG_ENABLE_LOCAL_OBJECT_STORAGE)?;
  let enable_s3_1_object_storage = config.get_bool(CONFIG_ENABLE_S3_1_OBJECT_STORAGE)?;
  let s3_1_region = config.get_string(CONFIG_S3_1_REGION).ok();
  let s3_1_endpoint = config.get_string(CONFIG_S3_1_ENDPOINT).ok();
  let s3_1_bucket = config.get_string(CONFIG_S3_1_BUCKET).ok();
  let s3_1_key = config.get_string(CONFIG_S3_1_KEY).ok();
  let s3_1_secret = config.get_string(CONFIG_S3_1_SECRET).ok();
  let enable_s3_2_object_storage = config.get_bool(CONFIG_ENABLE_S3_2_OBJECT_STORAGE)?;
  let s3_2_region = config.get_string(CONFIG_S3_2_REGION).ok();
  let s3_2_endpoint = config.get_string(CONFIG_S3_2_ENDPOINT).ok();
  let s3_2_bucket = config.get_string(CONFIG_S3_2_BUCKET).ok();
  let s3_2_key = config.get_string(CONFIG_S3_2_KEY).ok();
  let s3_2_secret = config.get_string(CONFIG_S3_2_SECRET).ok();
  let object_store = Arc::new(
    match ObjectStore::new(&data_dir, enable_local_object_storage,
                           enable_s3_1_object_storage, s3_1_region, s3_1_endpoint, s3_1_bucket, s3_1_key, s3_1_secret,
                           enable_s3_2_object_storage, s3_2_region, s3_2_endpoint, s3_2_bucket, s3_2_key, s3_2_secret) {
      Ok(object_store) => object_store,
      Err(e) => {
        return Err(format!("Failed to initialize object store: {}", e).into());
      }
    }
  );

  let cache_dir = config.get_string(CONFIG_CACHE_DIR)?;
  let cache_max_mb = usize::try_from(config.get_int(CONFIG_CACHE_MAX_MB)?)?;
  let image_cache = Arc::new(tokio::sync::Mutex::new(
    match ImageCache::new(&cache_dir, cache_max_mb).await {
      Ok(image_cache) => image_cache,
      Err(e) => {
        return Err(format!("Failed to initialize config: {}", e).into());
      }
    }
  ));

  let addr_str = format!("{}:{}", config.get_string(CONFIG_ADDRESS)?, config.get_int(CONFIG_PORT)?);
  let addr: SocketAddr = match addr_str.parse() {
    Ok(addr) => addr,
    Err(e) => {
      return Err(format!("Invalid socket address: {} ({})", addr_str, e).into());
    }
  };

  let config = Arc::new(config);

  let listener = TcpListener::bind(addr).await?;
  loop {
    let (stream, _) = listener.accept().await?;
    let db = db.clone();
    let object_store = object_store.clone();
    let image_cache = image_cache.clone();
    let config = config.clone();
    tokio::task::spawn(async move {
      if let Err(err) = http1::Builder::new()
        .serve_connection(
          stream,
          service_fn(move |req| http_serve(db.clone(), object_store.clone(), image_cache.clone(), config.clone(), req))
        ).await
      {
        info!("Error serving connection: {:?}", err);
      }
    });
  }

}
