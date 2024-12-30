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

use std::env::temp_dir;

use clap::{Arg, ArgAction, ArgMatches, Command};
use config::Config;
use infusdk::util::infu::InfuResult;
use log::{error, info, warn};

use crate::cli::restore::process_backup;
use crate::setup::add_config_defaults;
use crate::util::fs::ensure_256_subdirs;
use crate::web::start_server;


pub fn make_clap_subcommand() -> Command {
  Command::new("emergency")
    .about("Automates pulling the latest backup file for a specific Infumap user and bringing up a temporary local infumap instance based on this.")

    .arg(Arg::new("s3_backup_endpoint")
      .long("s3-backup-endpoint")
      .help("The s3 endpoint for the backup object store (if required by your provider).")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_backup_region")
      .long("s3-backup-region")
      .help("The s3 region for the backup object store (if required by your provider).")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_backup_bucket")
      .long("s3-backup-bucket")
      .help("The s3 bucket name of the backup object store.")
      .num_args(1)
      .required(true))
    .arg(Arg::new("s3_backup_key")
      .long("s3-backup-key")
      .help("The s3 key for accessing the backup object store.")
      .num_args(1)
      .required(true))
    .arg(Arg::new("s3_backup_secret")
      .long("s3-backup-secret")
      .help("The s3 secret for accessing the backup object store.")
      .num_args(1)
      .required(true))

    .arg(Arg::new("s3_endpoint")
      .long("s3-endpoint")
      .help("The s3 endpoint for the infumap data object store (if required by your provider).")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_region")
      .long("s3-region")
      .help("The s3 region for the infumap data object store (if required by your provider).")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_bucket")
      .long("s3-bucket")
      .help("The s3 bucket name of the infumap data object store.")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_key")
      .long("s3-key")
      .help("The s3 key for the infumap data object store.")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_secret")
      .long("s3-secret")
      .help("The s3 secret for the infumap data object store.")
      .num_args(1)
      .required(false))

    .arg(Arg::new("user_id")
      .long("user-id")
      .help("The infumap user id.")
      .num_args(1)
      .required(true))
    .arg(Arg::new("encryption_key")
      .long("encryption-key")
      .help("The 32 byte hex encoded encryption key (64 chars) that was used to encrypt the backup.")
      .num_args(1)
      .required(true))
    .arg(Arg::new("keep")
      .long("keep")
      .help("keep the generated settings and data directories around after exit (otherwise delete them on exit).")
      .num_args(0)
      .action(ArgAction::SetTrue)
      .required(false))

    .arg(Arg::new("dev_feature_flag")
      .long("dev")
      .help("Enable experimental in-development features.")
      .num_args(0)
      .action(ArgAction::SetTrue)
      .required(false))
}


pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let s3_backup_endpoint = sub_matches.get_one::<String>("s3_backup_endpoint");
  let s3_backup_region = sub_matches.get_one::<String>("s3_backup_region");
  let s3_backup_bucket = sub_matches.get_one::<String>("s3_backup_bucket").unwrap();
  let s3_backup_key = sub_matches.get_one::<String>("s3_backup_key").unwrap();
  let s3_backup_secret = sub_matches.get_one("s3_backup_secret").unwrap();

  let s3_endpoint = sub_matches.get_one::<String>("s3_endpoint");
  let s3_region = sub_matches.get_one::<String>("s3_region");
  let s3_bucket = sub_matches.get_one::<String>("s3_bucket");
  let s3_key = sub_matches.get_one::<String>("s3_key");
  let s3_secret = sub_matches.get_one::<String>("s3_secret");

  let user_id = sub_matches.get_one::<String>("user_id").unwrap();
  let encryption_key = sub_matches.get_one::<String>("encryption_key").unwrap();
  let keep_files = sub_matches.get_flag("keep");
  
  let dev_feature_flag = sub_matches.get_flag("dev_feature_flag");

  info!("fetching list of backup files.");
  let bs = crate::storage::backup::new(s3_backup_region, s3_backup_endpoint, s3_backup_bucket, s3_backup_key, s3_backup_secret)?;
  let mut files = crate::storage::backup::list(bs.clone()).await?;
  info!("found {} backup files for {} users.", files.iter().map(|kv| kv.1.len()).fold(0, |acc, x| acc + x), files.len());
  let timestamps_for_user = match files.get_mut(user_id) {
    Some(r) => {
      if r.len() == 0 {
        error!("no backup files for user {}.", user_id);
        return Ok(())
      }
      r
    },
    None => {
      error!("no backup files for user {}.", user_id);
      return Ok(())
    }
  };
  timestamps_for_user.sort();
  let last_timestamp = *timestamps_for_user.last().unwrap();
  info!("retrieving latest backup file (timestamp {}) for user {}.", last_timestamp, user_id);
  let backup_bytes = crate::storage::backup::get(bs.clone(), &user_id, last_timestamp).await?;
  info!("retrieved {} bytes.", backup_bytes.len());

  let mut infumap_dir = temp_dir();
  infumap_dir.push("infumap_emergency");
  let mut infumap_cache_dir = infumap_dir.clone();
  infumap_cache_dir.push("cache");
  let mut infumap_data_dir = infumap_dir.clone();
  infumap_data_dir.push("data");
  let mut infumap_user_data_dir = infumap_data_dir.clone();
  infumap_user_data_dir.push(format!("user_{}", user_id));
  let mut items_json_path = infumap_user_data_dir.clone();
  items_json_path.push("items.json");
  let mut user_json_path = infumap_user_data_dir.clone();
  user_json_path.push("user.json");

  if std::fs::metadata(&infumap_dir).is_ok() {
    warn!("infumap emergency directory exists, removing.");
    std::fs::remove_dir_all(&infumap_dir)?;
  }
  info!("creating temporary infumap directory: {:?}", infumap_dir);
  std::fs::create_dir_all(&infumap_dir)?;
  std::fs::create_dir(infumap_data_dir.clone())?;
  std::fs::create_dir(infumap_user_data_dir.clone())?;
  std::fs::create_dir(infumap_cache_dir.clone())?;

  info!("unpacking items/user json files from backup file.");
  process_backup(
    &backup_bytes,
    &items_json_path.to_str().ok_or(format!("could not interpret items.json path as str: {:?}", items_json_path))?,
    &user_json_path.to_str().ok_or(format!("could not interpret user.json path as str: {:?}", user_json_path))?,
    &encryption_key,
    &user_id).await?;

  info!("creating cache: {:?}", infumap_cache_dir);
  let num_created = ensure_256_subdirs(&infumap_cache_dir).await?;
  info!("created {} cache subdirectories.", num_created);

  info!("configuring.");
  let mut config_builder = Config::builder();
  config_builder = add_config_defaults(config_builder)?
    .set_override("log_level", "debug").map_err(|_| "failed to override log_level config")?
    .set_override("data_dir", infumap_data_dir.to_str().ok_or("can't interpret data dir pathbuf")?).map_err(|_| "failed to override data_dir config")?
    .set_override("cache_dir", infumap_cache_dir.to_str().ok_or("can't interpret cache dir pathbuf")?).map_err(|_| "failed to override cache_dir config")?
    .set_override("enable_local_object_storage", "false").map_err(|_| "failed to override enable_local_object_storage config")?;
  if s3_region.is_some() || s3_endpoint.is_some() {
    config_builder = config_builder.set_override("enable_s3_1_object_storage", "true").map_err(|_| "failed to override enable_s1_1_object_storage config")?;
  }
  if let Some(s3_region) = s3_region {
    config_builder = config_builder.set_override("s3_1_region", s3_region.clone()).map_err(|_| "failed to override s3_1_region config")?;
  }
  if let Some(s3_endpoint) = s3_endpoint {
    config_builder = config_builder.set_override("s3_1_endpoint", s3_endpoint.clone()).map_err(|_| "failed to override s3_1_endpoint config")?;
  }
  if let Some(s3_bucket) = s3_bucket {
    config_builder = config_builder.set_override("s3_1_bucket", s3_bucket.clone()).map_err(|_| "failed to override s3_1_bucket config")?;
  }
  if let Some(s3_key) = s3_key {
    config_builder = config_builder.set_override("s3_1_key", s3_key.clone()).map_err(|_| "failed to override s3_1_key config")?;
  }
  if let Some(s3_secret) = s3_secret {
    config_builder = config_builder.set_override("s3_1_secret", s3_secret.clone()).map_err(|_| "failed to override s3_1_secret config")?;
  }

  let config = match config_builder.build() {
    Ok(c) => c,
    Err(e) => {
      return Err(format!("an error occurred constructing configuration: '{e}'").into());
    }
  };

  info!("starting webserver on localhost:8000");
  start_server(config, dev_feature_flag).await?;

  if !keep_files {
    info!("removing the infumap emergency directory.");
    std::fs::remove_dir_all(&infumap_dir)?;
  }
  Ok(())
}
