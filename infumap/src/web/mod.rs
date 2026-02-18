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

mod dist_handlers;
mod prometheus;
mod serve;

pub mod cookie;
pub mod routes;
pub mod session;

use clap::{Arg, ArgAction, ArgMatches, Command};
use config::Config;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use infusdk::util::infu::InfuResult;
use log::{info, error, debug};
use once_cell::sync::Lazy;
use ::prometheus::IntCounter;
use tokio::sync::Mutex;
use tokio::task::spawn_blocking;
use tokio::{task, time};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use std::io::Cursor;
use byteorder::{ReadBytesExt, BigEndian};
use tokio::fs;
use tokio::io::AsyncWriteExt;

use crate::config::*;
use crate::setup::init_fs_maybe_and_get_config;
use crate::storage::backup::{self as storage_backup, BackupStore};
use crate::storage::db::users_extra::BackupStatus;
use crate::storage::db::Db;
use crate::storage::cache::{self as storage_cache, ImageCache};
use crate::storage::object::{self as storage_object, ObjectStore};
use crate::tokiort::TokioIo;
use crate::util::crypto::{encrypt_file_data, decrypt_file_data};
use crate::util::fs::expand_tilde;

use self::prometheus::spawn_prometheus_listener;
use self::serve::http_serve;


pub static METRIC_BACKUPS_INITIATED_TOTAL: Lazy<IntCounter> = Lazy::new(|| {
  IntCounter::new(
    "backups_total",
    "Total number of times a user database backup has been initiated.")
      .expect("Could not create METRIC_BACKUPS_TOTAL")
});

pub static METRIC_BACKUPS_FAILED_TOTAL: Lazy<IntCounter> = Lazy::new(|| {
  IntCounter::new(
    "backups_failed_total",
    "Total number of times a user database backup has failed.")
      .expect("Could not create METRIC_BACKUPS_FAILED_TOTAL")
});


pub static METRIC_BACKUP_CLEANUP_DELETE_REQUESTS_TOTAL: Lazy<IntCounter> = Lazy::new(|| {
  IntCounter::new(
    "backup_cleanup_delete_requests_total",
    "Total number of outdated backup file delete requests made.")
      .expect("Could not create METRIC_BACKUP_CLEANUP_DELETE_REQUESTS_TOTAL")
});

pub static METRIC_BACKUP_CLEANUP_DELETE_FAILURES_TOTAL: Lazy<IntCounter> = Lazy::new(|| {
  IntCounter::new(
    "backup_cleanup_delete_failures_total",
    "Total number of outdated backup file delete requests that failed.")
      .expect("Could not create METRIC_BACKUP_CLEANUP_DELETE_FAILURES_TOTAL")
});


pub fn make_clap_subcommand() -> Command {
  Command::new("web")
    .about("Starts the Infumap web server.")
    .arg(Arg::new("settings_path")
      .short('s')
      .long("settings")
      .help(concat!("Path to a toml settings configuration file. If not specified and the env_only config is not defined ",
                    "via env vars, ~/.infumap/settings.toml will be used. If it does not exist, it will created with default ",
                    "values. On-disk data directories will also be created in ~/.infumap."))
      .num_args(1)
      .required(false))
    .arg(Arg::new("dev_feature_flag")
      .long("dev")
      .help("Enable experimental in-development features.")
      .num_args(0)
      .action(ArgAction::SetTrue)
      .required(false))
}


pub async fn execute(arg_matches: &ArgMatches) -> InfuResult<()> {
  let config = init_fs_maybe_and_get_config(arg_matches.get_one::<String>("settings_path")).await?;
  let dev_feature_flag = arg_matches.get_flag("dev_feature_flag");
  start_server(config, dev_feature_flag).await
}


pub async fn start_server(config: Config, dev_feature_flag: bool) -> InfuResult<()> {
  start_server_with_options(config, dev_feature_flag, false).await
}

