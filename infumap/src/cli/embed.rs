use std::path::{Path, PathBuf};

use clap::{Arg, ArgMatches, Command};
use config::Config;
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio::fs;

use super::build_http_client;
use crate::config::{CONFIG_DATA_DIR, CONFIG_TEXT_EMBEDDING_URL};
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::util::fs::expand_tilde;

pub fn make_clap_subcommand() -> Command {
  Command::new("embed")
    .about("Embed one item's existing fragments via the external text embedding service and print vectors to stdout.")
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
        .help("Text embedding service base URL or /embed endpoint. Falls back to text_embedding_url in settings.toml.")
        .num_args(1)
        .required(false),
    )
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let item = load_item(&data_dir, sub_matches).await?;
  let fragments_path = fragments_path_for_item(&data_dir, &item.owner_id, &item.id)?;
  let embed_url = service_embed_url(&resolve_service_url(&config, sub_matches, "service_url", "--service-url")?)?;
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

  eprintln!("Embedding {} fragment(s) for item '{}' via '{}'.", fragments.len(), item.id, embed_url);

  let client = build_http_client(None).await?;
  let response = fetch_service_embeddings(&client, &embed_url, &item.id, &fragments).await?;

  for (fragment, embedding) in fragments.iter().zip(response.results.into_iter()) {
    let record = PrintedEmbeddingRecord {
      item_id: item.id.clone(),
      model: response.model.clone(),
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

async fn load_item(data_dir: &str, sub_matches: &ArgMatches) -> InfuResult<Item> {
  let mut db = Db::new(data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?;

  let all_user_ids: Vec<String> = db.user.all_user_ids().iter().cloned().collect();
  for user_id in all_user_ids {
    db.item.load_user_items(&user_id, false).await?;
  }

  let item_id = sub_matches.get_one::<String>("item_id").expect("clap requires --item-id");
  Ok(db.item.get(item_id).map_err(|e| e.to_string())?.clone())
}

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

async fn fetch_service_embeddings(
  client: &reqwest::Client,
  embed_url: &Url,
  item_id: &str,
  fragments: &[StoredFragmentRecord],
) -> InfuResult<ResolvedServiceEmbedResponse> {
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

  Ok(ResolvedServiceEmbedResponse {
    model: response.model,
    results: ordered
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

fn resolve_service_url(
  config: &Config,
  sub_matches: &ArgMatches,
  arg_name: &str,
  flag_name: &str,
) -> InfuResult<String> {
  match sub_matches.get_one::<String>(arg_name) {
    Some(url) if !url.trim().is_empty() => Ok(url.clone()),
    _ => text_embedding_url_from_config(config)?
      .ok_or(format!("{} must be configured or specified via {}.", CONFIG_TEXT_EMBEDDING_URL, flag_name).into()),
  }
}

fn text_embedding_url_from_config(config: &Config) -> InfuResult<Option<String>> {
  match config.get_string(CONFIG_TEXT_EMBEDDING_URL) {
    Ok(value) => {
      let trimmed = value.trim();
      if trimmed.is_empty() { Ok(None) } else { Ok(Some(trimmed.to_owned())) }
    }
    Err(_) => Ok(None),
  }
}

fn service_embed_url(base_url: &str) -> InfuResult<Url> {
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

fn settings_arg() -> Arg {
  Arg::new("settings_path")
    .short('s')
    .long("settings")
    .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
    .num_args(1)
    .required(false)
}

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

#[derive(Deserialize)]
struct StoredFragmentRecord {
  ordinal: usize,
  text: String,
  page_start: Option<usize>,
  page_end: Option<usize>,
}

#[derive(Serialize)]
struct PrintedEmbeddingRecord {
  item_id: String,
  model: String,
  ordinal: usize,
  page_start: Option<usize>,
  page_end: Option<usize>,
  dimensions: usize,
  embedding: Vec<f32>,
}

#[derive(Serialize)]
struct ServiceEmbedRequest {
  inputs: Vec<ServiceEmbedInput>,
}

#[derive(Serialize)]
struct ServiceEmbedInput {
  id: Option<String>,
  text: String,
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

struct ResolvedServiceEmbedResponse {
  model: String,
  results: Vec<Vec<f32>>,
}

#[cfg(test)]
mod tests {
  use super::{parse_fragment_records, service_embed_url};

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
  fn service_url_defaults_to_embed_path() {
    let url = service_embed_url("http://127.0.0.1:8789").unwrap();
    assert_eq!(url.as_str(), "http://127.0.0.1:8789/embed");

    let url = service_embed_url("http://127.0.0.1:8789/embed").unwrap();
    assert_eq!(url.as_str(), "http://127.0.0.1:8789/embed");
  }
}
