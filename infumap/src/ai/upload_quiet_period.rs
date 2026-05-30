use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use log::{debug, info};
use once_cell::sync::Lazy;
use tokio::time::sleep;

pub const OBJECT_STORE_UPLOAD_QUIET_PERIOD_SECS: u64 = 10 * 60;

static PROCESS_STARTED_AT: Lazy<Instant> = Lazy::new(Instant::now);
static LAST_OBJECT_STORE_BACKED_UPLOAD_AT_MS: AtomicU64 = AtomicU64::new(0);

pub fn record_object_store_backed_item_upload(item_id: &str) {
  let uploaded_at_ms = elapsed_process_millis().saturating_add(1);
  LAST_OBJECT_STORE_BACKED_UPLOAD_AT_MS.store(uploaded_at_ms, Ordering::SeqCst);
  debug!(
    "Recorded object-store-backed upload for item '{}'; background extraction and indexing will wait for {} of upload quiet time.",
    item_id,
    format_duration_for_log(quiet_period())
  );
}

pub async fn wait_for_object_store_upload_quiet_period(worker_label: &str) {
  loop {
    let Some(remaining) = object_store_upload_quiet_period_remaining() else {
      return;
    };
    info!(
      "Deferring {} for {} because object-store-backed uploads are still inside the quiet period.",
      worker_label,
      format_duration_for_log(remaining)
    );
    sleep(remaining).await;
  }
}

fn object_store_upload_quiet_period_remaining() -> Option<Duration> {
  let uploaded_at_ms = LAST_OBJECT_STORE_BACKED_UPLOAD_AT_MS.load(Ordering::SeqCst);
  if uploaded_at_ms == 0 {
    return None;
  }

  let quiet_until_ms = uploaded_at_ms.saturating_add(duration_millis(quiet_period()));
  let now_ms = elapsed_process_millis();
  if now_ms >= quiet_until_ms { None } else { Some(Duration::from_millis(quiet_until_ms - now_ms)) }
}

fn quiet_period() -> Duration {
  Duration::from_secs(OBJECT_STORE_UPLOAD_QUIET_PERIOD_SECS)
}

fn elapsed_process_millis() -> u64 {
  duration_millis(PROCESS_STARTED_AT.elapsed())
}

fn duration_millis(duration: Duration) -> u64 {
  duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn format_duration_for_log(duration: Duration) -> String {
  if duration.as_secs() >= 60 && duration.as_secs() % 60 == 0 && duration.subsec_nanos() == 0 {
    let minutes = duration.as_secs() / 60;
    return if minutes == 1 { "1 minute".to_owned() } else { format!("{} minutes", minutes) };
  }
  if duration.as_secs() > 0 && duration.subsec_nanos() == 0 {
    let seconds = duration.as_secs();
    return if seconds == 1 { "1 second".to_owned() } else { format!("{} seconds", seconds) };
  }
  format!("{:.3} seconds", duration.as_secs_f64())
}