pub async fn start_server_with_options(config: Config, dev_feature_flag: bool, skip_backup_validation: bool) -> InfuResult<()> {
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let db = Arc::new(tokio::sync::Mutex::new(
    match Db::new(&data_dir).await {
      Ok(db) => db,
      Err(e) => {
        return Err(format!("Failed to initialize database: {}", e).into());
      }
    }
  ));

  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let enable_local_object_storage = config.get_bool(CONFIG_ENABLE_LOCAL_OBJECT_STORAGE).map_err(|e| e.to_string())?;
  let enable_s3_1_object_storage = config.get_bool(CONFIG_ENABLE_S3_1_OBJECT_STORAGE).map_err(|e| e.to_string())?;
  let s3_1_region = config.get_string(CONFIG_S3_1_REGION).ok();
  let s3_1_endpoint = config.get_string(CONFIG_S3_1_ENDPOINT).ok();
  let s3_1_bucket = config.get_string(CONFIG_S3_1_BUCKET).ok();
  let s3_1_key = config.get_string(CONFIG_S3_1_KEY).ok();
  let s3_1_secret = config.get_string(CONFIG_S3_1_SECRET).ok();
  let enable_s3_2_object_storage = config.get_bool(CONFIG_ENABLE_S3_2_OBJECT_STORAGE).map_err(|e| e.to_string())?;
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

  if config.get_bool(CONFIG_ENABLE_S3_BACKUP).map_err(|e| e.to_string())? {
    let s3_region = config.get_string(CONFIG_S3_BACKUP_REGION).ok();
    let s3_endpoint = config.get_string(CONFIG_S3_BACKUP_ENDPOINT).ok();
    let s3_bucket = config.get_string(CONFIG_S3_BACKUP_BUCKET).map_err(|e| e.to_string())?;
    let s3_key = config.get_string(CONFIG_S3_BACKUP_KEY).map_err(|e| e.to_string())?;
    let s3_secret = config.get_string(CONFIG_S3_BACKUP_SECRET).map_err(|e| e.to_string())?;
    let backup_store =
      match storage_backup::new(s3_region.as_ref(), s3_endpoint.as_ref(), &s3_bucket, &s3_key, &s3_secret) {
        Ok(backup_store) => backup_store,
        Err(e) => {
          return Err(format!("Failed to initialize backup store: {}", e).into());
        }
      };

    init_db_backup(
      config.get_int(CONFIG_BACKUP_PERIOD_MINUTES).map_err(|e| e.to_string())? as u32,
      config.get_int(CONFIG_BACKUP_RETENTION_PERIOD_DAYS).map_err(|e| e.to_string())? as u32,
      config.get_bool(CONFIG_DISABLE_BACKUP_CLEANUP).map_err(|e| e.to_string())?,
      config.get_string(CONFIG_BACKUP_ENCRYPTION_KEY).map_err(|e| e.to_string())?.clone(),
      data_dir.clone(), db.clone(), backup_store.clone());
  }

  let cache_dir = config.get_string(CONFIG_CACHE_DIR).map_err(|e| e.to_string())?;
  let cache_max_mb = usize::try_from(config.get_int(CONFIG_CACHE_MAX_MB).map_err(|e| e.to_string())?)?;
  let image_cache =
    match storage_cache::new(&cache_dir, cache_max_mb).await {
      Ok(image_cache) => image_cache,
      Err(e) => {
        return Err(format!("Failed to initialize cache: {}", e).into());
      }
    };

  let addr_str = format!("{}:{}", config.get_string(CONFIG_ADDRESS).map_err(|e| e.to_string())?, config.get_int(CONFIG_PORT).map_err(|e| e.to_string())?);
  let addr: SocketAddr = match addr_str.parse() {
    Ok(addr) => addr,
    Err(e) => {
      return Err(format!("Invalid socket address: {} ({})", addr_str, e).into());
    }
  };

  let config = Arc::new(config);

  if config.get_bool(CONFIG_ENABLE_PROMETHEUS_METRICS).map_err(|e| e.to_string())? {
    let prometheus_addr_str = format!("{}:{}", config.get_string(CONFIG_PROMETHEUS_ADDRESS).map_err(|e| e.to_string())?, config.get_int(CONFIG_PROMETHEUS_PORT).map_err(|e| e.to_string())?);
    let prometheus_addr: SocketAddr = match prometheus_addr_str.parse() {
      Ok(addr) => addr,
      Err(e) => {
        return Err(format!("Invalid prometheus socket address: {} ({})", addr_str, e).into());
      }
    };
    spawn_prometheus_listener(prometheus_addr).await?;
  }

  {
    info!("Loading all items for all users...");
    let mut db = db.lock().await;
    let all_user_ids: Vec<String> = db.user.all_user_ids().iter().map(|v| v.clone()).collect();
    for user_id in all_user_ids {
      db.item.load_user_items(&user_id, false).await?;
    }
    info!("Done loading all items for all users.");
  }

  if config.get_bool(CONFIG_ENABLE_S3_BACKUP).map_err(|e| e.to_string())? && !skip_backup_validation {
    let s3_region = config.get_string(CONFIG_S3_BACKUP_REGION).ok();
    let s3_endpoint = config.get_string(CONFIG_S3_BACKUP_ENDPOINT).ok();
    let s3_bucket = config.get_string(CONFIG_S3_BACKUP_BUCKET).map_err(|e| e.to_string())?;
    let s3_key = config.get_string(CONFIG_S3_BACKUP_KEY).map_err(|e| e.to_string())?;
    let s3_secret = config.get_string(CONFIG_S3_BACKUP_SECRET).map_err(|e| e.to_string())?;
    let backup_store =
      match storage_backup::new(s3_region.as_ref(), s3_endpoint.as_ref(), &s3_bucket, &s3_key, &s3_secret) {
        Ok(backup_store) => backup_store,
        Err(e) => {
          return Err(format!("Failed to initialize backup store for validation: {}", e).into());
        }
      };

    info!("Validating local backup tracking against S3...");
    validate_backup_tracking(&data_dir, backup_store, config.clone()).await?;
    info!("Backup tracking validation completed successfully.");
  }

  listen(addr, db.clone(), object_store.clone(), image_cache.clone(), config.clone(), dev_feature_flag).await
}


