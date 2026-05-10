use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::{Arg, ArgMatches, Command};
use infusdk::item::{Item, ItemType};
use infusdk::util::infu::InfuResult;
use log::info;
use tokio::sync::Mutex;

use crate::ai::fragment::sources::{
  content_fragment_source_for_item, embedding_context_title_for_item, image_fragment_source_for_item,
  markdown_fragment_source_for_item, pdf_fragment_source_for_item,
};
use crate::ai::fragment::{FragmentBuildOutcome, FragmentSource, clear_item_fragments, write_item_fragments};
use crate::ai::image_tagging::should_tag_image_item;
use crate::config::{
  CONFIG_DATA_DIR, CONFIG_ENABLE_LOCAL_OBJECT_STORAGE, CONFIG_ENABLE_S3_1_OBJECT_STORAGE,
  CONFIG_ENABLE_S3_2_OBJECT_STORAGE, CONFIG_S3_1_BUCKET, CONFIG_S3_1_ENDPOINT, CONFIG_S3_1_KEY, CONFIG_S3_1_REGION,
  CONFIG_S3_1_SECRET, CONFIG_S3_2_BUCKET, CONFIG_S3_2_ENDPOINT, CONFIG_S3_2_KEY, CONFIG_S3_2_REGION,
  CONFIG_S3_2_SECRET,
};
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::storage::object::{self as storage_object, ObjectStore};

const MARKDOWN_MIME_TYPE: &str = "text/markdown";
const PDF_MIME_TYPE: &str = "application/pdf";
const FRAGMENT_PROGRESS_ITEM_INTERVAL: usize = 5000;
const FRAGMENT_PROGRESS_TIME_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
enum FragmentTargetKind {
  Content,
  Image,
  Markdown,
  Pdf,
}

impl FragmentTargetKind {
  fn matches_item(self, item: &Item) -> bool {
    match self {
      FragmentTargetKind::Content => matches!(item.item_type, ItemType::Page | ItemType::Table),
      FragmentTargetKind::Image => should_tag_image_item(item),
      FragmentTargetKind::Markdown => {
        item.item_type == ItemType::File && item.mime_type.as_deref() == Some(MARKDOWN_MIME_TYPE)
      }
      FragmentTargetKind::Pdf => item.item_type == ItemType::File && item.mime_type.as_deref() == Some(PDF_MIME_TYPE),
    }
  }

  fn singular_label(self) -> &'static str {
    match self {
      FragmentTargetKind::Content => "page or table",
      FragmentTargetKind::Image => "supported image",
      FragmentTargetKind::Markdown => "Markdown file",
      FragmentTargetKind::Pdf => "PDF file",
    }
  }

  fn summary_label(self) -> &'static str {
    match self {
      FragmentTargetKind::Content => "page/table",
      FragmentTargetKind::Image => "image",
      FragmentTargetKind::Markdown => "markdown",
      FragmentTargetKind::Pdf => "pdf",
    }
  }
}

#[derive(Default)]
struct FragmentRunSummary {
  items_processed: usize,
  items_with_fragments: usize,
  items_cleared: usize,
  items_without_fragments: usize,
  fragments_written: usize,
}

pub fn make_clap_subcommand() -> Command {
  Command::new("fragment")
    .about("Build on-disk fragment artifacts without starting the web server.")
    .subcommand_required(true)
    .arg_required_else_help(true)
    .subcommand(make_content_subcommand())
    .subcommand(make_image_subcommand())
    .subcommand(make_markdown_subcommand())
    .subcommand(make_pdf_subcommand())
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  match sub_matches.subcommand() {
    Some(("content", sub_matches)) => execute_content(sub_matches).await,
    Some(("page-table", sub_matches)) => execute_content(sub_matches).await,
    Some(("image", sub_matches)) => execute_image(sub_matches).await,
    Some(("images", sub_matches)) => execute_image(sub_matches).await,
    Some(("markdown", sub_matches)) => execute_markdown(sub_matches).await,
    Some(("markdowns", sub_matches)) => execute_markdown(sub_matches).await,
    Some(("md", sub_matches)) => execute_markdown(sub_matches).await,
    Some(("pdf", sub_matches)) => execute_pdf(sub_matches).await,
    Some(("pdfs", sub_matches)) => execute_pdf(sub_matches).await,
    _ => Err(
      "Missing fragment subcommand. Use 'fragment content', 'fragment image', 'fragment markdown', or 'fragment pdf'."
        .into(),
    ),
  }
}

