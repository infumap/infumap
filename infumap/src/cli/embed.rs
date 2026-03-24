use std::path::{Path, PathBuf};

use clap::{Arg, ArgMatches, Command};
#[cfg(feature = "embed-onnx")]
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio::fs;

#[cfg(feature = "embed-onnx")]
use super::build_http_client;
use crate::config::CONFIG_DATA_DIR;
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::util::fs::expand_tilde;

#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
const MODEL_NAME: &str = "BAAI/bge-base-en-v1.5";
const EMBED_ONNX_FEATURE: &str = "embed-onnx";

pub fn make_clap_subcommand() -> Command {
  Command::new("embed")
    .about("Embed one item's existing fragments with fastembed and print vectors to stdout.")
    .arg(settings_arg())
    .arg(
      Arg::new("item_id")
        .long("item-id")
        .help("Embed the existing fragments for this item id.")
        .num_args(1)
        .required(true),
    )
    .arg(
      Arg::new("service_url")
        .long("service-url")
        .help("Service URL. When present, also embed the same fragments via the text embedding service, compare both results, and still print the embedded Rust vectors to stdout.")
        .num_args(1)
        .required(false),
    )
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  if !embedding_capability_enabled() {
    eprintln!(
      "This infumap build does not include ONNX embedding support. Rebuild with `cargo build --features {}` to enable the embed command.",
      EMBED_ONNX_FEATURE
    );
    return Ok(());
  }

  execute_with_onnx(sub_matches).await
}

#[cfg(feature = "embed-onnx")]
async fn execute_with_onnx(sub_matches: &ArgMatches) -> InfuResult<()> {
  let (data_dir, item) = load_data_dir_and_item(sub_matches).await?;
  let fragments_path = fragments_path_for_item(&data_dir, &item.owner_id, &item.id)?;
  let embedding_cache_dir = embedding_cache_dir(&data_dir)?;
  let service_url =
    sub_matches.get_one::<String>("service_url").map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
  fs::create_dir_all(&embedding_cache_dir)
    .await
    .map_err(|e| format!("Could not create embedding cache directory '{}': {}", embedding_cache_dir.display(), e))?;
  let fragments = load_fragment_records(&fragments_path).await?;
  if fragments.is_empty() {
    return Err(
      format!(
        "No fragments found for item '{}' in '{}'. Run the fragments command first.",
        item.id,
        fragments_path.display()
      )
      .into(),
    );
  }

  let texts = fragments.iter().map(|fragment| fragment.text.clone()).collect::<Vec<String>>();
  eprintln!(
    "Embedding {} fragment(s) for item '{}' with {}. Model cache: {}.",
    fragments.len(),
    item.id,
    MODEL_NAME,
    embedding_cache_dir.display()
  );
  let embeddings = tokio::task::spawn_blocking(move || embed_texts(texts.clone(), embedding_cache_dir))
    .await
    .map_err(|e| format!("Embedding task failed: {}", e))??;

  if let Some(service_url) = service_url {
    let embed_url = service_embed_url(&service_url)?;
    let client = build_http_client(None).await?;
    eprintln!("Comparing embedded vectors against service '{}'.", embed_url);
    let service_embeddings = fetch_service_embeddings(&client, &embed_url, &item.id, &fragments).await?;
    let comparison = compare_embeddings(&embeddings, &service_embeddings)?;
    print_comparison_report(&embed_url, &comparison);
  }

  for (fragment, embedding) in fragments.iter().zip(embeddings.into_iter()) {
    let record = PrintedEmbeddingRecord {
      item_id: item.id.clone(),
      model: MODEL_NAME,
      ordinal: fragment.ordinal,
      page_start: fragment.page_start,
      page_end: fragment.page_end,
      dimensions: embedding.len(),
      embedding,
    };
    println!("{}", serde_json::to_string(&record)?);
  }

  Ok(())
}

#[cfg(not(feature = "embed-onnx"))]
async fn execute_with_onnx(_sub_matches: &ArgMatches) -> InfuResult<()> {
  Ok(())
}

