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

use std::collections::{HashSet, HashMap};
use std::sync::{Mutex, Arc};

use clap::{App, Arg, ArgMatches};
use config::Config;

use crate::config::{CONFIG_DATA_DIR, CONFIG_S3_1_REGION, CONFIG_S3_1_ENDPOINT, CONFIG_S3_1_BUCKET, CONFIG_S3_1_KEY, CONFIG_S3_1_SECRET, CONFIG_S3_2_REGION, CONFIG_S3_2_ENDPOINT, CONFIG_S3_2_BUCKET, CONFIG_S3_2_KEY, CONFIG_S3_2_SECRET};
use crate::setup::init_fs_maybe_and_get_config;
use crate::storage::db::Db;
use crate::storage::db::item::is_data_item;
use crate::storage::file as storage_file;
use crate::storage::s3 as storage_s3;
use crate::util::{infu::InfuResult, crypto::encrypt_file_data};


pub fn make_clap_subcommand<'a, 'b>() -> App<'a> {
  App::new("repair")
    .about("Object store validation/repair tool. WORK IN PROGRESS.")
    .arg(Arg::new("settings_path")
      .short('s')
      .long("settings")
      .help(concat!("Path to a toml settings configuration file. If not specified, the default will be assumed."))
      .takes_value(true)
      .multiple_values(false)
      .required(false))
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

async fn list_s3_files(s3_store: Arc<storage_s3::S3Store>) -> InfuResult<HashSet<String>> {
  let mut files_in_s3 = HashSet::new();
  for o in storage_s3::list(s3_store).await? { files_in_s3.insert(format!("{}_{}", o.user_id, o.item_id)); }
  Ok(files_in_s3)
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

async fn list_desired_files(db: &mut Db) -> InfuResult<HashMap<String, (String, String)>> {
  for user_id in db.user.all_user_ids().iter() {
    db.item.load_user_items(user_id, false).await?;
  }

  let mut desired_files = HashMap::new();
  for iu in db.item.all_loaded_items() {
    let item = db.item.get(&iu.item_id)?;
    if !is_data_item(&item.item_type) { continue; }
    desired_files.insert(format!("{}_{}", iu.user_id, iu.item_id), (iu.user_id, iu.item_id));
  }

  Ok(desired_files)
}

async fn list_filesystem_files(db: &Db, file_store: Arc<Mutex<storage_file::FileStore>>) -> InfuResult<HashSet<String>> {
  let mut result = HashSet::new();
  for user_id in &db.user.all_user_ids() {
    let files = storage_file::list(file_store.clone(), user_id).await?;
    for file in &files {
      result.insert(format!("{}_{}", user_id, file));
    }
  }
  Ok(result)
}

pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = init_fs_maybe_and_get_config(sub_matches.value_of("settings_path").map(|a| a.to_string())).await?;
  let mut db = create_db(&config).await?;

  let file_store = storage_file::new(&config.get_string(CONFIG_DATA_DIR)?)?;

  let s3_1_maybe = create_s3_1_data_store_maybe(&config)?.unwrap();
  let _s3_2_maybe = create_s3_2_data_store_maybe(&config)?;

  let files_in_s3 = list_s3_files(s3_1_maybe.clone()).await?;
  let filesystem_files = list_filesystem_files(&db, file_store.clone()).await?;
  let desired_files = list_desired_files(&mut db).await?;

  let mut have_fs = vec![];
  let mut have_not_fs = vec![];
  let mut have = vec![];
  let mut have_not = vec![];
  for desired_file in &desired_files {
    if files_in_s3.contains(desired_file.0) {
      have.push(desired_file);
    } else {
      have_not.push(desired_file);
    }
    if filesystem_files.contains(desired_file.0) {
      have_fs.push(desired_file);
    } else {
      have_not_fs.push(desired_file);
    }
  }

  let mut extra = vec![];
  for have_file in &files_in_s3 {
    if !desired_files.contains_key(have_file) {
      extra.push(have_file);
    }
  }

  let mut extra_fs = vec![];
  for have_file in &filesystem_files {
    if !desired_files.contains_key(have_file) {
      extra_fs.push(have_file);
    }
  }
  
  println!("Desired files in S3: {}", have.len());
  println!("Desired files missing from S3: {}", have_not.len());
  println!("Undesired files in S3: {}", extra.len());

  println!("Desired files in filesystem: {}", have_fs.len());
  println!("Desired files missing from filesystem: {}", have_not_fs.len());
  println!("Undesired files in filesystem: {}", extra_fs.len());

  for df in have_not_fs {
    let item = db.item.get(&df.1.1)?;
    println!("{:?}", item.title);
  }

  for hn in have_not {
    let user_id = &hn.1.0;
    let item_id = &hn.1.1;
    let file = match storage_file::get(file_store.clone(), user_id, item_id).await {
      Ok(file) => file,
      Err(e) => {
        println!("Couldn't get file from filestore: {} {}", e, item_id);
        continue;
      }
    };
    let user = db.user.get(user_id).unwrap();
    let encrypted_data = Arc::new(encrypt_file_data(&user.object_encryption_key, &file, hn.0)?);
    match storage_s3::put(s3_1_maybe.clone(), user_id.clone(), item_id.clone(), encrypted_data).await {
      Ok(_) => {},
      Err(e) => {
        println!("Could not write to s3, continuing {}", e);
        continue;
      }
    };
    println!("put: {}", hn.0);
  }

  Ok(())
}
