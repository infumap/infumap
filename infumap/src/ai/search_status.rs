use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use infusdk::util::infu::InfuResult;
use infusdk::util::uid::Uid;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::fs;

use crate::ai::fragment::{is_lexical_search_source_kind, read_item_fragment_metadata};
use crate::ai::image_tagging::{
  ImageTagArtifactState, image_tagging_artifact_state, is_supported_image_tagging_mime_type,
};
use crate::ai::text_extraction::{PdfTextArtifactState, pdf_text_artifact_state};
use crate::ai::user_id_for_log;
use crate::storage::db::Db;
use crate::util::fs::expand_tilde;

pub const SEARCH_STATUS_SCHEMA_VERSION: u32 = 1;
pub const SEARCH_STATUS_FILENAME: &str = "search_status.json";
pub const SEARCH_FAILED_PAGE_TITLE: &str = "Search fragments failed";
pub const SEARCH_PENDING_PAGE_TITLE: &str = "Search fragments pending";
pub const SEARCH_FAILED_PAGE_ROUTE_ID: &str = "search/failed";
pub const SEARCH_PENDING_PAGE_ROUTE_ID: &str = "search/pending";

const PDF_SOURCE_MIME_TYPE: &str = "application/pdf";
const MARKDOWN_SOURCE_MIME_TYPE: &str = "text/markdown";
const TEXT_SOURCE_MIME_TYPE: &str = "text/plain";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchStatusPageKind {
  Failed,
  Pending,
}

impl SearchStatusPageKind {
  pub fn as_str(self) -> &'static str {
    match self {
      SearchStatusPageKind::Failed => "failed",
      SearchStatusPageKind::Pending => "pending",
    }
  }

  pub fn title(self) -> &'static str {
    match self {
      SearchStatusPageKind::Failed => SEARCH_FAILED_PAGE_TITLE,
      SearchStatusPageKind::Pending => SEARCH_PENDING_PAGE_TITLE,
    }
  }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SearchStatusArtifact {
  pub schema_version: u32,
  pub updated_at_unix_secs: i64,
  pub failed_item_ids: Vec<Uid>,
  pub pending_item_ids: Vec<Uid>,
}

impl SearchStatusArtifact {
  pub fn empty() -> SearchStatusArtifact {
    SearchStatusArtifact {
      schema_version: SEARCH_STATUS_SCHEMA_VERSION,
      updated_at_unix_secs: 0,
      failed_item_ids: Vec::new(),
      pending_item_ids: Vec::new(),
    }
  }

  pub fn new(failed_item_ids: Vec<Uid>, pending_item_ids: Vec<Uid>) -> InfuResult<SearchStatusArtifact> {
    Ok(SearchStatusArtifact {
      schema_version: SEARCH_STATUS_SCHEMA_VERSION,
      updated_at_unix_secs: unix_now_secs()?,
      failed_item_ids: normalized_item_ids(failed_item_ids),
      pending_item_ids: normalized_item_ids(pending_item_ids),
    })
  }

  pub fn item_ids_for_page_kind(&self, page_kind: SearchStatusPageKind) -> &[Uid] {
    match page_kind {
      SearchStatusPageKind::Failed => &self.failed_item_ids,
      SearchStatusPageKind::Pending => &self.pending_item_ids,
    }
  }
}

pub fn user_search_status_artifact_path(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push(SEARCH_STATUS_FILENAME);
  Ok(path)
}

pub async fn read_search_status_artifact(data_dir: &str, user_id: &str) -> InfuResult<Option<SearchStatusArtifact>> {
  let path = user_search_status_artifact_path(data_dir, user_id)?;
  let bytes = match fs::read(&path).await {
    Ok(bytes) => bytes,
    Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("Could not read search status artifact '{}': {}", path.display(), e).into()),
  };
  let artifact: SearchStatusArtifact = serde_json::from_slice(&bytes)
    .map_err(|e| format!("Could not parse search status artifact '{}': {}", path.display(), e))?;
  if artifact.schema_version != SEARCH_STATUS_SCHEMA_VERSION {
    return Err(
      format!("Unsupported search status artifact schema version {} in '{}'.", artifact.schema_version, path.display())
        .into(),
    );
  }
  Ok(Some(artifact))
}

pub async fn write_search_status_artifact(
  data_dir: &str,
  user_id: &str,
  artifact: &SearchStatusArtifact,
) -> InfuResult<()> {
  let path = user_search_status_artifact_path(data_dir, user_id)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).await?;
  }
  let mut temp_path = path.as_os_str().to_os_string();
  temp_path.push(".tmp");
  let temp_path = PathBuf::from(temp_path);
  fs::write(&temp_path, serde_json::to_vec_pretty(artifact)?)
    .await
    .map_err(|e| format!("Could not write temporary search status artifact '{}': {}", temp_path.display(), e))?;
  fs::rename(&temp_path, &path)
    .await
    .map_err(|e| format!("Could not install search status artifact '{}': {}", path.display(), e).into())
}

