use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use clap::{Arg, ArgMatches, Command};
use infusdk::item::is_container_item_type;
use infusdk::util::infu::InfuResult;
use log::info;
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use tokio::time::sleep;

use crate::config::{
  CONFIG_DATA_DIR, CONFIG_ENABLE_LOCAL_OBJECT_STORAGE, CONFIG_ENABLE_S3_1_OBJECT_STORAGE,
  CONFIG_ENABLE_S3_2_OBJECT_STORAGE, CONFIG_S3_1_BUCKET, CONFIG_S3_1_ENDPOINT, CONFIG_S3_1_KEY, CONFIG_S3_1_REGION,
  CONFIG_S3_1_SECRET, CONFIG_S3_2_BUCKET, CONFIG_S3_2_ENDPOINT, CONFIG_S3_2_KEY, CONFIG_S3_2_REGION,
  CONFIG_S3_2_SECRET,
};
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::storage::object::{self as storage_object};
use crate::web::image_tagging::{
  image_tagging_url_from_config, list_failed_images, start_image_tagging_processing_loop, tag_single_item,
};

const CLI_ENDPOINT_BACKOFF_SECS: u64 = 2;
const DEFAULT_CLI_IMAGE_TAGGING_CONCURRENCY: usize = 1;

pub fn make_clap_subcommand() -> Command {
  Command::new("tag-images")
    .about("Run the image tagging processing loop without starting the web server.")
    .arg(
      Arg::new("settings_path")
        .short('s')
        .long("settings")
        .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("image_tagging_url")
        .long("image-tagging-url")
        .help("Override the configured image tagging service URL for this process.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("item_id")
        .long("item-id")
        .help("Tag only this item (must be a supported image). Exits after one image.")
        .num_args(1)
        .conflicts_with("container_id")
        .required(false),
    )
    .arg(
      Arg::new("container_id")
        .long("container-id")
        .help("Tag only supported images within this container subtree. Exits after the finite batch completes.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("image_tagging_concurrency")
        .long("image-tagging-concurrency")
        .help("Set the number of concurrent image tagging requests for this process. Defaults to 1.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("image_tagging_delay_secs")
        .long("image-tagging-delay-secs")
        .help("Sleep for this many seconds after each image tagging request in this process.")
        .num_args(1)
        .required(false),
    )
    .arg(
      Arg::new("list_failed")
        .long("list-failed")
        .help("List all supported images for which image tagging failed. Exits after listing.")
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
    let failed = list_failed_images(&data_dir, db.clone()).await?;
    let failed = if let Some(container_id) = sub_matches.get_one::<String>("container_id") {
      let container_image_ids = collect_taggable_image_ids_in_container(db.clone(), container_id).await?;
      let container_image_id_set = container_image_ids.into_iter().collect::<HashSet<String>>();
      failed
        .into_iter()
        .filter(|failed_image| container_image_id_set.contains(&failed_image.item_id))
        .collect::<Vec<_>>()
    } else {
      failed
    };
    for failed_image in &failed {
      println!(
        "user: {}  item: {}  file: {}  error: {}",
        failed_image.user_id,
        failed_image.item_id,
        failed_image.file_name,
        failed_image.error.as_deref().unwrap_or("")
      );
    }
    if failed.is_empty() {
      println!("No supported images with failed image tagging.");
    }
    return Ok(());
  }

  let image_tagging_url = match sub_matches.get_one::<String>("image_tagging_url") {
    Some(url) if !url.trim().is_empty() => url.clone(),
    _ => image_tagging_url_from_config(&config)?
      .ok_or("image_tagging_url must be configured or specified via --image-tagging-url.")?,
  };
  let image_tagging_concurrency = match sub_matches.get_one::<String>("image_tagging_concurrency") {
    Some(value) => {
      let parsed = value.parse::<usize>().map_err(|e| {
        format!("Invalid --image-tagging-concurrency value '{}': {}. Expected an integer >= 1.", value, e)
      })?;
      if parsed < 1 {
        return Err("--image-tagging-concurrency must be at least 1.".into());
      }
      parsed
    }
    None => DEFAULT_CLI_IMAGE_TAGGING_CONCURRENCY,
  };
  let image_tagging_delay = match sub_matches.get_one::<String>("image_tagging_delay_secs") {
    Some(value) => {
      let parsed = value
        .parse::<f64>()
        .map_err(|e| format!("Invalid --image-tagging-delay-secs value '{}': {}. Expected a number >= 0.", value, e))?;
      if parsed < 0.0 {
        return Err("--image-tagging-delay-secs must be greater than or equal to 0.".into());
      }
      std::time::Duration::from_secs_f64(parsed)
    }
    None => std::time::Duration::ZERO,
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
    tag_single_item(&data_dir, &image_tagging_url, db, object_store, item_id).await?;
    return Ok(());
  }

  if let Some(container_id) = sub_matches.get_one::<String>("container_id") {
    let item_ids = collect_taggable_image_ids_in_container(db.clone(), container_id).await?;
    process_container_image_batch(
      &data_dir,
      &image_tagging_url,
      image_tagging_concurrency,
      image_tagging_delay,
      container_id,
      item_ids,
      db,
      object_store,
    )
    .await?;
    return Ok(());
  }

  start_image_tagging_processing_loop(
    data_dir,
    image_tagging_url.clone(),
    image_tagging_concurrency,
    image_tagging_delay,
    std::time::Duration::from_secs(CLI_ENDPOINT_BACKOFF_SECS),
    db,
    object_store,
  )?;
  info!(
    "Running image tagging loop using '{}' with concurrency {} and delay {:.3}s. Press Ctrl-C to stop.",
    image_tagging_url,
    image_tagging_concurrency,
    image_tagging_delay.as_secs_f64()
  );
  tokio::signal::ctrl_c().await.map_err(|e| format!("Failed waiting for Ctrl-C: {}", e))?;
  Ok(())
}

#[derive(Default)]
struct BatchProgress {
  processed: usize,
  succeeded: usize,
  failed: usize,
}

async fn collect_taggable_image_ids_in_container(db: Arc<Mutex<Db>>, container_id: &str) -> InfuResult<Vec<String>> {
  let db = db.lock().await;
  let container = db.item.get(&container_id.to_owned()).map_err(|e| e.to_string())?;
  if !is_container_item_type(container.item_type) {
    return Err(format!("Item '{}' is not a container item.", container_id).into());
  }

  let mut visited_item_ids = HashSet::new();
  let mut collected_image_ids = HashSet::new();
  let mut ordered_image_ids = vec![];
  collect_taggable_image_ids_recursive(
    &db,
    container_id,
    &mut visited_item_ids,
    &mut collected_image_ids,
    &mut ordered_image_ids,
  )?;
  Ok(ordered_image_ids)
}

fn collect_taggable_image_ids_recursive(
  db: &Db,
  item_id: &str,
  visited_item_ids: &mut HashSet<String>,
  collected_image_ids: &mut HashSet<String>,
  ordered_image_ids: &mut Vec<String>,
) -> InfuResult<()> {
  if !visited_item_ids.insert(item_id.to_owned()) {
    return Ok(());
  }

  for attachment in db.item.get_attachments(&item_id.to_owned())? {
    if crate::web::image_tagging::should_tag_image_item(attachment) && collected_image_ids.insert(attachment.id.clone())
    {
      ordered_image_ids.push(attachment.id.clone());
    }
    collect_taggable_image_ids_recursive(db, &attachment.id, visited_item_ids, collected_image_ids, ordered_image_ids)?;
  }

  for child in db.item.get_children(&item_id.to_owned())? {
    if crate::web::image_tagging::should_tag_image_item(child) && collected_image_ids.insert(child.id.clone()) {
      ordered_image_ids.push(child.id.clone());
    }
    collect_taggable_image_ids_recursive(db, &child.id, visited_item_ids, collected_image_ids, ordered_image_ids)?;
  }

  Ok(())
}

async fn process_container_image_batch(
  data_dir: &str,
  image_tagging_url: &str,
  image_tagging_concurrency: usize,
  image_tagging_delay: std::time::Duration,
  container_id: &str,
  item_ids: Vec<String>,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
) -> InfuResult<()> {
  if item_ids.is_empty() {
    info!("No supported images found under container '{}'. Nothing to tag.", container_id);
    return Ok(());
  }

  let total_items = item_ids.len();
  let queue = Arc::new(Mutex::new(VecDeque::from(item_ids)));
  let progress = Arc::new(Mutex::new(BatchProgress::default()));
  let mut join_set = JoinSet::new();

  for worker_index in 0..image_tagging_concurrency {
    let worker_queue = queue.clone();
    let worker_progress = progress.clone();
    let worker_db = db.clone();
    let worker_object_store = object_store.clone();
    let worker_data_dir = data_dir.to_owned();
    let worker_image_tagging_url = image_tagging_url.to_owned();

    join_set.spawn(async move {
      loop {
        let item_id = {
          let mut queue = worker_queue.lock().await;
          queue.pop_front()
        };

        let Some(item_id) = item_id else {
          break;
        };

        match tag_single_item(
          &worker_data_dir,
          &worker_image_tagging_url,
          worker_db.clone(),
          worker_object_store.clone(),
          &item_id,
        )
        .await
        {
          Ok(()) => {
            let mut progress = worker_progress.lock().await;
            progress.processed += 1;
            progress.succeeded += 1;
            info!(
              "Container-scoped image tagging worker {}: tagged '{}' successfully ({}/{}).",
              worker_index + 1,
              item_id,
              progress.processed,
              total_items
            );
          }
          Err(e) => {
            let mut progress = worker_progress.lock().await;
            progress.processed += 1;
            progress.failed += 1;
            info!(
              "Container-scoped image tagging worker {}: failed for '{}' ({}/{}): {}",
              worker_index + 1,
              item_id,
              progress.processed,
              total_items,
              e
            );
          }
        }

        if image_tagging_delay > std::time::Duration::ZERO {
          sleep(image_tagging_delay).await;
        }
      }
    });
  }

  while let Some(join_result) = join_set.join_next().await {
    join_result.map_err(|e| format!("Container-scoped image tagging worker task failed: {}", e))?;
  }

  let progress = progress.lock().await;
  info!(
    "Container-scoped image tagging finished for container '{}': total={} succeeded={} failed={}.",
    container_id, total_items, progress.succeeded, progress.failed
  );
  Ok(())
}
