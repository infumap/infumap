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

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::{Arg, ArgAction, ArgMatches, Command};
use config::Config;
use infusdk::item::{Item, is_container_item_type};
use infusdk::util::infu::InfuResult;
use log::info;
use serde::Deserialize;
use tokio::fs;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::sleep;

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
use crate::web::image_tagging::{
  LoadedImageTagging, delete_item_image_tag_dir, image_tagging_url_from_config, is_supported_image_tagging_mime_type,
  item_needs_image_tagging, list_failed_images, load_image_for_tagging, mark_item_image_tagging_failed,
  process_loaded_image_tagging, should_tag_image_item, start_image_tagging_processing_loop, tag_single_item_no_retry,
};
use crate::web::text_extraction::{
  LoadedPdfExtraction, delete_item_text_dir, extract_single_item_no_retry, item_needs_text_extraction,
  list_failed_pdfs, load_pdf_for_extraction, mark_item_text_extraction_failed, process_loaded_pdf_extraction,
  start_text_extraction_processing_loop, text_extraction_url_from_config,
};

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
        .help("Service URL. Overrides the configured text extraction URL, if present.")
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
        .help("Service URL. Overrides the configured image tagging URL, if present.")
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

#[derive(Default)]
struct BatchProgress {
  processed: usize,
  succeeded: usize,
  failed: usize,
}

impl BatchProgress {
  fn summary(&self) -> String {
    format!("total={} succeeded={} failed={}", self.processed, self.succeeded, self.failed)
  }
}

struct BatchUiText {
  noun_singular: &'static str,
  noun_plural: &'static str,
  action_name: &'static str,
  action_infinitive: &'static str,
  action_past: &'static str,
  artifact_label: &'static str,
  throughput_unit_label: Option<&'static str>,
}

fn average_throughput_suffix(
  started_at: &Instant,
  completed_requests: usize,
  throughput_unit_label: Option<&str>,
) -> String {
  let Some(unit_label) = throughput_unit_label else {
    return String::new();
  };
  if completed_requests == 0 {
    return String::new();
  }

  let elapsed_secs = started_at.elapsed().as_secs_f64().max(0.001);
  let per_minute = (completed_requests as f64) * 60.0 / elapsed_secs;
  format!(" avg_throughput={:.2} {}", per_minute, unit_label)
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

type NeedsProcessingFuture<'a> = Pin<Box<dyn Future<Output = InfuResult<bool>> + Send + 'a>>;
type NeedsProcessingFn = for<'a> fn(&'a str, Arc<Mutex<Db>>, &'a str) -> NeedsProcessingFuture<'a>;
type LoadItemFuture<'a, LoadedItem> = Pin<Box<dyn Future<Output = InfuResult<LoadedItem>> + Send + 'a>>;
type LoadItemFn<LoadedItem> = for<'a> fn(
  &'a str,
  &'a str,
  Arc<Mutex<Db>>,
  Arc<storage_object::ObjectStore>,
  &'a str,
) -> LoadItemFuture<'a, LoadedItem>;
type ProcessLoadedItemFuture<'a> = Pin<Box<dyn Future<Output = InfuResult<()>> + Send + 'a>>;
type ProcessLoadedItemFn<LoadedItem> =
  for<'a> fn(&'a str, &'a str, Arc<Mutex<Db>>, LoadedItem, bool) -> ProcessLoadedItemFuture<'a>;

