use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use infusdk::util::infu::InfuResult;
use infusdk::util::uid::Uid;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::fs;

use crate::util::fs::expand_tilde;

pub const SEARCH_STATUS_SCHEMA_VERSION: u32 = 1;
pub const SEARCH_STATUS_FILENAME: &str = "search_status.json";
pub const SEARCH_FAILED_PAGE_TITLE: &str = "zz Index failed";
pub const SEARCH_PENDING_PAGE_TITLE: &str = "zz Not indexed yet";
pub const SEARCH_FAILED_PAGE_ROUTE_ID: &str = "search/failed";
pub const SEARCH_PENDING_PAGE_ROUTE_ID: &str = "search/pending";

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
  fs::write(&path, serde_json::to_vec_pretty(artifact)?)
    .await
    .map_err(|e| format!("Could not write search status artifact '{}': {}", path.display(), e).into())
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
