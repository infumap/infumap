use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use clap::{Arg, ArgAction, ArgMatches, Command};
use infusdk::item::{Item, ItemType, is_container_item_type, is_data_item_type};
use infusdk::util::infu::InfuResult;
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::sync::Mutex;

use crate::config::CONFIG_DATA_DIR;
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::util::fs::{expand_tilde, path_exists};
use crate::web::image_tagging::is_supported_image_tagging_mime_type;

const PDF_MIME_TYPE: &str = "application/pdf";

pub fn make_clap_subcommand() -> Command {
  Command::new("stats")
    .about("Show comprehensive local Infumap instance statistics without starting the web server.")
    .arg(
      Arg::new("settings_path")
        .short('s')
        .long("settings")
        .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("json")
        .long("json")
        .help("Emit machine-readable JSON instead of the default human-readable report.")
        .action(ArgAction::SetTrue),
    )
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let db = std::sync::Arc::new(Mutex::new(
    Db::new(&data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?,
  ));

  let (user_directory_stats, items) = {
    let mut db = db.lock().await;
    let all_user_ids: Vec<String> = db.user.all_user_ids().iter().map(|v| v.clone()).collect();
    for user_id in &all_user_ids {
      db.item.load_user_items(user_id, false).await?;
    }

    let mut user_directory_stats = BTreeMap::<String, UserStatsReport>::new();
    for user_id in &all_user_ids {
      let username = db.user.get(user_id).map(|user| user.username.clone()).unwrap_or_else(|| user_id.clone());
      user_directory_stats.insert(user_id.clone(), UserStatsReport::new(user_id.clone(), username));
    }

    let items = db
      .item
      .all_loaded_items()
      .into_iter()
      .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().map(ItemSnapshot::from_item))
      .collect::<Vec<ItemSnapshot>>();

    (user_directory_stats, items)
  };

  let mut report = StatsReport {
    data_dir: data_dir.clone(),
    user_count: user_directory_stats.len(),
    storage: StorageStatsReport::default(),
    items: ItemStatsReport::default(),
    image_tagging: DerivedStatsReport::default(),
    geo: DerivedStatsReport::default(),
    pdf_text_extraction: DerivedStatsReport::default(),
    per_user: vec![],
  };

  let mut per_user = user_directory_stats;
  let mut image_candidate_keys = HashSet::<ItemKey>::new();
  let mut pdf_candidate_keys = HashSet::<ItemKey>::new();

  for item in &items {
    report.items.record(item);
    if let Some(user_stats) = per_user.get_mut(&item.user_id) {
      user_stats.items.record(item);
    }

    if item.is_supported_image() {
      image_candidate_keys.insert(item.key());
    }
    if item.is_pdf() {
      pdf_candidate_keys.insert(item.key());
    }
  }

  for user_stats in per_user.values_mut() {
    user_stats.storage.item_log_bytes = file_size_or_zero(item_log_path(&data_dir, &user_stats.user_id)?).await?;
    user_stats.storage.user_log_bytes = file_size_or_zero(user_log_path(&data_dir, &user_stats.user_id)?).await?;
    report.storage.item_log_bytes += user_stats.storage.item_log_bytes;
    report.storage.user_log_bytes += user_stats.storage.user_log_bytes;
  }

  for item in &items {
    if item.is_supported_image() {
      let user_stats = per_user.get_mut(&item.user_id).ok_or(format!("Missing user stats for '{}'.", item.user_id))?;
      update_current_derived_stats(
        &data_dir,
        &item.user_id,
        &item.item_id,
        DerivedKind::Image,
        &mut report.image_tagging,
        &mut user_stats.image_tagging,
      )
      .await?;
      update_current_derived_stats(
        &data_dir,
        &item.user_id,
        &item.item_id,
        DerivedKind::Geo,
        &mut report.geo,
        &mut user_stats.geo,
      )
      .await?;
    }

    if item.is_pdf() {
      let user_stats = per_user.get_mut(&item.user_id).ok_or(format!("Missing user stats for '{}'.", item.user_id))?;
      update_current_derived_stats(
        &data_dir,
        &item.user_id,
        &item.item_id,
        DerivedKind::Pdf,
        &mut report.pdf_text_extraction,
        &mut user_stats.pdf_text_extraction,
      )
      .await?;
    }
  }

  scan_orphaned_manifests(
    &data_dir,
    DerivedKind::Image,
    &image_candidate_keys,
    &mut report.image_tagging,
    &mut per_user,
  )
  .await?;
  scan_orphaned_manifests(&data_dir, DerivedKind::Geo, &image_candidate_keys, &mut report.geo, &mut per_user).await?;
  scan_orphaned_manifests(
    &data_dir,
    DerivedKind::Pdf,
    &pdf_candidate_keys,
    &mut report.pdf_text_extraction,
    &mut per_user,
  )
  .await?;

  let mut per_user_values = per_user.into_values().collect::<Vec<UserStatsReport>>();
  per_user_values
    .sort_by(|a, b| a.username.to_lowercase().cmp(&b.username.to_lowercase()).then(a.user_id.cmp(&b.user_id)));
  report.per_user = per_user_values;

  if sub_matches.get_flag("json") {
    println!("{}", serde_json::to_string_pretty(&report)?);
  } else {
    print_human_report(&report);
  }

  Ok(())
}