fn init_db_backup(backup_period_minutes: u32, backup_retention_period_days: u32, disable_backup_cleanup: bool, encryption_key: String, data_dir: String, db: Arc<Mutex<Db>>, backup_store: Arc<BackupStore>) {

  // *** BACKUP ***
  let backup_store_ref = backup_store.clone();

  let _forever = task::spawn(async move {
    loop {
      time::sleep(Duration::from_secs((backup_period_minutes * 60) as u64)).await;

      let dirty_user_ids = db.lock().await.all_dirty_user_ids();
      debug!("Backing up database logs for {} users.", dirty_user_ids.len());

      for user_id in dirty_user_ids {
        METRIC_BACKUPS_INITIATED_TOTAL.inc();

        async fn update_backup_status(db: Arc<Mutex<Db>>, user_id: &String, status: BackupStatus, detail: &str) {
          match db.lock().await.user_extra.update_backup_status(user_id, status).await {
            Ok(_) => {},
            Err(e) => {
              error!("Failed to update backup status for user '{}': {} ({})", user_id, e, detail);
            }
          }
        }

        debug!("Getting raw logs for user '{}'", &user_id);
        let raw_backup_bytes = match db.lock().await.create_user_backup_raw(&user_id).await {
          Ok(bytes) => bytes,
          Err(e) => {
            error!("Failed to create database log backup for user '{}': {}", user_id, e);
            update_backup_status(db.clone(), &user_id, BackupStatus::Failed, "1").await;
            METRIC_BACKUPS_FAILED_TOTAL.inc();
            continue;
          }
        };

        // This is very CPU intensive, so spawn a blocking task to avoid the potential for
        // HTTP requests to get backed up (which they do otherwise).
        debug!("Compressing backup data for user '{}' .", user_id);
        let compress_result = spawn_blocking(move || {
          let mut compressed = Vec::with_capacity(raw_backup_bytes.len() + 8);
          // Write 4-byte magic header for zstd
          compressed.extend_from_slice(b"IMZ1");
          match zstd::stream::encode_all(&raw_backup_bytes[..], 3) {
            Ok(zstd_bytes) => {
              compressed.extend_from_slice(&zstd_bytes);
              Ok(compressed)
            },
            Err(e) => Err(format!("{}", e))
          }
        }).await;
        let compress_result = match compress_result {
          Ok(r) => r,
          Err(e) => {
            error!("Failed to compress backup database logs for user '{}': {}", user_id, e);
            update_backup_status(db.clone(), &user_id, BackupStatus::Failed, "2").await;
            METRIC_BACKUPS_FAILED_TOTAL.inc();
            continue;
          }
        };
        let compressed = match compress_result {
          Ok(bytes) => bytes,
          Err(e) => {
            error!("Failed to compress backup database logs for user '{}': {}", user_id, e);
            update_backup_status(db.clone(), &user_id, BackupStatus::Failed, "3").await;
            METRIC_BACKUPS_FAILED_TOTAL.inc();
            continue;
          }
        };

        let timestamp = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
          Ok(duration) => duration.as_secs(),
          Err(e) => {
            error!("Failed to create backup timestamp for user '{}': {}", user_id, e);
            update_backup_status(db.clone(), &user_id, BackupStatus::Failed, "4").await;
            METRIC_BACKUPS_FAILED_TOTAL.inc();
            continue;
          }
        };
        let backup_filename = storage_backup::format_backup_filename(&user_id, timestamp);

        // Bind ciphertext to the exact backup object name to prevent replay/rename attacks.
        debug!("Encrypting backup data for user '{}' with backup filename '{}'.", user_id, backup_filename);
        let encrypted = match encrypt_file_data(&encryption_key, &compressed, backup_filename.as_str()) {
          Ok(bytes) => bytes,
          Err(e) => {
            error!("Failed to encrypt database logs for user '{}': {}", user_id, e);
            update_backup_status(db.clone(), &user_id, BackupStatus::Failed, "5").await;
            METRIC_BACKUPS_FAILED_TOTAL.inc();
            continue;
          }
        };

        info!("Finished creating database log backup for user '{}' with size {} bytes.", user_id, encrypted.len());

        match storage_backup::put(backup_store_ref.clone(), &backup_filename, encrypted).await {
          Ok(_) => {
            info!("Backed up database logs for user '{}' to '{}'.", user_id, backup_filename);

            match crate::util::fs::write_last_backup_filename(&data_dir, &user_id, &backup_filename).await {
              Ok(_) => {
                info!("Updated last backup tracking file for user '{}'.", user_id);
              },
              Err(e) => {
                error!("Failed to update last backup tracking file for user '{}': {}", user_id, e);
              }
            }

            update_backup_status(db.clone(), &user_id, BackupStatus::Succeeded, "6").await;
          },
          Err(e) => {
            error!("Database log backup failed for user '{}': {}", user_id, e);
            update_backup_status(db.clone(), &user_id, BackupStatus::Failed, "7").await;
            METRIC_BACKUPS_FAILED_TOTAL.inc();
          }
        }
      }

    }
  });

  // *** CLEANUP ***
  let backup_store_ref = backup_store.clone();
  let _forever = task::spawn(async move {
    const CLEANUP_PERIOD: u32 = 10; // run cleanup logic every 10 backup cycles.
    let backup_retention_period_s = (backup_retention_period_days * 24 * 60 * 60) as u64;
    loop {
      time::sleep(Duration::from_secs((backup_period_minutes * 60 * CLEANUP_PERIOD) as u64)).await;

      if disable_backup_cleanup {
        info!("Backup cleanup is disabled, skipping cleanup cycle.");
        continue;
      }

      info!("Cleaning up unneeded db backups.");
  
      let backups = match storage_backup::list(backup_store_ref.clone()).await {
        Ok(r) => r,
        Err(e) => {
          error!("Could not list db backups: {}", e);
          continue;
        }
      };

      for (user_id, timestamps) in backups.iter() {
        // At least one timestamp per user is always returned. Always keep first backup.
        let mut last_kept = *timestamps.first().unwrap();
        for i in 1..timestamps.len()-1 { // Do not consider (always keep) last backup.
          let timestamp = timestamps[i];
          if timestamp - last_kept < backup_retention_period_s {
            METRIC_BACKUP_CLEANUP_DELETE_REQUESTS_TOTAL.inc();
            match storage_backup::delete(backup_store_ref.clone(), user_id, timestamp).await {
              Ok(_) => {
                info!("Deleted db backup for user '{}' at timestamp {}.", user_id, timestamp);
              },
              Err(e) => {
                error!("Failed to delete db backup for user '{}' at timestamp {}: {}", user_id, timestamp, e);
                METRIC_BACKUP_CLEANUP_DELETE_FAILURES_TOTAL.inc();
              }
            };
          } else {
            last_kept = timestamp;
          }
        }
      }

      info!("Done cleaning up database log backups.");
    }
  });
}


