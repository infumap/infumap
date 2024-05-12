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

use clap::{App, Arg, ArgMatches};
use config::Config;
use infusdk::util::infu::InfuResult;
use log::{error, info, warn};

use crate::{cli::restore::process_backup, setup::add_config_defaults, util::fs::ensure_256_subdirs, web::start_server};


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("emergency")
    .about("Automates pulling the latest backup file for a specific infumap user and bringing up a temporary local infumap instance based on this.")
    .arg(Arg::new("s3_endpoint")
      .short('e')
      .long("s3-endpoint")
      .help(".")
      .takes_value(true)
      .multiple_values(false)
      .required(false))
    .arg(Arg::new("s3_region")
      .short('r')
      .long("s3-region")
      .help(".")
      .takes_value(true)
      .multiple_values(false)
      .required(false))
    .arg(Arg::new("s3_bucket")
      .short('b')
      .long("s3-bucket")
      .help(".")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("s3_key")
      .long("s3-key")
      .help("Your s3 key.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("s3_secret")
      .long("s3-secret")
      .help("Your s3 secret.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("user_id")
    .short('u')
      .long("user-id")
      .help("The infumap user id.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("encryption_key")
      .short('k')
      .long("encryption-key")
      .help("The 32 byte hex encoded encryption key (64 chars) that was used to encrypt the backup.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("keep")
      .long("keep")
      .help("keep the generated settings and data directories around after exit (otherwise delete them on exit).")
      .takes_value(false)
      .multiple_values(false)
      .required(false))
}


pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let s3_endpoint = sub_matches.value_of("s3_endpoint").map(|a| a.to_string());
  let s3_region = sub_matches.value_of("s3_region").map(|a| a.to_string());
  let s3_bucket = match sub_matches.value_of("s3_bucket").map(|a| a.to_string()) {
    Some(p) => p,
    None => { return Err("s3 bucket name must be specified.".into()); }
  };
  let s3_key = match sub_matches.value_of("s3_key").map(|a| a.to_string()) {
    Some(p) => p,
    None => { return Err("s3 key must be specified.".into()); }
  };
  let s3_secret = match sub_matches.value_of("s3_secret").map(|a| a.to_string()) {
    Some(p) => p,
    None => { return Err("s3 secret must be specified.".into()); }
  };
  let user_id = match sub_matches.value_of("user_id").map(|a| a.to_string()) {
    Some(p) => p,
    None => { return Err("infumap user_id must be specified.".into()); }
  };
  let encryption_key = match sub_matches.value_of("encryption_key").map(|a| a.to_string()) {
    Some(p) => p,
    None => { return Err("encryption key must be specified.".into()); }
  };
  let keep_files = sub_matches.is_present("keep");
  
  info!("fetching list of backup files.");
  let bs = crate::storage::backup::new(s3_region, s3_endpoint, s3_bucket, s3_key, s3_secret)?;
  let mut files = crate::storage::backup::list(bs.clone()).await?;
  info!("found {} backup files for {} users.", files.iter().map(|kv| kv.1.len()).fold(0, |acc, x| acc + x), files.len());
  let timestamps_for_user = match files.get_mut(&user_id) {
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
  info!("retrived {} bytes.", backup_bytes.len());

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
    .set_override("log_level", "debug").unwrap()
    .set_override("data_dir", infumap_data_dir.to_str().unwrap()).unwrap()
    .set_override("cache_dir", infumap_cache_dir.to_str().unwrap()).unwrap();
  let config = match config_builder.build() {
    Ok(c) => c,
    Err(e) => {
      return Err(format!("An error occurred constructing configuration: '{e}'").into());
    }
  };

  // #enable_s3_1_object_storage = false
// #s3_1_region =
// #s3_1_endpoint =
// #s3_1_bucket =
// #s3_1_key =
// #s3_1_secret =

  info!("starting webserver on localhost:8000");
  start_server(config).await?;

  if !keep_files {
    info!("removing the infumap emergency directory.");
    std::fs::remove_dir_all(&infumap_dir)?;
  }
  Ok(())
}
