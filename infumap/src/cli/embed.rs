use std::collections::{BTreeMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use clap::{Arg, ArgAction, ArgMatches, Command};
use infusdk::util::infu::InfuResult;
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::fs;

use super::build_http_client;
use crate::ai::text_embedding::{
  DEFAULT_TEXT_EMBEDDING_BATCH_SIZE, TextEmbeddingBatch, TextEmbeddingInput, embed_texts,
  resolve_text_embedding_service_url,
};
use crate::ai::vector_db::{
  EmbeddedFragment, FragmentVectorDb, FragmentVectorDbBackend, FragmentVectorDbFragmentKey,
  FragmentVectorDbRebuildMetadata, ensure_user_index_dir, fragment_vector_db_path, fragment_vector_db_temp_path,
  open_fragment_vector_db,
};
use crate::config::CONFIG_DATA_DIR;
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::util::fs::{expand_tilde, path_exists};

const UNKNOWN_FRAGMENT_SOURCE_KIND: &str = "unknown";

pub fn make_clap_subcommand() -> Command {
  Command::new("embed")
    .about("Rebuild per-user fragment vector databases from existing fragment artifacts.")
    .arg(settings_arg())
    .arg(
      Arg::new("service_url")
        .long("service-url")
        .help("Text embedding service base URL, /embed endpoint, or legacy /v1/embeddings endpoint. Falls back to text_embedding_url in settings.toml.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("continue")
        .long("continue")
        .help("Continue a previous rebuild by resuming fragments already written to fragments.sqlite3.tmp.")
        .action(ArgAction::SetTrue),
    )
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let embed_url = resolve_text_embedding_service_url(
    &config,
    sub_matches.get_one::<String>("service_url").map(String::as_str),
    "--service-url",
  )?;
  let continue_rebuild = sub_matches.get_flag("continue");

  let plans = load_fragment_index_plans(&data_dir).await?;
  let client = build_http_client(None).await?;
  let mut summary = EmbedRebuildSummary { users_seen: plans.len(), ..Default::default() };

  for plan in plans {
    let outcome = rebuild_user_fragment_index(&data_dir, &plan, &client, &embed_url, continue_rebuild).await?;
    summary.record(&outcome);
  }

  println!(
    "Processed {} user(s): rebuilt {}, skipped current {}, embedded {} fragment(s), reused {} fragment(s) from temp DB, removed {} stale empty index file(s).",
    summary.users_seen,
    summary.users_rebuilt,
    summary.users_skipped_current,
    summary.fragments_embedded,
    summary.fragments_reused,
    summary.empty_index_files_removed
  );

  Ok(())
}

async fn load_fragment_index_plans(data_dir: &str) -> InfuResult<Vec<UserFragmentIndexPlan>> {
  let mut db = Db::new(data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?;

  let mut user_ids = db.user.all_user_ids();
  user_ids.sort();
  for user_id in &user_ids {
    db.item.load_user_items(user_id, false).await?;
  }

  let mut item_ids_by_user_id =
    user_ids.iter().map(|user_id| (user_id.clone(), Vec::new())).collect::<BTreeMap<String, Vec<String>>>();
  for item_key in db.item.all_loaded_items() {
    if let Some(item_ids) = item_ids_by_user_id.get_mut(&item_key.user_id) {
      item_ids.push(item_key.item_id);
    }
  }

  let mut plans = Vec::new();
  for (user_id, mut item_ids) in item_ids_by_user_id {
    item_ids.sort();
    let mut fragments = Vec::new();
    for item_id in item_ids {
      let fragments_path = fragments_path_for_item(data_dir, &user_id, &item_id)?;
      if !path_exists(&fragments_path).await {
        continue;
      }

      let records = load_fragment_records(&fragments_path).await?;
      if records.is_empty() {
        continue;
      }

      let manifest_path = fragments_manifest_path_for_item(data_dir, &user_id, &item_id)?;
      let manifest = load_fragments_manifest(&manifest_path).await?;
      if let Some(expected_count) = manifest.as_ref().and_then(|manifest| manifest.fragment_count)
        && expected_count != records.len()
      {
        return Err(
          format!(
            "Fragment manifest '{}' says {} fragment(s), but '{}' contains {} non-empty fragment record(s).",
            manifest_path.display(),
            expected_count,
            fragments_path.display(),
            records.len()
          )
          .into(),
        );
      }
      let source_kind = manifest
        .and_then(|manifest| manifest.source_kind)
        .map(|source_kind| source_kind.trim().to_owned())
        .filter(|source_kind| !source_kind.is_empty())
        .unwrap_or_else(|| UNKNOWN_FRAGMENT_SOURCE_KIND.to_owned());

      for record in records {
        fragments.push(FragmentRecordForIndex {
          item_id: item_id.clone(),
          ordinal: record.ordinal,
          source_kind: source_kind.clone(),
          text_sha256: fragment_text_sha256(&record.text),
          text: record.text,
          page_start: record.page_start,
          page_end: record.page_end,
        });
      }
    }

    fragments.sort_by(|a, b| a.item_id.cmp(&b.item_id).then(a.ordinal.cmp(&b.ordinal)));
    validate_unique_fragment_ordinals(&user_id, &fragments)?;
    let source_digest = fragment_corpus_digest(&fragments);
    plans.push(UserFragmentIndexPlan { user_id, fragments, source_digest });
  }

  Ok(plans)
}

async fn rebuild_user_fragment_index(
  data_dir: &str,
  plan: &UserFragmentIndexPlan,
  client: &reqwest::Client,
  embed_url: &Url,
  continue_rebuild: bool,
) -> InfuResult<UserRebuildOutcome> {
  let final_path = fragment_vector_db_path(data_dir, &plan.user_id)?;
  let temp_path = fragment_vector_db_temp_path(data_dir, &plan.user_id)?;

  if plan.fragments.is_empty() {
    let removed = remove_stale_empty_index_files(&final_path, &temp_path).await?;
    if removed > 0 {
      eprintln!("User {} has no fragments; removed {} stale fragment index file(s).", plan.user_id, removed);
    }
    return Ok(UserRebuildOutcome { empty_index_files_removed: removed, ..Default::default() });
  }

  ensure_user_index_dir(data_dir, &plan.user_id).await?;

  if continue_rebuild {
    let final_db = open_fragment_vector_db(FragmentVectorDbBackend::SqliteVec, final_path.clone());
    if !path_exists(&temp_path).await
      && let Some(status) = final_db.rebuild_status().await?
      && status.complete
      && status.source_digest == plan.source_digest
      && status.expected_fragment_count == plan.fragments.len()
    {
      eprintln!(
        "User {} fragment index is already current ({} fragment(s), model '{}', {} dims).",
        plan.user_id, status.expected_fragment_count, status.model, status.embedding_dimensions
      );
      return Ok(UserRebuildOutcome { users_skipped_current: 1, ..Default::default() });
    }
  }

  let temp_db = open_fragment_vector_db(FragmentVectorDbBackend::SqliteVec, temp_path.clone());
  let mut metadata = prepare_temp_rebuild(&*temp_db, &temp_path, plan, continue_rebuild).await?;
  let existing_keys = if metadata.is_some() { temp_db.embedded_fragment_keys().await? } else { HashSet::new() };
  let pending_fragments =
    plan.fragments.iter().filter(|fragment| !existing_keys.contains(&fragment.key())).cloned().collect::<Vec<_>>();

  let mut embedded_count = 0;
  for batch in pending_fragments.chunks(DEFAULT_TEXT_EMBEDDING_BATCH_SIZE) {
    let inputs = batch
      .iter()
      .map(|fragment| {
        TextEmbeddingInput::retrieval_document(
          Some(format!("{}:{}", fragment.item_id, fragment.ordinal)),
          fragment.text.clone(),
        )
      })
      .collect::<Vec<_>>();
    let response = embed_texts(client, embed_url, &inputs).await?;

    if metadata.is_none() {
      let dimensions = validate_embedding_batch(&response, None, None)?;
      let initialized_metadata = FragmentVectorDbRebuildMetadata {
        source_digest: plan.source_digest.clone(),
        expected_fragment_count: plan.fragments.len(),
        model: response.model.clone(),
        embedding_dimensions: dimensions,
      };
      temp_db.begin_rebuild(&initialized_metadata, false).await?;
      metadata = Some(initialized_metadata);
    }

    let metadata_ref = metadata.as_ref().ok_or("Embedding metadata was not initialized.")?;
    validate_embedding_batch(&response, Some(&metadata_ref.model), Some(metadata_ref.embedding_dimensions))?;
    let embedded_fragments = batch
      .iter()
      .zip(response.embeddings)
      .map(|(fragment, embedding)| EmbeddedFragment {
        item_id: fragment.item_id.clone(),
        ordinal: fragment.ordinal,
        source_kind: fragment.source_kind.clone(),
        text: fragment.text.clone(),
        page_start: fragment.page_start,
        page_end: fragment.page_end,
        embedding,
      })
      .collect::<Vec<_>>();
    temp_db.insert_embedded_fragments(&embedded_fragments).await?;
    embedded_count += embedded_fragments.len();
    eprintln!("User {} embedded {}/{} pending fragment(s).", plan.user_id, embedded_count, pending_fragments.len());
  }

  let metadata = metadata.ok_or_else(|| {
    format!("User {} has {} fragment(s), but no embeddings were produced.", plan.user_id, plan.fragments.len())
  })?;
  let finished = temp_db.finish_rebuild(&metadata).await?;
  fs::rename(&temp_path, &final_path).await.map_err(|e| {
    format!(
      "Could not atomically replace fragment vector DB '{}' with '{}': {}",
      final_path.display(),
      temp_path.display(),
      e
    )
  })?;

  let final_db = open_fragment_vector_db(FragmentVectorDbBackend::SqliteVec, final_path);
  let final_status = final_db.rebuild_status().await?.ok_or("Final fragment vector DB is missing metadata.")?;
  if !final_status.complete
    || final_status.source_digest != plan.source_digest
    || final_status.expected_fragment_count != plan.fragments.len()
    || final_status.model != metadata.model
    || final_status.embedding_dimensions != metadata.embedding_dimensions
    || final_status.embedded_fragment_count != plan.fragments.len()
    || final_status.embedding_row_count != plan.fragments.len()
  {
    return Err(format!("Final fragment vector DB validation failed for user {}.", plan.user_id).into());
  }

  eprintln!(
    "User {} rebuilt fragment index: {} fragment(s), model '{}', {} dims.",
    plan.user_id, finished.expected_fragment_count, finished.model, finished.embedding_dimensions
  );

  Ok(UserRebuildOutcome {
    users_rebuilt: 1,
    fragments_embedded: embedded_count,
    fragments_reused: existing_keys.len(),
    ..Default::default()
  })
}

async fn prepare_temp_rebuild(
  temp_db: &dyn FragmentVectorDb,
  temp_path: &Path,
  plan: &UserFragmentIndexPlan,
  continue_rebuild: bool,
) -> InfuResult<Option<FragmentVectorDbRebuildMetadata>> {
  if !continue_rebuild {
    remove_file_if_exists(temp_path).await?;
    return Ok(None);
  }

  let Some(status) = temp_db.rebuild_status().await? else {
    remove_file_if_exists(temp_path).await?;
    return Ok(None);
  };

  if status.source_digest != plan.source_digest {
    return Err(
      format!(
        "Cannot continue fragment vector DB rebuild '{}': temp DB source digest differs from current fragments. Run without --continue to start a fresh rebuild.",
        temp_path.display()
      )
      .into(),
    );
  }
  if status.expected_fragment_count != plan.fragments.len() {
    return Err(
      format!(
        "Cannot continue fragment vector DB rebuild '{}': temp DB expects {} fragment(s), current fragments contain {}. Run without --continue to start a fresh rebuild.",
        temp_path.display(),
        status.expected_fragment_count,
        plan.fragments.len()
      )
      .into(),
    );
  }

  let metadata = FragmentVectorDbRebuildMetadata {
    source_digest: status.source_digest,
    expected_fragment_count: status.expected_fragment_count,
    model: status.model,
    embedding_dimensions: status.embedding_dimensions,
  };
  temp_db.begin_rebuild(&metadata, true).await?;
  Ok(Some(metadata))
}

fn validate_embedding_batch(
  response: &TextEmbeddingBatch,
  expected_model: Option<&str>,
  expected_dimensions: Option<usize>,
) -> InfuResult<usize> {
  if response.model.trim().is_empty() {
    return Err("Text embedding service returned an empty model name.".into());
  }
  if let Some(expected_model) = expected_model
    && response.model != expected_model
  {
    return Err(
      format!(
        "Text embedding service returned model '{}', but this rebuild is using model '{}'.",
        response.model, expected_model
      )
      .into(),
    );
  }

  let first = response.embeddings.first().ok_or("Text embedding service returned an empty embedding batch.")?;
  let dimensions = first.len();
  if dimensions == 0 {
    return Err("Text embedding service returned an embedding with zero dimensions.".into());
  }
  if let Some(expected_dimensions) = expected_dimensions
    && dimensions != expected_dimensions
  {
    return Err(
      format!(
        "Text embedding service returned {} dimensions, but this rebuild is using {} dimensions.",
        dimensions, expected_dimensions
      )
      .into(),
    );
  }
  for (index, embedding) in response.embeddings.iter().enumerate() {
    if embedding.len() != dimensions {
      return Err(
        format!(
          "Text embedding service returned inconsistent dimensions in one batch: result 0 has {}, result {} has {}.",
          dimensions,
          index,
          embedding.len()
        )
        .into(),
      );
    }
  }

  Ok(dimensions)
}

fn validate_unique_fragment_ordinals(user_id: &str, fragments: &[FragmentRecordForIndex]) -> InfuResult<()> {
  let mut seen = HashSet::new();
  for fragment in fragments {
    if !seen.insert((fragment.item_id.as_str(), fragment.ordinal)) {
      return Err(
        format!(
          "User {} has duplicate fragment ordinal {} for item '{}'. Regenerate fragments before embedding.",
          user_id, fragment.ordinal, fragment.item_id
        )
        .into(),
      );
    }
  }
  Ok(())
}

async fn remove_stale_empty_index_files(final_path: &Path, temp_path: &Path) -> InfuResult<usize> {
  let mut removed = 0;
  if remove_file_if_exists(temp_path).await? {
    removed += 1;
  }
  if remove_file_if_exists(final_path).await? {
    removed += 1;
  }
  Ok(removed)
}

async fn remove_file_if_exists(path: &Path) -> InfuResult<bool> {
  match fs::remove_file(path).await {
    Ok(()) => Ok(true),
    Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
    Err(e) => Err(format!("Could not remove '{}': {}", path.display(), e).into()),
  }
}

async fn load_fragment_records(path: &Path) -> InfuResult<Vec<StoredFragmentRecord>> {
  let contents =
    fs::read_to_string(path).await.map_err(|e| format!("Could not read fragments file '{}': {}", path.display(), e))?;
  parse_fragment_records(&contents)
}

fn parse_fragment_records(contents: &str) -> InfuResult<Vec<StoredFragmentRecord>> {
  let mut out = Vec::new();

  for (line_number, line) in contents.lines().enumerate() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    let record: StoredFragmentRecord = serde_json::from_str(trimmed)
      .map_err(|e| format!("Could not parse fragment record on line {} of fragments.jsonl: {}", line_number + 1, e))?;
    if !record.text.trim().is_empty() {
      out.push(record);
    }
  }

  Ok(out)
}

async fn load_fragments_manifest(path: &Path) -> InfuResult<Option<StoredFragmentsManifest>> {
  match fs::read_to_string(path).await {
    Ok(contents) => serde_json::from_str(&contents)
      .map(Some)
      .map_err(|e| format!("Could not parse fragments manifest '{}': {}", path.display(), e).into()),
    Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("Could not read fragments manifest '{}': {}", path.display(), e).into()),
  }
}

fn settings_arg() -> Arg {
  Arg::new("settings_path")
    .short('s')
    .long("settings")
    .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
    .num_args(1)
    .required(false)
}

fn fragments_path_for_item(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = item_fragments_dir(data_dir, user_id, item_id)?;
  path.push("fragments.jsonl");
  Ok(path)
}

fn fragments_manifest_path_for_item(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = item_fragments_dir(data_dir, user_id, item_id)?;
  path.push("fragments_manifest.json");
  Ok(path)
}

fn item_fragments_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("fragments");
  path.push(&item_id[..2]);
  path.push(item_id);
  Ok(path)
}

