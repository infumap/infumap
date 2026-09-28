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

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use log::{Level, info};
use once_cell::sync::Lazy;
use serde::Serialize;

use crate::storage::db::Db;

/// How often progress is logged while search work is outstanding.
const PROGRESS_REPORT_INTERVAL: Duration = Duration::from_secs(120);

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

  /// Index stages commit queued work in batches rather than one item at a time.
  fn is_batched_index(self) -> bool {
    matches!(self, Stage::Title | Stage::ContentIndex)
  }

  /// Title and content are independent tracks. Within a track, a problem at
  /// one stage explains waiting at later stages, so it takes precedence.
  fn is_title_track(self) -> bool {
    self == Stage::Title
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum Phase {
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
  started_at: Option<Instant>,
}

impl Entry {
  fn new(phase: Phase) -> Entry {
    Entry { phase, detail: None, retry_at_unix_secs: None, queued_again: false, started_at: None }
  }
}

/// Outcomes since the last progress report.
#[derive(Default)]
struct StageOutcomes {
  done: u64,
  failed: u64,
  latest_failure: Option<String>,
}

type Key = (String, String, Stage);

static ACTIVITY: Lazy<Mutex<BTreeMap<Key, Entry>>> = Lazy::new(|| Mutex::new(BTreeMap::new()));
static STARTUP_SCANS_PENDING: AtomicUsize = AtomicUsize::new(0);
static OUTCOMES: Lazy<Mutex<BTreeMap<Stage, StageOutcomes>>> = Lazy::new(|| Mutex::new(BTreeMap::new()));
/// When the open batch window of each index stage closes and its batch commits.
static BATCH_COMMITS: Lazy<Mutex<BTreeMap<Stage, Instant>>> = Lazy::new(|| Mutex::new(BTreeMap::new()));

fn record_outcome(stage: Stage, failure: Option<&str>) {
  if let Ok(mut outcomes) = OUTCOMES.lock() {
    let outcome = outcomes.entry(stage).or_default();
    match failure {
      Some(detail) => {
        outcome.failed += 1;
        outcome.latest_failure = Some(detail.to_owned());
      }
      None => outcome.done += 1,
    }
  }
}

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
      Phase::Queued => {}
    }
  });
}

pub fn running(user_id: &str, item_id: &str, stage: Stage) {
  with_entries(|entries| {
    let mut entry = Entry::new(Phase::Processing);
    entry.started_at = Some(Instant::now());
    entries.insert(key(user_id, item_id, stage), entry);
  });
}

pub fn done(user_id: &str, item_id: &str, stage: Stage) {
  let mut completed = false;
  with_entries(|entries| {
    let key = key(user_id, item_id, stage);
    if let Some(entry) = entries.get_mut(&key) {
      completed = entry.phase == Phase::Processing;
      if entry.queued_again {
        *entry = Entry::new(Phase::Queued);
      } else {
        entries.remove(&key);
      }
    }
  });
  if completed {
    record_outcome(stage, None);
  }
}

/// An index worker opened a batch window that commits at `commit_at`.
pub fn batch_window_opened(stage: Stage, commit_at: Instant) {
  if let Ok(mut commits) = BATCH_COMMITS.lock() {
    commits.insert(stage, commit_at);
  }
}

/// The batch window closed and its batch is being committed.
pub fn batch_window_closed(stage: Stage) {
  if let Ok(mut commits) = BATCH_COMMITS.lock() {
    commits.remove(&stage);
  }
}

/// The attempt failed and the worker has scheduled another one.
pub fn retry(user_id: &str, item_id: &str, stage: Stage, detail: &str, delay: Duration) {
  let phase = if stage.is_required() && needs_attention(detail) { Phase::NeedsAttention } else { Phase::Waiting };
  let retry_at_unix_secs = infusdk::util::time::unix_now_secs_i64().ok().map(|now| now + delay.as_secs() as i64);
  with_entries(|entries| {
    entries.insert(
      key(user_id, item_id, stage),
      Entry { phase, detail: Some(detail.to_owned()), retry_at_unix_secs, queued_again: false, started_at: None },
    );
  });
  record_outcome(stage, Some(detail));
}

