use std::path::{Path, PathBuf};

use clap::{Arg, ArgMatches, Command};
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::config::CONFIG_DATA_DIR;
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::util::fs::expand_tilde;

const MODEL_NAME: &str = "BAAI/bge-base-en-v1.5";

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
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let (data_dir, item) = load_data_dir_and_item(sub_matches).await?;
  let fragments_path = fragments_path_for_item(&data_dir, &item.owner_id, &item.id)?;
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
  eprintln!("Embedding {} fragment(s) for item '{}' with {}.", fragments.len(), item.id, MODEL_NAME);
  let embeddings = tokio::task::spawn_blocking(move || embed_texts(texts))
    .await
    .map_err(|e| format!("Embedding task failed: {}", e))??;

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

fn embed_texts(texts: Vec<String>) -> InfuResult<Vec<Vec<f32>>> {
  let mut model =
    TextEmbedding::try_new(InitOptions::new(EmbeddingModel::BGEBaseENV15).with_show_download_progress(true))
      .map_err(|e| format!("Could not initialize fastembed model {}: {}", MODEL_NAME, e))?;
  model.embed(texts, None).map_err(|e| format!("Could not embed fragments with {}: {}", MODEL_NAME, e).into())
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
  model: &'static str,
  ordinal: usize,
  page_start: Option<usize>,
  page_end: Option<usize>,
  dimensions: usize,
  embedding: Vec<f32>,
}

#[cfg(test)]
mod tests {
  use super::parse_fragment_records;

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
}
