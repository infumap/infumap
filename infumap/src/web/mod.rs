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

use clap::{ArgMatches, App, Arg};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use log::{info, error, warn, debug};
use tokio::sync::Mutex;
use tokio::task::spawn_blocking;
use tokio::{task, time};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;

use crate::config::*;
use crate::setup::init_fs_maybe_and_get_config;
use crate::storage::backup::{self as storage_backup, BackupStore};
use crate::storage::db::Db;
use crate::storage::cache::{self as storage_cache, ImageCache};
use crate::storage::object::{self as storage_object, ObjectStore};
use crate::util::crypto::encrypt_file_data;
use crate::util::infu::InfuResult;

use self::serve::http_serve;


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("web")
    .about("Starts the Infumap web server.")
    .arg(Arg::new("settings_path")
    .short('s')
    .long("settings")
    .help(concat!("Path to a toml settings configuration file. If not specified and the env_only config is not defined ",
                  "via env vars, ~/.infumap/settings.toml will be used. If it does not exist, it will created with default ",
                  "values. On-disk data directories will also be created in ~/.infumap."))
    .takes_value(true)
    .multiple_values(false)
    .required(false))
}


pub async fn execute<'a>(arg_matches: &ArgMatches) -> InfuResult<()> {
  let config = init_fs_maybe_and_get_config(
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
  let object_store = 
    match storage_object::new(&data_dir, enable_local_object_storage,
                              enable_s3_1_object_storage, s3_1_region, s3_1_endpoint, s3_1_bucket, s3_1_key, s3_1_secret,
                              enable_s3_2_object_storage, s3_2_region, s3_2_endpoint, s3_2_bucket, s3_2_key, s3_2_secret) {
      Ok(object_store) => object_store,
      Err(e) => {
        return Err(format!("Failed to initialize object store: {}", e).into());
      }
    };

  if config.get_bool(CONFIG_ENABLE_S3_BACKUP)? {
    let s3_region = config.get_string(CONFIG_S3_BACKUP_REGION).ok();
    let s3_endpoint = config.get_string(CONFIG_S3_BACKUP_ENDPOINT).ok();
    let s3_bucket = config.get_string(CONFIG_S3_BACKUP_BUCKET)?;
    let s3_key = config.get_string(CONFIG_S3_BACKUP_KEY)?;
    let s3_secret = config.get_string(CONFIG_S3_BACKUP_SECRET)?;
    let backup_store =
      match storage_backup::new(s3_region, s3_endpoint, s3_bucket, s3_key, s3_secret) {
        Ok(backup_store) => backup_store,
        Err(e) => {
          return Err(format!("Failed to initialize backup store: {}", e).into());
        }
      };

    init_db_backup(
      config.get_int(CONFIG_BACKUP_PERIOD_MINUTES)? as u32,
      config.get_int(CONFIG_BACKUP_RETENTION_PERIOD_DAYS)? as u32,
      config.get_string(CONFIG_BACKUP_ENCRYPTION_KEY)?.clone(),
      db.clone(), backup_store.clone());
  }

  let cache_dir = config.get_string(CONFIG_CACHE_DIR)?;
  let cache_max_mb = usize::try_from(config.get_int(CONFIG_CACHE_MAX_MB)?)?;
  let image_cache =
    match storage_cache::new(&cache_dir, cache_max_mb).await {
      Ok(image_cache) => image_cache,
      Err(e) => {
        return Err(format!("Failed to initialize config: {}", e).into());
      }
    };

  let addr_str = format!("{}:{}", config.get_string(CONFIG_ADDRESS)?, config.get_int(CONFIG_PORT)?);
  let addr: SocketAddr = match addr_str.parse() {
    Ok(addr) => addr,
    Err(e) => {
      return Err(format!("Invalid socket address: {} ({})", addr_str, e).into());
    }
  };

  let config = Arc::new(config);

  listen(addr, db.clone(), object_store.clone(), image_cache.clone(), config.clone()).await
}


fn init_db_backup(backup_period_minutes: u32, backup_retention_period_days: u32, encryption_key: String, db: Arc<Mutex<Db>>, backup_store: Arc<BackupStore>) {
  let _forever = task::spawn(async move {
    loop {
      time::sleep(Duration::from_secs((backup_period_minutes * 60) as u64)).await;

      let dirty_user_ids = db.lock().await.all_dirty_user_ids();

      debug!("Backing up database logs for {} users.", dirty_user_ids.len());
      for user_id in dirty_user_ids {

        debug!("Getting raw logs for user '{}'", &user_id);
        let raw_backup_bytes = match db.lock().await.create_user_backup_raw(&user_id).await {
          Ok(bytes) => bytes,
          Err(e) => {
            error!("Failed to create database log backup for user '{}': {}", user_id, e);
            continue;
          }
        };

        // This is very CPU intensive, so spawn a blocking task to avoid the potential for
        // HTTP requests to get backed up (which they do).
        debug!("Compressing backup data for user '{}'.", user_id);
        let compress_result = spawn_blocking(move || {
          let mut compressed = Vec::with_capacity(raw_backup_bytes.len() + 8);
          match brotli::BrotliCompress(&mut &raw_backup_bytes[..], &mut compressed, &Default::default()) {
            Ok(l) => {
              if l != compressed.len() {
                Err("Compressed sizes do not match".to_owned())
              } else {
                Ok(compressed)
              }
            },
            Err(e) => {
              Err(format!("{}", e))
            }
          }
        }).await;
        let compress_result = match compress_result {
          Ok(r) => r,
          Err(e) => {
            error!("Failed to compress backup database logs for user '{}': {}", user_id, e);
            continue;
          }
        };
        let compressed = match compress_result {
          Ok(bytes) => bytes,
          Err(e) => {
            error!("Failed to compress backup database logs for user '{}': {}", user_id, e);
            continue;
          }
        };

        // This doesn't require enough CPU to bother spawning.
        debug!("Encrypting backup data for user '{}'.", user_id);
        let encrypted = match encrypt_file_data(&encryption_key, &compressed, &user_id) {
          Ok(bytes) => bytes,
          Err(e) => {
            error!("Failed to encrypt database logs for user '{}': {}", user_id, e);
            continue;
          }
        };

        info!("Finished creating database log backup for user '{}' with size {} bytes.", user_id, encrypted.len());

        match storage_backup::put(backup_store.clone(), &user_id, encrypted).await {
          Ok(s3_filename) => {
            info!("Backed up database logs for user '{}' to '{}'.", user_id, s3_filename);
          },
          Err(e) => {
            error!("Database log backup failed for user '{}': {}", user_id, e);
          }
        }
      }

    }
  });

  let _forever = task::spawn(async move {
    loop {
      time::sleep(Duration::from_secs((backup_retention_period_days * 24 * 60 * 60) as u64)).await;

      warn!("TODO: cleanup backup store");
    }
  });
}


async fn listen(addr: SocketAddr, db: Arc<Mutex<Db>>, object_store: Arc<ObjectStore>, image_cache: Arc<std::sync::Mutex<ImageCache>>, config: Arc<config::Config>) -> InfuResult<()> {
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
