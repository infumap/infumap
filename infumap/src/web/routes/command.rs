// Copyright (C) 2022-2023 The Infumap Authors
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

use std::io::Cursor;
use std::sync::{Mutex, MutexGuard};
use base64::{Engine as _, engine::general_purpose};
use image::ImageOutputFormat;
use image::imageops::FilterType;
use image::io::Reader;
use log::{error, warn, debug};
use once_cell::sync::Lazy;
use rocket::http::CookieJar;
use rocket::State;
use rocket::serde::json::{Json, Value};
use rocket_prometheus::prometheus::{IntCounterVec, opts};
use serde::{Deserialize, Serialize};
use crate::storage::cache::FileCache;
use crate::storage::db::Db;
use crate::storage::db::item::{Item, is_data_item, is_image_item};
use crate::storage::file::FileStore;
use crate::util::infu::InfuResult;
use crate::web::session::get_and_validate_session;
use super::WebApiJsonSerializable;


pub static METRIC_COMMANDS_HANDLED_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(opts!(
    "commands_handled_total",
    "Total number of times a command has been called."), &["name", "success"])
      .expect("Could not create METRIC_COMMANDS_HANDLED_TOTAL")
});

#[derive(Deserialize)]
pub struct SendRequest {
  command: String,
  #[serde(rename="jsonData")]
  json_data: String,
  #[serde(rename="base64Data")]
  base64_data: Option<String>,
}

#[derive(Serialize)]
pub struct SendResponse {
  success: bool,
  #[serde(rename="jsonData")]
  json_data: Option<String>,
}

#[post("/command", data = "<request>")]
pub fn command(
    db: &State<Mutex<Db>>,
    file_store: &State<Mutex<FileStore>>,
    cache: &State<Mutex<FileCache>>,
    request: Json<SendRequest>,
    cookies: &CookieJar) -> Json<SendResponse> {

  let mut db = db.lock().unwrap();

  let session = match get_and_validate_session(cookies, &mut db) {
    Ok(s) => s,
    Err(e) => {
      error!("An error occured retrieving user session: {}", e);
      return Json(SendResponse { success: false, json_data: None });
    }
  };

  // load user items if required
  if !db.item.user_items_loaded(&session.user_id) {
    match db.item.load_user_items(&session.user_id, false) {
      Ok(_) => {},
      Err(e) => {
        error!("An error occurred loading item state for user '{}': {}", session.user_id, e);
        return Json(SendResponse { success: false, json_data: None });
      }
    }
  }

  // handle
  let response_data_maybe = match request.command.as_str() {
    "get-children-with-their-attachments" => handle_get_children_with_their_attachments(&mut db, &request.json_data),
    "add-item" => handle_add_item(&mut db, &file_store, &request.json_data, &request.base64_data, &session.user_id),
    "update-item" => handle_update_item(&mut db, &request.json_data),
    "delete-item" => handle_delete_item(&mut db, &file_store, &cache, &request.json_data, &session.user_id),
    _ => {
      warn!("Unknown command '{}' issued by user '{}', session '{}'", request.command, session.user_id, session.id);
      return Json(SendResponse { success: false, json_data: None });
    }
  };

  let response_data = match response_data_maybe {
    Ok(r) => r,
    Err(e) => {
      error!("An error occurred servicing a '{}' command for user '{}': {}.", request.command, session.user_id, e);
      METRIC_COMMANDS_HANDLED_TOTAL.with_label_values(&[&request.command, "false"]).inc();
      return Json(SendResponse { success: false, json_data: None });
    }
  };

  METRIC_COMMANDS_HANDLED_TOTAL.with_label_values(&[&request.command, "true"]).inc();
  let r = SendResponse { success: true, json_data: response_data };
  Json(r)
}


#[derive(Deserialize)]
pub struct GetChildrenRequest {
  #[serde(rename="parentId")]
  parent_id: String,
}

fn handle_get_children_with_their_attachments(db: &mut MutexGuard<Db>, json_data: &str) -> InfuResult<Option<String>> {
  let request: GetChildrenRequest = serde_json::from_str(json_data)?;
  let child_items = db.item
    .get_children(&request.parent_id)?;

  let children_result = child_items.iter()
    .map(|v| v.to_api_json().ok())
    .collect::<Option<Vec<serde_json::Map<String, serde_json::Value>>>>()
    .ok_or(format!("Error occurred getting children for {}", &request.parent_id))?;

  let mut attachments_result = serde_json::Map::new();

  for c in &child_items {
    let id = &c.id;
    let item_attachments_result = db.item.get_attachments(id)?.iter()
      .map(|v| v.to_api_json().ok())
      .collect::<Option<Vec<serde_json::Map<String, serde_json::Value>>>>()
      .ok_or(format!("Error occurred getting attachments for {}", id))?;
    if item_attachments_result.len() > 0 {
      attachments_result.insert(id.clone(), Value::from(item_attachments_result));
    }
  }

  let mut result = serde_json::Map::new();
  result.insert(String::from("children"), Value::from(children_result));
  result.insert(String::from("attachments"), Value::from(attachments_result));

  Ok(Some(serde_json::to_string(&result)?))
}


