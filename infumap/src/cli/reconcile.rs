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

use clap::{Arg, ArgAction, ArgMatches, Command};
use config::Config;
use futures_util::{StreamExt, stream};
use infusdk::item::is_data_item_type;
use infusdk::util::infu::InfuResult;

use crate::config::{
  CONFIG_DATA_DIR, CONFIG_ENABLE_LOCAL_OBJECT_STORAGE, CONFIG_S3_1_BUCKET, CONFIG_S3_1_ENDPOINT, CONFIG_S3_1_KEY,
  CONFIG_S3_1_REGION, CONFIG_S3_1_SECRET, CONFIG_S3_2_BUCKET, CONFIG_S3_2_ENDPOINT, CONFIG_S3_2_KEY,
  CONFIG_S3_2_REGION, CONFIG_S3_2_SECRET,
};
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::storage::db::item_db::ItemAndUserId;
use crate::storage::file as storage_file;
use crate::storage::object::IndividualObjectStore;
use crate::storage::s3 as storage_s3;

/// Stop rather than work through every remaining file if, for example, the credentials or the network have failed.
const MAX_CONSECUTIVE_COPY_FAILURES: usize = 20;

enum ObjectStoreName {
  S3_1,
  S3_2,
  Local,
}

impl ObjectStoreName {
  pub fn as_str(&self) -> &'static str {
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
      other => Err(format!("Invalid Command value: '{}'.", other).into()),
    }
  }
}

pub fn make_clap_subcommand() -> Command {
  Command::new("reconcile")
    .about("Check / reconcile the contents of the configured object stores and item database.")
    .subcommand(make_missing_subcommand())
    .subcommand(make_orphaned_subcommand())
}

fn settings_path_from_matches<'a>(sub_matches: &'a ArgMatches) -> Option<&'a String> {
  sub_matches.try_get_one::<String>("settings_path").ok().flatten().or_else(|| {
    sub_matches
      .subcommand()
      .and_then(|(_, child_matches)| child_matches.try_get_one::<String>("settings_path").ok().flatten())
  })
}

fn make_missing_subcommand() -> Command {
  Command::new("missing")
    .arg(
      Arg::new("settings_path")
        .short('s')
        .long("settings")
        .help(concat!("Path to a toml settings configuration file. If not specified, the default will be assumed."))
        .num_args(1)
        .required(false),
    )
    .arg(Arg::new("a").short('a').long("a").help("The source object store.").num_args(1).required(true))
    .arg(Arg::new("b").short('b').long("b").help("The destination object store.").num_args(1).required(true))
    .arg(
      Arg::new("copy")
        .short('c')
        .long("copy")
        .help("If specified, missing items will be copied to the destination, else they will just be listed.")
        .num_args(0)
        .action(ArgAction::SetTrue)
        .required(false),
    )
    .arg(
      Arg::new("concurrency")
        .long("concurrency")
        .help("With --copy, the number of files to copy at the same time. Must be 1 if the destination is local.")
        .num_args(1)
        .value_parser(clap::value_parser!(u16).range(1..))
        .default_value("1")
        .requires("copy"),
    )
}

fn make_orphaned_subcommand() -> Command {
  Command::new("orphaned")
    .arg(
      Arg::new("settings_path")
        .short('s')
        .long("settings")
        .help(concat!("Path to a toml settings configuration file. If not specified, the default will be assumed."))
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("o")
        .short('o')
        .long("o")
        .help("The object store to check for orphaned files.")
        .num_args(1)
        .required(true),
    )
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(settings_path_from_matches(sub_matches)).await?;

  match sub_matches.subcommand() {
    Some(("missing", arg_sub_matches)) => execute_missing(arg_sub_matches, &config).await,
    Some(("orphaned", arg_sub_matches)) => execute_orphaned(arg_sub_matches, &config).await,
    _ => return Err("Sub command was not recognized or specified.".into()),
  }
}