async fn execute_pdf(sub_matches: &ArgMatches) -> InfuResult<()> {
  let CliRuntime { config, data_dir, db, object_store } =
    init_runtime(sub_matches.get_one::<String>("settings_path")).await?;

  if maybe_execute_delete_all(sub_matches, &data_dir, db.clone(), DeleteAllKind::Pdf).await? {
    return Ok(());
  }

  if sub_matches.get_flag("list_failed") {
    let failed = list_failed_pdfs(&data_dir, db.clone()).await?;
    let failed = if let Some(container_id) = sub_matches.get_one::<String>("container_id") {
      let container_item_ids =
        collect_matching_item_ids_in_container(db.clone(), container_id, is_extractable_pdf_item).await?;
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
    let collected_item_ids =
      collect_matching_item_ids_in_container(db.clone(), container_id, is_extractable_pdf_item).await?;
    let total_candidate_items = collected_item_ids.len();
    let (item_ids, skipped_existing) = if overwrite {
      (collected_item_ids, 0)
    } else {
      filter_item_ids_to_process(&data_dir, db.clone(), collected_item_ids, item_needs_text_extraction_boxed).await?
    };
    if skipped_existing > 0 {
      info!(
        "Skipping {} of {} PDFs under container '{}' because extraction artifacts already exist. Use --overwrite to reprocess them.",
        skipped_existing, total_candidate_items, container_id
      );
    }
    process_container_batch(
      &data_dir,
      &text_extraction_url,
      text_extraction_delay,
      container_id,
      total_candidate_items,
      skipped_existing,
      item_ids,
      db,
      object_store,
      BatchUiText {
        noun_singular: "PDF",
        noun_plural: "PDFs",
        action_name: "text extraction",
        action_infinitive: "extract",
        action_past: "extracted",
        artifact_label: "extraction artifacts",
        throughput_unit_label: None,
      },
      load_pdf_for_extraction_boxed,
      process_loaded_pdf_extraction_boxed,
    )
    .await?;
    return Ok(());
  }

  start_text_extraction_processing_loop(
    data_dir,
    text_extraction_url.clone(),
    text_extraction_delay,
    db,
    object_store,
  )?;
  info!(
    "Running text extraction loop using '{}' with pipelined source-object prefetch and delay {:.3}s. Press Ctrl-C to stop.",
    text_extraction_url,
    text_extraction_delay.as_secs_f64()
  );
  tokio::signal::ctrl_c().await.map_err(|e| format!("Failed waiting for Ctrl-C: {}", e))?;
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
      let container_item_ids =
        collect_matching_item_ids_in_container(db.clone(), container_id, should_tag_image_item).await?;
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
    let collected_item_ids =
      collect_matching_item_ids_in_container(db.clone(), container_id, should_tag_image_item).await?;
    let total_candidate_items = collected_item_ids.len();
    let (item_ids, skipped_existing) = if overwrite {
      (collected_item_ids, 0)
    } else {
      filter_item_ids_to_process(&data_dir, db.clone(), collected_item_ids, item_needs_image_tagging_boxed).await?
    };
    if skipped_existing > 0 {
      info!(
        "Skipping {} of {} images under container '{}' because image-tag artifacts already exist. Use --overwrite to reprocess them.",
        skipped_existing, total_candidate_items, container_id
      );
    }
    process_container_batch(
      &data_dir,
      &image_tagging_url,
      image_tagging_delay,
      container_id,
      total_candidate_items,
      skipped_existing,
      item_ids,
      db,
      object_store,
      BatchUiText {
        noun_singular: "image",
        noun_plural: "supported images",
        action_name: "image tagging",
        action_infinitive: "tag",
        action_past: "tagged",
        artifact_label: "image-tag artifacts",
        throughput_unit_label: Some("images/min"),
      },
      load_image_for_tagging_boxed,
      process_loaded_image_tagging_boxed,
    )
    .await?;
    return Ok(());
  }

  start_image_tagging_processing_loop(data_dir, image_tagging_url.clone(), image_tagging_delay, db, object_store)?;
  info!(
    "Running image tagging loop using '{}' with pipelined source-object prefetch and delay {:.3}s. Press Ctrl-C to stop.",
    image_tagging_url,
    image_tagging_delay.as_secs_f64()
  );
  tokio::signal::ctrl_c().await.map_err(|e| format!("Failed waiting for Ctrl-C: {}", e))?;
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

async fn filter_item_ids_to_process(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  item_ids: Vec<String>,
  needs_processing: NeedsProcessingFn,
) -> InfuResult<(Vec<String>, usize)> {
  let mut filtered_item_ids = vec![];
  let mut skipped_existing = 0usize;

  for item_id in item_ids {
    if needs_processing(data_dir, db.clone(), &item_id).await? {
      filtered_item_ids.push(item_id);
    } else {
      skipped_existing += 1;
    }
  }

  Ok((filtered_item_ids, skipped_existing))
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
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut dir = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  dir.push(format!("user_{}", user_id));
  dir.push("text");
  dir.push(&item_id[..2]);

  let mut manifest_path = dir.clone();
  manifest_path.push(format!("{}_manifest.json", item_id));
  let mut content_path = dir;
  content_path.push(format!("{}_text", item_id));
  Ok((manifest_path, content_path))
}

async fn collect_matching_item_ids_in_container<PredicateFn>(
  db: Arc<Mutex<Db>>,
  container_id: &str,
  predicate: PredicateFn,
) -> InfuResult<Vec<String>>
where
  PredicateFn: Fn(&Item) -> bool + Copy,
{
  let db = db.lock().await;
  let container = db.item.get(&container_id.to_owned()).map_err(|e| e.to_string())?;
  if !is_container_item_type(container.item_type) {
    return Err(format!("Item '{}' is not a container item.", container_id).into());
  }

  let mut visited_item_ids = HashSet::new();
  let mut collected_item_ids = HashSet::new();
  let mut ordered_item_ids = vec![];
  collect_matching_item_ids_recursive(
    &db,
    container_id,
    &mut visited_item_ids,
    &mut collected_item_ids,
    &mut ordered_item_ids,
    predicate,
  )?;
  Ok(ordered_item_ids)
}

fn collect_matching_item_ids_recursive<PredicateFn>(
  db: &Db,
  item_id: &str,
  visited_item_ids: &mut HashSet<String>,
  collected_item_ids: &mut HashSet<String>,
  ordered_item_ids: &mut Vec<String>,
  predicate: PredicateFn,
) -> InfuResult<()>
where
  PredicateFn: Fn(&Item) -> bool + Copy,
{
  if !visited_item_ids.insert(item_id.to_owned()) {
    return Ok(());
  }

  for attachment in db.item.get_attachments(&item_id.to_owned())? {
    if predicate(attachment) && collected_item_ids.insert(attachment.id.clone()) {
      ordered_item_ids.push(attachment.id.clone());
    }
    collect_matching_item_ids_recursive(
      db,
      &attachment.id,
      visited_item_ids,
      collected_item_ids,
      ordered_item_ids,
      predicate,
    )?;
  }

  for child in db.item.get_children(&item_id.to_owned())? {
    if predicate(child) && collected_item_ids.insert(child.id.clone()) {
      ordered_item_ids.push(child.id.clone());
    }
    collect_matching_item_ids_recursive(
      db,
      &child.id,
      visited_item_ids,
      collected_item_ids,
      ordered_item_ids,
      predicate,
    )?;
  }

  Ok(())
}

async fn process_container_batch<LoadedItem>(
  data_dir: &str,
  service_url: &str,
  delay: Duration,
  container_id: &str,
  total_candidate_items: usize,
  skipped_existing: usize,
  item_ids: Vec<String>,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
  ui_text: BatchUiText,
  load_item: LoadItemFn<LoadedItem>,
  process_loaded_item: ProcessLoadedItemFn<LoadedItem>,
) -> InfuResult<()>
where
  LoadedItem: Send + 'static,
{
  if item_ids.is_empty() {
    if total_candidate_items == 0 {
      info!(
        "No {} found under container '{}'. Nothing to {}.",
        ui_text.noun_plural, container_id, ui_text.action_infinitive
      );
    } else {
      info!(
        "All {} {} under container '{}' already have {}. Nothing to {}. Use --overwrite to reprocess them.",
        total_candidate_items, ui_text.noun_plural, container_id, ui_text.artifact_label, ui_text.action_infinitive
      );
    }
    return Ok(());
  }

  let scheduled_items = item_ids.len();
  let started_at = Instant::now();
  info!(
    "Starting container-scoped {} for container '{}' using '{}' with pipelined source-object prefetch and delay {:.3}s. Scheduled {}: {} (existing skipped: {}, total discovered: {}).",
    ui_text.action_name,
    container_id,
    service_url,
    delay.as_secs_f64(),
    ui_text.noun_plural,
    scheduled_items,
    skipped_existing,
    total_candidate_items
  );
  let mut queue = VecDeque::from(item_ids);
  let mut progress = BatchProgress::default();
  let mut next_prefetch = queue
    .pop_front()
    .map(|item_id| spawn_prefetch(data_dir, service_url, db.clone(), object_store.clone(), item_id, load_item));
  let mut current_process = advance_prefetch_to_process(
    data_dir,
    service_url,
    db.clone(),
    object_store.clone(),
    &mut queue,
    &mut next_prefetch,
    &ui_text,
    &mut progress,
    load_item,
    process_loaded_item,
  )
  .await?;

  while let Some(current_handle) = current_process {
    let next_process = if delay == Duration::ZERO {
      advance_prefetch_to_process(
        data_dir,
        service_url,
        db.clone(),
        object_store.clone(),
        &mut queue,
        &mut next_prefetch,
        &ui_text,
        &mut progress,
        load_item,
        process_loaded_item,
      )
      .await?
    } else {
      None
    };

    let (item_id, result) = current_handle
      .await
      .map_err(|e| format!("Container-scoped {} request task failed: {}", ui_text.action_name, e))?;

    match result {
      Ok(()) => {
        progress.processed += 1;
        progress.succeeded += 1;
        let throughput_suffix =
          average_throughput_suffix(&started_at, progress.processed, ui_text.throughput_unit_label);
        info!(
          "Container-scoped {}: {} '{}' successfully ({}/{}).{}",
          ui_text.action_name, ui_text.action_past, item_id, progress.processed, scheduled_items, throughput_suffix
        );
      }
      Err(e) => {
        progress.processed += 1;
        progress.failed += 1;
        let throughput_suffix =
          average_throughput_suffix(&started_at, progress.processed, ui_text.throughput_unit_label);
        info!(
          "Container-scoped {}: failed for '{}' ({}/{}): {}.{}",
          ui_text.action_name, item_id, progress.processed, scheduled_items, e, throughput_suffix
        );
      }
    }

    if delay > Duration::ZERO {
      sleep(delay).await;
      current_process = advance_prefetch_to_process(
        data_dir,
        service_url,
        db.clone(),
        object_store.clone(),
        &mut queue,
        &mut next_prefetch,
        &ui_text,
        &mut progress,
        load_item,
        process_loaded_item,
      )
      .await?;
    } else {
      current_process = next_process;
    }
  }

  info!(
    "Container-scoped {} finished for container '{}': scheduled={} skipped_existing={} succeeded={} failed={}.",
    ui_text.action_name, container_id, scheduled_items, skipped_existing, progress.succeeded, progress.failed
  );
  Ok(())
}

fn spawn_prefetch<LoadedItem>(
  data_dir: &str,
  service_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
  item_id: String,
  load_item: LoadItemFn<LoadedItem>,
) -> JoinHandle<(String, InfuResult<LoadedItem>)>
where
  LoadedItem: Send + 'static,
{
  let worker_data_dir = data_dir.to_owned();
  let worker_service_url = service_url.to_owned();
  tokio::spawn(async move {
    let loaded = load_item(&worker_data_dir, &worker_service_url, db, object_store, &item_id).await;
    (item_id, loaded)
  })
}

async fn advance_prefetch_to_process<LoadedItem>(
  data_dir: &str,
  service_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
  queue: &mut VecDeque<String>,
  next_prefetch: &mut Option<JoinHandle<(String, InfuResult<LoadedItem>)>>,
  ui_text: &BatchUiText,
  progress: &mut BatchProgress,
  load_item: LoadItemFn<LoadedItem>,
  process_loaded_item: ProcessLoadedItemFn<LoadedItem>,
) -> InfuResult<Option<JoinHandle<(String, InfuResult<()>)>>>
where
  LoadedItem: Send + 'static,
{
  loop {
    let Some(current_prefetch) = next_prefetch.take() else {
      return Ok(None);
    };

    let (item_id, loaded_result) = current_prefetch
      .await
      .map_err(|e| format!("Container-scoped {} prefetch task failed: {}", ui_text.action_name, e))?;

    *next_prefetch = queue.pop_front().map(|next_item_id| {
      spawn_prefetch(data_dir, service_url, db.clone(), object_store.clone(), next_item_id, load_item)
    });
    let pending_queue = queue.len() + usize::from(next_prefetch.is_some());

    match loaded_result {
      Ok(loaded_item) => {
        info!(
          "Container-scoped {} starting {} '{}'. Pending queue: {}. Progress: {}",
          ui_text.action_name,
          ui_text.noun_singular,
          item_id,
          pending_queue,
          progress.summary()
        );
        return Ok(Some(spawn_process_loaded_item(
          data_dir,
          service_url,
          db.clone(),
          item_id,
          loaded_item,
          process_loaded_item,
        )));
      }
      Err(e) => {
        progress.processed += 1;
        progress.failed += 1;
        info!(
          "Container-scoped {}: failed during source-object load for '{}'. {} Error: {}",
          ui_text.action_name,
          item_id,
          progress.summary(),
          e
        );
        if next_prefetch.is_none() {
          return Ok(None);
        }
      }
    }
  }
}

fn spawn_process_loaded_item<LoadedItem>(
  data_dir: &str,
  service_url: &str,
  db: Arc<Mutex<Db>>,
  item_id: String,
  loaded_item: LoadedItem,
  process_loaded_item: ProcessLoadedItemFn<LoadedItem>,
) -> JoinHandle<(String, InfuResult<()>)>
where
  LoadedItem: Send + 'static,
{
  let worker_data_dir = data_dir.to_owned();
  let worker_service_url = service_url.to_owned();
  tokio::spawn(async move {
    let result = process_loaded_item(&worker_data_dir, &worker_service_url, db, loaded_item, true).await;
    (item_id, result)
  })
}

fn is_extractable_pdf_item(item: &Item) -> bool {
  item.mime_type.as_deref() == Some("application/pdf")
}

fn item_needs_text_extraction_boxed<'a>(
  data_dir: &'a str,
  db: Arc<Mutex<Db>>,
  item_id: &'a str,
) -> NeedsProcessingFuture<'a> {
  Box::pin(item_needs_text_extraction(data_dir, db, item_id))
}