#[derive(Clone)]
struct ItemSnapshot {
  user_id: String,
  item_id: String,
  item_type: ItemType,
  mime_type: Option<String>,
  file_size_bytes: Option<i64>,
}

impl ItemSnapshot {
  fn from_item(item: &Item) -> ItemSnapshot {
    ItemSnapshot {
      user_id: item.owner_id.clone(),
      item_id: item.id.clone(),
      item_type: item.item_type,
      mime_type: item.mime_type.clone(),
      file_size_bytes: item.file_size_bytes,
    }
  }

  fn key(&self) -> ItemKey {
    ItemKey { user_id: self.user_id.clone(), item_id: self.item_id.clone() }
  }

  fn is_supported_image(&self) -> bool {
    is_supported_image_tagging_mime_type(self.mime_type.as_deref())
  }

  fn is_pdf(&self) -> bool {
    self.mime_type.as_deref() == Some(PDF_MIME_TYPE)
  }
}

#[derive(Clone, Eq, PartialEq, Hash)]
struct ItemKey {
  user_id: String,
  item_id: String,
}

#[derive(Clone, Copy)]
enum DerivedKind {
  Image,
  Geo,
  Pdf,
}

impl DerivedKind {
  fn matches_source_mime_type(self, mime_type: &str) -> bool {
    match self {
      DerivedKind::Image | DerivedKind::Geo => {
        crate::web::image_tagging::is_supported_image_tagging_mime_type(Some(mime_type))
      }
      DerivedKind::Pdf => mime_type == PDF_MIME_TYPE,
    }
  }

  fn manifest_suffix(self) -> &'static str {
    match self {
      DerivedKind::Image | DerivedKind::Pdf => "_manifest.json",
      DerivedKind::Geo => "_geo_manifest.json",
    }
  }

  fn content_suffix(self) -> &'static str {
    match self {
      DerivedKind::Image | DerivedKind::Pdf => "_text",
      DerivedKind::Geo => "_geo.json",
    }
  }
}

#[derive(Default, Deserialize)]
struct DerivedManifestSummary {
  #[serde(default)]
  status: String,
  source_mime_type: String,
}

#[derive(Serialize, Default)]
struct StatsReport {
  data_dir: String,
  user_count: usize,
  storage: StorageStatsReport,
  items: ItemStatsReport,
  image_tagging: DerivedStatsReport,
  geo: DerivedStatsReport,
  pdf_text_extraction: DerivedStatsReport,
  per_user: Vec<UserStatsReport>,
}

#[derive(Serialize, Default)]
struct StorageStatsReport {
  item_log_bytes: u64,
  user_log_bytes: u64,
}

#[derive(Serialize, Default)]
struct ItemStatsReport {
  total: usize,
  container_items: usize,
  data_items: usize,
  image_items: usize,
  supported_image_items: usize,
  pdf_items: usize,
  declared_data_bytes: u64,
  declared_supported_image_bytes: u64,
  declared_pdf_bytes: u64,
  by_type: BTreeMap<String, usize>,
}

