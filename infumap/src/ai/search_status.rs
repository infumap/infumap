//! Virtual search status pages, built from live worker activity.
//! See `search_activity` for what is observed and how pages are populated.

use infusdk::util::uid::Uid;
use sha2::{Digest, Sha256};

use crate::ai::search_activity::user_summary;

pub const SEARCH_ATTENTION_PAGE_TITLE: &str = "Search needs attention";
pub const SEARCH_PROCESSING_PAGE_TITLE: &str = "Search processing";
pub const SEARCH_ATTENTION_PAGE_ROUTE_ID: &str = "search/attention";
pub const SEARCH_PROCESSING_PAGE_ROUTE_ID: &str = "search/processing";
const LEGACY_SEARCH_FAILED_PAGE_ROUTE_ID: &str = "search/failed";
const LEGACY_SEARCH_PENDING_PAGE_ROUTE_ID: &str = "search/pending";

/// Largest version component that keeps combined container versions exact in JavaScript.
const SYNC_VERSION_MASK: u64 = (1 << 22) - 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchStatusPageKind {
  Attention,
  Processing,
}

impl SearchStatusPageKind {
  /// Stable identity used to derive page and link ids; unchanged from the
  /// earlier "failed"/"pending" pages so existing links keep working.
  pub fn as_str(self) -> &'static str {
    match self {
      SearchStatusPageKind::Attention => "failed",
      SearchStatusPageKind::Processing => "pending",
    }
  }

  pub fn title(self) -> &'static str {
    match self {
      SearchStatusPageKind::Attention => SEARCH_ATTENTION_PAGE_TITLE,
      SearchStatusPageKind::Processing => SEARCH_PROCESSING_PAGE_TITLE,
    }
  }
}

#[derive(Clone, Debug)]
pub struct SearchStatusView {
  pub attention_item_ids: Vec<Uid>,
  pub processing_item_ids: Vec<Uid>,
  pub checking: bool,
}

impl SearchStatusView {
  pub fn empty() -> SearchStatusView {
    SearchStatusView { attention_item_ids: Vec::new(), processing_item_ids: Vec::new(), checking: false }
  }

  pub fn for_user(user_id: &str) -> SearchStatusView {
    let summary = user_summary(user_id);
    SearchStatusView {
      attention_item_ids: summary.attention_item_ids.into_iter().collect(),
      processing_item_ids: summary.processing_item_ids.into_iter().collect(),
      checking: summary.checking,
    }
  }

  pub fn item_ids_for_page_kind(&self, page_kind: SearchStatusPageKind) -> &[Uid] {
    match page_kind {
      SearchStatusPageKind::Attention => &self.attention_item_ids,
      SearchStatusPageKind::Processing => &self.processing_item_ids,
    }
  }

  /// Changes whenever page contents change, including across restarts. Nonzero.
  pub fn sync_version(&self) -> u64 {
    let mut hasher = Sha256::new();
    hasher.update([self.checking as u8]);
    for item_ids in [&self.attention_item_ids, &self.processing_item_ids] {
      hasher.update([0xff]);
      for item_id in item_ids {
        hasher.update(item_id.as_bytes());
        hasher.update([0]);
      }
    }
    let digest = hasher.finalize();
    let value = u64::from_be_bytes(digest[..8].try_into().expect("digest has at least 8 bytes"));
    (value & SYNC_VERSION_MASK).max(1)
  }
}

pub fn search_attention_page_id(user_id: &str) -> Uid {
  search_status_page_id(user_id, SearchStatusPageKind::Attention)
}

pub fn search_processing_page_id(user_id: &str) -> Uid {
  search_status_page_id(user_id, SearchStatusPageKind::Processing)
}

pub fn search_status_page_id(user_id: &str, page_kind: SearchStatusPageKind) -> Uid {
  deterministic_uid(&["page", user_id, page_kind.as_str()])
}

pub fn search_status_link_id(user_id: &str, page_kind: SearchStatusPageKind, target_item_id: &str) -> Uid {
  deterministic_uid(&["link", user_id, page_kind.as_str(), target_item_id])
}

pub fn search_status_page_kind_for_route_id(route_id: &str) -> Option<SearchStatusPageKind> {
  match route_id {
    SEARCH_ATTENTION_PAGE_ROUTE_ID | LEGACY_SEARCH_FAILED_PAGE_ROUTE_ID => Some(SearchStatusPageKind::Attention),
    SEARCH_PROCESSING_PAGE_ROUTE_ID | LEGACY_SEARCH_PENDING_PAGE_ROUTE_ID => Some(SearchStatusPageKind::Processing),
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