pub async fn execute_missing(sub_matches: &ArgMatches, config: &Config) -> InfuResult<()> {
  let copying = sub_matches.get_flag("copy");
  let concurrency = *sub_matches.get_one::<u16>("concurrency").unwrap() as usize;

  let a = match sub_matches.get_one::<String>("a") {
    Some(a) => match ObjectStoreName::from_str(a) {
      Ok(v) => v,
      Err(_e) => return Err(format!("Unknown source object store name '{}'.", a).into()),
    },
    None => return Err("Source object store ('a') was not specified.".into()),
  };

  let b = match sub_matches.get_one::<String>("b") {
    Some(b) => match ObjectStoreName::from_str(b) {
      Ok(v) => v,
      Err(_e) => return Err(format!("Unknown destination object store name '{}'.", b).into()),
    },
    None => return Err("Destination object store ('b') was not specified.".into()),
  };

  let s3_1_maybe = create_s3_1_data_store_maybe(&config)?;
  let s3_2_maybe = create_s3_2_data_store_maybe(&config)?;
  let local_maybe = if config.get_bool(CONFIG_ENABLE_LOCAL_OBJECT_STORAGE).map_err(|e| e.to_string())? {
    Some(storage_file::new(&config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?)?)
  } else {
    None
  };

  let source_store = match a {
    ObjectStoreName::S3_1 => match &s3_1_maybe {
      Some(s) => s as &dyn IndividualObjectStore,
      None => return Err("S3_1 data store is not configured/enabled.".into()),
    },
    ObjectStoreName::S3_2 => match &s3_2_maybe {
      Some(s) => s as &dyn IndividualObjectStore,
      None => return Err("S3_2 data store is not configured/enabled.".into()),
    },
    ObjectStoreName::Local => match &local_maybe {
      Some(s) => s as &dyn IndividualObjectStore,
      None => return Err("Local data store is not enabled.".into()),
    },
  };

  let destination_store = match b {
    ObjectStoreName::S3_1 => match &s3_1_maybe {
      Some(s) => s as &dyn IndividualObjectStore,
      None => return Err("S3_1 data store is not configured/enabled.".into()),
    },
    ObjectStoreName::S3_2 => match &s3_2_maybe {
      Some(s) => s as &dyn IndividualObjectStore,
      None => return Err("S3_2 data store is not configured/enabled.".into()),
    },
    ObjectStoreName::Local => match &local_maybe {
      Some(s) => s as &dyn IndividualObjectStore,
      None => return Err("Local data store is not enabled.".into()),
    },
  };

  // Local writes are not atomic, so stopping a run part way can leave a partial file that the next run treats as
  // present. That is manageable with one file in flight (delete the newest), but not with many.
  if concurrency > 1 && matches!(b, ObjectStoreName::Local) {
    return Err("--concurrency must be 1 if the destination is local.".into());
  }

  println!("Source (-a):      {}", describe_store(&a, config));
  println!("Destination (-b): {}", describe_store(&b, config));
  if copying {
    println!("Mode:             copy missing files to {}, {} at a time\n", b.as_str(), concurrency);
  } else {
    println!("Mode:             list only (pass --copy to copy)\n");
  }

  println!("Retrieving {} file list...", a.as_str());
  let source_files = source_store.list().await?;
  println!("Number of files in {}: {}.", a.as_str(), source_files.len());
  println!("Retrieving {} file list...", b.as_str());
  let destination_files = HashSet::<ItemAndUserId>::from_iter(destination_store.list().await?.iter().cloned());
  println!("Number of files in {}: {}.", b.as_str(), destination_files.len());

  let missing_files = source_files.iter().filter(|f| !destination_files.contains(*f)).collect::<Vec<_>>();
  println!("Number of files in {} that are missing from {}: {}.\n", a.as_str(), b.as_str(), missing_files.len());

  if copying {
    return copy_files(source_store, destination_store, &missing_files, concurrency).await;
  }
  for s_file in &missing_files {
    println!("{}_{}", s_file.user_id, s_file.item_id);
  }

  Ok(())
}

/// Copy the files, carrying on past a failure so that one bad file does not hold up the rest of a long run.
async fn copy_files(
  source_store: &dyn IndividualObjectStore,
  destination_store: &dyn IndividualObjectStore,
  files: &[&ItemAndUserId],
  concurrency: usize,
) -> InfuResult<()> {
  let mut results = stream::iter(files.iter().copied())
    .map(|file| async move { (file, copy_file(source_store, destination_store, file).await) })
    .buffer_unordered(concurrency);

  let mut copied_cnt = 0;
  let mut consecutive_failures = 0;
  let mut failures = vec![];
  let mut stopped_early = false;
  while let Some((file, result)) = results.next().await {
    let done_cnt = copied_cnt + failures.len() + 1;
    match result {
      Ok(num_bytes) => {
        copied_cnt += 1;
        consecutive_failures = 0;
        println!("Copied {}/{}: {}_{} [{} bytes]", done_cnt, files.len(), file.user_id, file.item_id, num_bytes);
      }
      Err(e) => {
        consecutive_failures += 1;
        let failure = format!("{}_{}: {}", file.user_id, file.item_id, e);
        println!("FAILED {}/{}: {}", done_cnt, files.len(), failure);
        failures.push(failure);
        if consecutive_failures >= MAX_CONSECUTIVE_COPY_FAILURES {
          stopped_early = true;
          break;
        }
      }
    }
  }

  println!("\nCopied: {}. Failed: {}. Total to copy: {}.", copied_cnt, failures.len(), files.len());
  if failures.is_empty() {
    return Ok(());
  }
  println!("Failures:");
  for failure in &failures {
    println!("  {}", failure);
  }
  if stopped_early {
    return Err(
      format!(
        "Stopped after {} failures in a row, which suggests a problem that is not specific to a file.",
        MAX_CONSECUTIVE_COPY_FAILURES
      )
      .into(),
    );
  }
  Err(format!("{} file(s) could not be copied (listed above). Run this again to retry them.", failures.len()).into())
}

