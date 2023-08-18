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

use std::collections::HashSet;
use std::sync::Arc;

use clap::{App, Arg, ArgMatches};
use config::Config;

use crate::config::{CONFIG_DATA_DIR, CONFIG_S3_1_REGION, CONFIG_S3_1_ENDPOINT, CONFIG_S3_1_BUCKET, CONFIG_S3_1_KEY, CONFIG_S3_1_SECRET, CONFIG_S3_2_REGION, CONFIG_S3_2_ENDPOINT, CONFIG_S3_2_BUCKET, CONFIG_S3_2_KEY, CONFIG_S3_2_SECRET, CONFIG_ENABLE_LOCAL_OBJECT_STORAGE};
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::storage::db::item::is_data_item_type;
use crate::storage::db::item_db::ItemAndUserId;
use crate::storage::file as storage_file;
use crate::storage::object::IndividualObjectStore;
use crate::storage::s3 as storage_s3;
use crate::util::infu::InfuResult;


enum ObjectStoreName {
  S3_1,
  S3_2,
  Local,
}

impl ObjectStoreName {
  pub fn _as_str(&self) -> &'static str {
    match self {
      ObjectStoreName::S3_1 => "s3_1",
      ObjectStoreName::S3_2 => "s3_2",
      ObjectStoreName::Local => "local",
    }
  }

  pub fn from_str(s: &str) -> InfuResult<ObjectStoreName> {
    match s {
      "s3_1" => Ok(ObjectStoreName::S3_1),
      "s3_2" => Ok(ObjectStoreName::S3_2),
      "local" => Ok(ObjectStoreName::Local),
      other => Err(format!("Invalid Command value: '{}'.", other).into())
    }
  }
}


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("reconcile")
    .about("Check / reconcile the contents of the configured object stores and item database.")
    .subcommand(make_missing_subcommand())
    .subcommand(make_orphaned_subcommand())
}


fn make_missing_subcommand<'a, 'b>() -> App<'a> {
  App::new("missing")
    .arg(Arg::new("settings_path")
      .short('s')
      .long("settings")
      .help(concat!("Path to a toml settings configuration file. If not specified, the default will be assumed."))
      .takes_value(true)
      .multiple_values(false)
      .required(false))
    .arg(Arg::new("a")
      .short('a')
      .long("a")
      .help("The source object store.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("b")
      .short('b')
      .long("b")
      .help("The destination object store.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
    .arg(Arg::new("copy")
      .short('c')
      .long("copy")
      .help("If specified, missing items will be copied to the destination, else they will just be listed.")
      .takes_value(false)
      .multiple_values(false)
      .required(true)) // TODO: with other commands implemented, this will be false.
}


fn make_orphaned_subcommand<'a, 'b>() -> App<'a> {
  App::new("orphaned")
    .arg(Arg::new("settings_path")
      .short('s')
      .long("settings")
      .help(concat!("Path to a toml settings configuration file. If not specified, the default will be assumed."))
      .takes_value(true)
      .multiple_values(false)
      .required(false))
    .arg(Arg::new("o")
      .short('o')
      .long("o")
      .help("The object store to check for orphaned files.")
      .takes_value(true)
      .multiple_values(false)
      .required(true))
}

pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(sub_matches.value_of("settings_path").map(|a| a.to_string())).await?;

  match sub_matches.subcommand() {
    Some(("missing", arg_sub_matches)) => {
      execute_missing(arg_sub_matches, &config).await
    },
    Some(("orphaned", arg_sub_matches)) => {
      execute_orphaned(arg_sub_matches, &config).await
    },
    _ => return Err("Sub command was not specified.".into())
  }
}