fn extract_timestamp_from_backup_filename(filename: &str) -> Option<u64> {
  let parts: Vec<&str> = filename.split('_').collect();
  if parts.len() == 2 {
    parts[1].parse::<u64>().ok()
  } else {
    None
  }
}

async fn find_next_backup_number(data_dir: &str, user_id: &str, base_filename: &str) -> InfuResult<u32> {
  let mut user_dir = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  user_dir.push(format!("user_{}", user_id));

  let mut n = 1u32;
  loop {
    let backup_filename = format!("{}.bk.{}", base_filename, n);
    let mut backup_path = user_dir.clone();
    backup_path.push(&backup_filename);

    if !backup_path.exists() {
      return Ok(n);
    }
    n += 1;
  }
}

async fn process_and_restore_backup(
  backup_bytes: &[u8],
  data_dir: &str,
  user_id: &str,
  encryption_key: &str,
  backup_filename: &str
) -> InfuResult<()> {
  let unencrypted = decrypt_file_data(encryption_key, backup_bytes, backup_filename)?;

  let (compression_type, compressed_data) = if unencrypted.len() > 4 && &unencrypted[0..4] == b"IMZ1" {
    (1u8, &unencrypted[4..])
  } else if unencrypted.len() > 4 && &unencrypted[0..4] == b"IMB0" {
    (0u8, &unencrypted[4..])
  } else {
    (0u8, &unencrypted[..])
  };

  let mut uncompressed = vec![];
  match compression_type {
    1 => {
      let mut zstd_decoder = zstd::stream::Decoder::new(compressed_data)?;
      std::io::copy(&mut zstd_decoder, &mut uncompressed)?;
    },
    _ => {
      let mut u_cursor = std::io::Cursor::new(compressed_data);
      brotli::BrotliDecompress(&mut u_cursor, &mut uncompressed)
        .map_err(|e| format!("Failed to decompress backup data for user {}: {}", user_id, e))?;
    }
  }

  let mut rdr = Cursor::new(&mut uncompressed[0..8]);
  let isize = rdr.read_u64::<BigEndian>()? as usize;
  let mut rdr = Cursor::new(&mut uncompressed[(8+isize)..(16+isize)]);
  let usize = rdr.read_u64::<BigEndian>()? as usize;

  let mut user_dir = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  user_dir.push(format!("user_{}", user_id));

  let items_path = user_dir.join("items.json");
  let user_path = user_dir.join("user.json");

  if items_path.exists() {
    let backup_num = find_next_backup_number(data_dir, user_id, "items.json").await?;
    let backup_items_path = user_dir.join(format!("items.json.bk.{}", backup_num));
    fs::rename(&items_path, &backup_items_path).await?;
    info!("Renamed existing items.json to items.json.bk.{} for user '{}'", backup_num, user_id);
  }

  if user_path.exists() {
    let backup_num = find_next_backup_number(data_dir, user_id, "user.json").await?;
    let backup_user_path = user_dir.join(format!("user.json.bk.{}", backup_num));
    fs::rename(&user_path, &backup_user_path).await?;
    info!("Renamed existing user.json to user.json.bk.{} for user '{}'", backup_num, user_id);
  }

  let mut file = fs::File::create(&items_path).await?;
  file.write_all(&uncompressed[8..(8+isize)]).await?;
  file.flush().await?;
  info!("Restored items.json from S3 backup for user '{}'", user_id);

  let mut file = fs::File::create(&user_path).await?;
  file.write_all(&uncompressed[(16+isize)..(16+isize+usize)]).await?;
  file.flush().await?;
  info!("Restored user.json from S3 backup for user '{}'", user_id);

  Ok(())
}