fn make_content_subcommand() -> Command {
  Command::new("content")
    .visible_alias("page-table")
    .about("Build fragments for page and table content.")
    .arg(settings_arg())
    .arg(item_id_arg("Build fragments only for this page or table item."))
}

fn make_image_subcommand() -> Command {
  Command::new("image")
    .visible_alias("images")
    .about(
      "Build semantic text fragments for supported images using item metadata, image-tagging output, and geo output.",
    )
    .arg(settings_arg())
    .arg(item_id_arg("Build fragments only for this supported image item."))
}

fn make_markdown_subcommand() -> Command {
  Command::new("markdown")
    .visible_alias("markdowns")
    .visible_alias("md")
    .about("Build lexical text fragments directly from Markdown file items.")
    .arg(settings_arg())
    .arg(item_id_arg("Build fragments only for this Markdown file item."))
}

fn make_pdf_subcommand() -> Command {
  Command::new("pdf")
    .visible_alias("pdfs")
    .about("Build semantic text fragments from extracted markdown for PDF file items.")
    .arg(settings_arg())
    .arg(item_id_arg("Build fragments only for this PDF item."))
}

fn settings_arg() -> Arg {
  Arg::new("settings_path")
    .short('s')
    .long("settings")
    .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
    .num_args(1)
    .required(false)
}

fn item_id_arg(help: &'static str) -> Arg {
  Arg::new("item_id").long("item-id").help(help).num_args(1).required(false)
}

async fn execute_content(sub_matches: &ArgMatches) -> InfuResult<()> {
  let (data_dir, db, items) = load_db_and_items(sub_matches, FragmentTargetKind::Content).await?;
  let mut summary = FragmentRunSummary::default();

  for item in items {
    let fragment_source = {
      let db = db.lock().await;
      content_fragment_source_for_item(&db, &item)
    };
    let outcome = apply_fragment_source(&data_dir, &item, fragment_source).await?;
    record_fragment_outcome(&mut summary, &outcome);
  }

  log_fragment_summary(FragmentTargetKind::Content, &summary);
  Ok(())
}

async fn execute_image(sub_matches: &ArgMatches) -> InfuResult<()> {
  let (data_dir, db, items) = load_db_and_items(sub_matches, FragmentTargetKind::Image).await?;
  let mut summary = FragmentRunSummary::default();
  let single_item_run = sub_matches.get_one::<String>("item_id").is_some();
  let mut progress = FragmentRunProgress::new(FragmentTargetKind::Image, items.len());

  for (index, item) in items.into_iter().enumerate() {
    progress.log_before_item(index, &item);
    let context_title = {
      let db = db.lock().await;
      embedding_context_title_for_item(&db, &item)
    };
    let fragment_source = image_fragment_source_for_item(&data_dir, &item, context_title).await?;
    let had_fragment_source = fragment_source.is_some();
    let outcome = apply_fragment_source(&data_dir, &item, fragment_source).await?;
    record_fragment_outcome(&mut summary, &outcome);
    if single_item_run {
      log_single_item_fragment_outcome(FragmentTargetKind::Image, &item, had_fragment_source, &outcome);
    }
    progress.log_after_item(index + 1, &summary);
  }

  log_fragment_summary(FragmentTargetKind::Image, &summary);
  Ok(())
}