fn fragment_text_sha256(text: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(text.as_bytes());
  format!("{:x}", hasher.finalize())
}

fn fragment_corpus_digest(fragments: &[FragmentRecordForIndex]) -> String {
  let mut hasher = Sha256::new();
  for fragment in fragments {
    hasher.update(fragment.item_id.as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.ordinal.to_string().as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.source_kind.as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.page_start.map(|v| v.to_string()).unwrap_or_default().as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.page_end.map(|v| v.to_string()).unwrap_or_default().as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.text_sha256.as_bytes());
    hasher.update([0xff_u8]);
  }
  format!("{:x}", hasher.finalize())
}

#[derive(Default)]
struct EmbedRebuildSummary {
  users_seen: usize,
  users_rebuilt: usize,
  users_skipped_current: usize,
  fragments_embedded: usize,
  fragments_reused: usize,
  empty_index_files_removed: usize,
}

impl EmbedRebuildSummary {
  fn record(&mut self, outcome: &UserRebuildOutcome) {
    self.users_rebuilt += outcome.users_rebuilt;
    self.users_skipped_current += outcome.users_skipped_current;
    self.fragments_embedded += outcome.fragments_embedded;
    self.fragments_reused += outcome.fragments_reused;
    self.empty_index_files_removed += outcome.empty_index_files_removed;
  }
}

