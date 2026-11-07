// Copyright (C) The Infumap Authors
// This file is part of Infumap.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use std::io::Write;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose};
use clap::{Arg, ArgAction, ArgMatches, Command};
use config::Config;
use infusdk::item::{Item, ItemType};
use infusdk::util::geometry::Dimensions;
use infusdk::util::infu::InfuResult;
use infusdk::util::time::unix_now_secs_i64;
use infusdk::web::WebApiJsonSerializable;

use crate::config::{
  CONFIG_DATA_DIR, CONFIG_ENABLE_LOCAL_OBJECT_STORAGE, CONFIG_ENABLE_S3_1_OBJECT_STORAGE,
  CONFIG_ENABLE_S3_2_OBJECT_STORAGE, CONFIG_S3_1_BUCKET, CONFIG_S3_1_ENDPOINT, CONFIG_S3_1_KEY, CONFIG_S3_1_REGION,
  CONFIG_S3_1_SECRET, CONFIG_S3_2_BUCKET, CONFIG_S3_2_ENDPOINT, CONFIG_S3_2_KEY, CONFIG_S3_2_REGION,
  CONFIG_S3_2_SECRET,
};
use crate::setup::get_config;
use crate::storage::db::item_db::ItemDb;
use crate::storage::db::user_db::UserDb;
use crate::storage::object::{self, ObjectStore};
use crate::util::cr2::is_cr2;
use crate::util::image::{IMAGE_PROCESSING_SEMAPHORE, create_image_placeholder, decode_image};
use crate::util::mime::{
  CR2_MIME_TYPE, is_cr2_mime_type, is_heif_image, is_heif_mime_type, mime_type_from_title_extension,
  normalized_mime_type,
};

#[derive(Clone, Copy)]
pub enum PromotionFormat {
  Heic,
  Cr2,
}

impl PromotionFormat {
  fn name(self) -> &'static str {
    match self {
      Self::Heic => "HEIC",
      Self::Cr2 => "CR2",
    }
  }

  fn command(self) -> &'static str {
    match self {
      Self::Heic => "promote-heic",
      Self::Cr2 => "promote-cr2",
    }
  }

  fn mime_type(self) -> &'static str {
    match self {
      Self::Heic => "image/heic",
      Self::Cr2 => CR2_MIME_TYPE,
    }
  }

  fn matches_mime(self, mime_type: &str) -> bool {
    match self {
      Self::Heic => is_heif_mime_type(mime_type),
      Self::Cr2 => is_cr2_mime_type(mime_type),
    }
  }

  fn matches_data(self, data: &[u8]) -> bool {
    match self {
      Self::Heic => is_heif_image(data),
      Self::Cr2 => is_cr2(data),
    }
  }
}

pub fn make_clap_subcommand(format: PromotionFormat) -> Command {
  Command::new(format.command())
    .about(match format {
      PromotionFormat::Heic => {
        "Convert existing HEIC file items into image items, retaining their IDs and original data."
      }
      PromotionFormat::Cr2 => {
        "Convert existing CR2 file items into image items using embedded JPEG previews, retaining IDs and originals."
      }
    })
    .after_help(
      "Stop the web server before running this command. By default, only candidates are listed; no originals are \
       read or items changed. With --apply, originals are decoded one at a time and successful conversions are \
       saved individually. Rerun to retry failures; already converted images are skipped. Missing image tagging \
       and search work is picked up when the web server restarts.",
    )
    .arg(
      Arg::new("user")
        .long("user")
        .help("The username or ID of the user whose file items should be converted.")
        .num_args(1)
        .required(true),
    )
    .arg(
      Arg::new("settings_path")
        .short('s')
        .long("settings")
        .help("Path to settings.toml, or its directory. Defaults to the usual Infumap configuration.")
        .num_args(1),
    )
    .arg(
      Arg::new("apply")
        .long("apply")
        .help("Decode and save conversions. Without this flag, only list candidates by MIME type or extension.")
        .action(ArgAction::SetTrue),
    )
}

