use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use clap::{Arg, ArgMatches, Command};
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::info;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;
use tokio::sync::Mutex;
use tokio::time::sleep;

use super::build_http_client;
use crate::config::CONFIG_DATA_DIR;
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::util::fs::{ensure_256_subdirs, expand_tilde, path_exists};
use crate::web::image_tagging::is_supported_image_tagging_mime_type;

const DEFAULT_GEOAPIFY_REVERSE_URL: &str = "https://api.geoapify.com/v1/geocode/reverse";
const JSON_CONTENT_MIME_TYPE: &str = "application/json";
const GEO_MANIFEST_SCHEMA_VERSION: u32 = 1;
const GEOAPIFY_PROVIDER_NAME: &str = "geoapify";
const GEOAPIFY_API_KEY_ENV_VAR: &str = "INFUMAP_GEOAPIFY_API_KEY";

pub fn make_clap_subcommand() -> Command {
  Command::new("geo")
    .about("Reverse geocode GPS-tagged images that already have image-tag output.")
    .arg(settings_arg())
    .arg(
      Arg::new("api_key")
        .long("api-key")
        .help("Geoapify API key. Defaults to INFUMAP_GEOAPIFY_API_KEY.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("service_url")
        .long("service-url")
        .help("Reverse geocoding service URL.")
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

  let api_key = resolve_api_key(sub_matches)?;
  let service_url = sub_matches
    .get_one::<String>("service_url")
    .map(|value| value.trim().to_owned())
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| DEFAULT_GEOAPIFY_REVERSE_URL.to_owned());
  let overwrite = sub_matches.get_flag("overwrite") || sub_matches.get_one::<String>("item_id").is_some();
  let max_requests = parse_optional_usize(sub_matches, "max_requests")?;
  let delay = parse_delay_secs(sub_matches)?;

  let candidates =
    load_candidates(db.clone(), sub_matches.get_one::<String>("item_id").map(|value| value.as_str())).await?;
  if candidates.is_empty() {
    println!("No supported images matched.");
    return Ok(());
  }

  let client = build_http_client(None).await?;
  let mut cache = HashMap::<String, Value>::new();
  let mut summary = GeoRunSummary::default();

  info!(
    "Running reverse geocoding for {} supported image(s) using '{}' (overwrite={}, delay {:.3}s).",
    candidates.len(),
    service_url,
    overwrite,
    delay.as_secs_f64()
  );

  for candidate in candidates {
    if let Some(limit) = max_requests {
      if summary.external_requests >= limit {
        info!("Stopping reverse geocoding after reaching --max-requests={}.", limit);
        break;
      }
    }

    let image_tag_path = image_tag_text_path(&data_dir, &candidate.user_id, &candidate.item_id)?;
    if !path_exists(&image_tag_path).await {
      summary.skipped_without_image_tag_output += 1;
      continue;
    }

    let geo_manifest_path = geo_manifest_path(&data_dir, &candidate.user_id, &candidate.item_id)?;
    if !overwrite && existing_geo_manifest_should_skip(&geo_manifest_path).await? {
      summary.skipped_existing += 1;
      continue;
    }

    let image_tag_bytes = match fs::read(&image_tag_path).await {
      Ok(bytes) => bytes,
      Err(e) => {
        write_failed_geo_manifest(
          &data_dir,
          &candidate,
          &service_url,
          None,
          None,
          false,
          None,
          &format!("Could not read image-tag output '{}': {}", image_tag_path.display(), e),
        )
        .await?;
        summary.failed += 1;
        continue;
      }
    };

    let coords = match extract_geo_query_coordinates(&image_tag_bytes) {
      Ok(coords) => coords,
      Err(e) => {
        let error_message = e.to_string();
        write_failed_geo_manifest(&data_dir, &candidate, &service_url, None, None, false, None, &error_message).await?;
        summary.failed += 1;
        continue;
      }
    };

    let Some((lat, lon)) = coords else {
      write_skipped_geo_manifest(
        &data_dir,
        &candidate,
        &service_url,
        None,
        None,
        false,
        "No GPS latitude/longitude found in image metadata.",
      )
      .await?;
      summary.skipped_no_gps += 1;
      continue;
    };

    let cache_key = format!("{lat:.7},{lon:.7}");
    if let Some(cached_response) = cache.get(&cache_key) {
      write_success_geo_artifacts(&data_dir, &candidate, &service_url, lat, lon, true, Some(0), cached_response)
        .await?;
      summary.succeeded += 1;
      summary.cache_hits += 1;
      continue;
    }

    let request_started_at = Instant::now();
    match reverse_geocode(&client, &service_url, &api_key, lat, lon).await {
      Ok(response_json) => {
        let duration_ms = elapsed_millis(request_started_at.elapsed());
        cache.insert(cache_key, response_json.clone());
        write_success_geo_artifacts(
          &data_dir,
          &candidate,
          &service_url,
          lat,
          lon,
          false,
          Some(duration_ms),
          &response_json,
        )
        .await?;
        summary.succeeded += 1;
        summary.external_requests += 1;
        if delay > Duration::ZERO {
          sleep(delay).await;
        }
      }
      Err(e) => {
        let duration_ms = elapsed_millis(request_started_at.elapsed());
        let error_message = e.to_string();
        write_failed_geo_manifest(
          &data_dir,
          &candidate,
          &service_url,
          Some(lat),
          Some(lon),
          false,
          Some(duration_ms),
          &error_message,
        )
        .await?;
        summary.failed += 1;
        summary.external_requests += 1;
        if delay > Duration::ZERO {
          sleep(delay).await;
        }
      }
    }
  }

  print_summary(&summary);
  Ok(())
}

#[derive(Clone)]
struct GeoCandidate {
  user_id: String,
  item_id: String,
  mime_type: String,
}

impl GeoCandidate {
  fn from_item(item: &Item) -> Option<GeoCandidate> {
    let mime_type = item.mime_type.as_deref()?;
    if !is_supported_image_tagging_mime_type(Some(mime_type)) {
      return None;
    }
    Some(GeoCandidate { user_id: item.owner_id.clone(), item_id: item.id.clone(), mime_type: mime_type.to_owned() })
  }
}

#[derive(Default)]
struct GeoRunSummary {
  succeeded: usize,
  failed: usize,
  skipped_existing: usize,
  skipped_no_gps: usize,
  skipped_without_image_tag_output: usize,
  external_requests: usize,
  cache_hits: usize,
}

#[derive(Deserialize)]
struct StoredImageTagArtifact {
  image_metadata: Option<StoredImageMetadata>,
}

#[derive(Deserialize)]
struct StoredImageMetadata {
  gps_latitude: Option<f64>,
  gps_longitude: Option<f64>,
}

#[derive(Deserialize)]
struct GeoManifestSummary {
  #[serde(default)]
  status: String,
}

#[derive(Serialize, Deserialize)]
struct GeoManifest {
  schema_version: u32,
  status: String,
  source_mime_type: String,
  content_mime_type: String,
  extractor: GeoManifestExtractor,
  error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct GeoManifestExtractor {
  provider: String,
  service_url: String,
  reverse_geocoded_at_unix_secs: i64,
  duration_ms: Option<u64>,
  query_latitude: Option<f64>,
  query_longitude: Option<f64>,
  cached: bool,
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

fn resolve_api_key(sub_matches: &ArgMatches) -> InfuResult<String> {
  let from_flag =
    sub_matches.get_one::<String>("api_key").map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
  if let Some(value) = from_flag {
    return Ok(value);
  }

  let from_env =
    std::env::var(GEOAPIFY_API_KEY_ENV_VAR).ok().map(|value| value.trim().to_owned()).filter(|v| !v.is_empty());
  if let Some(value) = from_env {
    return Ok(value);
  }

  Err(format!("Missing Geoapify API key. Pass --api-key or set {}.", GEOAPIFY_API_KEY_ENV_VAR).into())
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

async fn existing_geo_manifest_should_skip(path: &PathBuf) -> InfuResult<bool> {
  if !path_exists(path).await {
    return Ok(false);
  }
  let bytes = fs::read(path).await?;
  let manifest = match serde_json::from_slice::<GeoManifestSummary>(&bytes) {
    Ok(manifest) => manifest,
    Err(_) => return Ok(false),
  };
  Ok(matches!(manifest.status.as_str(), "succeeded" | "failed" | "skipped"))
}

fn extract_geo_query_coordinates(bytes: &[u8]) -> InfuResult<Option<(f64, f64)>> {
  let artifact: StoredImageTagArtifact = serde_json::from_slice(bytes)
    .map_err(|e| format!("Could not parse image-tag output JSON while looking for GPS coordinates: {}", e))?;
  let Some(metadata) = artifact.image_metadata else {
    return Ok(None);
  };
  match (metadata.gps_latitude, metadata.gps_longitude) {
    (Some(lat), Some(lon)) => Ok(Some((lat, lon))),
    _ => Ok(None),
  }
}

async fn reverse_geocode(
  client: &reqwest::Client,
  service_url: &str,
  api_key: &str,
  lat: f64,
  lon: f64,
) -> InfuResult<Value> {
  let response = client
    .get(service_url)
    .query(&[
      ("lat", lat.to_string()),
      ("lon", lon.to_string()),
      ("format", "json".to_owned()),
      ("apiKey", api_key.to_owned()),
    ])
    .send()
    .await
    .map_err(|e| format!("Reverse geocoding request failed: {}", e))?;

  let status = response.status();
  let body = response.text().await.map_err(|e| format!("Could not read reverse geocoding response body: {}", e))?;
  if !status.is_success() {
    return Err(format!("Reverse geocoding service returned HTTP {}: {}", status, body).into());
  }

  let parsed: Value =
    serde_json::from_str(&body).map_err(|e| format!("Could not parse reverse geocoding JSON response: {}", e))?;
  Ok(parsed)
}

async fn write_success_geo_artifacts(
  data_dir: &str,
  candidate: &GeoCandidate,
  service_url: &str,
  lat: f64,
  lon: f64,
  cached: bool,
  duration_ms: Option<u64>,
  response_json: &Value,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let content_path = geo_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = geo_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  fs::write(&content_path, serde_json::to_vec_pretty(response_json)?).await?;
  let manifest = GeoManifest {
    schema_version: GEO_MANIFEST_SCHEMA_VERSION,
    status: "succeeded".to_owned(),
    source_mime_type: candidate.mime_type.clone(),
    content_mime_type: JSON_CONTENT_MIME_TYPE.to_owned(),
    extractor: GeoManifestExtractor {
      provider: GEOAPIFY_PROVIDER_NAME.to_owned(),
      service_url: service_url.to_owned(),
      reverse_geocoded_at_unix_secs: unix_now_secs()?,
      duration_ms,
      query_latitude: Some(lat),
      query_longitude: Some(lon),
      cached,
    },
    error: None,
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  info!(
    "Reverse geocoded image '{}' (user {}){}.",
    candidate.item_id,
    candidate.user_id,
    if cached { " using in-memory cache" } else { "" }
  );
  Ok(())
}

async fn write_failed_geo_manifest(
  data_dir: &str,
  candidate: &GeoCandidate,
  service_url: &str,
  lat: Option<f64>,
  lon: Option<f64>,
  cached: bool,
  duration_ms: Option<u64>,
  error_message: &str,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let content_path = geo_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = geo_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  if path_exists(&content_path).await {
    fs::remove_file(&content_path).await?;
  }
  let manifest = GeoManifest {
    schema_version: GEO_MANIFEST_SCHEMA_VERSION,
    status: "failed".to_owned(),
    source_mime_type: candidate.mime_type.clone(),
    content_mime_type: JSON_CONTENT_MIME_TYPE.to_owned(),
    extractor: GeoManifestExtractor {
      provider: GEOAPIFY_PROVIDER_NAME.to_owned(),
      service_url: service_url.to_owned(),
      reverse_geocoded_at_unix_secs: unix_now_secs()?,
      duration_ms,
      query_latitude: lat,
      query_longitude: lon,
      cached,
    },
    error: Some(error_message.to_owned()),
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  info!("Reverse geocoding failed for image '{}' (user {}): {}", candidate.item_id, candidate.user_id, error_message);
  Ok(())
}

async fn write_skipped_geo_manifest(
  data_dir: &str,
  candidate: &GeoCandidate,
  service_url: &str,
  lat: Option<f64>,
  lon: Option<f64>,
  cached: bool,
  reason: &str,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let content_path = geo_content_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = geo_manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  if path_exists(&content_path).await {
    fs::remove_file(&content_path).await?;
  }
  let manifest = GeoManifest {
    schema_version: GEO_MANIFEST_SCHEMA_VERSION,
    status: "skipped".to_owned(),
    source_mime_type: candidate.mime_type.clone(),
    content_mime_type: JSON_CONTENT_MIME_TYPE.to_owned(),
    extractor: GeoManifestExtractor {
      provider: GEOAPIFY_PROVIDER_NAME.to_owned(),
      service_url: service_url.to_owned(),
      reverse_geocoded_at_unix_secs: unix_now_secs()?,
      duration_ms: None,
      query_latitude: lat,
      query_longitude: lon,
      cached,
    },
    error: Some(reason.to_owned()),
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  info!("Skipping reverse geocoding for image '{}' (user {}): {}", candidate.item_id, candidate.user_id, reason);
  Ok(())
}

fn image_tag_text_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}_text", item_id));
  Ok(path)
}

fn geo_content_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}_geo.json", item_id));
  Ok(path)
}

fn geo_manifest_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}_geo_manifest.json", item_id));
  Ok(path)
}

fn text_shard_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut text_dir = user_text_dir(data_dir, user_id)?;
  text_dir.push(&item_id[..2]);
  Ok(text_dir)
}