impl ItemStatsReport {
  fn record(&mut self, item: &ItemSnapshot) {
    self.total += 1;
    if is_container_item_type(item.item_type) {
      self.container_items += 1;
    }
    if is_data_item_type(item.item_type) {
      self.data_items += 1;
      match item.file_size_bytes {
        Some(size_bytes) if size_bytes >= 0 => {
          self.declared_data_bytes += size_bytes as u64;
          if item.is_supported_image() {
            self.declared_supported_image_bytes += size_bytes as u64;
          }
          if item.is_pdf() {
            self.declared_pdf_bytes += size_bytes as u64;
          }
        }
        _ => {}
      }
    }
    if item.item_type == ItemType::Image {
      self.image_items += 1;
    }
    if item.is_supported_image() {
      self.supported_image_items += 1;
    }
    if item.is_pdf() {
      self.pdf_items += 1;
    }
    *self.by_type.entry(item.item_type.as_str().to_owned()).or_insert(0) += 1;
  }
}

#[derive(Serialize, Default)]
struct DerivedStatsReport {
  candidates: usize,
  succeeded: usize,
  failed: usize,
  skipped: usize,
  pending: usize,
  invalid_manifest: usize,
  success_missing_content: usize,
  failed_with_content: usize,
  content_without_manifest: usize,
  orphaned_manifests: usize,
}

#[derive(Serialize)]
struct UserStatsReport {
  user_id: String,
  username: String,
  storage: StorageStatsReport,
  items: ItemStatsReport,
  image_tagging: DerivedStatsReport,
  geo: DerivedStatsReport,
  pdf_text_extraction: DerivedStatsReport,
}

impl UserStatsReport {
  fn new(user_id: String, username: String) -> UserStatsReport {
    UserStatsReport {
      user_id,
      username,
      storage: StorageStatsReport::default(),
      items: ItemStatsReport::default(),
      image_tagging: DerivedStatsReport::default(),
      geo: DerivedStatsReport::default(),
      pdf_text_extraction: DerivedStatsReport::default(),
    }
  }
}

async fn update_current_derived_stats(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
  kind: DerivedKind,
  global: &mut DerivedStatsReport,
  per_user: &mut DerivedStatsReport,
) -> InfuResult<()> {
  global.candidates += 1;
  per_user.candidates += 1;

  let (manifest_path, content_path) = derived_result_paths(data_dir, user_id, item_id, kind)?;
  let manifest_exists = path_exists(&manifest_path).await;
  let content_exists = path_exists(&content_path).await;

  if !manifest_exists {
    global.pending += 1;
    per_user.pending += 1;
    if content_exists {
      global.content_without_manifest += 1;
      per_user.content_without_manifest += 1;
    }
    return Ok(());
  }

  let manifest = match load_manifest_summary(&manifest_path).await {
    Ok(Some(manifest)) => manifest,
    Ok(None) | Err(_) => {
      global.pending += 1;
      per_user.pending += 1;
      global.invalid_manifest += 1;
      per_user.invalid_manifest += 1;
      return Ok(());
    }
  };

  if !kind.matches_source_mime_type(&manifest.source_mime_type) {
    global.pending += 1;
    per_user.pending += 1;
    global.invalid_manifest += 1;
    per_user.invalid_manifest += 1;
    return Ok(());
  }

  match manifest.status.as_str() {
    "succeeded" => {
      global.succeeded += 1;
      per_user.succeeded += 1;
      if !content_exists {
        global.success_missing_content += 1;
        per_user.success_missing_content += 1;
      }
    }
    "failed" => {
      global.failed += 1;
      per_user.failed += 1;
      if content_exists {
        global.failed_with_content += 1;
        per_user.failed_with_content += 1;
      }
    }
    "skipped" => {
      global.skipped += 1;
      per_user.skipped += 1;
      if content_exists {
        global.failed_with_content += 1;
        per_user.failed_with_content += 1;
      }
    }
    _ => {
      global.pending += 1;
      per_user.pending += 1;
      global.invalid_manifest += 1;
      per_user.invalid_manifest += 1;
    }
  }

  Ok(())
}