pub async fn execute_missing<'a>(sub_matches: &ArgMatches, config: &Config) -> InfuResult<()> {

  let copying = sub_matches.is_present("copy");

  let a = match sub_matches.value_of("a") {
    Some(a) => match ObjectStoreName::from_str(a) {
      Ok(v) => v,
      Err(_e) => return Err(format!("Unknown source object store name '{}'.", a).into())
    },
    None => return Err("Source object store ('a') was not specified.".into())
  };

  let b = match sub_matches.value_of("b") {
    Some(b) => match ObjectStoreName::from_str(b) {
      Ok(v) => v,
      Err(_e) => return Err(format!("Unknown destination object store name '{}'.", b).into())
    },
    None => return Err("Destination object store ('b') was not specified.".into())
  };

  let s3_1_maybe = create_s3_1_data_store_maybe(&config)?;
  let s3_2_maybe = create_s3_2_data_store_maybe(&config)?;
  let local_maybe = if config.get_bool(CONFIG_ENABLE_LOCAL_OBJECT_STORAGE)? {
    Some(storage_file::new(&config.get_string(CONFIG_DATA_DIR)?)?)
  } else {
    None
  };

  let source_store = match a {
    ObjectStoreName::S3_1 => {
      match &s3_1_maybe {
        Some(s) => s as &dyn IndividualObjectStore,
        None => return Err("S3_1 data store is not configured/enabled.".into())
      }
    },
    ObjectStoreName::S3_2 => {
      match &s3_2_maybe {
        Some(s) => s as &dyn IndividualObjectStore,
        None => return Err("S3_2 data store is not configured/enabled.".into())
      }
    },
    ObjectStoreName::Local => {
      match &local_maybe {
        Some(s) => s as &dyn IndividualObjectStore,
        None => return Err("Local data store is not enabled.".into())
      }
    }
  };

  let destination_store = match b {
    ObjectStoreName::S3_1 => {
      match &s3_1_maybe {
        Some(s) => s as &dyn IndividualObjectStore,
        None => return Err("S3_1 data store is not configured/enabled.".into())
      }
    },
    ObjectStoreName::S3_2 => {
      match &s3_2_maybe {
        Some(s) => s as &dyn IndividualObjectStore,
        None => return Err("S3_2 data store is not configured/enabled.".into())
      }
    },
    ObjectStoreName::Local => {
      match &local_maybe {
        Some(s) => s as &dyn IndividualObjectStore,
        None => return Err("Local data store is not enabled.".into())
      }
    }
  };

  println!("Retrieving source file list...");
  let source_files = source_store.list().await?;
  println!("Number of source files: {}.", source_files.len());
  println!("Retrieving destination file list...");
  let destination_files = HashSet::<ItemAndUserId>::from_iter(
    destination_store.list().await?.iter().cloned());
  println!("Number of destination files: {}.", destination_files.len());

  let mut missing_cnt = 0;
  for s_file in &source_files {
    if !destination_files.contains(&s_file) {
      missing_cnt += 1;
    }
  }
  println!("Number of source files missing in destination: {}.\n", missing_cnt);

  let mut cnt = 0;
  for s_file in &source_files {
    if !destination_files.contains(&s_file) {
      cnt += 1;
      if copying {
        println!("Copying {}/{}: {}_{}", cnt, missing_cnt, s_file.user_id, s_file.item_id);
        let val = Arc::new(source_store.get(s_file.user_id.clone(), s_file.item_id.clone()).await?);
        destination_store.put(s_file.user_id.clone(), s_file.item_id.clone(), val).await?;
      } else {
        println!("{}_{}", s_file.user_id, s_file.item_id);
      }
    }
  }

  Ok(())
}


