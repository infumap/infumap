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

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use clap::{Arg, ArgAction, ArgMatches, Command};
use config::Config;
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::info;
use serde::Deserialize;
use tokio::fs;
use tokio::sync::Mutex;

use crate::ai::artifact_paths::item_text_artifact_paths;
use crate::ai::batch_processing::{
  BatchScope, collect_image_item_ids_in_container, collect_pdf_item_ids_in_container, is_extractable_pdf_item,
  process_image_tagging_batch, process_pdf_extraction_batch,
};
use crate::ai::image_tagging::{
  delete_item_image_tag_dir, image_tagging_url_from_config, is_supported_image_tagging_mime_type, list_failed_images,
  mark_item_image_tagging_failed, should_tag_image_item, tag_single_item_no_retry,
};
use crate::ai::text_extraction::{
  delete_item_text_dir, extract_single_item_no_retry, list_failed_pdfs, mark_item_text_extraction_failed,
  text_extraction_url_from_config,
};
use crate::config::{
  CONFIG_DATA_DIR, CONFIG_ENABLE_LOCAL_OBJECT_STORAGE, CONFIG_ENABLE_S3_1_OBJECT_STORAGE,
  CONFIG_ENABLE_S3_2_OBJECT_STORAGE, CONFIG_S3_1_BUCKET, CONFIG_S3_1_ENDPOINT, CONFIG_S3_1_KEY, CONFIG_S3_1_REGION,
  CONFIG_S3_1_SECRET, CONFIG_S3_2_BUCKET, CONFIG_S3_2_ENDPOINT, CONFIG_S3_2_KEY, CONFIG_S3_2_REGION,
  CONFIG_S3_2_SECRET,
};
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::storage::object::{self as storage_object};
use crate::util::fs::{expand_tilde, path_exists};

const PDF_SOURCE_MIME_TYPE: &str = "application/pdf";

pub fn make_clap_subcommand() -> Command {
  Command::new("extract")
    .about("Run PDF text extraction or image tagging without starting the web server.")
    .subcommand_required(true)
    .arg_required_else_help(true)
    .subcommand(make_pdf_subcommand())
    .subcommand(make_image_subcommand())
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  match sub_matches.subcommand() {
    Some(("pdf", sub_matches)) => execute_pdf(sub_matches).await,
    Some(("image", sub_matches)) => execute_image(sub_matches).await,
    _ => Err("Missing extract subcommand. Use 'extract pdf' or 'extract image'.".into()),
  }
}