#[derive(Default)]
struct UserRebuildOutcome {
  users_rebuilt: usize,
  users_skipped_current: usize,
  fragments_embedded: usize,
  fragments_reused: usize,
  empty_index_files_removed: usize,
}

struct UserFragmentIndexPlan {
  user_id: String,
  fragments: Vec<FragmentRecordForIndex>,
  source_digest: String,
}

#[derive(Clone)]
struct FragmentRecordForIndex {
  item_id: String,
  ordinal: usize,
  source_kind: String,
  text_sha256: String,
  text: String,
  page_start: Option<usize>,
  page_end: Option<usize>,
}

impl FragmentRecordForIndex {
  fn key(&self) -> FragmentVectorDbFragmentKey {
    FragmentVectorDbFragmentKey {
      item_id: self.item_id.clone(),
      ordinal: self.ordinal,
      text_sha256: self.text_sha256.clone(),
    }
  }
}

#[derive(Deserialize)]
struct StoredFragmentRecord {
  ordinal: usize,
  text: String,
  page_start: Option<usize>,
  page_end: Option<usize>,
}

#[derive(Deserialize)]
struct StoredFragmentsManifest {
  source_kind: Option<String>,
  fragment_count: Option<usize>,
}

#[cfg(test)]
mod tests {
  use super::{
    FragmentRecordForIndex, fragment_corpus_digest, fragments_path_for_item, parse_fragment_records,
    validate_embedding_batch, validate_unique_fragment_ordinals,
  };
  use crate::ai::text_embedding::TextEmbeddingBatch;

