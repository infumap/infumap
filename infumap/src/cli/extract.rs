use std::sync::Arc;

use clap::{Arg, ArgMatches, Command};
use infusdk::util::infu::InfuResult;
use log::info;
use tokio::sync::Mutex;

use crate::config::{
  CONFIG_DATA_DIR, CONFIG_ENABLE_LOCAL_OBJECT_STORAGE, CONFIG_ENABLE_S3_1_OBJECT_STORAGE,
  CONFIG_ENABLE_S3_2_OBJECT_STORAGE, CONFIG_S3_1_BUCKET, CONFIG_S3_1_ENDPOINT, CONFIG_S3_1_KEY, CONFIG_S3_1_REGION,
  CONFIG_S3_1_SECRET, CONFIG_S3_2_BUCKET, CONFIG_S3_2_ENDPOINT, CONFIG_S3_2_KEY, CONFIG_S3_2_REGION,
  CONFIG_S3_2_SECRET,
};
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::storage::object::{self as storage_object};
use crate::web::text_extraction::{
  extract_single_item, list_failed_pdfs, start_text_extraction_processing_loop,
  text_extraction_concurrency_from_config, text_extraction_url_from_config,
};

pub fn make_clap_subcommand() -> Command {
  Command::new("extract")
    .about("Run the text extraction processing loop without starting the web server.")
    .arg(
      Arg::new("settings_path")
        .short('s')
        .long("settings")
        .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("text_extraction_url")
        .long("text-extraction-url")
        .help("Override the configured text extraction service URL for this process.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("item_id")
        .long("item-id")
        .help("Extract text only for this item (must be a PDF). Exits after one extraction.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("text_extraction_concurrency")
        .long("text-extraction-concurrency")
        .help("Override the configured number of concurrent PDF extraction requests for this process.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("list_failed")
        .long("list-failed")
        .help("List all PDFs for which text extraction failed. Exits after listing.")
        .num_args(0)
        .required(false),
    )
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let db = Arc::new(Mutex::new(Db::new(&data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?));

  {
    let mut db = db.lock().await;
    let all_user_ids: Vec<String> = db.user.all_user_ids().iter().map(|v| v.clone()).collect();
    for user_id in all_user_ids {
      db.item.load_user_items(&user_id, false).await?;
    }
  }

  if sub_matches.get_flag("list_failed") {
    let failed = list_failed_pdfs(&data_dir, db).await?;
    for f in &failed {
      println!(
        "user: {}  item: {}  file: {}  error: {}",
        f.user_id,
        f.item_id,
        f.file_name,
        f.error.as_deref().unwrap_or("")
      );
    }
    if failed.is_empty() {
      println!("No PDFs with failed text extraction.");
    }
    return Ok(());
  }

  let text_extraction_url = match sub_matches.get_one::<String>("text_extraction_url") {
    Some(url) if !url.trim().is_empty() => url.clone(),
    _ => text_extraction_url_from_config(&config)?
      .ok_or("text_extraction_url must be configured or specified via --text-extraction-url.")?,
  };
  let text_extraction_concurrency = match sub_matches.get_one::<String>("text_extraction_concurrency") {
    Some(value) => {
      let parsed = value.parse::<usize>().map_err(|e| {
        format!("Invalid --text-extraction-concurrency value '{}': {}. Expected an integer >= 1.", value, e)
      })?;
      if parsed < 1 {
        return Err("--text-extraction-concurrency must be at least 1.".into());
      }
      parsed
    }
    None => text_extraction_concurrency_from_config(&config)?,
  };
  let object_store = storage_object::new(
    &data_dir,
    config.get_bool(CONFIG_ENABLE_LOCAL_OBJECT_STORAGE).map_err(|e| e.to_string())?,
    config.get_bool(CONFIG_ENABLE_S3_1_OBJECT_STORAGE).map_err(|e| e.to_string())?,
    config.get_string(CONFIG_S3_1_REGION).ok(),
    config.get_string(CONFIG_S3_1_ENDPOINT).ok(),
    config.get_string(CONFIG_S3_1_BUCKET).ok(),
    config.get_string(CONFIG_S3_1_KEY).ok(),
    config.get_string(CONFIG_S3_1_SECRET).ok(),
    config.get_bool(CONFIG_ENABLE_S3_2_OBJECT_STORAGE).map_err(|e| e.to_string())?,
    config.get_string(CONFIG_S3_2_REGION).ok(),
    config.get_string(CONFIG_S3_2_ENDPOINT).ok(),
    config.get_string(CONFIG_S3_2_BUCKET).ok(),
    config.get_string(CONFIG_S3_2_KEY).ok(),
    config.get_string(CONFIG_S3_2_SECRET).ok(),
  )
  .map_err(|e| format!("Failed to initialize object store: {}", e))?;

  if let Some(item_id) = sub_matches.get_one::<String>("item_id") {
    extract_single_item(&data_dir, &text_extraction_url, db, object_store, item_id).await?;
    return Ok(());
  }

  start_text_extraction_processing_loop(
    data_dir,
    text_extraction_url.clone(),
    text_extraction_concurrency,
    db,
    object_store,
  )?;
  info!(
    "Running text extraction loop using '{}' with concurrency {}. Press Ctrl-C to stop.",
    text_extraction_url, text_extraction_concurrency
  );
  tokio::signal::ctrl_c().await.map_err(|e| format!("Failed waiting for Ctrl-C: {}", e))?;
  Ok(())
}