async fn validate_backup_tracking(data_dir: &str, backup_store: Arc<BackupStore>, config: Arc<config::Config>) -> InfuResult<()> {
  use crate::util::fs::{read_last_backup_filename};
  use crate::storage::backup::get_latest_backup_filename_for_user;

  let db = crate::storage::db::Db::new(data_dir).await?;
  let all_user_ids: Vec<String> = db.user.all_user_ids().iter().map(|v| v.clone()).collect();

  for user_id in all_user_ids {
    let local_last_backup = read_last_backup_filename(data_dir, &user_id).await?;
    let s3_latest_backup = get_latest_backup_filename_for_user(backup_store.clone(), &user_id).await?;

    match (local_last_backup, s3_latest_backup) {
      (Some(local), Some(s3)) => {
        if local != s3 {
          let local_timestamp = extract_timestamp_from_backup_filename(&local);
          let s3_timestamp = extract_timestamp_from_backup_filename(&s3);

          match (local_timestamp, s3_timestamp) {
            (Some(local_ts), Some(s3_ts)) => {
              if s3_ts > local_ts {
                info!("S3 backup for user '{}' is newer ({}) than local tracking ({}). Attempting recovery.",
                      user_id, s3, local);

                let backup_bytes = storage_backup::get(backup_store.clone(), &user_id, s3_ts).await
                  .map_err(|e| format!("Failed to retrieve backup '{}' for user '{}': {}", s3, user_id, e))?;

                let encryption_key = config.get_string(CONFIG_BACKUP_ENCRYPTION_KEY).map_err(|e| e.to_string())?;
                process_and_restore_backup(&backup_bytes, data_dir, &user_id, &encryption_key, &s3).await
                  .map_err(|e| format!("Failed to restore backup for user '{}': {}", user_id, e))?;

                crate::util::fs::write_last_backup_filename(data_dir, &user_id, &s3).await
                  .map_err(|e| format!("Failed to update last backup tracking file for user '{}': {}", user_id, e))?;

                info!("Successfully restored user '{}' from S3 backup '{}'. The process is terminating as requested.", user_id, s3);
                std::process::exit(0);
              } else {
                return Err(format!(
                  "Backup validation failed for user '{}': S3 backup '{}' (timestamp {}) is older than or equal to local backup '{}' (timestamp {})",
                  user_id, s3, s3_ts, local, local_ts
                ).into());
              }
            },
            _ => {
              return Err(format!(
                "Backup validation failed for user '{}': could not parse timestamps from local backup '{}' or S3 backup '{}'",
                user_id, local, s3
              ).into());
            }
          }
        }
      },
      (Some(local), None) => {
        return Err(format!(
          "Backup validation failed for user '{}': local last backup '{}' exists but no backups found in S3",
          user_id, local
        ).into());
      },
      (None, Some(s3)) => {
        return Err(format!(
          "Backup validation failed for user '{}': S3 has latest backup '{}' but no local tracking file found",
          user_id, s3
        ).into());
      },
      (None, None) => {
      }
    }
  }

  Ok(())
}


async fn listen(addr: SocketAddr, db: Arc<Mutex<Db>>, object_store: Arc<ObjectStore>, image_cache: Arc<std::sync::Mutex<ImageCache>>, config: Arc<config::Config>, dev_feature_flag: bool) -> InfuResult<()> {
  let listener = TcpListener::bind(addr).await?;
  loop {
    let (stream, _) = listener.accept().await?;
    let db = db.clone();
    let object_store = object_store.clone();
    let image_cache = image_cache.clone();
    let config = config.clone();

    let io = TokioIo::new(stream);
    tokio::task::spawn(async move {
      if let Err(err) = http1::Builder::new()
          .serve_connection(io, service_fn(move |req| http_serve(db.clone(), object_store.clone(), image_cache.clone(), config.clone(), dev_feature_flag, req)))
          .await {
        info!("Error serving connection: {:?}", err);
      }
    });
  }
}