fn handle_add_item(
    db: &mut MutexGuard<Db>,
    file_store: &State<Mutex<FileStore>>,
    json_data: &str,
    base64_data_maybe: &Option<String>,
    user_id: &String) -> InfuResult<Option<String>> {

  let deserializer = serde_json::Deserializer::from_str(json_data);
  let mut iterator = deserializer.into_iter::<serde_json::Value>();
  let item_map_maybe = iterator.next().ok_or("Add item request has no item data.")??;
  let item_map = item_map_maybe.as_object().ok_or("Add item request body is not a JSON object.")?;
  let mut item: Item = Item::from_api_json(item_map)?;

  if db.item.get(&item.id).is_ok() {
    return Err(format!("Attempt was made to add item with id '{}', but an item with this id already exists.", item.id).into());
  }

  if is_data_item(&item.item_type) {
    let base64_data = base64_data_maybe.as_ref().ok_or(format!("Add item request has no base64 data, when this is expected for item of type {}.", item.item_type))?;
    let decoded = general_purpose::STANDARD.decode(&base64_data).map_err(|e| format!("There was a problem decoding base64 data for new item '{}': {}", item.id, e))?;
    if decoded.len() != item.file_size_bytes.ok_or(format!("File size was not specified for new data item '{}'.", item.id))? as usize {
      return Err(format!("File size specified for new data item '{}' ({}) does not match the actual size of the data ({}).", item.id, item.file_size_bytes.unwrap(), decoded.len()).into());
    }
    file_store.lock().unwrap().put(user_id, &item.id, &decoded)?;

    if is_image_item(&item.item_type) {
      let file_cursor = Cursor::new(decoded);
      let file_reader = Reader::new(file_cursor).with_guessed_format()?;
      let img = file_reader.decode().ok().ok_or(format!("Could not add new image item '{}' - could not interpret base64 data as a image.", item.id))?;
      let img = img.resize_exact(8, 8, FilterType::Nearest);
      // TODO (LOW): consider EXIF rotation information - the thumbnail may not be oriented correctly. But it's only 8x8, so doesn't matter much.
      let buf = Vec::new();
      let mut cursor = Cursor::new(buf);
      img.write_to(&mut cursor, ImageOutputFormat::Png)
        .map_err(|e| format!("An error occured creating the thumbnail png for new image '{}': {}.", item.id, e))?;
      let thumbnail_data = cursor.get_ref().to_vec();
      let thumbnail_base64 = general_purpose::STANDARD.encode(thumbnail_data);
      item.thumbnail = Some(thumbnail_base64);
    }
  } else {
    if base64_data_maybe.is_some() {
      return Err("Add item request has base64 data, when this is not expected.".into());
    }
  }

  let serialized_item = serde_json::to_string(&item.to_api_json()?)?;
  db.item.add(item)?;

  Ok(Some(serialized_item))
}


fn handle_update_item(
    db: &mut MutexGuard<Db>,
    json_data: &str) -> InfuResult<Option<String>> {

  let deserializer = serde_json::Deserializer::from_str(json_data);
  let mut iterator = deserializer.into_iter::<serde_json::Value>();
  let item_map_maybe = iterator.next().ok_or("Update item request has no item.")??;
  let item_map = item_map_maybe.as_object().ok_or("Update item request body is not a JSON object.")?;
  let item: Item = Item::from_api_json(item_map)?;
  db.item.update(&item)?;
  Ok(None)
}


#[derive(Deserialize)]
pub struct DeleteItemRequest {
  #[serde(rename="id")]
  id: String,
}

fn handle_delete_item(
    db: &mut MutexGuard<Db>,
    file_store: &State<Mutex<FileStore>>,
    cache: &State<Mutex<FileCache>>,
    json_data: &str,
    user_id: &String) -> InfuResult<Option<String>> {

  let request: DeleteItemRequest = serde_json::from_str(json_data)?;

  if db.item.has_children_or_attachments(&request.id)? {
    return Err(format!("Cannot delete item '{}' because it has one or more associated child or attachment item.", request.id).into());
  }

  let item = db.item.remove(&request.id)?;
  debug!("Deleting item '{}' from database.", request.id);

  if is_data_item(&item.item_type) {
    let mut file_store = file_store.lock().unwrap();
    file_store.delete(user_id, &request.id)?;
    debug!("Deleted item '{}' from filestore.", request.id);
  }
  if is_image_item(&item.item_type) {
    let mut cache = cache.lock().unwrap();
    let num_removed = cache.delete_all_with_prefix(user_id, &request.id)?;
    debug!("Deleted all {} entries related to item '{}' from cache.", num_removed, request.id);
  }
  Ok(None)
}