pub async fn refresh_user_search_fragment_status(
  data_dir: &str,
  db: &Db,
  user_id: &str,
) -> InfuResult<SearchStatusArtifact> {
  let mut item_ids = db
    .item
    .all_loaded_items()
    .into_iter()
    .filter(|item| item.user_id == user_id)
    .map(|item| item.item_id)
    .collect::<Vec<_>>();
  item_ids.sort();

  let mut failed_item_ids = Vec::new();
  let mut pending_item_ids = Vec::new();
  for item_id in item_ids {
    let item = db.item.get(&item_id)?;
    let Some(kind) = search_status_candidate_kind(item.mime_type.as_deref()) else {
      continue;
    };
    let has_search_fragments = read_item_fragment_metadata(data_dir, user_id, &item_id)
      .await?
      .is_some_and(|metadata| is_lexical_search_source_kind(&metadata.source_kind));
    if has_search_fragments {
      continue;
    }

    match classify_missing_search_fragments(data_dir, user_id, &item_id, kind).await? {
      SearchStatusClassification::Failed => failed_item_ids.push(item_id),
      SearchStatusClassification::Pending => pending_item_ids.push(item_id),
      SearchStatusClassification::Blocked => {}
    }
  }

  let artifact = SearchStatusArtifact::new(failed_item_ids, pending_item_ids)?;
  write_search_status_artifact(data_dir, user_id, &artifact).await?;
  log::debug!(
    "User {} refreshed search fragment status: failed={} pending={}.",
    user_id_for_log(user_id),
    artifact.failed_item_ids.len(),
    artifact.pending_item_ids.len()
  );
  Ok(artifact)
}

pub fn search_failed_page_id(user_id: &str) -> Uid {
  search_status_page_id(user_id, SearchStatusPageKind::Failed)
}

pub fn search_pending_page_id(user_id: &str) -> Uid {
  search_status_page_id(user_id, SearchStatusPageKind::Pending)
}

pub fn search_status_page_id(user_id: &str, page_kind: SearchStatusPageKind) -> Uid {
  deterministic_uid(&["page", user_id, page_kind.as_str()])
}

pub fn search_status_link_id(user_id: &str, page_kind: SearchStatusPageKind, target_item_id: &str) -> Uid {
  deterministic_uid(&["link", user_id, page_kind.as_str(), target_item_id])
}

pub fn search_status_page_kind_for_route_id(route_id: &str) -> Option<SearchStatusPageKind> {
  match route_id {
    SEARCH_FAILED_PAGE_ROUTE_ID => Some(SearchStatusPageKind::Failed),
    SEARCH_PENDING_PAGE_ROUTE_ID => Some(SearchStatusPageKind::Pending),
    _ => None,
  }
}

fn deterministic_uid(parts: &[&str]) -> Uid {
  let mut hasher = Sha256::new();
  hasher.update(b"infumap-search-status-id-v1");
  for part in parts {
    hasher.update([0]);
    hasher.update(part.as_bytes());
  }
  hasher.finalize().iter().take(16).map(|byte| format!("{:02x}", byte)).collect()
}

fn search_status_candidate_kind(mime_type: Option<&str>) -> Option<SearchStatusCandidateKind> {
  match mime_type? {
    PDF_SOURCE_MIME_TYPE => Some(SearchStatusCandidateKind::Pdf),
    MARKDOWN_SOURCE_MIME_TYPE => Some(SearchStatusCandidateKind::Markdown),
    TEXT_SOURCE_MIME_TYPE => Some(SearchStatusCandidateKind::Text),
    mime_type if is_supported_image_tagging_mime_type(Some(mime_type)) => Some(SearchStatusCandidateKind::Image),
    _ => None,
  }
}

async fn classify_missing_search_fragments(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
  kind: SearchStatusCandidateKind,
) -> InfuResult<SearchStatusClassification> {
  Ok(match kind {
    SearchStatusCandidateKind::Pdf => match pdf_text_artifact_state(data_dir, user_id, item_id).await? {
      PdfTextArtifactState::Failed => SearchStatusClassification::Failed,
      PdfTextArtifactState::Blocked => SearchStatusClassification::Blocked,
      PdfTextArtifactState::Succeeded | PdfTextArtifactState::Pending => SearchStatusClassification::Pending,
    },
    SearchStatusCandidateKind::Image => match image_tagging_artifact_state(data_dir, user_id, item_id).await? {
      ImageTagArtifactState::Failed | ImageTagArtifactState::UnsupportedSchemaVersion { .. } => {
        SearchStatusClassification::Failed
      }
      ImageTagArtifactState::Empty
      | ImageTagArtifactState::Succeeded
      | ImageTagArtifactState::Incomplete(_)
      | ImageTagArtifactState::RetryableFailed => SearchStatusClassification::Pending,
    },
    SearchStatusCandidateKind::Markdown | SearchStatusCandidateKind::Text => SearchStatusClassification::Pending,
  })
}

#[derive(Clone, Copy)]
enum SearchStatusCandidateKind {
  Pdf,
  Image,
  Markdown,
  Text,
}

#[derive(Clone, Copy)]
enum SearchStatusClassification {
  Failed,
  Pending,
  Blocked,
}

fn normalized_item_ids(mut item_ids: Vec<Uid>) -> Vec<Uid> {
  item_ids.sort();
  item_ids.dedup();
  item_ids
}

fn unix_now_secs() -> InfuResult<i64> {
  Ok(
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map_err(|e| format!("Could not determine current unix time: {}", e))?
      .as_secs() as i64,
  )
}
