use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use clap::{Arg, ArgMatches, Command, value_parser};
use infusdk::util::infu::InfuResult;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::fs;

use crate::ai::fragment::sources::item_title_fragment_for_item;
use crate::ai::fragment_indexing::load_item_search_fragments;
use crate::ai::lexical_index::{
  LexicalFragment, TantivyDocumentFragmentIndex, TantivyItemTitleIndex, document_fragment_lexical_index_dir,
  document_fragment_lexical_index_temp_dir, item_title_lexical_index_dir, item_title_lexical_index_temp_dir,
};
use crate::ai::search_index_paths::ensure_user_index_dir;
use crate::ai::title_indexing::lexical_fragment_from_item_title_fragment;
use crate::config::CONFIG_DATA_DIR;
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::util::fs::expand_tilde;

const CHECKPOINT_VERSION: u32 = 1;
const CHECKPOINT_FILENAME: &str = "rebuild_search_index_checkpoint.json";
const DEFAULT_BATCH_SIZE: usize = 100;

#[derive(Clone)]
struct RebuildItem {
  user_id: String,
  item_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct PendingInstall {
  user_id: String,
  document_index_present: bool,
  title_index_present: bool,
}

#[derive(Deserialize, Serialize)]
struct RebuildCheckpoint {
  version: u32,
  corpus_digest: String,
  next_item: usize,
  pending_install: Option<PendingInstall>,
}

pub fn make_clap_subcommand() -> Command {
  Command::new("rebuild-search-index")
    .about("Rebuild lexical search indexes explicitly, with resumable batch progress. Run while the web server is stopped.")
    .arg(settings_arg())
    .arg(
      Arg::new("batch_size")
        .long("batch-size")
        .help("Items committed per checkpoint. Smaller batches lose less work if interrupted; larger batches create fewer index segments.")
        .value_parser(value_parser!(usize))
        .default_value("100"),
    )
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let batch_size = *sub_matches.get_one::<usize>("batch_size").unwrap_or(&DEFAULT_BATCH_SIZE);
  if batch_size == 0 {
    return Err("--batch-size must be at least 1.".into());
  }

  let mut db = Db::new(&data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?;
  let mut user_ids = db.user.all_user_ids();
  user_ids.sort();
  for user_id in &user_ids {
    db.item.load_user_items(user_id, false).await?;
  }

  let mut items = db
    .item
    .all_loaded_items()
    .into_iter()
    .map(|key| RebuildItem { user_id: key.user_id, item_id: key.item_id })
    .collect::<Vec<_>>();
  items.sort_by(|a, b| a.user_id.cmp(&b.user_id).then(a.item_id.cmp(&b.item_id)));
  let corpus_digest = rebuild_corpus_digest(&user_ids, &items);
  let checkpoint_path = checkpoint_path(&data_dir)?;
  let mut checkpoint = load_checkpoint(&checkpoint_path).await?.filter(|checkpoint| {
    checkpoint.version == CHECKPOINT_VERSION
      && checkpoint.corpus_digest == corpus_digest
      && checkpoint.next_item <= items.len()
  });

  if checkpoint.is_none() {
    remove_stale_rebuild_dirs(&data_dir, &user_ids).await?;
    checkpoint = Some(RebuildCheckpoint {
      version: CHECKPOINT_VERSION,
      corpus_digest: corpus_digest.clone(),
      next_item: 0,
      pending_install: None,
    });
    write_checkpoint(&checkpoint_path, checkpoint.as_ref().unwrap()).await?;
  }
  let mut checkpoint = checkpoint.unwrap();

  if let Some(pending) = checkpoint.pending_install.clone() {
    println!("Resuming finalization for user {}...", pending.user_id);
    finalize_user_indexes(&data_dir, &pending).await?;
    checkpoint.pending_install = None;
    write_checkpoint(&checkpoint_path, &checkpoint).await?;
  }

  println!(
    "Lexical search index rebuild: {} item(s), {} user(s), batch size {}, resuming at item {}. Ctrl-C is safe; rerun this command to continue.",
    items.len(),
    user_ids.len(),
    batch_size,
    checkpoint.next_item
  );

  let started = Instant::now();
  let start_item = checkpoint.next_item;
  let mut indexed_fragments = 0_usize;
  while checkpoint.next_item < items.len() {
    let batch_start = checkpoint.next_item;
    let user_id = items[batch_start].user_id.clone();
    let user_end = items[batch_start..]
      .iter()
      .position(|item| item.user_id != user_id)
      .map(|offset| batch_start + offset)
      .unwrap_or(items.len());
    let batch_end = (batch_start + batch_size).min(user_end);
    ensure_user_index_dir(&data_dir, &user_id).await?;

    let mut document_updates = Vec::<(String, Vec<LexicalFragment>)>::new();
    let mut title_updates = Vec::<(String, Vec<LexicalFragment>)>::new();
    for item in &items[batch_start..batch_end] {
      let document_fragments = load_item_search_fragments(&data_dir, &item.user_id, &item.item_id).await?;
      indexed_fragments += document_fragments.len();
      document_updates.push((item.item_id.clone(), document_fragments));

      let title_item = db.item.get(&item.item_id).map_err(|e| e.to_string())?;
      let title_fragment = item_title_fragment_for_item(&db, title_item)?
        .map(lexical_fragment_from_item_title_fragment)
        .into_iter()
        .collect::<Vec<_>>();
      title_updates.push((item.item_id.clone(), title_fragment));
    }

    let document_refs =
      document_updates.iter().map(|(item_id, fragments)| (item_id.as_str(), fragments.as_slice())).collect::<Vec<_>>();
    let title_refs =
      title_updates.iter().map(|(item_id, fragments)| (item_id.as_str(), fragments.as_slice())).collect::<Vec<_>>();
    TantivyDocumentFragmentIndex::new(document_fragment_lexical_index_temp_dir(&data_dir, &user_id)?)
      .replace_items_fragments(&document_refs)
      .await?;
    TantivyItemTitleIndex::new(item_title_lexical_index_temp_dir(&data_dir, &user_id)?)
      .replace_items_titles(&title_refs)
      .await?;

    checkpoint.next_item = batch_end;
    if batch_end == user_end {
      let pending = pending_install_for_user(&data_dir, &user_id).await?;
      checkpoint.pending_install = Some(pending.clone());
      write_checkpoint(&checkpoint_path, &checkpoint).await?;
      println!("Compacting and installing lexical indexes for user {}...", user_id);
      finalize_user_indexes(&data_dir, &pending).await?;
      checkpoint.pending_install = None;
    }
    write_checkpoint(&checkpoint_path, &checkpoint).await?;
    print_progress(started, start_item, checkpoint.next_item, items.len(), indexed_fragments);
  }

  for user_id in user_ids.iter().filter(|user_id| !items.iter().any(|item| &item.user_id == *user_id)) {
    let pending =
      PendingInstall { user_id: user_id.clone(), document_index_present: false, title_index_present: false };
    checkpoint.pending_install = Some(pending.clone());
    write_checkpoint(&checkpoint_path, &checkpoint).await?;
    finalize_user_indexes(&data_dir, &pending).await?;
    checkpoint.pending_install = None;
    write_checkpoint(&checkpoint_path, &checkpoint).await?;
  }

  remove_path_if_exists(&checkpoint_path).await?;
  println!(
    "Search index rebuild complete: {} item(s) total, {} document fragment(s) processed this run, {:.1}s elapsed.",
    items.len(),
    indexed_fragments,
    started.elapsed().as_secs_f64()
  );
  Ok(())
}

async fn pending_install_for_user(data_dir: &str, user_id: &str) -> InfuResult<PendingInstall> {
  Ok(PendingInstall {
    user_id: user_id.to_owned(),
    document_index_present: path_exists(&document_fragment_lexical_index_temp_dir(data_dir, user_id)?).await,
    title_index_present: path_exists(&item_title_lexical_index_temp_dir(data_dir, user_id)?).await,
  })
}

async fn finalize_user_indexes(data_dir: &str, pending: &PendingInstall) -> InfuResult<()> {
  let document_temp = document_fragment_lexical_index_temp_dir(data_dir, &pending.user_id)?;
  let document_final = document_fragment_lexical_index_dir(data_dir, &pending.user_id)?;
  finalize_one_index(&document_temp, &document_final, pending.document_index_present, || {
    TantivyDocumentFragmentIndex::new(document_temp.clone())
  })
  .await?;

  let title_temp = item_title_lexical_index_temp_dir(data_dir, &pending.user_id)?;
  let title_final = item_title_lexical_index_dir(data_dir, &pending.user_id)?;
  finalize_one_index(&title_temp, &title_final, pending.title_index_present, || {
    TantivyItemTitleIndex::new(title_temp.clone())
  })
  .await
}

trait CompactLexicalIndex {
  async fn compact(&self) -> InfuResult<()>;
}

impl CompactLexicalIndex for TantivyDocumentFragmentIndex {
  async fn compact(&self) -> InfuResult<()> {
    TantivyDocumentFragmentIndex::compact(self).await
  }
}

impl CompactLexicalIndex for TantivyItemTitleIndex {
  async fn compact(&self) -> InfuResult<()> {
    TantivyItemTitleIndex::compact(self).await
  }
}

async fn finalize_one_index<T, F>(temp: &Path, final_path: &Path, expected: bool, make_index: F) -> InfuResult<()>
where
  T: CompactLexicalIndex,
  F: FnOnce() -> T,
{
  if !expected {
    remove_path_if_exists(final_path).await?;
    return Ok(());
  }
  if !path_exists(temp).await {
    if path_exists(final_path).await {
      return Ok(());
    }
    return Err(format!("Rebuilt index '{}' disappeared before installation.", temp.display()).into());
  }

  make_index().compact().await?;
  install_index_dir(temp, final_path).await
}

async fn install_index_dir(temp: &Path, final_path: &Path) -> InfuResult<()> {
  let old_path = path_with_suffix(final_path, ".rebuild-old");
  if path_exists(&old_path).await && path_exists(final_path).await {
    remove_path_if_exists(&old_path).await?;
  }
  if path_exists(final_path).await {
    fs::rename(final_path, &old_path)
      .await
      .map_err(|e| format!("Could not move current lexical index '{}' aside: {}", final_path.display(), e))?;
  }
  if let Err(e) = fs::rename(temp, final_path).await {
    if !path_exists(final_path).await && path_exists(&old_path).await {
      let _ = fs::rename(&old_path, final_path).await;
    }
    return Err(format!("Could not install lexical index '{}': {}", final_path.display(), e).into());
  }
  remove_path_if_exists(&old_path).await?;
  Ok(())
}

async fn remove_stale_rebuild_dirs(data_dir: &str, user_ids: &[String]) -> InfuResult<()> {
  for user_id in user_ids {
    for path in [
      document_fragment_lexical_index_temp_dir(data_dir, user_id)?,
      item_title_lexical_index_temp_dir(data_dir, user_id)?,
      path_with_suffix(&document_fragment_lexical_index_dir(data_dir, user_id)?, ".rebuild-old"),
      path_with_suffix(&item_title_lexical_index_dir(data_dir, user_id)?, ".rebuild-old"),
    ] {
      remove_path_if_exists(&path).await?;
    }
  }
  Ok(())
}

fn print_progress(started: Instant, start_item: usize, completed: usize, total: usize, fragments: usize) {
  let elapsed = started.elapsed();
  let completed_this_run = completed.saturating_sub(start_item);
  let rate = if elapsed.as_secs_f64() > 0.0 { completed_this_run as f64 / elapsed.as_secs_f64() } else { 0.0 };
  let eta =
    if rate > 0.0 { Duration::from_secs_f64((total.saturating_sub(completed)) as f64 / rate) } else { Duration::ZERO };
  println!(
    "items {}/{} · document fragments this run {} · {:.1} items/s · ETA {}",
    completed,
    total,
    fragments,
    rate,
    format_duration(eta)
  );
}

fn format_duration(duration: Duration) -> String {
  let seconds = duration.as_secs();
  if seconds >= 3600 {
    format!("{}h {:02}m", seconds / 3600, (seconds % 3600) / 60)
  } else if seconds >= 60 {
    format!("{}m {:02}s", seconds / 60, seconds % 60)
  } else {
    format!("{}s", seconds)
  }
}

fn rebuild_corpus_digest(user_ids: &[String], items: &[RebuildItem]) -> String {
  let mut hasher = Sha256::new();
  for user_id in user_ids {
    hasher.update(user_id.as_bytes());
    hasher.update([0_u8]);
  }
  hasher.update([0xff_u8]);
  for item in items {
    hasher.update(item.user_id.as_bytes());
    hasher.update([0_u8]);
    hasher.update(item.item_id.as_bytes());
    hasher.update([0xff_u8]);
  }
  format!("{:x}", hasher.finalize())
}

async fn load_checkpoint(path: &Path) -> InfuResult<Option<RebuildCheckpoint>> {
  match fs::read(path).await {
    Ok(bytes) => serde_json::from_slice(&bytes)
      .map(Some)
      .map_err(|e| format!("Could not parse search index rebuild checkpoint '{}': {}", path.display(), e).into()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("Could not read search index rebuild checkpoint '{}': {}", path.display(), e).into()),
  }
}

async fn write_checkpoint(path: &Path, checkpoint: &RebuildCheckpoint) -> InfuResult<()> {
  let temp_path = path_with_suffix(path, ".tmp");
  fs::write(&temp_path, serde_json::to_vec_pretty(checkpoint)?).await?;
  fs::rename(&temp_path, path).await?;
  Ok(())
}

fn checkpoint_path(data_dir: &str) -> InfuResult<PathBuf> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret data directory path.")?;
  path.push(CHECKPOINT_FILENAME);
  Ok(path)
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
  let mut value = path.as_os_str().to_os_string();
  value.push(suffix);
  PathBuf::from(value)
}

async fn path_exists(path: &Path) -> bool {
  fs::metadata(path).await.is_ok()
}

async fn remove_path_if_exists(path: &Path) -> InfuResult<()> {
  match fs::metadata(path).await {
    Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path).await?,
    Ok(_) => fs::remove_file(path).await?,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
    Err(e) => return Err(format!("Could not inspect '{}': {}", path.display(), e).into()),
  }
  Ok(())
}

fn settings_arg() -> Arg {
  Arg::new("settings_path")
    .short('s')
    .long("settings")
    .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
    .num_args(1)
    .required(false)
}
