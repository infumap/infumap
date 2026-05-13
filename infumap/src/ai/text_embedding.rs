use config::Config;
use infusdk::util::infu::InfuResult;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Instant;

use crate::ai::metrics::{METRIC_AI_EMBEDDING_REQUEST_DURATION_SECONDS, METRIC_AI_EMBEDDING_REQUESTS_TOTAL};
use crate::config::CONFIG_TEXT_EMBEDDING_URL;

pub const DEFAULT_TEXT_EMBEDDING_MODEL: &str = "Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0";
pub const DEFAULT_TEXT_EMBEDDING_BATCH_SIZE: usize = 256;
pub const DEFAULT_RETRIEVAL_QUERY_INSTRUCTION: &str =
  "Given a web search query, retrieve relevant passages that answer the query";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextEmbeddingInputRole {
  RetrievalDocument,
  RetrievalQuery,
}

#[derive(Clone)]
pub struct TextEmbeddingInput {
  pub id: Option<String>,
  pub text: String,
  pub role: TextEmbeddingInputRole,
}

impl TextEmbeddingInput {
  pub fn retrieval_document(id: Option<String>, text: String) -> Self {
    Self { id, text, role: TextEmbeddingInputRole::RetrievalDocument }
  }

  pub fn retrieval_query(id: Option<String>, text: String) -> Self {
    Self { id, text, role: TextEmbeddingInputRole::RetrievalQuery }
  }
}

#[derive(Debug)]
pub struct TextEmbeddingBatch {
  pub model: String,
  pub embeddings: Vec<Vec<f32>>,
}

#[derive(Serialize)]
struct OpenAiEmbeddingRequest {
  model: String,
  input: Vec<String>,
  encoding_format: &'static str,
}

#[derive(Deserialize)]
struct OpenAiEmbeddingResponse {
  model: Option<String>,
  data: Vec<OpenAiEmbeddingResult>,
}

#[derive(Deserialize)]
struct OpenAiEmbeddingResult {
  index: usize,
  embedding: Vec<f32>,
}

fn format_text_embedding_input(input: &TextEmbeddingInput) -> String {
  match input.role {
    TextEmbeddingInputRole::RetrievalDocument => input.text.clone(),
    TextEmbeddingInputRole::RetrievalQuery => {
      format!("Instruct: {}\n Query:{}", DEFAULT_RETRIEVAL_QUERY_INSTRUCTION, input.text)
    }
  }
}

pub fn resolve_text_embedding_service_url(
  config: &Config,
  override_url: Option<&str>,
  override_flag_name: &str,
) -> InfuResult<Url> {
  let base_url = match override_url.map(str::trim).filter(|url| !url.is_empty()) {
    Some(url) => url.to_owned(),
    None => text_embedding_url_from_config(config)?
      .ok_or(format!("{} must be configured or specified via {}.", CONFIG_TEXT_EMBEDDING_URL, override_flag_name))?,
  };
  text_embedding_embed_url(&base_url)
}

pub fn text_embedding_url_from_config(config: &Config) -> InfuResult<Option<String>> {
  match config.get_string(CONFIG_TEXT_EMBEDDING_URL) {
    Ok(value) => {
      let trimmed = value.trim();
      if trimmed.is_empty() { Ok(None) } else { Ok(Some(trimmed.to_owned())) }
    }
    Err(_) => Ok(None),
  }
}

pub fn text_embedding_embed_url(base_url: &str) -> InfuResult<Url> {
  let mut parsed = Url::parse(base_url).map_err(|e| format!("Could not parse service URL '{}': {}", base_url, e))?;
  let trimmed = parsed.path().trim_end_matches('/');
  if trimmed.ends_with("/text-embed") || trimmed.ends_with("/embed") || trimmed.ends_with("/v1/embeddings") {
    Ok(parsed)
  } else {
    let embed_path = if trimmed.is_empty() {
      "/text-embed".to_owned()
    } else if trimmed.ends_with("/v1") {
      format!("{}/embeddings", trimmed)
    } else {
      format!("{}/text-embed", trimmed)
    };
    parsed.set_path(&embed_path);
    Ok(parsed)
  }
}