pub async fn execute_orphaned<'a>(sub_matches: &ArgMatches, config: &Config) -> InfuResult<()> {
  if sub_matches.is_present("copy") {
    return Err("--copy flag is not valid for use with the \"orphaned\" command".into());
  }
  
  let o = match sub_matches.value_of("o") {
    Some(a) => match ObjectStoreName::from_str(a) {
      Ok(v) => v,
      Err(_e) => return Err(format!("Unknown object store name '{}'.", a).into())
    },
    None => return Err("Object store ('o') was not specified.".into())
  };

  let s3_1_maybe = create_s3_1_data_store_maybe(&config)?;
  let s3_2_maybe = create_s3_2_data_store_maybe(&config)?;
  let local_maybe = if config.get_bool(CONFIG_ENABLE_LOCAL_OBJECT_STORAGE)? {
    Some(storage_file::new(&config.get_string(CONFIG_DATA_DIR)?)?)
  } else {
    None
  };

  let source_store = match o {
    ObjectStoreName::S3_1 => {
      match &s3_1_maybe {
        Some(s) => s as &dyn IndividualObjectStore,
        None => return Err("S3_1 data store is not configured/enabled.".into())
      }
    },
    ObjectStoreName::S3_2 => {
      match &s3_2_maybe {
        Some(s) => s as &dyn IndividualObjectStore,
        None => return Err("S3_2 data store is not configured/enabled.".into())
      }
    },
    ObjectStoreName::Local => {
      match &local_maybe {
        Some(s) => s as &dyn IndividualObjectStore,
        None => return Err("Local data store is not enabled.".into())
      }
    }
  };

  let mut db = create_db(config).await?;

  println!("Retrieving db file list...");
  let db_files = HashSet::<ItemAndUserId>::from_iter(
    list_all_db_files(&mut db).await?.iter().cloned());
  println!("Retrieving source file list...");
  let source_files = source_store.list().await?;

  println!("Orphaned files:");
  let mut cnt = 0;
  for s_file in &source_files {
    if !db_files.contains(s_file) {
      cnt += 1;
      println!("{}_{}", s_file.user_id, s_file.item_id);
    }
  }
  println!("Number of orphaned files: {}.", cnt);

  Ok(())
}


fn create_s3_1_data_store_maybe(config: &Config) -> InfuResult<Option<Arc<storage_s3::S3Store>>> {
  let s3_1_region = config.get_string(CONFIG_S3_1_REGION).ok();
  let s3_1_endpoint = config.get_string(CONFIG_S3_1_ENDPOINT).ok();
  let s3_1_bucket = config.get_string(CONFIG_S3_1_BUCKET).ok();
  let s3_1_key = config.get_string(CONFIG_S3_1_KEY).ok();
  let s3_1_secret = config.get_string(CONFIG_S3_1_SECRET).ok();
  if s3_1_key.is_none() { return Ok(None); }
  Ok(Some(storage_s3::new(&s3_1_region, &s3_1_endpoint, &s3_1_bucket.unwrap(), &s3_1_key.unwrap(), &s3_1_secret.unwrap())?))
}


fn create_s3_2_data_store_maybe(config: &Config) -> InfuResult<Option<Arc<storage_s3::S3Store>>> {
  let s3_2_region = config.get_string(CONFIG_S3_2_REGION).ok();
  let s3_2_endpoint = config.get_string(CONFIG_S3_2_ENDPOINT).ok();
  let s3_2_bucket = config.get_string(CONFIG_S3_2_BUCKET).ok();
  let s3_2_key = config.get_string(CONFIG_S3_2_KEY).ok();
  let s3_2_secret = config.get_string(CONFIG_S3_2_SECRET).ok();
  if s3_2_key.is_none() { return Ok(None); }
  Ok(Some(storage_s3::new(&s3_2_region, &s3_2_endpoint, &s3_2_bucket.unwrap(), &s3_2_key.unwrap(), &s3_2_secret.unwrap())?))
}


async fn create_db(config: &Config) -> InfuResult<Db> {
  let data_dir = config.get_string(CONFIG_DATA_DIR)?;
  let db =
    match Db::new(&data_dir).await {
      Ok(db) => db,
      Err(e) => {
        return Err(format!("Failed to initialize database: {}", e).into());
      }
    };
  Ok(db)
}


async fn list_all_db_files(db: &mut Db) -> InfuResult<Vec<ItemAndUserId>> {
  for user_id in db.user.all_user_ids().iter() {
    db.item.load_user_items(user_id, false).await?;
  }

  let mut files = vec![];
  for iu in db.item.all_loaded_items() {
    let item = db.item.get(&iu.item_id)?;
    if !is_data_item_type(item.item_type) { continue; }
    files.push(ItemAndUserId { user_id: iu.user_id, item_id: iu.item_id });
  }

  Ok(files)
}