/// Log level for one failed attempt. A problem needing attention is logged as
/// a warning the first time an item hits it after startup; dependency waits and
/// repeated failures are debug only. The periodic progress report shows failure
/// counts and the latest reason, so outages do not flood the log.
pub fn failure_log_level(detail: &str, attempt: u32) -> Level {
  if attempt <= 1 && needs_attention(detail) { Level::Warn } else { Level::Debug }
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

struct StageReport {
  stage: Stage,
  queued: usize,
  processing: Vec<(String, Duration)>,
  waiting: usize,
  attention: usize,
  /// Time until the open batch window commits, for batched index stages.
  commit_in: Option<Duration>,
  done: u64,
  failed: u64,
  latest_failure: Option<String>,
}

impl StageReport {
  fn is_empty(&self) -> bool {
    self.queued + self.processing.len() + self.waiting + self.attention == 0 && self.done + self.failed == 0
  }

  fn render(&self, titles: &HashMap<String, String>) -> String {
    let mut parts = Vec::new();
    match self.processing.as_slice() {
      [] => {}
      [(item_id, elapsed)] => parts.push(format!(
        "processing '{}' ({}) for {}",
        titles.get(item_id).map(String::as_str).unwrap_or("untitled"),
        item_id,
        format_elapsed(*elapsed)
      )),
      processing => parts.push(format!(
        "processing {} (longest {})",
        processing.len(),
        format_elapsed(processing.iter().map(|(_, elapsed)| *elapsed).max().unwrap_or_default())
      )),
    }
    // Queued index work only reaches search when its batch commits.
    let queued_label = match (self.stage.is_batched_index(), self.commit_in) {
      (true, Some(commit_in)) => format!("queued for batched index commit in {}", format_elapsed(commit_in)),
      (true, None) => "queued for next batched index commit".to_owned(),
      (false, _) => "queued".to_owned(),
    };
    for (count, label) in
      [(self.queued, queued_label.as_str()), (self.waiting, "waiting to retry"), (self.attention, "need attention")]
    {
      if count > 0 {
        parts.push(format!("{} {}", count, label));
      }
    }
    let mut line = format!("Search progress: {}: {}", self.stage.label(), parts.join(", "));
    if self.done + self.failed > 0 {
      if parts.is_empty() {
        line.push_str("idle");
      }
      line.push_str(&format!(
        "; last {}m: {} done, {} retrying",
        PROGRESS_REPORT_INTERVAL.as_secs() / 60,
        self.done,
        self.failed
      ));
      if let Some(failure) = &self.latest_failure {
        line.push_str(&format!(" (latest: {})", truncate(failure, 160)));
      }
    }
    line
  }
}

fn stage_report(reports: &mut BTreeMap<Stage, StageReport>, stage: Stage) -> &mut StageReport {
  reports.entry(stage).or_insert_with(|| StageReport {
    stage,
    queued: 0,
    processing: Vec::new(),
    waiting: 0,
    attention: 0,
    commit_in: None,
    done: 0,
    failed: 0,
    latest_failure: None,
  })
}

fn take_progress_report() -> Vec<StageReport> {
  let mut reports = BTreeMap::<Stage, StageReport>::new();
  if let Ok(entries) = ACTIVITY.lock() {
    for ((_, item_id, stage), entry) in entries.iter() {
      let stage_report = stage_report(&mut reports, *stage);
      match entry.phase {
        Phase::Queued => stage_report.queued += 1,
        Phase::Processing => stage_report
          .processing
          .push((item_id.clone(), entry.started_at.map(|started| started.elapsed()).unwrap_or_default())),
        Phase::Waiting => stage_report.waiting += 1,
        Phase::NeedsAttention => stage_report.attention += 1,
      }
    }
  }
  if let Ok(mut outcomes) = OUTCOMES.lock() {
    for (stage, outcome) in std::mem::take(&mut *outcomes) {
      let stage_report = stage_report(&mut reports, stage);
      stage_report.done = outcome.done;
      stage_report.failed = outcome.failed;
      stage_report.latest_failure = outcome.latest_failure;
    }
  }
  if let Ok(commits) = BATCH_COMMITS.lock() {
    for (stage, commit_at) in commits.iter() {
      if let Some(report) = reports.get_mut(stage) {
        report.commit_in = Some(commit_at.saturating_duration_since(Instant::now()));
      }
    }
  }
  reports.into_values().filter(|report| !report.is_empty()).collect()
}

/// Logs one line per active stage every couple of minutes while search work is
/// outstanding or has just happened, and one line when it becomes idle.
pub fn spawn_progress_logger(db: Arc<tokio::sync::Mutex<Db>>) {
  tokio::spawn(async move {
    let mut was_active = false;
    loop {
      tokio::time::sleep(PROGRESS_REPORT_INTERVAL).await;
      let reports = take_progress_report();
      if reports.is_empty() {
        if was_active {
          info!("Search progress: all search processing is idle.");
        }
        was_active = false;
        continue;
      }
      was_active = true;
      let titles = {
        let db = db.lock().await;
        reports
          .iter()
          .filter(|report| report.processing.len() == 1)
          .flat_map(|report| report.processing.iter())
          .filter_map(|(item_id, _)| {
            let title = db.item.get(item_id).ok()?.title.clone()?;
            Some((item_id.clone(), truncate(&title, 60)))
          })
          .collect::<HashMap<_, _>>()
      };
      for report in reports {
        info!("{}", report.render(&titles));
      }
    }
  });
}

fn format_elapsed(elapsed: Duration) -> String {
  let secs = elapsed.as_secs();
  if secs >= 60 { format!("{}m{:02}s", secs / 60, secs % 60) } else { format!("{}s", secs) }
}

fn truncate(text: &str, max_chars: usize) -> String {
  if text.chars().count() <= max_chars {
    text.to_owned()
  } else {
    format!("{}...", text.chars().take(max_chars).collect::<String>())
  }
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
  fn queued_index_work_reports_batched_commit() {
    let report = |stage, commit_in| StageReport {
      stage,
      queued: 2,
      processing: Vec::new(),
      waiting: 0,
      attention: 0,
      commit_in,
      done: 0,
      failed: 0,
      latest_failure: None,
    };
    let titles = HashMap::new();
    assert_eq!(
      report(Stage::ContentIndex, Some(Duration::from_secs(492))).render(&titles),
      "Search progress: Content indexing: 2 queued for batched index commit in 8m12s"
    );
    assert_eq!(
      report(Stage::Title, None).render(&titles),
      "Search progress: Title indexing: 2 queued for next batched index commit"
    );
    assert_eq!(report(Stage::Fragments, None).render(&titles), "Search progress: Content preparation: 2 queued");
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