pub async fn execute(sub_matches: &ArgMatches, format: PromotionFormat) -> InfuResult<()> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let user_name_or_id = sub_matches.get_one::<String>("user").ok_or("--user is required.")?;
  let user_db = UserDb::init(&data_dir).await?;
  let user = user_db
    .get_by_username_case_insensitive(user_name_or_id)
    .or_else(|| user_db.get(user_name_or_id))
    .ok_or_else(|| format!("User '{}' does not exist.", user_name_or_id))?;
  let mut item_db = ItemDb::init(&data_dir);
  item_db.load_user_items(&user.id, false).await?;
  let mut candidate_ids = item_db
    .user_items(&user.id)
    .filter(|item| is_candidate(item, format))
    .map(|item| item.id.clone())
    .collect::<Vec<_>>();
  candidate_ids.sort();

  println!("Found {} {} file candidate(s) for '{}' ({}).", candidate_ids.len(), format.name(), user.username, user.id);
  if !sub_matches.get_flag("apply") {
    for id in &candidate_ids {
      let item = item_db.get(id)?;
      println!("{}\t{:?}\t{}", id, item.title.as_deref().unwrap_or(""), item.mime_type.as_deref().unwrap_or(""));
    }
    println!("Dry run: no originals read or items changed. Stop the web server and add --apply to convert.");
    return Ok(());
  }
  if candidate_ids.is_empty() {
    return Ok(());
  }

  let object_store = configured_object_store(&config, &data_dir)?;
  let mut converted_count = 0;
  let mut failed_count = 0;
  for (index, id) in candidate_ids.iter().enumerate() {
    let source = item_db.get(id)?.clone();
    print!("[{}/{}] {} {:?}: ", index + 1, candidate_ids.len(), id, source.title.as_deref().unwrap_or(""));
    std::io::stdout().flush()?;
    let image = match prepare_image_item(source, object_store.clone(), &user.object_encryption_key, format).await {
      Ok(image) => image,
      Err(error) => {
        failed_count += 1;
        println!("FAILED (left as file): {}", error);
        continue;
      }
    };

    // A failed append may leave an incomplete log record. Stop on persistence errors rather than appending
    // further conversions to a potentially damaged log. Decode/read failures above never touch the database.
    item_db.replace_type(&image).await.map_err(|error| {
      format!(
        "Could not save conversion for '{}': {}. Stopped after {} conversion(s) and {} read/decode failure(s).",
        id, error, converted_count, failed_count
      )
    })?;
    converted_count += 1;
    println!("converted");
  }
  println!("Finished: {} converted, {} failed.", converted_count, failed_count);
  if converted_count > 0 {
    // Queues are in memory: startup reconciliation will schedule missing artifacts for these image items.
    println!("Restart the web server to pick up missing image tagging and search processing.");
  }
  if failed_count > 0 {
    return Err(
      format!("Some {} files could not be converted. They remain file items; rerun to retry them.", format.name())
        .into(),
    );
  }
  Ok(())
}

fn is_candidate(item: &Item, format: PromotionFormat) -> bool {
  item.item_type == ItemType::File
    && (item.mime_type.as_deref().is_some_and(|mime_type| format.matches_mime(&normalized_mime_type(mime_type)))
      || item
        .title
        .as_deref()
        .and_then(mime_type_from_title_extension)
        .is_some_and(|mime_type| format.matches_mime(&mime_type)))
}

async fn prepare_image_item(
  mut source: Item,
  object_store: Arc<ObjectStore>,
  encryption_key: &str,
  format: PromotionFormat,
) -> InfuResult<Item> {
  let bytes = object::get(object_store, source.owner_id.clone(), source.id.clone(), encryption_key).await?;
  // Names and MIME types only select candidates. Validate the actual format before promoting.
  if !format.matches_data(&bytes) {
    return Err(format!("Original data is not a {} image.", format.name()).into());
  }
  let item_id = source.id.clone();
  let permit = IMAGE_PROCESSING_SEMAPHORE
    .clone()
    .acquire_owned()
    .await
    .map_err(|e| format!("Image processing semaphore closed: {}", e))?;
  let (dimensions, placeholder) = tokio::task::spawn_blocking(move || -> InfuResult<_> {
    let _permit = permit;
    let img = decode_image(&bytes, &item_id)?;
    Ok((Dimensions { w: i64::from(img.width()), h: i64::from(img.height()) }, create_image_placeholder(&img)?))
  })
  .await
  .map_err(|e| format!("Image conversion task failed: {}", e))??;

  source.item_type = ItemType::Image;
  source.mime_type = Some(format.mime_type().to_owned());
  source.image_size_px = Some(dimensions);
  source.thumbnail = Some(general_purpose::STANDARD.encode(placeholder));
  // File icons are not image fields, and file flag bits have different meanings from image flag bits.
  source.emoji = None;
  source.icon_mode = None;
  source.flags = Some(0);
  source.last_modified_date = unix_now_secs_i64()?.max(source.last_modified_date.saturating_add(1));
  // Check required image fields and reject any remaining file-only fields before writing the replacement.
  Item::from_api_json(&source.to_api_json()?)?;
  Ok(source)
}

fn configured_object_store(config: &Config, data_dir: &str) -> InfuResult<Arc<ObjectStore>> {
  object::new(
    data_dir,
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
}