async fn copy_file(
  source_store: &dyn IndividualObjectStore,
  destination_store: &dyn IndividualObjectStore,
  file: &ItemAndUserId,
) -> InfuResult<usize> {
  let val = source_store.get(file.user_id.clone(), file.item_id.clone()).await?;
  let num_bytes = val.len();
  destination_store.put(file.user_id.clone(), file.item_id.clone(), Arc::new(val)).await?;
  Ok(num_bytes)
}

pub async fn execute_orphaned(sub_matches: &ArgMatches, config: &Config) -> InfuResult<()> {
  let o = match sub_matches.get_one::<String>("o") {
    Some(a) => match ObjectStoreName::from_str(a) {
      Ok(v) => v,
      Err(_e) => return Err(format!("Unknown object store name '{}'.", a).into()),
    },
    None => return Err("Object store ('o') was not specified.".into()),
  };

  let s3_1_maybe = create_s3_1_data_store_maybe(&config)?;
  let s3_2_maybe = create_s3_2_data_store_maybe(&config)?;
  let local_maybe = if config.get_bool(CONFIG_ENABLE_LOCAL_OBJECT_STORAGE).map_err(|e| e.to_string())? {
    Some(storage_file::new(&config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?)?)
  } else {
    None
  };

  let source_store = match o {
    ObjectStoreName::S3_1 => match &s3_1_maybe {
      Some(s) => s as &dyn IndividualObjectStore,
      None => return Err("S3_1 data store is not configured/enabled.".into()),
    },
    ObjectStoreName::S3_2 => match &s3_2_maybe {
      Some(s) => s as &dyn IndividualObjectStore,
      None => return Err("S3_2 data store is not configured/enabled.".into()),
    },
    ObjectStoreName::Local => match &local_maybe {
      Some(s) => s as &dyn IndividualObjectStore,
      None => return Err("Local data store is not enabled.".into()),
    },
  };

  println!("Object store (-o): {}\n", describe_store(&o, config));

  let mut db = create_db(config).await?;

  println!("Retrieving db file list...");
  let db_files = HashSet::<ItemAndUserId>::from_iter(list_all_db_files(&mut db).await?.iter().cloned());
  println!("Retrieving {} file list...", o.as_str());
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

/// Where a store's files live, from the settings, so the user can confirm which buckets a command is reading and writing.
fn describe_store(store: &ObjectStoreName, config: &Config) -> String {
  let (bucket_key, endpoint_key, region_key) = match store {
    ObjectStoreName::S3_1 => (CONFIG_S3_1_BUCKET, CONFIG_S3_1_ENDPOINT, CONFIG_S3_1_REGION),
    ObjectStoreName::S3_2 => (CONFIG_S3_2_BUCKET, CONFIG_S3_2_ENDPOINT, CONFIG_S3_2_REGION),
    ObjectStoreName::Local => {
      let data_dir = config.get_string(CONFIG_DATA_DIR).unwrap_or_else(|_| "?".to_owned());
      return format!("local: data dir '{}'", data_dir);
    }
  };
  let bucket = config.get_string(bucket_key).unwrap_or_else(|_| "?".to_owned());
  let location = match (config.get_string(endpoint_key).ok(), config.get_string(region_key).ok()) {
    (Some(endpoint), _) => format!(" at {}", endpoint),
    (None, Some(region)) => format!(" in region {}", region),
    (None, None) => String::new(),
  };
  format!("{}: bucket '{}'{}", store.as_str(), bucket, location)
}

fn create_s3_1_data_store_maybe(config: &Config) -> InfuResult<Option<Arc<storage_s3::S3Store>>> {
  let s3_1_region = config.get_string(CONFIG_S3_1_REGION).ok();
  let s3_1_endpoint = config.get_string(CONFIG_S3_1_ENDPOINT).ok();
  let s3_1_bucket = config.get_string(CONFIG_S3_1_BUCKET).ok();
  let s3_1_key = config.get_string(CONFIG_S3_1_KEY).ok();
  let s3_1_secret = config.get_string(CONFIG_S3_1_SECRET).ok();
  if s3_1_key.is_none() {
    return Ok(None);
  }
  Ok(Some(storage_s3::new(
    s3_1_region.as_ref(),
    s3_1_endpoint.as_ref(),
    &s3_1_bucket.unwrap(),
    &s3_1_key.unwrap(),
    &s3_1_secret.unwrap(),
  )?))
}

fn create_s3_2_data_store_maybe(config: &Config) -> InfuResult<Option<Arc<storage_s3::S3Store>>> {
  let s3_2_region = config.get_string(CONFIG_S3_2_REGION).ok();
  let s3_2_endpoint = config.get_string(CONFIG_S3_2_ENDPOINT).ok();
  let s3_2_bucket = config.get_string(CONFIG_S3_2_BUCKET).ok();
  let s3_2_key = config.get_string(CONFIG_S3_2_KEY).ok();
  let s3_2_secret = config.get_string(CONFIG_S3_2_SECRET).ok();
  if s3_2_key.is_none() {
    return Ok(None);
  }
  Ok(Some(storage_s3::new(
    s3_2_region.as_ref(),
    s3_2_endpoint.as_ref(),
    &s3_2_bucket.unwrap(),
    &s3_2_key.unwrap(),
    &s3_2_secret.unwrap(),
  )?))
}

async fn create_db(config: &Config) -> InfuResult<Db> {
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let db = match Db::new(&data_dir).await {
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
    if !is_data_item_type(item.item_type) {
      continue;
    }
    files.push(ItemAndUserId { user_id: iu.user_id, item_id: iu.item_id });
  }

  Ok(files)
}

#[cfg(test)]
mod tests {
  use std::sync::Mutex;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::time::Duration;

  use async_trait::async_trait;
  use infusdk::util::uid::Uid;

  use super::*;

  #[derive(Default)]
  struct FakeStore {
    stored: Mutex<HashSet<Uid>>,
    failing_item_ids: HashSet<Uid>,
    put_attempts: AtomicUsize,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
  }

  #[async_trait]
  impl IndividualObjectStore for FakeStore {
    async fn get(&self, _user_id: Uid, _item_id: Uid) -> InfuResult<Vec<u8>> {
      Ok(vec![0; 3])
    }

    async fn put(&self, _user_id: Uid, item_id: Uid, _val: Arc<Vec<u8>>) -> InfuResult<()> {
      self.put_attempts.fetch_add(1, Ordering::SeqCst);
      let in_flight = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
      self.max_in_flight.fetch_max(in_flight, Ordering::SeqCst);
      tokio::time::sleep(Duration::from_millis(5)).await;
      self.in_flight.fetch_sub(1, Ordering::SeqCst);
      if self.failing_item_ids.contains(&item_id) {
        return Err("put failed".into());
      }
      self.stored.lock().unwrap().insert(item_id);
      Ok(())
    }

    async fn list(&self) -> InfuResult<Vec<ItemAndUserId>> {
      Ok(vec![])
    }
  }

  fn files(count: usize) -> Vec<ItemAndUserId> {
    (0..count).map(|n| ItemAndUserId { user_id: "user".to_owned(), item_id: format!("item{}", n) }).collect()
  }

  #[tokio::test]
  async fn copies_every_file_without_exceeding_the_concurrency() {
    let (source, destination) = (FakeStore::default(), FakeStore::default());
    let files = files(50);

    copy_files(&source, &destination, &files.iter().collect::<Vec<_>>(), 8).await.unwrap();

    assert_eq!(destination.stored.lock().unwrap().len(), 50);
    assert_eq!(destination.max_in_flight.load(Ordering::SeqCst), 8);
  }

  #[tokio::test]
  async fn carries_on_past_a_failed_file_and_reports_it() {
    let source = FakeStore::default();
    let destination = FakeStore { failing_item_ids: HashSet::from(["item3".to_owned()]), ..FakeStore::default() };
    let files = files(10);

    let result = copy_files(&source, &destination, &files.iter().collect::<Vec<_>>(), 1).await;

    assert!(result.is_err());
    assert_eq!(destination.stored.lock().unwrap().len(), 9);
  }

  #[tokio::test]
  async fn stops_when_every_file_is_failing() {
    let source = FakeStore::default();
    let files = files(500);
    let destination =
      FakeStore { failing_item_ids: files.iter().map(|f| f.item_id.clone()).collect(), ..FakeStore::default() };

    let result = copy_files(&source, &destination, &files.iter().collect::<Vec<_>>(), 4).await;

    assert!(result.unwrap_err().to_string().contains("in a row"));
    assert!(destination.put_attempts.load(Ordering::SeqCst) < MAX_CONSECUTIVE_COPY_FAILURES + 8);
  }
}