pub fn validate_text_embedding_vector(label: &str, embedding: &[f32]) -> InfuResult<()> {
  if embedding.is_empty() {
    return Err(format!("{} has zero dimensions.", label).into());
  }

  let mut squared_norm = 0.0_f64;
  for (index, value) in embedding.iter().enumerate() {
    if !value.is_finite() {
      return Err(format!("{} has non-finite value at dimension {}.", label, index).into());
    }
    squared_norm += f64::from(*value) * f64::from(*value);
  }

  if squared_norm == 0.0 {
    return Err(format!("{} is all zeros.", label).into());
  }

  Ok(())
}

pub fn text_embedding_vector_fingerprint(embedding: &[f32]) -> String {
  let mut hasher = Sha256::new();
  for value in embedding {
    hasher.update(value.to_le_bytes());
  }
  let hex = format!("{:x}", hasher.finalize());
  hex.chars().take(12).collect()
}

pub fn text_embedding_vector_norm(embedding: &[f32]) -> f64 {
  embedding.iter().map(|value| f64::from(*value) * f64::from(*value)).sum::<f64>().sqrt()
}

pub async fn embed_texts(
  client: &reqwest::Client,
  embed_url: &Url,
  inputs: &[TextEmbeddingInput],
) -> InfuResult<TextEmbeddingBatch> {
  let started = Instant::now();
  let result = embed_texts_inner(client, embed_url, inputs).await;
  let outcome = if result.is_ok() { "success" } else { "failed" };
  METRIC_AI_EMBEDDING_REQUESTS_TOTAL.with_label_values(&[outcome]).inc();
  METRIC_AI_EMBEDDING_REQUEST_DURATION_SECONDS.with_label_values(&[outcome]).observe(started.elapsed().as_secs_f64());
  result
}

async fn embed_texts_inner(
  client: &reqwest::Client,
  embed_url: &Url,
  inputs: &[TextEmbeddingInput],
) -> InfuResult<TextEmbeddingBatch> {
  let request = OpenAiEmbeddingRequest {
    model: DEFAULT_TEXT_EMBEDDING_MODEL.to_owned(),
    input: inputs.iter().map(format_text_embedding_input).collect(),
    encoding_format: "float",
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

  let response: OpenAiEmbeddingResponse = response
    .json()
    .await
    .map_err(|e| format!("Could not deserialize text embedding response from '{}': {}", embed_url, e))?;

  if response.data.len() != inputs.len() {
    return Err(
      format!(
        "Text embedding service '{}' returned {} result rows but {} input(s) were requested.",
        embed_url,
        response.data.len(),
        inputs.len()
      )
      .into(),
    );
  }

  let mut ordered = vec![None; inputs.len()];
  for result in response.data {
    if result.index >= inputs.len() {
      return Err(
        format!(
          "Text embedding service '{}' returned out-of-range result index {} for {} input(s).",
          embed_url,
          result.index,
          inputs.len()
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

  let model = response
    .model
    .map(|model| model.trim().to_owned())
    .filter(|model| !model.is_empty())
    .unwrap_or_else(|| DEFAULT_TEXT_EMBEDDING_MODEL.to_owned());

  Ok(TextEmbeddingBatch {
    model,
    embeddings: ordered
      .into_iter()
      .enumerate()
      .map(|(index, vector)| {
        vector.ok_or_else(|| {
          let id = inputs[index].id.as_deref().unwrap_or("<none>");
          format!(
            "Text embedding service '{}' did not return an embedding for result index {} (id {}).",
            embed_url, index, id
          )
          .into()
        })
      })
      .collect::<InfuResult<Vec<Vec<f32>>>>()?,
  })
}

#[allow(dead_code)]
pub async fn embed_texts_batched(
  client: &reqwest::Client,
  embed_url: &Url,
  inputs: &[TextEmbeddingInput],
  batch_size: usize,
) -> InfuResult<TextEmbeddingBatch> {
  let batch_size = batch_size.max(1);
  let mut model: Option<String> = None;
  let mut embeddings = Vec::with_capacity(inputs.len());

  for chunk in inputs.chunks(batch_size) {
    let batch = embed_texts(client, embed_url, chunk).await?;
    if model.is_none() {
      model = Some(batch.model);
    }
    embeddings.extend(batch.embeddings);
  }

  Ok(TextEmbeddingBatch { model: model.unwrap_or_default(), embeddings })
}