#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
async fn load_data_dir_and_item(sub_matches: &ArgMatches) -> InfuResult<(String, Item)> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let mut db = Db::new(&data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?;

  let all_user_ids: Vec<String> = db.user.all_user_ids().iter().cloned().collect();
  for user_id in all_user_ids {
    db.item.load_user_items(&user_id, false).await?;
  }

  let item_id = sub_matches.get_one::<String>("item_id").expect("clap requires --item-id");
  let item = db.item.get(item_id).map_err(|e| e.to_string())?.clone();
  Ok((data_dir, item))
}

#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
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

pub fn embedding_capability_enabled() -> bool {
  cfg!(feature = "embed-onnx")
}

#[cfg(feature = "embed-onnx")]
fn embed_texts(texts: Vec<String>, cache_dir: PathBuf) -> InfuResult<Vec<Vec<f32>>> {
  let mut model = TextEmbedding::try_new(
    InitOptions::new(EmbeddingModel::BGEBaseENV15).with_cache_dir(cache_dir).with_show_download_progress(true),
  )
  .map_err(|e| format!("Could not initialize fastembed model {}: {}", MODEL_NAME, e))?;
  model.embed(texts, None).map_err(|e| format!("Could not embed fragments with {}: {}", MODEL_NAME, e).into())
}

#[cfg(feature = "embed-onnx")]
async fn fetch_service_embeddings(
  client: &reqwest::Client,
  embed_url: &Url,
  item_id: &str,
  fragments: &[StoredFragmentRecord],
) -> InfuResult<Vec<Vec<f32>>> {
  let request = ServiceEmbedRequest {
    inputs: fragments
      .iter()
      .map(|fragment| ServiceEmbedInput {
        id: Some(format!("{}:{}", item_id, fragment.ordinal)),
        text: fragment.text.clone(),
      })
      .collect(),
  };

  let response = client
    .post(embed_url.clone())
    .json(&request)
    .send()
    .await
    .map_err(|e| format!("Could not call text embedding service '{}': {}", embed_url, e))?;
  let status = response.status();
  if !status.is_success() {
    let body = response.text().await.unwrap_or_else(|_| String::from("<could not read response body>"));
    return Err(format!("Text embedding service '{}' returned {}: {}", embed_url, status, body).into());
  }

  let response: ServiceEmbedResponse = response
    .json()
    .await
    .map_err(|e| format!("Could not deserialize text embedding response from '{}': {}", embed_url, e))?;

  if !response.success {
    return Err(format!("Text embedding service '{}' reported success=false.", embed_url).into());
  }

  if response.count != fragments.len() {
    return Err(
      format!(
        "Text embedding service '{}' returned count {} but {} fragments were requested.",
        embed_url,
        response.count,
        fragments.len()
      )
      .into(),
    );
  }

  if response.results.len() != fragments.len() {
    return Err(
      format!(
        "Text embedding service '{}' returned {} result rows but {} fragments were requested.",
        embed_url,
        response.results.len(),
        fragments.len()
      )
      .into(),
    );
  }

  let mut ordered = vec![None; fragments.len()];
  for result in response.results {
    if result.index >= fragments.len() {
      return Err(
        format!(
          "Text embedding service '{}' returned out-of-range result index {} for {} fragments.",
          embed_url,
          result.index,
          fragments.len()
        )
        .into(),
      );
    }
    if ordered[result.index].is_some() {
      return Err(
        format!("Text embedding service '{}' returned duplicate result index {}.", embed_url, result.index).into(),
      );
    }
    ordered[result.index] = Some(result.embedding);
  }

  ordered
    .into_iter()
    .enumerate()
    .map(|(index, vector)| {
      vector.ok_or_else(|| {
        format!("Text embedding service '{}' did not return an embedding for result index {}.", embed_url, index).into()
      })
    })
    .collect()
}

#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
fn service_embed_url(base_url: &str) -> InfuResult<Url> {
  let parsed = Url::parse(base_url).map_err(|e| format!("Could not parse service URL '{}': {}", base_url, e))?;
  if parsed.path().ends_with("/embed") {
    Ok(parsed)
  } else {
    parsed.join("/embed").map_err(|e| format!("Could not build /embed URL from '{}': {}", base_url, e).into())
  }
}