fn user_text_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("text");
  Ok(path)
}

async fn ensure_user_text_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let text_dir = user_text_dir(data_dir, user_id)?;
  if !path_exists(&text_dir).await {
    fs::create_dir_all(&text_dir).await?;
  }
  ensure_256_subdirs(&text_dir).await?;
  Ok(text_dir)
}

fn unix_now_secs() -> InfuResult<i64> {
  Ok(
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map_err(|e| format!("Could not determine current unix time: {}", e))?
      .as_secs() as i64,
  )
}

fn elapsed_millis(duration: Duration) -> u64 {
  duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn print_summary(summary: &GeoRunSummary) {
  println!("Reverse geocoding complete.");
  println!("  succeeded: {}", summary.succeeded);
  println!("  failed: {}", summary.failed);
  println!("  skipped existing: {}", summary.skipped_existing);
  println!("  skipped no gps: {}", summary.skipped_no_gps);
  println!("  skipped without image-tag output: {}", summary.skipped_without_image_tag_output);
  println!("  external requests: {}", summary.external_requests);
  println!("  cache hits: {}", summary.cache_hits);
}

fn settings_arg() -> Arg {
  Arg::new("settings_path")
    .short('s')
    .long("settings")
    .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
    .num_args(1)
    .required(false)
}