  #[test]
  fn parses_fragment_jsonl_records() {
    let records = parse_fragment_records(
      r#"{"ordinal":0,"text":"first fragment","page_start":1,"page_end":1}

{"ordinal":1,"text":"second fragment"}
"#,
    )
    .unwrap();

    assert_eq!(records.len(), 2);
    assert_eq!(records[0].ordinal, 0);
    assert_eq!(records[0].page_start, Some(1));
    assert_eq!(records[1].ordinal, 1);
    assert_eq!(records[1].page_start, None);
  }

  #[test]
  fn fragment_path_uses_fragments_directory() {
    let path = fragments_path_for_item("/data/infumap", "user123", "abcdef").unwrap();
    assert_eq!(path.to_string_lossy(), "/data/infumap/user_user123/fragments/ab/abcdef/fragments.jsonl");
  }

  #[test]
  fn corpus_digest_tracks_fragment_identity_and_text() {
    let mut fragments = vec![fragment_for_digest("item-a", 0, "alpha")];
    let digest_a = fragment_corpus_digest(&fragments);

    fragments[0].text_sha256 = "different".to_owned();
    let digest_b = fragment_corpus_digest(&fragments);

    assert_ne!(digest_a, digest_b);
  }

  #[test]
  fn validates_embedding_batch_model_and_dimensions() {
    let batch = TextEmbeddingBatch { model: "model-a".to_owned(), embeddings: vec![vec![0.0, 1.0], vec![1.0, 0.0]] };
    assert_eq!(validate_embedding_batch(&batch, Some("model-a"), Some(2)).unwrap(), 2);

    assert!(validate_embedding_batch(&batch, Some("model-b"), Some(2)).is_err());
    assert!(validate_embedding_batch(&batch, Some("model-a"), Some(3)).is_err());
    assert!(
      validate_embedding_batch(
        &TextEmbeddingBatch { model: "model-a".to_owned(), embeddings: vec![vec![0.0], vec![0.0, 1.0]] },
        None,
        None,
      )
      .is_err()
    );
  }

  #[test]
  fn rejects_duplicate_fragment_ordinals_for_one_item() {
    let fragments = vec![fragment_for_digest("item-a", 0, "alpha"), fragment_for_digest("item-a", 0, "beta")];
    assert!(validate_unique_fragment_ordinals("user-a", &fragments).is_err());
  }

  fn fragment_for_digest(item_id: &str, ordinal: usize, text_sha256: &str) -> FragmentRecordForIndex {
    FragmentRecordForIndex {
      item_id: item_id.to_owned(),
      ordinal,
      source_kind: "page_contents".to_owned(),
      text_sha256: text_sha256.to_owned(),
      text: "text".to_owned(),
      page_start: None,
      page_end: None,
    }
  }
}