async fn scan_orphaned_manifests(
  data_dir: &str,
  kind: DerivedKind,
  live_candidate_keys: &HashSet<ItemKey>,
  global: &mut DerivedStatsReport,
  per_user: &mut BTreeMap<String, UserStatsReport>,
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
        if matches!(kind, DerivedKind::Image | DerivedKind::Pdf)
          && file_name.ends_with(DerivedKind::Geo.manifest_suffix())
        {
          continue;
        }
        let Some(item_id) = file_name.strip_suffix(kind.manifest_suffix()) else {
          continue;
        };

        let manifest = match load_manifest_summary(&file_entry.path()).await {
          Ok(Some(manifest)) => manifest,
          Ok(None) | Err(_) => continue,
        };
        if !kind.matches_source_mime_type(&manifest.source_mime_type) {
          continue;
        }

        let key = ItemKey { user_id: user_id.to_owned(), item_id: item_id.to_owned() };
        if live_candidate_keys.contains(&key) {
          continue;
        }

        global.orphaned_manifests += 1;
        if let Some(user_stats) = per_user.get_mut(user_id) {
          let derived_stats = match kind {
            DerivedKind::Image => &mut user_stats.image_tagging,
            DerivedKind::Geo => &mut user_stats.geo,
            DerivedKind::Pdf => &mut user_stats.pdf_text_extraction,
          };
          derived_stats.orphaned_manifests += 1;
        }
      }
    }
  }

  Ok(())
}

async fn load_manifest_summary(path: &PathBuf) -> InfuResult<Option<DerivedManifestSummary>> {
  let manifest_bytes = match fs::read(path).await {
    Ok(bytes) => bytes,
    Err(_) => return Ok(None),
  };
  match serde_json::from_slice::<DerivedManifestSummary>(&manifest_bytes) {
    Ok(manifest) => Ok(Some(manifest)),
    Err(_) => Ok(None),
  }
}

fn derived_result_paths(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
  kind: DerivedKind,
) -> InfuResult<(PathBuf, PathBuf)> {
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut dir = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  dir.push(format!("user_{}", user_id));
  dir.push("text");
  dir.push(&item_id[..2]);

  let mut manifest_path = dir.clone();
  manifest_path.push(format!("{}{}", item_id, kind.manifest_suffix()));
  let mut content_path = dir;
  content_path.push(format!("{}{}", item_id, kind.content_suffix()));
  Ok((manifest_path, content_path))
}

fn item_log_path(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("items.json");
  Ok(path)
}

fn user_log_path(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("user.json");
  Ok(path)
}