async fn execute_markdown(sub_matches: &ArgMatches) -> InfuResult<()> {
  let (data_dir, db, items) = load_db_and_items(sub_matches, FragmentTargetKind::Markdown).await?;
  let mut summary = FragmentRunSummary::default();
  if items.is_empty() {
    log_fragment_summary(FragmentTargetKind::Markdown, &summary);
    return Ok(());
  }

  let object_store = load_object_store(sub_matches, &data_dir).await?;
  let single_item_run = sub_matches.get_one::<String>("item_id").is_some();
  let mut progress = FragmentRunProgress::new(FragmentTargetKind::Markdown, items.len());

  for (index, item) in items.into_iter().enumerate() {
    progress.log_before_item(index, &item);
    let (context_title, object_encryption_key) = {
      let db = db.lock().await;
      let object_encryption_key = db
        .user
        .get(&item.owner_id)
        .ok_or(format!("User '{}' not loaded.", item.owner_id))?
        .object_encryption_key
        .clone();
      (embedding_context_title_for_item(&db, &item), object_encryption_key)
    };
    let fragment_source =
      markdown_fragment_source_for_item(object_store.clone(), &item, &object_encryption_key, context_title).await?;
    let had_fragment_source = fragment_source.is_some();
    let outcome = apply_fragment_source(&data_dir, &item, fragment_source).await?;
    record_fragment_outcome(&mut summary, &outcome);
    if single_item_run {
      log_single_item_fragment_outcome(FragmentTargetKind::Markdown, &item, had_fragment_source, &outcome);
    }
    progress.log_after_item(index + 1, &summary);
  }

  log_fragment_summary(FragmentTargetKind::Markdown, &summary);
  Ok(())
}

async fn execute_pdf(sub_matches: &ArgMatches) -> InfuResult<()> {
  let (data_dir, db, items) = load_db_and_items(sub_matches, FragmentTargetKind::Pdf).await?;
  let mut summary = FragmentRunSummary::default();

  for item in items {
    let context_title = {
      let db = db.lock().await;
      embedding_context_title_for_item(&db, &item)
    };
    let fragment_source = pdf_fragment_source_for_item(&data_dir, &item, context_title).await?;
    let outcome = apply_fragment_source(&data_dir, &item, fragment_source).await?;
    record_fragment_outcome(&mut summary, &outcome);
  }

  log_fragment_summary(FragmentTargetKind::Pdf, &summary);
  Ok(())
}

async fn load_db_and_items(
  sub_matches: &ArgMatches,
  target_kind: FragmentTargetKind,
) -> InfuResult<(String, Arc<Mutex<Db>>, Vec<Item>)> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let db = Arc::new(Mutex::new(Db::new(&data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?));

  {
    let mut db = db.lock().await;
    let all_user_ids: Vec<String> = db.user.all_user_ids().iter().map(|value| value.clone()).collect();
    for user_id in all_user_ids {
      db.item.load_user_items(&user_id, false).await?;
    }
  }

  let items = {
    let db = db.lock().await;
    if let Some(item_id) = sub_matches.get_one::<String>("item_id") {
      let item = db.item.get(item_id).map_err(|e| e.to_string())?.clone();
      if !target_kind.matches_item(&item) {
        return Err(format!("Item '{}' is not a {}.", item_id, target_kind.singular_label()).into());
      }
      vec![item]
    } else {
      let mut items = db
        .item
        .all_loaded_items()
        .into_iter()
        .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().map(Item::clone))
        .filter(|item| target_kind.matches_item(item))
        .collect::<Vec<Item>>();
      items.sort_by(|a, b| a.owner_id.cmp(&b.owner_id).then(a.id.cmp(&b.id)));
      items
    }
  };

  info!(
    "Selected {} {} item(s) for fragment building{}.",
    items.len(),
    target_kind.summary_label(),
    sub_matches.get_one::<String>("item_id").map(|item_id| format!(" (--item-id {})", item_id)).unwrap_or_default()
  );

  Ok((data_dir, db, items))
}

async fn load_object_store(sub_matches: &ArgMatches, data_dir: &str) -> InfuResult<Arc<ObjectStore>> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  storage_object::new(
    data_dir,
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
  .map_err(|e| format!("Failed to initialize object store: {}", e).into())
}

async fn apply_fragment_source(
  data_dir: &str,
  item: &Item,
  fragment_source: Option<FragmentSource>,
) -> InfuResult<FragmentBuildOutcome> {
  match fragment_source {
    Some(fragment_source) => {
      write_item_fragments(data_dir, item, fragment_source.source_kind, fragment_source.fragments).await
    }
    None => clear_item_fragments(data_dir, item).await,
  }
}

fn record_fragment_outcome(summary: &mut FragmentRunSummary, outcome: &FragmentBuildOutcome) {
  summary.items_processed += 1;
  if outcome.wrote_fragments {
    summary.items_with_fragments += 1;
    summary.fragments_written += outcome.fragment_count;
  } else if outcome.cleared_existing_fragments {
    summary.items_cleared += 1;
  } else {
    summary.items_without_fragments += 1;
  }
}

