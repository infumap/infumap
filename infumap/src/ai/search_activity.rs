//! Live, in-memory observations of search processing for the status pages.
//!
//! Workers report what their own queues are doing. This is not a queue or a
//! recovery store: it is lost on restart, and the startup scans rebuild it by
//! queueing items again. Entries only describe outstanding work; completed work
//! is removed, so the absence of an entry never establishes completion.
//!
//! Deliberate trade-off: pages show outstanding work only, not ready or
//! successful-empty outcomes, which would need persisted acknowledgements.
//! Items whose only pending work is a queued index batch (up to 10 minutes) are
//! still listed on the processing page; that noise was accepted.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize)]
pub enum Stage {
  Title,
  PdfExtraction,
  ImageExtraction,
  Fragments,
  PdfCaption,
  Location,
  ContentIndex,
}

impl Stage {
  pub fn label(self) -> &'static str {
    match self {
      Stage::Title => "Title indexing",
      Stage::PdfExtraction => "PDF extraction",
      Stage::ImageExtraction => "Image extraction",
      Stage::Fragments => "Content preparation",
      Stage::PdfCaption => "PDF caption",
      Stage::Location => "Optional location",
      Stage::ContentIndex => "Content indexing",
    }
  }

  /// Optional enrichment never puts an item on the status pages.
  fn is_required(self) -> bool {
    self != Stage::Location
  }

  /// Title and content are independent tracks. Within a track, a problem at
  /// one stage explains waiting at later stages, so it takes precedence.
  fn is_title_track(self) -> bool {
    self == Stage::Title
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum Phase {
  /// Queued by a startup scan to verify existing outputs; not known to be outstanding.
  Checking,
  Queued,
  Processing,
  /// Automatic retry is scheduled because a dependency is unavailable or busy.
  Waiting,
  /// Retry is still scheduled, but the problem is unlikely to resolve by itself.
  NeedsAttention,
}

#[derive(Clone, Debug, Serialize)]
pub struct StageActivity {
  pub stage: Stage,
  pub label: &'static str,
  pub phase: Phase,
  pub detail: Option<String>,
  pub retry_at_unix_secs: Option<i64>,
}

struct Entry {
  phase: Phase,
  detail: Option<String>,
  retry_at_unix_secs: Option<i64>,
  /// Queued again while an attempt was running, so completion leaves it queued.
  queued_again: bool,
}

impl Entry {
  fn new(phase: Phase) -> Entry {
    Entry { phase, detail: None, retry_at_unix_secs: None, queued_again: false }
  }
}

type Key = (String, String, Stage);

static ACTIVITY: Lazy<Mutex<BTreeMap<Key, Entry>>> = Lazy::new(|| Mutex::new(BTreeMap::new()));
static STARTUP_SCANS_PENDING: AtomicUsize = AtomicUsize::new(0);

fn key(user_id: &str, item_id: &str, stage: Stage) -> Key {
  (user_id.to_owned(), item_id.to_owned(), stage)
}

fn with_entries(f: impl FnOnce(&mut BTreeMap<Key, Entry>)) {
  if let Ok(mut entries) = ACTIVITY.lock() {
    f(&mut entries);
  }
}

/// Work was added to a queue. Does not hide a scheduled retry.
pub fn queued(user_id: &str, item_id: &str, stage: Stage) {
  with_entries(|entries| {
    let entry = entries.entry(key(user_id, item_id, stage)).or_insert_with(|| Entry::new(Phase::Queued));
    match entry.phase {
      Phase::Checking => entry.phase = Phase::Queued,
      Phase::Processing => entry.queued_again = true,
      Phase::Queued | Phase::Waiting | Phase::NeedsAttention => {}
    }
  });
}

/// Work was queued and any scheduled retry delay was cleared.
pub fn due(user_id: &str, item_id: &str, stage: Stage) {
  with_entries(|entries| {
    let entry = entries.entry(key(user_id, item_id, stage)).or_insert_with(|| Entry::new(Phase::Queued));
    match entry.phase {
      Phase::Processing => entry.queued_again = true,
      Phase::Waiting | Phase::NeedsAttention => *entry = Entry::new(Phase::Queued),
      Phase::Checking | Phase::Queued => {}
    }
  });
}

/// A startup scan queued this work only to verify it.
pub fn checking(user_id: &str, item_id: &str, stage: Stage) {
  with_entries(|entries| {
    if let Some(entry) = entries.get_mut(&key(user_id, item_id, stage)) {
      if entry.phase == Phase::Queued {
        entry.phase = Phase::Checking;
      }
    }
  });
}

pub fn running(user_id: &str, item_id: &str, stage: Stage) {
  with_entries(|entries| {
    entries.insert(key(user_id, item_id, stage), Entry::new(Phase::Processing));
  });
}

pub fn done(user_id: &str, item_id: &str, stage: Stage) {
  with_entries(|entries| {
    let key = key(user_id, item_id, stage);
    match entries.get_mut(&key) {
      Some(entry) if entry.queued_again => *entry = Entry::new(Phase::Queued),
      Some(_) => {
        entries.remove(&key);
      }
      None => {}
    }
  });
}

/// The attempt failed and the worker has scheduled another one.
pub fn retry(user_id: &str, item_id: &str, stage: Stage, detail: &str, delay: Duration) {
  let phase = if stage.is_required() && needs_attention(detail) { Phase::NeedsAttention } else { Phase::Waiting };
  let retry_at_unix_secs = infusdk::util::time::unix_now_secs_i64().ok().map(|now| now + delay.as_secs() as i64);
  with_entries(|entries| {
    entries.insert(
      key(user_id, item_id, stage),
      Entry { phase, detail: Some(detail.to_owned()), retry_at_unix_secs, queued_again: false },
    );
  });
}

/// The work was removed from its queue without completing, e.g. the item changed kind.
pub fn forget_stage(user_id: &str, item_id: &str, stage: Stage) {
  with_entries(|entries| {
    entries.remove(&key(user_id, item_id, stage));
  });
}

pub fn forget(user_id: &str, item_id: &str) {
  with_entries(|entries| entries.retain(|(owner, id, _), _| owner != user_id || id != item_id));
}

/// Dependency outages and waits on an earlier stage resolve without intervention.
/// Everything else (missing configuration or capability, password protection,
/// rejected documents, missing sources, local processing and index failures)
/// is still retried, but is reported as needing attention.
fn needs_attention(detail: &str) -> bool {
  const WAITING_MARKERS: &[&str] = &[
    "waiting for",
    "endpoint unavailable",
    "could not call gpu tools discovery endpoint",
    "could not read gpu tools discovery response",
    "gpu tools discovery endpoint",
    "timed out",
    "request failed:",
    "http 5",
  ];
  let detail = detail.to_lowercase();
  !WAITING_MARKERS.iter().any(|marker| detail.contains(marker))
}

pub fn begin_startup_scan() {
  STARTUP_SCANS_PENDING.fetch_add(1, Ordering::SeqCst);
}

pub fn end_startup_scan() {
  STARTUP_SCANS_PENDING.fetch_sub(1, Ordering::SeqCst);
}

#[derive(Clone, Debug, Default)]
pub struct UserActivitySummary {
  pub processing_item_ids: BTreeSet<String>,
  pub attention_item_ids: BTreeSet<String>,
  /// Current state is not yet established for every item.
  pub checking: bool,
}

pub fn user_summary(user_id: &str) -> UserActivitySummary {
  let mut summary = UserActivitySummary::default();
  summary.checking = STARTUP_SCANS_PENDING.load(Ordering::SeqCst) > 0;
  let mut active_tracks = BTreeSet::new();
  let mut attention_tracks = BTreeSet::new();
  if let Ok(entries) = ACTIVITY.lock() {
    for ((_, item_id, stage), entry) in entries.iter().filter(|((owner, _, _), _)| owner == user_id) {
      if !stage.is_required() {
        continue;
      }
      let track = (item_id.clone(), stage.is_title_track());
      match entry.phase {
        Phase::Checking => summary.checking = true,
        Phase::Queued | Phase::Processing | Phase::Waiting => {
          active_tracks.insert(track);
        }
        Phase::NeedsAttention => {
          attention_tracks.insert(track);
        }
      }
    }
  }
  for (item_id, _) in active_tracks.difference(&attention_tracks) {
    summary.processing_item_ids.insert(item_id.clone());
  }
  summary.attention_item_ids = attention_tracks.into_iter().map(|(item_id, _)| item_id).collect();
  summary
}

pub fn item_activity(user_id: &str, item_id: &str) -> Vec<StageActivity> {
  let Ok(entries) = ACTIVITY.lock() else { return vec![] };
  entries
    .iter()
    .filter(|((owner, id, _), _)| owner == user_id && id == item_id)
    .map(|((_, _, stage), entry)| StageActivity {
      stage: *stage,
      label: stage.label(),
      phase: entry.phase,
      detail: entry.detail.clone(),
      retry_at_unix_secs: entry.retry_at_unix_secs,
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn completion_after_requeue_leaves_work_queued() {
    let (user, item) = ("activity-test-user-1", "item");
    queued(user, item, Stage::Fragments);
    running(user, item, Stage::Fragments);
    queued(user, item, Stage::Fragments);
    done(user, item, Stage::Fragments);
    assert_eq!(item_activity(user, item)[0].phase, Phase::Queued);
    running(user, item, Stage::Fragments);
    done(user, item, Stage::Fragments);
    assert!(item_activity(user, item).is_empty());
  }

  #[test]
  fn classifies_dependency_waits_separately_from_problems() {
    let (user, item) = ("activity-test-user-2", "item");
    retry(user, item, Stage::PdfExtraction, "Text extraction endpoint unavailable: refused", Duration::ZERO);
    retry(user, item, Stage::Location, "Location lookup failed.", Duration::ZERO);
    let summary = user_summary(user);
    assert!(summary.processing_item_ids.contains(item) && summary.attention_item_ids.is_empty());

    retry(user, item, Stage::PdfExtraction, "PDF processing service is not configured.", Duration::ZERO);
    retry(user, item, Stage::Fragments, "Waiting for PDF text extraction.", Duration::ZERO);
    let summary = user_summary(user);
    assert!(summary.attention_item_ids.contains(item) && summary.processing_item_ids.is_empty());

    queued(user, item, Stage::Title);
    assert!(user_summary(user).processing_item_ids.contains(item));
    forget(user, item);
    assert!(user_summary(user).attention_item_ids.is_empty());
  }

  #[test]
  fn startup_checks_are_not_listed_until_they_run() {
    let (user, item) = ("activity-test-user-3", "item");
    queued(user, item, Stage::ImageExtraction);
    checking(user, item, Stage::ImageExtraction);
    let summary = user_summary(user);
    assert!(summary.checking && summary.processing_item_ids.is_empty());
    running(user, item, Stage::ImageExtraction);
    assert!(user_summary(user).processing_item_ids.contains(item));
  }

  #[test]
  fn due_work_replaces_a_scheduled_retry() {
    let (user, item) = ("activity-test-user-4", "item");
    retry(user, item, Stage::Fragments, "Waiting for successful image extraction.", Duration::from_secs(60));
    queued(user, item, Stage::Fragments);
    assert_eq!(item_activity(user, item)[0].phase, Phase::Waiting);
    due(user, item, Stage::Fragments);
    assert_eq!(item_activity(user, item)[0].phase, Phase::Queued);
  }
}