#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
fn compare_embeddings(embedded: &[Vec<f32>], service: &[Vec<f32>]) -> InfuResult<EmbeddingComparisonSummary> {
  if embedded.len() != service.len() {
    return Err(
      format!("Embedded result count {} does not match service count {}.", embedded.len(), service.len()).into(),
    );
  }

  let mut fragments = Vec::with_capacity(embedded.len());
  let mut min_cosine_similarity = f64::INFINITY;
  let mut max_abs_diff = 0.0_f64;
  let mut mean_abs_diff_sum = 0.0_f64;
  let mut cosine_similarity_sum = 0.0_f64;

  for (index, (embedded_vec, service_vec)) in embedded.iter().zip(service.iter()).enumerate() {
    if embedded_vec.len() != service_vec.len() {
      return Err(
        format!(
          "Embedded vector {} has dimension {} but service returned dimension {}.",
          index,
          embedded_vec.len(),
          service_vec.len()
        )
        .into(),
      );
    }

    let mut dot = 0.0_f64;
    let mut embedded_norm_sq = 0.0_f64;
    let mut service_norm_sq = 0.0_f64;
    let mut vector_abs_diff_sum = 0.0_f64;
    let mut vector_max_abs_diff = 0.0_f64;

    for (&embedded_value, &service_value) in embedded_vec.iter().zip(service_vec.iter()) {
      let embedded_value = embedded_value as f64;
      let service_value = service_value as f64;
      let abs_diff = (embedded_value - service_value).abs();
      vector_abs_diff_sum += abs_diff;
      vector_max_abs_diff = vector_max_abs_diff.max(abs_diff);
      dot += embedded_value * service_value;
      embedded_norm_sq += embedded_value * embedded_value;
      service_norm_sq += service_value * service_value;
    }

    let cosine_similarity = if embedded_norm_sq == 0.0 || service_norm_sq == 0.0 {
      if embedded_norm_sq == service_norm_sq { 1.0 } else { 0.0 }
    } else {
      dot / (embedded_norm_sq.sqrt() * service_norm_sq.sqrt())
    };
    let mean_abs_diff = if embedded_vec.is_empty() { 0.0 } else { vector_abs_diff_sum / embedded_vec.len() as f64 };

    min_cosine_similarity = min_cosine_similarity.min(cosine_similarity);
    max_abs_diff = max_abs_diff.max(vector_max_abs_diff);
    mean_abs_diff_sum += mean_abs_diff;
    cosine_similarity_sum += cosine_similarity;
    fragments.push(FragmentComparison {
      index,
      dimensions: embedded_vec.len(),
      cosine_similarity,
      max_abs_diff: vector_max_abs_diff,
      mean_abs_diff,
    });
  }

  let fragment_count = fragments.len();
  Ok(EmbeddingComparisonSummary {
    fragments,
    min_cosine_similarity: if fragment_count == 0 { 1.0 } else { min_cosine_similarity },
    mean_cosine_similarity: if fragment_count == 0 { 1.0 } else { cosine_similarity_sum / fragment_count as f64 },
    max_abs_diff,
    mean_abs_diff: if fragment_count == 0 { 0.0 } else { mean_abs_diff_sum / fragment_count as f64 },
  })
}