fn item_needs_image_tagging_boxed<'a>(
  data_dir: &'a str,
  db: Arc<Mutex<Db>>,
  item_id: &'a str,
) -> NeedsProcessingFuture<'a> {
  Box::pin(item_needs_image_tagging(data_dir, db, item_id))
}

fn load_pdf_for_extraction_boxed<'a>(
  data_dir: &'a str,
  service_url: &'a str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
  item_id: &'a str,
) -> LoadItemFuture<'a, LoadedPdfExtraction> {
  Box::pin(load_pdf_for_extraction(data_dir, service_url, db, object_store, item_id))
}

fn load_image_for_tagging_boxed<'a>(
  data_dir: &'a str,
  service_url: &'a str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
  item_id: &'a str,
) -> LoadItemFuture<'a, LoadedImageTagging> {
  let _ = (data_dir, service_url);
  Box::pin(load_image_for_tagging(db, object_store, item_id))
}

fn process_loaded_pdf_extraction_boxed<'a>(
  data_dir: &'a str,
  service_url: &'a str,
  db: Arc<Mutex<Db>>,
  loaded: LoadedPdfExtraction,
  retry_endpoint_unavailable: bool,
) -> ProcessLoadedItemFuture<'a> {
  Box::pin(process_loaded_pdf_extraction(data_dir, service_url, db, loaded, retry_endpoint_unavailable))
}

fn process_loaded_image_tagging_boxed<'a>(
  data_dir: &'a str,
  service_url: &'a str,
  db: Arc<Mutex<Db>>,
  loaded: LoadedImageTagging,
  retry_endpoint_unavailable: bool,
) -> ProcessLoadedItemFuture<'a> {
  Box::pin(process_loaded_image_tagging(data_dir, service_url, db, loaded, retry_endpoint_unavailable))
}
