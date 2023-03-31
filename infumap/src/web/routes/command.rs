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

use base64::{Engine as _, engine::general_purpose};
use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use hyper::{Request, Response};
use image::ImageOutputFormat;
use image::imageops::FilterType;
use image::io::Reader;
use log::{debug, error, warn};
use once_cell::sync::Lazy;
use prometheus::{IntCounterVec, opts};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::str;
use std::io::Cursor;
use std::sync::Arc;

use crate::storage::db::Db;
use crate::storage::db::item::{Item, is_data_item, is_image_item};
use crate::storage::cache as storage_cache;
use crate::storage::object;
use crate::util::infu::InfuResult;
use crate::util::ordering::new_ordering_at_end;
use crate::util::uid::{is_empty_uid, new_uid, EMPTY_UID, is_uid};
use crate::web::serve::{json_response, incoming_json};
use crate::web::session::get_and_validate_session;

use super::WebApiJsonSerializable;


pub static METRIC_COMMANDS_HANDLED_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(opts!(
    "commands_handled_total",
    "Total number of times a command type has been called."), &["name", "success"])
      .expect("Could not create METRIC_COMMANDS_HANDLED_TOTAL")
});

#[derive(Deserialize, Serialize)]
pub struct SendRequest {
  pub command: String,
  #[serde(rename="jsonData")]
  pub json_data: String,
  #[serde(rename="base64Data")]
  pub base64_data: Option<String>,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct SendResponse {
  pub success: bool,
  #[serde(rename="jsonData")]
  pub json_data: Option<String>,
}

pub async fn serve_command_route(
    db: &Arc<tokio::sync::Mutex<Db>>,
    object_store: &Arc<object::ObjectStore>,
    image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
    request: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {

  let session = match get_and_validate_session(&request, db).await {
    Some(session) => session,
    None => { return json_response(&SendResponse { success: false, json_data: None }); }
  };

  {
    // Load user items if required
    let mut db = db.lock().await;
    if !db.item.user_items_loaded(&session.user_id) {
      match db.item.load_user_items(&session.user_id, false).await {
        Ok(_) => {},
        Err(e) => {
          error!("An error occurred loading item state for user '{}': {}", session.user_id, e);
          return json_response(&SendResponse { success: false, json_data: None });
        }
      }
    }
  }

  let request: SendRequest = match incoming_json(request).await {
    Ok(r) => r,
    Err(e) => {
      error!("An error occurred parsing command payload for user '{}': {}", session.user_id, e);
      return json_response(&SendResponse { success: false, json_data: None });
    }
  };

  debug!("Received '{}' command for user '{}'.", request.command, session.user_id);

  let response_data_maybe = match request.command.as_str() {
    "get-children-with-their-attachments" => handle_get_children_with_their_attachments(db, &request.json_data, &session.user_id).await,
    "add-item" => handle_add_item(db, object_store.clone(), &request.json_data, &request.base64_data, &session.user_id).await,
    "update-item" => handle_update_item(db, &request.json_data, &session.user_id).await,
    "delete-item" => handle_delete_item(db, object_store.clone(), image_cache, &request.json_data, &session.user_id).await,
    _ => {
      warn!("Unknown command '{}' issued by user '{}', session '{}'", request.command, session.user_id, session.id);
      return json_response(&SendResponse { success: false, json_data: None });
    }
  };

  let response_data = match response_data_maybe {
    Ok(r) => r,
    Err(e) => {
      warn!("An error occurred servicing a '{}' command for user '{}': {}.", request.command, session.user_id, e);
      METRIC_COMMANDS_HANDLED_TOTAL.with_label_values(&[&request.command, "false"]).inc();
      return json_response(&SendResponse { success: false, json_data: None });
    }
  };

  METRIC_COMMANDS_HANDLED_TOTAL.with_label_values(&[&request.command, "true"]).inc();
  let r = SendResponse { success: true, json_data: response_data };

  debug!("Successfully processed a '{}' command.", request.command);
  json_response(&r)
}


#[derive(Deserialize, Serialize)]
pub struct GetChildrenRequest {
  #[serde(rename="parentId")]
  pub parent_id_maybe: Option<String>,
}

async fn handle_get_children_with_their_attachments(
    db: &Arc<tokio::sync::Mutex<Db>>,
    json_data: &str,
    session_user_id: &String) -> InfuResult<Option<String>> {
  let db = db.lock().await;

  let request: GetChildrenRequest = serde_json::from_str(json_data)?;

  let parent_id = match &request.parent_id_maybe {
    Some(parent_id) => parent_id,
    None => {
      &db.user.get(session_user_id).ok_or(format!("Unknown user '{}'.", session_user_id))?.root_page_id
    }
  };

  let parent_item = db.item.get(parent_id)?;
  if &parent_item.owner_id != session_user_id {
    return Err(format!("User '{}' does not own item '{}'.", session_user_id, parent_id).into());
  }

  let child_items = db.item
    .get_children(parent_id)?;

  let children_result = child_items.iter()
    .map(|v| v.to_api_json().ok())
    .collect::<Option<Vec<serde_json::Map<String, serde_json::Value>>>>()
    .ok_or(format!("Error occurred getting children for container '{}'.", parent_id))?;

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


async fn handle_add_item(
    db: &Arc<tokio::sync::Mutex<Db>>,
    object_store: Arc<object::ObjectStore>,
    json_data: &str,
    base64_data_maybe: &Option<String>,
    session_user_id: &String) -> InfuResult<Option<String>> {
  let mut db = db.lock().await;

  let deserializer = serde_json::Deserializer::from_str(json_data);
  let mut iterator = deserializer.into_iter::<serde_json::Value>();
  let item_map_maybe = iterator.next().ok_or("Add item request has no item data.")??;
  let mut item_map = item_map_maybe.as_object().ok_or("Add item request body is not a JSON object.")?.clone();

  // The JSON sent to an add-item command is more flexible than the item schema allows for.
  // First step is to prep/transform the received JSON map for deserialization into an item object.

  // 1. A missing id is interpreted as a request to generate a new one.
  if !item_map.contains_key("id") {
    item_map.insert("id".to_owned(), Value::String(new_uid().to_owned()));
  }

  // 2. A missing parent_id is interpreted as a request to use the user's root page id.
  if !item_map.contains_key("parentId") {
    item_map.insert("parentId".to_owned(),
      Value::String(db.user.get(session_user_id).ok_or(format!("No user with id '{}'.", session_user_id))?.root_page_id.clone()));
  }

  // 3. A missing ordering is interpreted as a request to create one at the end of the childrren of the parent and use that.
  if !item_map.contains_key("ordering") {
    let parent_id_value = item_map.get("parentId").unwrap(); // should always exist at this point.
    let parent_id = parent_id_value.as_str()
      .ok_or(format!("Attempt was made by user '{}' to add an item with a parentId that is not of type String", session_user_id))?;
    if !is_uid(parent_id) {
      return Err(format!("Attempt was made by user '{}' to add an item with invalid parent id.", session_user_id).into());
    }
    let orderings = db.item.get_children(&parent_id.to_owned())?.iter().map(|i| i.ordering.clone()).collect::<Vec<Vec<u8>>>();
    let ordering = new_ordering_at_end(orderings);
    item_map.insert(String::from("ordering"), Value::Array(ordering.iter().map(|v| Value::Number((*v).into())).collect::<Vec<_>>()));
  }

  // 4. TODO (MEDIUM): triage destinations.

  let mut item: Item = Item::from_api_json(&item_map)?;
  let parent_id = item_map.get("parentId").unwrap().as_str().unwrap(); // by this point, should never fail.

  if parent_id == EMPTY_UID {
    return Err(format!("Attempt was made by user '{}' to add an item with an empty parent id.", session_user_id).into());
  }

  let parent_item = db.item.get(&parent_id.to_owned())
    .map_err(|_| format!("Cannot add child item to '{}' because an item with that id does not exist.", parent_id))?;
  if &parent_item.owner_id != session_user_id {
    return Err(format!("Cannot add child item to '{}' because user '{}' is not the owner.", &parent_item.id, session_user_id,).into());
  }

  if is_empty_uid(&item.id) {
    return Err(format!("Attempt was made by user '{}' to add an item with an empty id.", session_user_id).into());
  }

  if &item.owner_id != session_user_id {
    return Err(format!("Item owner_id '{}' mismatch with session user '{}' when adding item '{}'.", item.owner_id, session_user_id, item.id).into());
  }

  if db.item.get(&item.id).is_ok() {
    return Err(format!("Attempt was made to add item with id '{}', but an item with this id already exists.", item.id).into());
  }

  if item.ordering.len() == 0 {
    return Err(format!("Attempt was made by user '{}' to add an item with empty ordering.", session_user_id).into());
  }

  if is_data_item(&item.item_type) {
    let base64_data = base64_data_maybe.as_ref().ok_or(format!("Add item request has no base64 data, when this is expected for item of type {}.", item.item_type))?;
    let decoded = general_purpose::STANDARD.decode(&base64_data).map_err(|e| format!("There was a problem decoding base64 data for new item '{}': {}", item.id, e))?;
    if decoded.len() != item.file_size_bytes.ok_or(format!("File size was not specified for new data item '{}'.", item.id))? as usize {
      return Err(format!("File size specified for new data item '{}' ({}) does not match the actual size of the data ({}).", item.id, item.file_size_bytes.unwrap(), decoded.len()).into());
    }
    let object_encryption_key = &db.user.get(session_user_id).ok_or(format!("User '{}' not found.", session_user_id))?.object_encryption_key;
    object::put(object_store.clone(), session_user_id, &item.id, &decoded, object_encryption_key).await?;

    if is_image_item(&item.item_type) {
      let file_cursor = Cursor::new(decoded);
      let file_reader = Reader::new(file_cursor).with_guessed_format()?;
      let img = file_reader.decode().ok().ok_or(format!("Could not add new image item '{}' - could not interpret base64 data as an image.", item.id))?;
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
  db.item.add(item).await?;

  Ok(Some(serialized_item))
}


async fn handle_update_item(
    db: &Arc<tokio::sync::Mutex<Db>>,
    json_data: &str,
    session_user_id: &String) -> InfuResult<Option<String>> {
  let mut db = db.lock().await;

  let deserializer = serde_json::Deserializer::from_str(json_data);
  let mut iterator = deserializer.into_iter::<serde_json::Value>();
  let item_map_maybe = iterator.next().ok_or("Update item request has no item.")??;
  let item_map = item_map_maybe.as_object().ok_or("Update item request body is not a JSON object.")?;
  let item: Item = Item::from_api_json(item_map)?;

  if &db.item.get(&item.id)?.owner_id != session_user_id {
    return Err(format!("Item owner_id '{}' mismatch with session user '{}' when updating item '{}'.", item.owner_id, session_user_id, item.id).into());
  }

  db.item.update(&item).await?;
  Ok(None)
}


#[derive(Deserialize)]
pub struct DeleteItemRequest {
  #[serde(rename="id")]
  pub id: String,
}

async fn handle_delete_item<'a>(
    db: &Arc<tokio::sync::Mutex<Db>>,
    object_store: Arc<object::ObjectStore>,
    image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
    json_data: &str,
    session_user_id: &String) -> InfuResult<Option<String>> {
  let mut db = db.lock().await;

  let request: DeleteItemRequest = serde_json::from_str(json_data)?;

  if &db.item.get(&request.id)?.owner_id != session_user_id {
    return Err(format!("User '{}' does not own item '{}'.", session_user_id, request.id).into());
  }

  if db.item.has_children_or_attachments(&request.id)? {
    return Err(format!("Cannot delete item '{}' because it has one or more associated child or attachment item.", request.id).into());
  }

  let item = db.item.remove(&request.id).await?;
  debug!("Deleted item '{}' from database.", request.id);

  if is_data_item(&item.item_type) {
    object::delete(object_store.clone(), session_user_id, &request.id).await?;
    debug!("Deleted item '{}' from object store.", request.id);
  }
  if is_image_item(&item.item_type) {
    let num_removed = storage_cache::delete_all(image_cache, session_user_id, &request.id).await?;
    debug!("Deleted all {} entries related to item '{}' from image cache.", num_removed, request.id);
  }
  Ok(None)
}