async fn file_size_or_zero(path: PathBuf) -> InfuResult<u64> {
  match fs::metadata(path).await {
    Ok(metadata) => Ok(metadata.len()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
    Err(e) => Err(e.into()),
  }
}

fn print_human_report(report: &StatsReport) {
  println!("Infumap stats");
  println!("  data dir: {}", report.data_dir);
  println!("  users: {}", report.user_count);
  println!();

  println!("Storage");
  println!("  item logs: {}", format_bytes(report.storage.item_log_bytes));
  println!("  user logs: {}", format_bytes(report.storage.user_log_bytes));
  println!();

  println!("Items");
  print_item_stats(&report.items, true, 2);
  println!();

  println!("Images");
  print_images_stats(&report.image_tagging, &report.geo, 2);
  println!();

  println!("PDFs");
  print_pdf_stats(&report.pdf_text_extraction, 2);

  if !report.per_user.is_empty() {
    println!();
    println!("Per user");
    for user in &report.per_user {
      println!("  {} ({})", user.username, user.user_id);
      println!("    item logs: {}", format_bytes(user.storage.item_log_bytes));
      println!("    user logs: {}", format_bytes(user.storage.user_log_bytes));
      println!("    items: {}", user.items.total);
      println!("    supported images: {}", user.items.supported_image_items);
      println!("    pdfs: {}", user.items.pdf_items);
      println!("    declared data bytes: {}", format_bytes(user.items.declared_data_bytes));
      println!(
        "    images: tagging(succeeded={} failed={} pending={} orphaned={}) geo(succeeded={} failed={} skipped={} pending={} orphaned={})",
        user.image_tagging.succeeded,
        user.image_tagging.failed,
        user.image_tagging.pending,
        user.image_tagging.orphaned_manifests,
        user.geo.succeeded,
        user.geo.failed,
        user.geo.skipped,
        user.geo.pending,
        user.geo.orphaned_manifests
      );
      println!(
        "    pdfs: extracted(succeeded={} failed={} pending={} orphaned={})",
        user.pdf_text_extraction.succeeded,
        user.pdf_text_extraction.failed,
        user.pdf_text_extraction.pending,
        user.pdf_text_extraction.orphaned_manifests
      );
    }
  }
}

fn print_item_stats(stats: &ItemStatsReport, include_by_type: bool, indent: usize) {
  let pad = " ".repeat(indent);
  println!("{}total: {}", pad, stats.total);
  println!("{}container items: {}", pad, stats.container_items);
  println!("{}data items: {}", pad, stats.data_items);
  println!("{}image items: {}", pad, stats.image_items);
  println!("{}supported images: {}", pad, stats.supported_image_items);
  println!("{}pdfs: {}", pad, stats.pdf_items);
  println!("{}declared data bytes: {}", pad, format_bytes(stats.declared_data_bytes));
  println!("{}declared supported image bytes: {}", pad, format_bytes(stats.declared_supported_image_bytes));
  println!("{}declared pdf bytes: {}", pad, format_bytes(stats.declared_pdf_bytes));
  if include_by_type {
    println!("{}by type:", pad);
    for (item_type, count) in &stats.by_type {
      println!("{}  {}: {}", pad, item_type, count);
    }
  }
}

fn print_images_stats(image_tagging: &DerivedStatsReport, geo: &DerivedStatsReport, indent: usize) {
  let pad = " ".repeat(indent);
  println!("{}candidates: {}", pad, image_tagging.candidates);
  println!(
    "{}tagging: succeeded={} failed={} pending={}",
    pad, image_tagging.succeeded, image_tagging.failed, image_tagging.pending
  );
  println!(
    "{}geo: succeeded={} failed={} skipped={} pending={}",
    pad, geo.succeeded, geo.failed, geo.skipped, geo.pending
  );
  print_derived_anomalies("tagging", image_tagging, indent);
  print_derived_anomalies("geo", geo, indent);
}

fn print_pdf_stats(stats: &DerivedStatsReport, indent: usize) {
  let pad = " ".repeat(indent);
  println!("{}candidates: {}", pad, stats.candidates);
  println!("{}extracted: succeeded={} failed={} pending={}", pad, stats.succeeded, stats.failed, stats.pending);
  print_derived_anomalies("extraction", stats, indent);
}

fn print_derived_anomalies(label: &str, stats: &DerivedStatsReport, indent: usize) {
  let pad = " ".repeat(indent);
  if stats.invalid_manifest > 0 {
    println!("{}{} invalid manifests: {}", pad, label, stats.invalid_manifest);
  }
  if stats.success_missing_content > 0 {
    println!("{}{} manifests missing content after success: {}", pad, label, stats.success_missing_content);
  }
  if stats.failed_with_content > 0 {
    println!("{}{} manifests with content despite failed/skipped status: {}", pad, label, stats.failed_with_content);
  }
  if stats.content_without_manifest > 0 {
    println!("{}{} content files without manifest: {}", pad, label, stats.content_without_manifest);
  }
  if stats.orphaned_manifests > 0 {
    println!("{}{} orphaned manifests: {}", pad, label, stats.orphaned_manifests);
  }
}

fn format_bytes(bytes: u64) -> String {
  const UNITS: [&str; 6] = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  if bytes == 0 {
    return "0 B".to_owned();
  }

  let mut value = bytes as f64;
  let mut unit_index = 0usize;
  while value >= 1024.0 && unit_index < UNITS.len() - 1 {
    value /= 1024.0;
    unit_index += 1;
  }

  if unit_index == 0 {
    format!("{} {}", bytes, UNITS[unit_index])
  } else {
    format!("{:.2} {}", value, UNITS[unit_index])
  }
}
