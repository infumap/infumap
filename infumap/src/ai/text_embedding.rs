use config::Config;
use infusdk::util::infu::InfuResult;
use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::config::CONFIG_TEXT_EMBEDDING_URL;

pub const DEFAULT_TEXT_EMBEDDING_BATCH_SIZE: usize = 256;

#[derive(Clone, Serialize)]
pub struct TextEmbeddingInput {
  pub id: Option<String>,
  pub text: String,
}

#[derive(Debug)]
pub struct TextEmbeddingBatch {
  pub model: String,
  pub embeddings: Vec<Vec<f32>>,
}

#[derive(Serialize)]
struct ServiceEmbedRequest {
  inputs: Vec<TextEmbeddingInput>,
}

#[derive(Deserialize)]
struct ServiceEmbedResponse {
  success: bool,
  model: String,
  count: usize,
  results: Vec<ServiceEmbedResult>,
}

#[derive(Deserialize)]
struct ServiceEmbedResult {
  index: usize,
  embedding: Vec<f32>,
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
  if parsed.path().ends_with("/embed") {
    Ok(parsed)
  } else {
    let trimmed = parsed.path().trim_end_matches('/');
    let embed_path = if trimmed.is_empty() { "/embed".to_owned() } else { format!("{}/embed", trimmed) };
    parsed.set_path(&embed_path);
    Ok(parsed)
  }
}

pub async fn embed_texts(
  client: &reqwest::Client,
  embed_url: &Url,
  inputs: &[TextEmbeddingInput],
) -> InfuResult<TextEmbeddingBatch> {
  let request = ServiceEmbedRequest { inputs: inputs.to_vec() };

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

  if response.count != inputs.len() {
    return Err(
      format!(
        "Text embedding service '{}' returned count {} but {} input(s) were requested.",
        embed_url,
        response.count,
        inputs.len()
      )
      .into(),
    );
  }

  if response.results.len() != inputs.len() {
    return Err(
      format!(
        "Text embedding service '{}' returned {} result rows but {} input(s) were requested.",
        embed_url,
        response.results.len(),
        inputs.len()
      )
      .into(),
    );
  }

  let mut ordered = vec![None; inputs.len()];
  for result in response.results {
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

  Ok(TextEmbeddingBatch {
    model: response.model,
    embeddings: ordered
      .into_iter()
      .enumerate()
      .map(|(index, vector)| {
        vector.ok_or_else(|| {
          format!("Text embedding service '{}' did not return an embedding for result index {}.", embed_url, index)
            .into()
        })
      })
      .collect::<InfuResult<Vec<Vec<f32>>>>()?,
  })
}

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

#[cfg(test)]
mod tests {
  use super::text_embedding_embed_url;

  #[test]
  fn service_url_defaults_to_embed_path() {
    let url = text_embedding_embed_url("http://127.0.0.1:8789").unwrap();
    assert_eq!(url.as_str(), "http://127.0.0.1:8789/embed");

    let url = text_embedding_embed_url("http://127.0.0.1:8789/embed").unwrap();
    assert_eq!(url.as_str(), "http://127.0.0.1:8789/embed");
  }
}