fn log_fragment_summary(target_kind: FragmentTargetKind, summary: &FragmentRunSummary) {
  info!(
    "Finished {} fragment build: processed {} item(s), wrote fragments for {} item(s), wrote {} fragment(s), cleared {} stale item fragment dir(s), skipped {} item(s) with no fragment source.",
    target_kind.summary_label(),
    summary.items_processed,
    summary.items_with_fragments,
    summary.fragments_written,
    summary.items_cleared,
    summary.items_without_fragments
  );
}

struct FragmentRunProgress {
  target_kind: FragmentTargetKind,
  total_items: usize,
  started_at: Instant,
  last_log_at: Instant,
}

impl FragmentRunProgress {
  fn new(target_kind: FragmentTargetKind, total_items: usize) -> FragmentRunProgress {
    let now = Instant::now();
    info!("Starting {} fragment build for {} item(s).", target_kind.summary_label(), total_items);
    FragmentRunProgress { target_kind, total_items, started_at: now, last_log_at: now }
  }

  fn log_before_item(&mut self, index: usize, item: &Item) {
    let now = Instant::now();
    if index == 0 || now.duration_since(self.last_log_at) >= FRAGMENT_PROGRESS_TIME_INTERVAL {
      info!(
        "Building {} fragments: processing item {}/{} '{}' (user '{}', title '{}').",
        self.target_kind.summary_label(),
        index + 1,
        self.total_items,
        item.id,
        item.owner_id,
        log_item_title(item)
      );
      self.last_log_at = now;
    }
  }

  fn log_after_item(&mut self, processed: usize, summary: &FragmentRunSummary) {
    if self.total_items == 0 {
      return;
    }
    let now = Instant::now();
    let should_log = processed == self.total_items
      || processed % FRAGMENT_PROGRESS_ITEM_INTERVAL == 0
      || now.duration_since(self.last_log_at) >= FRAGMENT_PROGRESS_TIME_INTERVAL;
    if !should_log {
      return;
    }
    info!(
      "{} fragment progress: processed {}/{} item(s) in {:.1}s; wrote {} fragment(s) for {} item(s), cleared {}, skipped {}.",
      self.target_kind.summary_label(),
      processed,
      self.total_items,
      now.duration_since(self.started_at).as_secs_f64(),
      summary.fragments_written,
      summary.items_with_fragments,
      summary.items_cleared,
      summary.items_without_fragments
    );
    self.last_log_at = now;
  }
}

fn log_single_item_fragment_outcome(
  target_kind: FragmentTargetKind,
  item: &Item,
  had_fragment_source: bool,
  outcome: &FragmentBuildOutcome,
) {
  if outcome.wrote_fragments {
    info!(
      "Built {} fragment artifact for item '{}' (user '{}'): {} fragment(s).",
      target_kind.summary_label(),
      item.id,
      item.owner_id,
      outcome.fragment_count
    );
  } else if outcome.cleared_existing_fragments {
    info!(
      "Cleared {} fragment artifact directory for item '{}' (user '{}') because no usable fragment source was available.",
      target_kind.summary_label(),
      item.id,
      item.owner_id
    );
  } else if had_fragment_source {
    info!(
      "No {} fragments were written for item '{}' (user '{}') after empty fragment text was filtered out.",
      target_kind.summary_label(),
      item.id,
      item.owner_id
    );
  } else {
    info!(
      "Skipped {} fragment artifact for item '{}' (user '{}') because no usable fragment source was available.",
      target_kind.summary_label(),
      item.id,
      item.owner_id
    );
  }
}

fn log_item_title(item: &Item) -> String {
  item
    .title
    .as_deref()
    .map(|title| title.split_whitespace().collect::<Vec<_>>().join(" "))
    .filter(|title| !title.is_empty())
    .map(|title| truncate_for_log(&title, 96))
    .unwrap_or_default()
}

fn truncate_for_log(value: &str, max_chars: usize) -> String {
  if value.chars().count() <= max_chars {
    return value.to_owned();
  }
  let mut truncated = value.chars().take(max_chars.saturating_sub(3)).collect::<String>();
  truncated.push_str("...");
  truncated
}