#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
fn print_comparison_report(embed_url: &Url, summary: &EmbeddingComparisonSummary) {
  eprintln!(
    "Service comparison via '{}': {} fragment(s), min cosine={:.9}, mean cosine={:.9}, max abs diff={:.9}, mean abs diff={:.9}.",
    embed_url,
    summary.fragments.len(),
    summary.min_cosine_similarity,
    summary.mean_cosine_similarity,
    summary.max_abs_diff,
    summary.mean_abs_diff
  );
  for fragment in &summary.fragments {
    eprintln!(
      "  fragment {}: dims={}, cosine={:.9}, max abs diff={:.9}, mean abs diff={:.9}",
      fragment.index, fragment.dimensions, fragment.cosine_similarity, fragment.max_abs_diff, fragment.mean_abs_diff
    );
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

#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
fn fragments_path_for_item(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("rag");
  path.push(&item_id[..2]);
  path.push(item_id);
  path.push("fragments.jsonl");
  Ok(path)
}

#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
fn embedding_cache_dir(data_dir: &str) -> InfuResult<PathBuf> {
  let data_path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  let mut path =
    data_path.parent().ok_or(format!("Data directory '{}' has no parent.", data_path.display()))?.to_path_buf();
  path.push("models");
  path.push("fastembed");
  Ok(path)
}

#[derive(Deserialize)]
#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
struct StoredFragmentRecord {
  ordinal: usize,
  text: String,
  page_start: Option<usize>,
  page_end: Option<usize>,
}

#[derive(Serialize)]
#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
struct PrintedEmbeddingRecord {
  item_id: String,
  model: &'static str,
  ordinal: usize,
  page_start: Option<usize>,
  page_end: Option<usize>,
  dimensions: usize,
  embedding: Vec<f32>,
}

#[derive(Serialize)]
#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
struct ServiceEmbedRequest {
  inputs: Vec<ServiceEmbedInput>,
}

#[derive(Serialize)]
#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
struct ServiceEmbedInput {
  id: Option<String>,
  text: String,
}

#[derive(Deserialize)]
#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
struct ServiceEmbedResponse {
  success: bool,
  count: usize,
  results: Vec<ServiceEmbedResult>,
}

#[derive(Deserialize)]
#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
struct ServiceEmbedResult {
  index: usize,
  embedding: Vec<f32>,
}

#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
struct EmbeddingComparisonSummary {
  fragments: Vec<FragmentComparison>,
  min_cosine_similarity: f64,
  mean_cosine_similarity: f64,
  max_abs_diff: f64,
  mean_abs_diff: f64,
}

#[cfg_attr(not(feature = "embed-onnx"), allow(dead_code))]
struct FragmentComparison {
  index: usize,
  dimensions: usize,
  cosine_similarity: f64,
  max_abs_diff: f64,
  mean_abs_diff: f64,
}

#[cfg(test)]
mod tests {
  use std::path::PathBuf;

  use super::{
    EMBED_ONNX_FEATURE, compare_embeddings, embedding_cache_dir, embedding_capability_enabled, parse_fragment_records,
    service_embed_url,
  };

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
  fn embedding_cache_path_is_under_data_dir() {
    let path = embedding_cache_dir("/tmp/infumap-data/data").unwrap();
    assert_eq!(path, PathBuf::from("/tmp/infumap-data/models/fastembed"));
  }

  #[test]
  fn embedding_capability_matches_build_feature() {
    assert_eq!(embedding_capability_enabled(), cfg!(feature = "embed-onnx"));
    assert_eq!(EMBED_ONNX_FEATURE, "embed-onnx");
  }

  #[test]
  fn service_url_defaults_to_embed_path() {
    let url = service_embed_url("http://127.0.0.1:8789").unwrap();
    assert_eq!(url.as_str(), "http://127.0.0.1:8789/embed");

    let url = service_embed_url("http://127.0.0.1:8789/embed").unwrap();
    assert_eq!(url.as_str(), "http://127.0.0.1:8789/embed");
  }

  #[test]
  fn comparison_metrics_are_zero_for_identical_vectors() {
    let summary = compare_embeddings(&[vec![1.0, 0.0], vec![0.5, -0.25]], &[vec![1.0, 0.0], vec![0.5, -0.25]]).unwrap();

    assert_eq!(summary.fragments.len(), 2);
    assert!((summary.min_cosine_similarity - 1.0).abs() < 1e-12);
    assert!((summary.mean_cosine_similarity - 1.0).abs() < 1e-12);
    assert!(summary.max_abs_diff.abs() < 1e-12);
    assert!(summary.mean_abs_diff.abs() < 1e-12);
  }
}
