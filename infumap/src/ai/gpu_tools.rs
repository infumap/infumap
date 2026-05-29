use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use config::Config;
use infusdk::util::infu::InfuResult;
use once_cell::sync::OnceCell;
use reqwest::Url;
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::config::CONFIG_GPU_TOOLS_URL;

pub const GPU_TOOL_IMAGE_EXTRACT: &str = "image_extract";
pub const GPU_TOOL_PDF_EXTRACT: &str = "pdf_extract";
pub const GPU_TOOL_PDF_EXTRACT_JOBS: &str = "pdf_extract_jobs";
pub const GPU_TOOL_PDF_EXTRACT_CAPTION_ONLY: &str = "pdf_extract_caption_only";
pub const GPU_TOOL_TEXT_EMBED: &str = "text_embed";

const DISCOVERY_PATH: &str = "/gpu-tools";
const DISCOVERY_REQUEST_TIMEOUT_SECS: u64 = 10;

static GPU_TOOLS_DISCOVERY_CACHE: OnceCell<Mutex<HashMap<String, Arc<GpuToolsDocument>>>> = OnceCell::new();

#[derive(Clone, Deserialize)]
struct GpuToolsDocument {
  schema_version: u32,
  endpoints: Vec<GpuToolEndpoint>,
}

#[derive(Clone, Deserialize)]
struct GpuToolEndpoint {
  id: String,
  path: String,
}

impl GpuToolsDocument {
  fn endpoint_path(&self, endpoint_id: &str) -> Option<&str> {
    self.endpoints.iter().find(|endpoint| endpoint.id == endpoint_id).map(|endpoint| endpoint.path.as_str())
  }
}

pub fn gpu_tools_url_from_config(config: &Config) -> InfuResult<Option<String>> {
  match config.get_string(CONFIG_GPU_TOOLS_URL) {
    Ok(value) => {
      let trimmed = value.trim();
      if trimmed.is_empty() { Ok(None) } else { Ok(Some(trimmed.to_owned())) }
    }
    Err(_) => Ok(None),
  }
}

pub async fn resolve_configured_gpu_tool_url(config: &Config, endpoint_id: &str) -> InfuResult<Option<Url>> {
  let gpu_tools_url = gpu_tools_url_from_config(config)?;
  resolve_gpu_tool_url(gpu_tools_url.as_deref(), endpoint_id).await
}

pub async fn resolve_gpu_tool_url(gpu_tools_url: Option<&str>, endpoint_id: &str) -> InfuResult<Option<Url>> {
  let Some(gpu_tools_url) = gpu_tools_url.map(str::trim).filter(|url| !url.is_empty()) else {
    return Ok(None);
  };
  let base_url = normalized_gpu_tools_base_url(gpu_tools_url)?;
  let discovery = cached_gpu_tools_discovery(&base_url).await?;
  let Some(endpoint_path) = discovery.endpoint_path(endpoint_id) else {
    return Ok(None);
  };
  Ok(Some(endpoint_url(&base_url, endpoint_path)?))
}

async fn cached_gpu_tools_discovery(base_url: &Url) -> InfuResult<Arc<GpuToolsDocument>> {
  let cache_key = base_url.as_str().trim_end_matches('/').to_owned();
  let cache = GPU_TOOLS_DISCOVERY_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
  {
    let cache = cache.lock().await;
    if let Some(discovery) = cache.get(&cache_key) {
      return Ok(discovery.clone());
    }
  }

  let discovery = Arc::new(fetch_gpu_tools_discovery(base_url).await?);
  let mut cache = cache.lock().await;
  Ok(cache.entry(cache_key).or_insert_with(|| discovery.clone()).clone())
}

async fn fetch_gpu_tools_discovery(base_url: &Url) -> InfuResult<GpuToolsDocument> {
  let discovery_url = endpoint_url(base_url, DISCOVERY_PATH)?;
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(DISCOVERY_REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build GPU tools discovery HTTP client: {}", e))?;
  let response = client
    .get(discovery_url.clone())
    .send()
    .await
    .map_err(|e| format!("Could not call GPU tools discovery endpoint '{}': {}", discovery_url, e))?;
  let status = response.status();
  let body = response
    .text()
    .await
    .map_err(|e| format!("Could not read GPU tools discovery response body from '{}': {}", discovery_url, e))?;
  if !status.is_success() {
    return Err(format!("GPU tools discovery endpoint '{}' returned HTTP {}: {}", discovery_url, status, body).into());
  }
  let discovery = serde_json::from_str::<GpuToolsDocument>(&body)
    .map_err(|e| format!("Could not parse GPU tools discovery response from '{}': {}", discovery_url, e))?;
  if discovery.schema_version != 1 {
    return Err(
      format!(
        "GPU tools discovery endpoint '{}' returned unsupported schema_version {}.",
        discovery_url, discovery.schema_version
      )
      .into(),
    );
  }
  Ok(discovery)
}

fn normalized_gpu_tools_base_url(gpu_tools_url: &str) -> InfuResult<Url> {
  let mut url = Url::parse(gpu_tools_url)
    .map_err(|e| format!("Could not parse {} '{}': {}", CONFIG_GPU_TOOLS_URL, gpu_tools_url, e))?;
  url.set_query(None);
  url.set_fragment(None);
  let path = url.path().trim_end_matches('/').to_owned();
  if let Some(prefix) = path.strip_suffix(DISCOVERY_PATH) {
    url.set_path(if prefix.is_empty() { "/" } else { prefix });
  }
  Ok(url)
}

fn endpoint_url(base_url: &Url, endpoint_path: &str) -> InfuResult<Url> {
  let mut url = base_url.clone();
  url.set_path(&joined_endpoint_path(base_url.path(), endpoint_path));
  url.set_query(None);
  url.set_fragment(None);
  Ok(url)
}

fn joined_endpoint_path(base_path: &str, endpoint_path: &str) -> String {
  let base_path = base_path.trim_end_matches('/');
  let endpoint_path = endpoint_path.trim_start_matches('/');
  if base_path.is_empty() {
    format!("/{endpoint_path}")
  } else if endpoint_path.is_empty() {
    base_path.to_owned()
  } else {
    format!("{base_path}/{endpoint_path}")
  }
}
