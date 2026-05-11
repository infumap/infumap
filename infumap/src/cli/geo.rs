use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use clap::{Arg, ArgMatches, Command};
use infusdk::util::infu::InfuResult;
use log::info;
use tokio::sync::Mutex;
use tokio::time::sleep;

use super::build_http_client;
use crate::ai::geo::{
  GeoCandidate, GeoProcessOutcome, GeoRequestThrottle, GeoRunSummary, geoapify_max_requests_per_minute_from_config,
  geoapify_url_from_config, resolve_geoapify_api_key, reverse_geocode_candidate_if_needed,
};
use crate::config::CONFIG_DATA_DIR;
use crate::setup::get_config;
use crate::storage::db::Db;

pub fn make_clap_subcommand() -> Command {
  Command::new("geo")
    .about("Reverse geocode GPS-tagged images that already have image-tag output.")
    .arg(settings_arg())
    .arg(
      Arg::new("service_url")
        .long("service-url")
        .help("Reverse geocoding service URL. Falls back to geoapify_url in settings.toml.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("item_id")
        .long("item-id")
        .help("Reverse geocode only this supported image item. Existing geo artifacts are overwritten. Exits after one item.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("overwrite")
        .long("overwrite")
        .help("Reprocess items even if geo artifacts already exist.")
        .num_args(0)
        .required(false),
    )
    .arg(
      Arg::new("max_requests")
        .long("max-requests")
        .help("Maximum number of external reverse-geocoding API requests to send in this run. Cached repeats do not count.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("delay_secs")
        .long("delay-secs")
        .help("Sleep for this many seconds after each external reverse-geocoding request.")
        .num_args(1)
        .required(false),
    )
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let db = Arc::new(Mutex::new(Db::new(&data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?));

  let api_key = resolve_geoapify_api_key(&config)?;
  let service_url =
    match sub_matches.get_one::<String>("service_url").map(|value| value.trim()).filter(|value| !value.is_empty()) {
      Some(value) => value.to_owned(),
      None => geoapify_url_from_config(&config)?,
    };
  let overwrite = sub_matches.get_flag("overwrite") || sub_matches.get_one::<String>("item_id").is_some();
  let max_requests = parse_optional_usize(sub_matches, "max_requests")?;
  let delay = parse_delay_secs(sub_matches)?;
  let geo_max_requests_per_minute = geoapify_max_requests_per_minute_from_config(&config)?;

  let candidates =
    load_candidates(db.clone(), sub_matches.get_one::<String>("item_id").map(|value| value.as_str())).await?;
  if candidates.is_empty() {
    println!("No supported images matched.");
    return Ok(());
  }

  let client = build_http_client(None).await?;
  let mut cache = HashMap::new();
  let mut summary = GeoRunSummary::default();
  let mut throttle = GeoRequestThrottle::new(geo_max_requests_per_minute);

  info!(
    "Running reverse geocoding for {} supported image(s) using '{}' (overwrite={}, delay {:.3}s).",
    candidates.len(),
    service_url,
    overwrite,
    delay.as_secs_f64()
  );

  for candidate in candidates {
    if let Some(limit) = max_requests
      && summary.external_requests >= limit
    {
      info!("Stopping reverse geocoding after reaching --max-requests={}.", limit);
      break;
    }

    let outcome = reverse_geocode_candidate_if_needed(
      &data_dir,
      &client,
      &service_url,
      &api_key,
      &candidate,
      overwrite,
      &mut cache,
      Some(&mut throttle),
    )
    .await?;
    let sent_external_request = outcome.sent_external_request();
    summary.record(&outcome);

    if let GeoProcessOutcome::Deferred { reason, retry_after_secs } = outcome {
      println!(
        "Stopping reverse geocoding: Geoapify reported {}; try again after {}.",
        reason.label(),
        format_duration_for_display(Duration::from_secs(retry_after_secs.max(1)))
      );
      break;
    }

    if sent_external_request && delay > Duration::ZERO {
      sleep(delay).await;
    }
  }

  print_summary(&summary);
  Ok(())
}

async fn load_candidates(db: Arc<Mutex<Db>>, item_id_maybe: Option<&str>) -> InfuResult<Vec<GeoCandidate>> {
  let mut db = db.lock().await;
  let all_user_ids: Vec<String> = db.user.all_user_ids().iter().map(|value| value.clone()).collect();
  for user_id in &all_user_ids {
    db.item.load_user_items(user_id, false).await?;
  }

  let mut candidates = db
    .item
    .all_loaded_items()
    .into_iter()
    .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().and_then(GeoCandidate::from_item))
    .collect::<Vec<GeoCandidate>>();

  candidates.sort_by(|a, b| a.user_id.cmp(&b.user_id).then(a.item_id.cmp(&b.item_id)));

  if let Some(item_id) = item_id_maybe {
    let filtered = candidates.into_iter().filter(|candidate| candidate.item_id == item_id).collect::<Vec<_>>();
    if filtered.is_empty() {
      return Err(format!("Item '{}' is not a supported image or was not found.", item_id).into());
    }
    return Ok(filtered);
  }

  Ok(candidates)
}

fn parse_optional_usize(sub_matches: &ArgMatches, key: &str) -> InfuResult<Option<usize>> {
  match sub_matches.get_one::<String>(key) {
    Some(value) => {
      let parsed =
        value.parse::<usize>().map_err(|e| format!("Could not parse --{} as usize: {}", key.replace('_', "-"), e))?;
      Ok(Some(parsed))
    }
    None => Ok(None),
  }
}

fn parse_delay_secs(sub_matches: &ArgMatches) -> InfuResult<Duration> {
  match sub_matches.get_one::<String>("delay_secs") {
    Some(value) => {
      let parsed = value.parse::<f64>().map_err(|e| format!("Could not parse --delay-secs as number: {}", e))?;
      if parsed < 0.0 {
        return Err("--delay-secs must be non-negative.".into());
      }
      Ok(Duration::from_secs_f64(parsed))
    }
    None => Ok(Duration::ZERO),
  }
}

fn print_summary(summary: &GeoRunSummary) {
  println!("Reverse geocoding complete.");
  println!("  succeeded: {}", summary.succeeded);
  println!("  failed: {}", summary.failed);
  println!("  skipped existing: {}", summary.skipped_existing);
  println!("  skipped no gps: {}", summary.skipped_no_gps);
  println!("  skipped without image tag output: {}", summary.skipped_without_image_tag_output);
  println!("  deferred: {}", summary.deferred);
  println!("  deferred quota exhausted: {}", summary.deferred_quota_exhausted);
  println!("  deferred rate limited: {}", summary.deferred_rate_limited);
  println!("  external requests: {}", summary.external_requests);
  println!("  cache hits: {}", summary.cache_hits);
}

fn format_duration_for_display(duration: Duration) -> String {
  if duration.as_secs() >= 24 * 60 * 60 && duration.as_secs() % (24 * 60 * 60) == 0 {
    let days = duration.as_secs() / (24 * 60 * 60);
    return if days == 1 { "1 day".to_owned() } else { format!("{} days", days) };
  }
  if duration.as_secs() >= 60 * 60 && duration.as_secs() % (60 * 60) == 0 {
    let hours = duration.as_secs() / (60 * 60);
    return if hours == 1 { "1 hour".to_owned() } else { format!("{} hours", hours) };
  }
  if duration.as_secs() >= 60 && duration.as_secs() % 60 == 0 {
    let minutes = duration.as_secs() / 60;
    return if minutes == 1 { "1 minute".to_owned() } else { format!("{} minutes", minutes) };
  }
  if duration.subsec_nanos() == 0 {
    let seconds = duration.as_secs();
    return if seconds == 1 { "1 second".to_owned() } else { format!("{} seconds", seconds) };
  }
  format!("{:.3} seconds", duration.as_secs_f64())
}

fn settings_arg() -> Arg {
  Arg::new("settings_path")
    .short('s')
    .long("settings")
    .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
    .num_args(1)
    .required(false)
}