fn make_pdf_subcommand() -> Command {
  Command::new("pdf")
    .about("Run PDF text extraction without starting the web server.")
    .arg(settings_arg())
    .arg(
      Arg::new("service_url")
        .long("service-url")
        .help("Text extraction service endpoint URL, for example http://127.0.0.1:8787/pdf-extract. Overrides the configured text extraction URL, if present.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("item_id")
        .long("item-id")
        .help("Extract text only for this item (must be a PDF). Existing extraction artifacts are overwritten. Exits after one extraction.")
        .num_args(1)
        .conflicts_with_all(["container_id", "mark_failed_item_id", "delete_all"])
        .required(false),
    )
    .arg(
      Arg::new("container_id")
        .long("container-id")
        .help("Extract text only for PDFs within this container subtree (recursive). By default, items with existing extraction artifacts are skipped; use --overwrite to reprocess them. Exits after the finite batch completes.")
        .num_args(1)
        .conflicts_with_all(["mark_failed_item_id", "delete_all"])
        .required(false),
    )
    .arg(
      Arg::new("overwrite")
        .long("overwrite")
        .help("When used with --container-id, reprocess items even if extraction artifacts already exist. --item-id always overwrites.")
        .num_args(0)
        .requires("container_id")
        .conflicts_with_all(["list_failed", "delete_all"])
        .required(false),
    )
    .arg(
      Arg::new("delay_secs")
        .long("delay-secs")
        .help("Sleep for this many seconds after each text extraction request in this process.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("list_failed")
        .long("list-failed")
        .help("List all PDFs for which text extraction failed. Exits after listing.")
        .num_args(0)
        .conflicts_with_all(["mark_failed_item_id", "delete_all"])
        .required(false),
    )
    .arg(
      Arg::new("mark_failed_item_id")
        .long("mark-failed-item-id")
        .help("Write a failed text-extraction manifest for this PDF and exit without contacting the extraction service. Repeat to mark multiple items.")
        .num_args(1)
        .action(ArgAction::Append)
        .conflicts_with("delete_all")
        .required(false),
    )
    .arg(
      Arg::new("mark_failed_reason")
        .long("mark-failed-reason")
        .help("Optional reason stored in failed manifests written via --mark-failed-item-id.")
        .num_args(1)
        .requires("mark_failed_item_id")
        .required(false),
    )
    .arg(
      Arg::new("delete_all")
        .long("delete-all")
        .help("Delete all derived PDF text-extraction results while leaving image-tagging results untouched.")
        .num_args(0)
        .conflicts_with_all(["service_url", "delay_secs"])
        .required(false),
    )
    .arg(
      Arg::new("force")
        .long("force")
        .help("Perform the deletion requested by --delete-all.")
        .num_args(0)
        .requires("delete_all")
        .conflicts_with("dry_run")
        .required(false),
    )
    .arg(
      Arg::new("dry_run")
        .long("dry-run")
        .help("Show what --delete-all would remove without deleting anything.")
        .num_args(0)
        .requires("delete_all")
        .conflicts_with("force")
        .required(false),
    )
}

fn make_image_subcommand() -> Command {
  Command::new("image")
    .about("Run image tagging without starting the web server.")
    .arg(settings_arg())
    .arg(
      Arg::new("service_url")
        .long("service-url")
        .help("Image tagging service endpoint URL, for example http://127.0.0.1:8787/image-extract. Overrides the configured image tagging URL, if present.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("item_id")
        .long("item-id")
        .help("Tag only this item (must be a supported image). Existing image-tag artifacts are overwritten. Exits after one image.")
        .num_args(1)
        .conflicts_with_all(["container_id", "mark_failed_item_id", "delete_all"])
        .required(false),
    )
    .arg(
      Arg::new("container_id")
        .long("container-id")
        .help("Tag only supported images within this container subtree (recursive). By default, items with existing image-tag artifacts are skipped; use --overwrite to reprocess them. Exits after the finite batch completes.")
        .num_args(1)
        .conflicts_with_all(["mark_failed_item_id", "delete_all"])
        .required(false),
    )
    .arg(
      Arg::new("overwrite")
        .long("overwrite")
        .help("When used with --container-id, reprocess items even if image-tag artifacts already exist. --item-id always overwrites.")
        .num_args(0)
        .requires("container_id")
        .conflicts_with_all(["list_failed", "delete_all"])
        .required(false),
    )
    .arg(
      Arg::new("delay_secs")
        .long("delay-secs")
        .help("Sleep for this many seconds after each image tagging request in this process.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("list_failed")
        .long("list-failed")
        .help("List all supported images for which image tagging failed. Exits after listing.")
        .num_args(0)
        .conflicts_with("delete_all")
        .required(false),
    )
    .arg(
      Arg::new("mark_failed_item_id")
        .long("mark-failed-item-id")
        .help("Write a failed image-tagging manifest for this image and exit without contacting the image tagging service. Repeat to mark multiple items.")
        .num_args(1)
        .action(ArgAction::Append)
        .conflicts_with("delete_all")
        .required(false),
    )
    .arg(
      Arg::new("mark_failed_reason")
        .long("mark-failed-reason")
        .help("Optional reason stored in failed manifests written via --mark-failed-item-id.")
        .num_args(1)
        .requires("mark_failed_item_id")
        .required(false),
    )
    .arg(
      Arg::new("delete_all")
        .long("delete-all")
        .help("Delete all derived image-tagging results while leaving PDF text-extraction results untouched.")
        .num_args(0)
        .conflicts_with_all(["service_url", "delay_secs"])
        .required(false),
    )
    .arg(
      Arg::new("force")
        .long("force")
        .help("Perform the deletion requested by --delete-all.")
        .num_args(0)
        .requires("delete_all")
        .conflicts_with("dry_run")
        .required(false),
    )
    .arg(
      Arg::new("dry_run")
        .long("dry-run")
        .help("Show what --delete-all would remove without deleting anything.")
        .num_args(0)
        .requires("delete_all")
        .conflicts_with("force")
        .required(false),
    )
}

fn settings_arg() -> Arg {
  Arg::new("settings_path")
    .short('s')
    .long("settings")
    .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
    .num_args(1)
    .required(false)
}

struct CliRuntime {
  config: Config,
  data_dir: String,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
}

#[derive(Clone, Copy)]
enum DeleteAllKind {
  Pdf,
  Image,
}

impl DeleteAllKind {
  fn result_label(self) -> &'static str {
    match self {
      DeleteAllKind::Pdf => "PDF text-extraction",
      DeleteAllKind::Image => "image-tagging",
    }
  }

  fn matches_item(self, item: &Item) -> bool {
    match self {
      DeleteAllKind::Pdf => is_extractable_pdf_item(item),
      DeleteAllKind::Image => should_tag_image_item(item),
    }
  }

  fn matches_source_mime_type(self, mime_type: &str) -> bool {
    match self {
      DeleteAllKind::Pdf => mime_type == PDF_SOURCE_MIME_TYPE,
      DeleteAllKind::Image => is_supported_image_tagging_mime_type(Some(mime_type)),
    }
  }
}

#[derive(Deserialize)]
struct DerivedManifestSummary {
  source_mime_type: String,
}

#[derive(Clone)]
struct DeleteAllTarget {
  user_id: String,
  item_id: String,
  manifest_exists: bool,
  content_exists: bool,
}

async fn execute_pdf(sub_matches: &ArgMatches) -> InfuResult<()> {
  let CliRuntime { config, data_dir, db, object_store } =
    init_runtime(sub_matches.get_one::<String>("settings_path")).await?;

  if maybe_execute_delete_all(sub_matches, &data_dir, db.clone(), DeleteAllKind::Pdf).await? {
    return Ok(());
  }

  if sub_matches.get_flag("list_failed") {
    let failed = list_failed_pdfs(&data_dir, db.clone()).await?;
    let failed = if let Some(container_id) = sub_matches.get_one::<String>("container_id") {
      let container_item_ids = collect_pdf_item_ids_in_container(db.clone(), container_id).await?;
      let container_item_ids = container_item_ids.into_iter().collect::<HashSet<String>>();
      failed.into_iter().filter(|failed_pdf| container_item_ids.contains(&failed_pdf.item_id)).collect::<Vec<_>>()
    } else {
      failed
    };
    for failed_pdf in &failed {
      println!(
        "user: {}  item: {}  file: {}  error: {}",
        failed_pdf.user_id,
        failed_pdf.item_id,
        failed_pdf.file_name,
        failed_pdf.error.as_deref().unwrap_or("")
      );
    }
    if failed.is_empty() {
      println!("No PDFs with failed text extraction.");
    }
    return Ok(());
  }

  if let Some(item_ids) = sub_matches.get_many::<String>("mark_failed_item_id") {
    let reason_maybe = sub_matches.get_one::<String>("mark_failed_reason").map(String::as_str);
    let item_ids = item_ids.cloned().collect::<Vec<String>>();
    for item_id in &item_ids {
      mark_item_text_extraction_failed(&data_dir, db.clone(), item_id, reason_maybe).await?;
    }
    info!(
      "Marked {} PDF(s) as failed for text extraction. They will be skipped until reprocessed explicitly.",
      item_ids.len()
    );
    return Ok(());
  }

  let text_extraction_url = resolve_service_url(
    &config,
    sub_matches,
    "service_url",
    "--service-url",
    text_extraction_url_from_config,
    "text_extraction_url",
  )?;
  let text_extraction_delay = parse_delay_arg(sub_matches, "delay_secs", "--delay-secs")?;

  if let Some(item_id) = sub_matches.get_one::<String>("item_id") {
    extract_single_item_no_retry(&data_dir, &text_extraction_url, db, object_store, item_id).await?;
    return Ok(());
  }

  if let Some(container_id) = sub_matches.get_one::<String>("container_id") {
    let overwrite = sub_matches.get_flag("overwrite");
    process_pdf_extraction_batch(
      &data_dir,
      &text_extraction_url,
      text_extraction_delay,
      BatchScope::Container { container_id: container_id.clone() },
      overwrite,
      db,
      object_store,
    )
    .await?;
    return Ok(());
  }

  process_pdf_extraction_batch(
    &data_dir,
    &text_extraction_url,
    text_extraction_delay,
    BatchScope::AllItems,
    false,
    db,
    object_store,
  )
  .await?;
  Ok(())
}

async fn execute_image(sub_matches: &ArgMatches) -> InfuResult<()> {
  let CliRuntime { config, data_dir, db, object_store } =
    init_runtime(sub_matches.get_one::<String>("settings_path")).await?;

  if maybe_execute_delete_all(sub_matches, &data_dir, db.clone(), DeleteAllKind::Image).await? {
    return Ok(());
  }

  if sub_matches.get_flag("list_failed") {
    let failed = list_failed_images(&data_dir, db.clone()).await?;
    let failed = if let Some(container_id) = sub_matches.get_one::<String>("container_id") {
      let container_item_ids = collect_image_item_ids_in_container(db.clone(), container_id).await?;
      let container_item_ids = container_item_ids.into_iter().collect::<HashSet<String>>();
      failed.into_iter().filter(|failed_image| container_item_ids.contains(&failed_image.item_id)).collect::<Vec<_>>()
    } else {
      failed
    };
    for failed_image in &failed {
      println!(
        "user: {}  item: {}  file: {}  error: {}",
        failed_image.user_id,
        failed_image.item_id,
        failed_image.file_name,
        failed_image.error.as_deref().unwrap_or("")
      );
    }
    if failed.is_empty() {
      println!("No supported images with failed image tagging.");
    }
    return Ok(());
  }

  if let Some(item_ids) = sub_matches.get_many::<String>("mark_failed_item_id") {
    let reason_maybe = sub_matches.get_one::<String>("mark_failed_reason").map(String::as_str);
    let item_ids = item_ids.cloned().collect::<Vec<String>>();
    for item_id in &item_ids {
      mark_item_image_tagging_failed(&data_dir, db.clone(), item_id, reason_maybe).await?;
    }
    info!(
      "Marked {} image(s) as failed for image tagging. They will be skipped until reprocessed explicitly.",
      item_ids.len()
    );
    return Ok(());
  }

  let image_tagging_url = resolve_service_url(
    &config,
    sub_matches,
    "service_url",
    "--service-url",
    image_tagging_url_from_config,
    "image_tagging_url",
  )?;
  let image_tagging_delay = parse_delay_arg(sub_matches, "delay_secs", "--delay-secs")?;

  if let Some(item_id) = sub_matches.get_one::<String>("item_id") {
    tag_single_item_no_retry(&data_dir, &image_tagging_url, db, object_store, item_id).await?;
    return Ok(());
  }

  if let Some(container_id) = sub_matches.get_one::<String>("container_id") {
    let overwrite = sub_matches.get_flag("overwrite");
    process_image_tagging_batch(
      &data_dir,
      &image_tagging_url,
      image_tagging_delay,
      BatchScope::Container { container_id: container_id.clone() },
      overwrite,
      db,
      object_store,
    )
    .await?;
    return Ok(());
  }

  process_image_tagging_batch(
    &data_dir,
    &image_tagging_url,
    image_tagging_delay,
    BatchScope::AllItems,
    false,
    db,
    object_store,
  )
  .await?;
  Ok(())
}

async fn init_runtime(settings_path_maybe: Option<&String>) -> InfuResult<CliRuntime> {
  let config = get_config(settings_path_maybe).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let db = Arc::new(Mutex::new(Db::new(&data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?));

  {
    let mut db = db.lock().await;
    let all_user_ids: Vec<String> = db.user.all_user_ids().iter().map(|v| v.clone()).collect();
    for user_id in all_user_ids {
      db.item.load_user_items(&user_id, false).await?;
    }
  }

  let object_store = storage_object::new(
    &data_dir,
    config.get_bool(CONFIG_ENABLE_LOCAL_OBJECT_STORAGE).map_err(|e| e.to_string())?,
    config.get_bool(CONFIG_ENABLE_S3_1_OBJECT_STORAGE).map_err(|e| e.to_string())?,
    config.get_string(CONFIG_S3_1_REGION).ok(),
    config.get_string(CONFIG_S3_1_ENDPOINT).ok(),
    config.get_string(CONFIG_S3_1_BUCKET).ok(),
    config.get_string(CONFIG_S3_1_KEY).ok(),
    config.get_string(CONFIG_S3_1_SECRET).ok(),
    config.get_bool(CONFIG_ENABLE_S3_2_OBJECT_STORAGE).map_err(|e| e.to_string())?,
    config.get_string(CONFIG_S3_2_REGION).ok(),
    config.get_string(CONFIG_S3_2_ENDPOINT).ok(),
    config.get_string(CONFIG_S3_2_BUCKET).ok(),
    config.get_string(CONFIG_S3_2_KEY).ok(),
    config.get_string(CONFIG_S3_2_SECRET).ok(),
  )
  .map_err(|e| format!("Failed to initialize object store: {}", e))?;

  Ok(CliRuntime { config, data_dir, db, object_store })
}

fn resolve_service_url(
  config: &Config,
  sub_matches: &ArgMatches,
  arg_name: &str,
  flag_name: &str,
  from_config: fn(&Config) -> InfuResult<Option<String>>,
  config_key_name: &str,
) -> InfuResult<String> {
  match sub_matches.get_one::<String>(arg_name) {
    Some(url) if !url.trim().is_empty() => Ok(url.clone()),
    _ => from_config(config)?
      .ok_or(format!("{} must be configured or specified via {}.", config_key_name, flag_name).into()),
  }
}

async fn maybe_execute_delete_all(
  sub_matches: &ArgMatches,
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  kind: DeleteAllKind,
) -> InfuResult<bool> {
  if !sub_matches.get_flag("delete_all") {
    return Ok(false);
  }

  let force = sub_matches.get_flag("force");
  let dry_run = sub_matches.get_flag("dry_run");
  if force == dry_run {
    return Err("When using --delete-all, specify exactly one of --force or --dry-run.".into());
  }

  let targets = collect_delete_all_targets(data_dir, db, kind).await?;
  let manifest_count = targets.iter().filter(|target| target.manifest_exists).count();
  let content_count = targets.iter().filter(|target| target.content_exists).count();

  if targets.is_empty() {
    println!("No {} derived results found.", kind.result_label());
    return Ok(true);
  }

  if dry_run {
    println!(
      "Dry run: would delete {} {} result set(s) ({} manifest file(s), {} content file(s)).",
      targets.len(),
      kind.result_label(),
      manifest_count,
      content_count
    );
    for target in &targets {
      let mut pieces = vec![];
      if target.manifest_exists {
        pieces.push("manifest");
      }
      if target.content_exists {
        pieces.push("content");
      }
      println!("would delete {} for user={} item={}", pieces.join("+"), target.user_id, target.item_id);
    }
    println!("Re-run with --force to perform this deletion.");
    return Ok(true);
  }

  for target in &targets {
    match kind {
      DeleteAllKind::Pdf => delete_item_text_dir(data_dir, &target.user_id, &target.item_id).await?,
      DeleteAllKind::Image => delete_item_image_tag_dir(data_dir, &target.user_id, &target.item_id).await?,
    }
  }

  info!(
    "Deleted {} {} result set(s) ({} manifest file(s), {} content file(s)).",
    targets.len(),
    kind.result_label(),
    manifest_count,
    content_count
  );
  Ok(true)
}

fn parse_delay_arg(sub_matches: &ArgMatches, arg_name: &str, flag_name: &str) -> InfuResult<Duration> {
  match sub_matches.get_one::<String>(arg_name) {
    Some(value) => {
      let parsed = value
        .parse::<f64>()
        .map_err(|e| format!("Invalid {} value '{}': {}. Expected a number >= 0.", flag_name, value, e))?;
      if parsed < 0.0 {
        return Err(format!("{} must be greater than or equal to 0.", flag_name).into());
      }
      Ok(Duration::from_secs_f64(parsed))
    }
    None => Ok(Duration::ZERO),
  }
}

async fn collect_delete_all_targets(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  kind: DeleteAllKind,
) -> InfuResult<Vec<DeleteAllTarget>> {
  let current_items = {
    let db = db.lock().await;
    db.item
      .all_loaded_items()
      .into_iter()
      .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().map(Item::clone))
      .filter(|item| kind.matches_item(item))
      .map(|item| (item.owner_id.clone(), item.id.clone()))
      .collect::<Vec<(String, String)>>()
  };

  let mut targets = HashMap::<(String, String), DeleteAllTarget>::new();

  for (user_id, item_id) in current_items {
    let (manifest_path, content_path) = derived_result_paths(data_dir, &user_id, &item_id)?;
    let manifest_exists = path_exists(&manifest_path).await;
    let content_exists = path_exists(&content_path).await;
    if manifest_exists || content_exists {
      targets.insert(
        (user_id.clone(), item_id.clone()),
        DeleteAllTarget { user_id, item_id, manifest_exists, content_exists },
      );
    }
  }

  scan_manifest_backed_delete_targets(data_dir, kind, &mut targets).await?;

  let mut targets = targets
    .into_values()
    .filter(|target| target.manifest_exists || target.content_exists)
    .collect::<Vec<DeleteAllTarget>>();
  targets.sort_by(|a, b| a.user_id.cmp(&b.user_id).then(a.item_id.cmp(&b.item_id)));
  Ok(targets)
}

async fn scan_manifest_backed_delete_targets(
  data_dir: &str,
  kind: DeleteAllKind,
  targets: &mut HashMap<(String, String), DeleteAllTarget>,
) -> InfuResult<()> {
  let base_dir = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  if !path_exists(&base_dir).await {
    return Ok(());
  }

  let mut user_entries = fs::read_dir(&base_dir).await?;
  while let Some(user_entry) = user_entries.next_entry().await? {
    if !user_entry.file_type().await?.is_dir() {
      continue;
    }
    let user_dir_name = user_entry.file_name().to_string_lossy().into_owned();
    let Some(user_id) = user_dir_name.strip_prefix("user_") else {
      continue;
    };
    let text_dir = user_entry.path().join("text");
    if !path_exists(&text_dir).await {
      continue;
    }

    let mut shard_entries = fs::read_dir(&text_dir).await?;
    while let Some(shard_entry) = shard_entries.next_entry().await? {
      if !shard_entry.file_type().await?.is_dir() {
        continue;
      }

      let mut file_entries = fs::read_dir(shard_entry.path()).await?;
      while let Some(file_entry) = file_entries.next_entry().await? {
        if !file_entry.file_type().await?.is_file() {
          continue;
        }
        let file_name = file_entry.file_name().to_string_lossy().into_owned();
        let Some(item_id) = file_name.strip_suffix("_manifest.json") else {
          continue;
        };

        let manifest_bytes = match fs::read(file_entry.path()).await {
          Ok(bytes) => bytes,
          Err(_) => continue,
        };
        let manifest: DerivedManifestSummary = match serde_json::from_slice(&manifest_bytes) {
          Ok(manifest) => manifest,
          Err(_) => continue,
        };
        if !kind.matches_source_mime_type(&manifest.source_mime_type) {
          continue;
        }

        let manifest_exists = true;
        let content_path = shard_entry.path().join(format!("{}_text", item_id));
        let content_exists = path_exists(&content_path).await;
        let key = (user_id.to_owned(), item_id.to_owned());
        targets
          .entry(key)
          .and_modify(|target| {
            target.manifest_exists = true;
            target.content_exists |= content_exists;
          })
          .or_insert(DeleteAllTarget {
            user_id: user_id.to_owned(),
            item_id: item_id.to_owned(),
            manifest_exists,
            content_exists,
          });
      }
    }
  }

  Ok(())
}

fn derived_result_paths(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<(std::path::PathBuf, std::path::PathBuf)> {
  item_text_artifact_paths(data_dir, user_id, item_id, "_manifest.json", "_text")
}
