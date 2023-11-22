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
use tokio::sync::MutexGuard;
use std::str;
use std::io::Cursor;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use async_recursion::async_recursion;

use crate::storage::db::Db;
use crate::storage::db::item::{Item, RelationshipToParent, ItemType, is_positionable_type, is_page_item, PermissionFlags, is_table_item, is_flags_item_type, is_permission_flags_item_type, is_composite_item};
use crate::storage::db::item::{is_data_item_type, is_image_item, is_container_item_type, is_attachments_item_type};
use crate::storage::cache as storage_cache;
use crate::storage::db::session::Session;
use crate::storage::db::user::ROOT_USER_NAME;
use crate::storage::object;
use crate::util::geometry::{Vector, Dimensions};
use crate::util::image::{get_exif_orientation, adjust_image_for_exif_orientation};
use crate::util::infu::InfuResult;
use crate::util::json;
use crate::util::ordering::new_ordering_at_end;
use crate::util::uid::{is_empty_uid, new_uid, EMPTY_UID, is_uid, Uid};
use crate::web::serve::{json_response, incoming_json, cors_response};
use crate::web::session::get_and_validate_session;

use super::WebApiJsonSerializable;


pub static METRIC_COMMANDS_HANDLED_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(opts!(
    "commands_handled_total",
    "Total number of times a command type has been called."), &["name", "success"])
      .expect("Could not create METRIC_COMMANDS_HANDLED_TOTAL")
});

#[derive(Deserialize, Serialize)]
pub struct CommandRequest {
  pub command: String,
  #[serde(rename="jsonData")]
  pub json_data: String,
  #[serde(rename="base64Data")]
  pub base64_data: Option<String>,
}

const REASON_SERVER: &str = "server";
const REASON_CLIENT: &str = "client";

#[derive(Deserialize, Serialize, Debug)]
pub struct CommandResponse {
  pub success: bool,
  #[serde(rename="failReason")]
  pub fail_reason: Option<String>,
  #[serde(rename="jsonData")]
  pub json_data: Option<String>,
}


pub async fn serve_command_route(
    db: &Arc<tokio::sync::Mutex<Db>>,
    object_store: &Arc<object::ObjectStore>,
    image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
    request: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {

  if request.method() == "OPTIONS" {
    debug!("Serving OPTIONS request, assuming CORS query.");
    return cors_response();
  }

  let session_maybe = get_and_validate_session(&request, db).await;

  let request: CommandRequest = match incoming_json(request).await {
    Ok(r) => r,
    Err(e) => {
      error!("An error occurred parsing command payload for user: {}", e);
      return json_response(&CommandResponse { success: false, fail_reason: Some(REASON_CLIENT.to_owned()), json_data: None });
    }
  };

  if let Some(session) = &session_maybe {
    debug!("Received '{}' command from user '{}'.", request.command, session.user_id);
  } else {
    debug!("Received '{}' command from sessionless user.", request.command);
  }

  let response_data_maybe = match request.command.as_str() {
    "get-items" => handle_get_items(db, &request.json_data, &session_maybe).await,
    "get-attachments" => handle_get_attachments(db, &request.json_data, &session_maybe).await,
    "add-item" => handle_add_item(db, object_store.clone(), &request.json_data, &request.base64_data, &session_maybe).await,
    "update-item" => handle_update_item(db, &request.json_data, &session_maybe).await.map(|_| None),
    "delete-item" => handle_delete_item(db, object_store.clone(), image_cache, &request.json_data, &session_maybe).await.map(|_| None),
    "search" => handle_search(db, &request.json_data, &session_maybe).await,
    "empty-trash" => handle_empty_trash(db, object_store.clone(), image_cache, &session_maybe).await,
    _ => {
      if let Some(session) = &session_maybe {
        warn!("Unknown command '{}' issued by user '{}', session '{}'", request.command, session.user_id, session.id);
      } else {
        warn!("Unknown command '{}' issued by anonymous user", request.command);
      }
      return json_response(&CommandResponse { success: false, fail_reason: Some(REASON_CLIENT.to_owned()), json_data: None });
    }
  };

  let response_data = match response_data_maybe {
    Ok(r) => r,
    Err(e) => {
      if let Some(session) = &session_maybe {
        warn!("An error occurred servicing a '{}' command for user '{}': {}.", request.command, session.user_id, e);
      } else {
        warn!("An error occurred servicing a '{}' command for sessionless user: {}.", request.command, e);
      }
      METRIC_COMMANDS_HANDLED_TOTAL.with_label_values(&[&request.command, "false"]).inc();
      return json_response(&CommandResponse { success: false, fail_reason: Some(REASON_SERVER.to_owned()), json_data: None });
    }
  };

  METRIC_COMMANDS_HANDLED_TOTAL.with_label_values(&[&request.command, "true"]).inc();
  let r = CommandResponse { success: true, fail_reason: None, json_data: response_data };

  debug!("Successfully processed a '{}' command.", request.command);
  json_response(&r)
}


#[derive(Debug, PartialEq)]
pub enum GetItemsMode {
  ItemAndAttachmentsOnly,
  ItemAttachmentsChildrenAndTheirAttachments,
  ChildrenAndTheirAttachmentsOnly
}

impl GetItemsMode {
  pub fn as_str(&self) -> &'static str {
    match self {
      GetItemsMode::ChildrenAndTheirAttachmentsOnly => "children-and-their-attachments-only",
      GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments => "item-attachments-children-and-their-attachments",
      GetItemsMode::ItemAndAttachmentsOnly => "item-and-attachments-only"
    }
  }

  pub fn from_str(s: &str) -> InfuResult<GetItemsMode> {
    match s {
      "children-and-their-attachments-only" => Ok(GetItemsMode::ChildrenAndTheirAttachmentsOnly),
      "item-attachments-children-and-their-attachments" => Ok(GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments),
      "item-and-attachments-only" => Ok(GetItemsMode::ItemAndAttachmentsOnly),
      other => Err(format!("Invalid GetItemsMode value: '{}'.", other).into())
    }
  }
}


#[derive(Deserialize, Serialize)]
pub struct GetItemsRequest {
  pub id: String,
  pub mode: String
}


/**
 * Access is authorized if and only if:
 * 1.  the session user owns the item.
 * 2.  the item is a page that is marked as public.
 * 3.  the item is in a page that is marked as public.
 * 4.  the item is in a table or composite in a page that is marked as public.
 * 5.  the item is an attachment of a page that is marked as public.
 * 6.  the item is an attachment of an item in a page that is marked as public.
 * 7.  the item is an attachment of an item in a table or composite in a page that is marked as public.
 * 8.  the item is in a composite in a table in a page that is marked as public.
 * 9.  the item is in a composite that is an attachment of a page that is marked as public.
 * 10. the item is in a composite that is an attachment of an item in a page that is marked as public.
 * 11. the item is in a composite that is an attachment of an item in a table or composite in a page that is marked as public.
 * 12. TODO (LOW): attachments of items in a composite.
 *
 * Note that whether or not a link item is authorized has no bearing on whether the
 * corresponding linked-to item is authorized - the authorization is based on the linked
 * to item, and it's canonical parent(s) as above.
 */
pub fn authorize_item(db: &MutexGuard<'_, Db>, item: &Item, session_user_id_maybe: &Option<String>, recursion_level: i32) -> InfuResult<()> {
  if recursion_level > 1 {
    return Err(format!("Not authorized to access item '{}' - recursion level too deep.", item.id).into());
  }

  // any item owned by the session user.
  if let Some(session_user_id) = session_user_id_maybe {
    if &item.owner_id == session_user_id {
      return Ok(());
    }
  }

  // any page that is public
  if is_page_item(item) {
    match item.permission_flags {
      Some(flags) => {
        if flags == PermissionFlags::Public as i64 {
          return Ok(());
        }
      },
      // Should never occur.
      None => return Err(format!("Page item '{}' has no permissions flag property.", item.id).into())
    }
  }

  // any item that has a parent page that is public
  if let Some(item_parent_id) = &item.parent_id {
    match item.relationship_to_parent {

      RelationshipToParent::Child => {
        let item_parent = db.item.get(&item_parent_id)?;
        if is_composite_item(item_parent) {
          // If the item is inside a composite, then what is effectively needed is authorization of the composite.
          match authorize_item(db, item_parent, session_user_id_maybe, recursion_level+1) {
            Ok(_) => return Ok(()),
            Err(e) => {
              return Err(format!("Not authorized to access item '{}': {}", item.id, e.to_string()).into());
            }
          }
        } else {
          item_auth_common(db, &item.id, item_parent)?;
          return Ok(());
        }
      },

      RelationshipToParent::Attachment => {
        let attachment_parent = db.item.get(&item_parent_id)?;
        if item_auth_common(db, &item.id, attachment_parent).is_ok() {
          return Ok(());
        }
        let attachment_parent_parent = match &attachment_parent.parent_id {
          Some(p) => db.item.get(&p)?,
          None => return Err(format!("Attachment parent item '{}' has no parent - cannot authorize.", attachment_parent.id).into())
        };
        item_auth_common(db, &attachment_parent.id, attachment_parent_parent)?;
        return Ok(());
      },

      RelationshipToParent::NoParent => {
        // Should never occur.
        return Err(format!("Item '{}' has no parent relationship, could not authorize.", item.id).into());
      }
    }
  }

  return Err(format!("Not authorized to access item '{}'.", item.id).into());
}

fn item_auth_common(db: &MutexGuard<'_, Db>, item_id: &Uid, item_parent: &Item) -> InfuResult<()> {
  if is_page_item(item_parent) {
    let page_item = item_parent;
    match page_item.permission_flags {
      Some(flags) => {
        if flags == PermissionFlags::Public as i64 {
          return Ok(());
        }
        return Err(format!("Not authorized to access parent page '{}' of item '{}'.", page_item.id, item_id).into());
      },
      // Should never occur.
      None => return Err(format!("Page item '{}' does not have a permissions flag property.", item_id).into())
    }
  } else if is_table_item(item_parent) {
    let parent_parent_id = match &item_parent.parent_id {
      Some(parent_parent_id) => parent_parent_id,
      // Should never occur.
      None => return Err(format!("Expecting table '{}' to have a parent defined.", item_parent.id).into())
    };
    let parent_parent = db.item.get(&parent_parent_id)?;
    if is_page_item(parent_parent) {
      match parent_parent.permission_flags {
        Some(flags) => {
          if flags == PermissionFlags::Public as i64 {
            return Ok(());
          }
          return Err(format!("Not authorized to access parent page '{}' of table '{}' that contains item '{}'.", parent_parent.id, item_parent.id, item_id).into());
        },
        // Should never occur.
        None => return Err(format!("Page item '{}' has no permissions flag property.", item_id).into())
      }
    } else {
      return Err(format!("Expecting parent '{}' of table '{}' to be a page.", parent_parent_id, parent_parent_id).into());
    }
  } else {
    return Err(format!("Item '{}' has unexpected parent type.", item_id).into());
  }
}


fn get_item_authorized<'a>(db: &'a MutexGuard<'_, Db>, id: &Uid, session_user_id_maybe: &Option<String>) -> InfuResult<&'a Item> {
  let item = db.item.get(&id)?;
  authorize_item(db, item, session_user_id_maybe, 0)
    .map_err(|_| format!("Not authorized to access item '{}'.", id))?;
  Ok(item)
}

fn get_children_authorized<'a>(db: &'a MutexGuard<'_, Db>, id: &Uid, session_user_id_maybe: &Option<String>) -> InfuResult<Vec<&'a Item>> {
  let children = db.item.get_children(id)?;
  for child in &children {
    // TODO (LOW): redundant, but doesn't hurt..
    authorize_item(db, child, session_user_id_maybe, 0)
      .map_err(|_| format!("Not authorized to access item '{}'.", id))?;
  }
  Ok(children)
}

fn get_attachments_authorized<'a>(db: &'a MutexGuard<'_, Db>, id: &Uid, session_user_id_maybe: &Option<String>) -> InfuResult<Vec<&'a Item>> {
  let attachments = db.item.get_attachments(id)?;
  for attachment in &attachments {
    // TODO (LOW): redundant, but doesn't hurt..
    authorize_item(db, attachment, session_user_id_maybe, 0)
      .map_err(|_| format!("Not authorized to access item '{}'.", id))?;
  }
  Ok(attachments)
}

async fn handle_get_items(
    db: &Arc<tokio::sync::Mutex<Db>>,
    json_data: &str,
    session_maybe: &Option<Session>) -> InfuResult<Option<String>> {

  let request: GetItemsRequest = serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;

  let parts = request.id.split('/').collect::<Vec<&str>>();
  if parts.len() != 1 {
    // TODO (MEDIUM): implement ids of the form: /{username}/{item_label}.
    return Err(format!("Get items request id '{}' has unexpected format.", request.id).into());
  }

  let item_id = if is_uid(&request.id) {
    request.id.to_owned()
  } else {
    let username = if request.id.len() == 0 { ROOT_USER_NAME } else { &request.id };
    match db.lock().await.user.get_by_username_case_insensitive(username) {
      Some(u) => { u.home_page_id.to_owned() },
      None => { return Err(format!("User '{}' is unknown.", request.id).into()); }
    }
  };

  let session_user_id_maybe = match &session_maybe {
    Some(session) => {
      Some(session.user_id.clone())
    },
    None => None,
  };

  let db = &db.lock().await;

  let mode = GetItemsMode::from_str(&request.mode)?;

  let item: &Item = get_item_authorized(db, &item_id, &session_user_id_maybe)?;

  let mut attachments_result = serde_json::Map::new();

  let children_result;
  if mode == GetItemsMode::ChildrenAndTheirAttachmentsOnly || mode == GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments {
    let child_items = get_children_authorized(db, &item_id, &session_user_id_maybe)?;

    children_result = child_items.iter()
      .map(|v| v.to_api_json().ok())
      .collect::<Option<Vec<serde_json::Map<String, serde_json::Value>>>>()
      .ok_or(format!("Error occurred getting children for container '{}'.", item_id))?;

    for c in &child_items {
      let id = &c.id;
      let item_attachments_result = get_attachments_authorized(db, id, &session_user_id_maybe)?.iter()
        .map(|v| v.to_api_json().ok())
        .collect::<Option<Vec<serde_json::Map<String, serde_json::Value>>>>()
        .ok_or(format!("Error occurred getting attachments for {}", id))?;
      if item_attachments_result.len() > 0 {
        attachments_result.insert(id.clone(), Value::from(item_attachments_result));
      }
    }
  } else {
    children_result = vec![];
  }

  if mode == GetItemsMode::ItemAndAttachmentsOnly || mode == GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments {
    let item_attachents_result = get_attachments_authorized(db, &item_id, &session_user_id_maybe)?.iter()
      .map(|v| v.to_api_json().ok())
      .collect::<Option<Vec<serde_json::Map<String, serde_json::Value>>>>()
      .ok_or(format!("Error occurred getting attachments for item {}", item_id))?;
    if item_attachents_result.len() > 0 {
      attachments_result.insert(item_id.clone(), Value::from(item_attachents_result));
    }
  }

  let mut result = serde_json::Map::new();
  if mode == GetItemsMode::ItemAndAttachmentsOnly || mode == GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments {
    let item_json_map = match item.to_api_json() {
      Ok(r) => r,
      Err(e) => return Err(format!("Error occurred getting item {}: {}", item_id, e).into())
    };
    result.insert(String::from("item"), Value::from(item_json_map));
  }
  result.insert(String::from("children"), Value::from(children_result));
  result.insert(String::from("attachments"), Value::from(attachments_result));

  debug!("Executed 'get-items' command for item '{}'.", item_id);

  Ok(Some(serde_json::to_string(&result)?))
}


#[derive(Deserialize, Serialize)]
pub struct GetAttachmentsRequest {
  #[serde(rename="parentId")]
  pub parent_id_maybe: Option<String>,
}

async fn handle_get_attachments(
    db: &Arc<tokio::sync::Mutex<Db>>,
    json_data: &str,
    session_maybe: &Option<Session>) -> InfuResult<Option<String>> {
  let db = db.lock().await;

  let request: GetAttachmentsRequest = serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;

  // TODO (MEDIUM): support sessionless get.
  let session = match session_maybe {
    Some(session) => session,
    None => { return Err(format!("Session is required to update an item.").into()); }
  };

  let parent_id = match &request.parent_id_maybe {
    Some(parent_id) => parent_id,
    None => {
      &db.user.get(&session.user_id).ok_or(format!("Unknown user '{}'.", &session.user_id))?.home_page_id
    }
  };

  let parent_item = db.item.get(parent_id)?;
  if &parent_item.owner_id != &session.user_id {
    return Err(format!("User '{}' does not own item '{}'.", &session.user_id, parent_id).into());
  }

  let attachment_items = db.item
    .get_attachments(parent_id)?;

  let attachments_result = attachment_items.iter()
    .map(|v| v.to_api_json().ok())
    .collect::<Option<Vec<serde_json::Map<String, serde_json::Value>>>>()
    .ok_or(format!("Error occurred getting attachments for item '{}'.", parent_id))?;

  debug!("Executed 'get-attachments' command for item '{}'.", parent_id);

  Ok(Some(serde_json::to_string(&attachments_result)?))
}


async fn handle_add_item(
    db: &Arc<tokio::sync::Mutex<Db>>,
    object_store: Arc<object::ObjectStore>,
    json_data: &str,
    base64_data_maybe: &Option<String>,
    session_maybe: &Option<Session>) -> InfuResult<Option<String>> {
  let mut db = db.lock().await;

  let session = match session_maybe {
    Some(session) => session,
    None => { return Err(format!("Session is required to add an item.").into()); }
  };

  let deserializer = serde_json::Deserializer::from_str(json_data);
  let mut iterator = deserializer.into_iter::<serde_json::Value>();
  let item_map_maybe = iterator.next().ok_or("Add item request has no item data.")??;
  let mut item_map = item_map_maybe.as_object().ok_or("Add item request body is not a JSON object.")?.clone();

  let item_type = String::from(
    item_map.get("itemType").ok_or("Item type was not specified.")?.as_str().ok_or("'itemType' field is not a string.")?);

  // The JSON sent to an add-item command is more flexible than the item schema allows for.
  // First step is to prep/transform/add defaults to the received JSON map for deserialization into an item object.

  if !item_map.contains_key("id") {
    item_map.insert("id".to_owned(), Value::String(new_uid().to_owned()));
  }

  if !item_map.contains_key("parentId") {
    item_map.insert("parentId".to_owned(),
      Value::String(db.user.get(&session.user_id).ok_or(format!("No user with id '{}'.", &session.user_id))?.home_page_id.clone()));
  }

  if !item_map.contains_key("ownerId") {
    item_map.insert("ownerId".to_owned(), Value::String(session.user_id.to_owned()));
  }

  if !item_map.contains_key("relationshipToParent") {
    item_map.insert("relationshipToParent".to_owned(), Value::String("child".to_owned()));
  }

  let unix_time_now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

  if !item_map.contains_key("creationDate") {
    item_map.insert("creationDate".to_owned(), Value::Number(unix_time_now.into()));
  }

  if !item_map.contains_key("lastModifiedDate") {
    item_map.insert("lastModifiedDate".to_owned(), Value::Number(unix_time_now.into()));
  }

  if !item_map.contains_key("spatialPositionGr") {
    if is_positionable_type(ItemType::from_str(&item_type)?) {
      item_map.insert("spatialPositionGr".to_owned(), json::vector_to_object(&Vector { x: 0, y: 0 }));
    }
  }

  if item_type == ItemType::Note.as_str() && !item_map.contains_key("format") {
    item_map.insert("format".to_owned(), Value::String("".to_owned()));
  }

  if item_type == ItemType::Image.as_str() && !item_map.contains_key("imageSizePx") {
    item_map.insert("imageSizePx".to_owned(), json::dimensions_to_object(&Dimensions { w: -1, h: -1 }));
  }

  if item_type == ItemType::Image.as_str() && !item_map.contains_key("thumbnail") {
    item_map.insert("thumbnail".to_owned(), Value::String("".to_owned()));
  }

  if is_flags_item_type(ItemType::from_str(&item_type)?) && !item_map.contains_key("flags") {
    item_map.insert("flags".to_owned(), Value::Number(0.into()));
  }

  if is_permission_flags_item_type(ItemType::from_str(&item_type)?) && !item_map.contains_key("permissionFlags") {
    item_map.insert("permissionFlags".to_owned(), Value::Number(0.into()));
  }

  if !item_map.contains_key("ordering") {
    let parent_id_value = item_map.get("parentId").unwrap(); // should always exist at this point.
    let parent_id = parent_id_value.as_str()
      .ok_or(format!("Attempt was made by user '{}' to add an item with a parentId that is not of type String", &session.user_id))?;
    if !is_uid(parent_id) {
      return Err(format!("Attempt was made by user '{}' to add an item with invalid parent id.", &session.user_id).into());
    }
    let orderings = db.item.get_children(&parent_id.to_owned())?.iter().map(|i| i.ordering.clone()).collect::<Vec<Vec<u8>>>();
    let ordering = new_ordering_at_end(orderings);
    item_map.insert(String::from("ordering"), Value::Array(ordering.iter().map(|v| Value::Number((*v).into())).collect::<Vec<_>>()));
  }

  // 4. TODO (MEDIUM): triage destinations.

  let mut item: Item = Item::from_api_json(&item_map)?;
  let parent_id = item_map.get("parentId").unwrap().as_str().unwrap(); // by this point, should never fail.

  if parent_id == EMPTY_UID {
    return Err(format!("Attempt was made by user '{}' to add an item with an empty parent id.", &session.user_id).into());
  }

  let parent_item = db.item.get(&parent_id.to_owned())
    .map_err(|_| format!("Cannot add child item to '{}' because an item with that id does not exist.", parent_id))?;
  if &parent_item.owner_id != &session.user_id {
    return Err(format!("Cannot add child item to '{}' because user '{}' is not the owner.", &parent_item.id, &session.user_id,).into());
  }

  match item.relationship_to_parent {
    RelationshipToParent::Child => {
      if !is_container_item_type(parent_item.item_type) {
        return Err(format!("Attempt was made by user '{}' to add a child item to a non-container parent.", &session.user_id).into());
      }
    },
    RelationshipToParent::Attachment => {
      if !is_attachments_item_type(parent_item.item_type) {
        return Err(format!("Attempt was made by user '{}' to add an attachment item to a non-attachments parent.", &session.user_id).into());
      }
    },
    RelationshipToParent::NoParent => {
      return Err(format!("Attempt was made by user '{}' to add a root level page.", &session.user_id).into());
    }
  };

  if is_empty_uid(&item.id) {
    return Err(format!("Attempt was made by user '{}' to add an item with an empty id.", &session.user_id).into());
  }

  if &item.owner_id != &session.user_id {
    return Err(format!("Item owner_id '{}' mismatch with session user '{}' when adding item '{}'.", item.owner_id, &session.user_id, item.id).into());
  }

  if db.item.get(&item.id).is_ok() {
    return Err(format!("Attempt was made to add item with id '{}', but an item with this id already exists.", item.id).into());
  }

  if item.ordering.len() == 0 {
    return Err(format!("Attempt was made by user '{}' to add an item with empty ordering.", &session.user_id).into());
  }

  if item.item_type == ItemType::Placeholder && item.relationship_to_parent != RelationshipToParent::Attachment {
    return Err(format!("Attempt was made to add a placeholder item where relationship to parent is not Attachment.").into());
  }

  if is_data_item_type(item.item_type) {
    let base64_data = base64_data_maybe.as_ref().ok_or(format!("Add item request has no base64 data, when this is expected for item of type {}.", item.item_type))?;
    let decoded = general_purpose::STANDARD.decode(&base64_data).map_err(|e| format!("There was a problem decoding base64 data for new item '{}': {}", item.id, e))?;
    if decoded.len() != item.file_size_bytes.ok_or(format!("File size was not specified for new data item '{}'.", item.id))? as usize {
      return Err(format!("File size specified for new data item '{}' ({}) does not match the actual size of the data ({}).", item.id, item.file_size_bytes.unwrap(), decoded.len()).into());
    }
    let object_encryption_key = &db.user.get(&session.user_id).ok_or(format!("User '{}' not found.", &session.user_id))?.object_encryption_key;
    object::put(object_store.clone(), &session.user_id, &item.id, &decoded, object_encryption_key).await?;

    if is_image_item(&item) {
      let title = match &item.title {
        Some(title) => title,
        None => { return Err(format!("Image item '{}' has no title set.", item.id).into()); }
      };
      // TODO (LOW): clone here seems a bit excessive.
      let exif_orientation = get_exif_orientation(decoded.clone(), title);
      let file_cursor = Cursor::new(decoded);
      let file_reader = Reader::new(file_cursor).with_guessed_format()?;
      let img = file_reader.decode().ok().ok_or(format!("Could not add new image item '{}' - could not interpret base64 data as an image.", item.id))?;
      let img = adjust_image_for_exif_orientation(img, exif_orientation, title);

      let width = img.width();
      let height = img.height();

      let img = img.resize_exact(8, 8, FilterType::Nearest);
      let buf = Vec::new();
      let mut cursor = Cursor::new(buf);
      img.write_to(&mut cursor, ImageOutputFormat::Png)
        .map_err(|e| format!("An error occured creating the thumbnail png for new image '{}': {}.", item.id, e))?;
      let thumbnail_data = cursor.get_ref().to_vec();
      let thumbnail_base64 = general_purpose::STANDARD.encode(thumbnail_data);
      if item.thumbnail.unwrap() != "" {
        return Err(format!("Attempt was made by user '{}' to add an image item with a non-empty thumbnail.", &session.user_id).into());
      }
      item.thumbnail = Some(thumbnail_base64);

      let img_size_px = &item.image_size_px.unwrap();
      if img_size_px.w != -1 && img_size_px.w != width as i64 {
        return Err(format!("Image width specified for new image item '{}' ({:?}) does not match the actual width of the image ({}).", item.id, img_size_px, width).into());
      }
      if img_size_px.h != -1 && img_size_px.h != height as i64 {
        return Err(format!("Image height specified for new image item '{}' ({:?}) does not match the actual height of the image ({}).", item.id, img_size_px, height).into());
      }
      item.image_size_px = Some(Dimensions { w: width as i64, h: height as i64 });
    }
  } else {
    if base64_data_maybe.is_some() {
      return Err("Add item request has base64 data, when this is not expected.".into());
    }
  }

  let serialized_item = serde_json::to_string(&item.to_api_json()?)?;

  let item_id = item.id.clone();
  db.item.add(item).await?;
  debug!("Executed 'add-item' command for item '{}'.", item_id);

  Ok(Some(serialized_item))
}


async fn handle_update_item(
    db: &Arc<tokio::sync::Mutex<Db>>,
    json_data: &str,
    session_maybe: &Option<Session>) -> InfuResult<()> {
  let mut db = db.lock().await;

  let session = match session_maybe {
    Some(session) => session,
    None => { return Err(format!("Session is required to update an item.").into()); }
  };

  let deserializer = serde_json::Deserializer::from_str(json_data);
  let mut iterator = deserializer.into_iter::<serde_json::Value>();
  let item_map_maybe = iterator.next().ok_or("Update item request has no item.")??;
  let item_map = item_map_maybe.as_object().ok_or("Update item request body is not a JSON object.")?;
  let item: Item = Item::from_api_json(item_map)?;

  if &db.item.get(&item.id)?.owner_id != &session.user_id {
    return Err(format!("Item owner_id '{}' mismatch with session user '{}' when updating item '{}'.", item.owner_id, session.user_id, item.id).into());
  }

  db.item.update(&item).await?;

  debug!("Executed 'update-item' command for item '{}'.", item.id);

  Ok(())
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
    session_maybe: &Option<Session>) -> InfuResult<()> {
  let mut db = db.lock().await;

  let request: DeleteItemRequest = serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;

  let session = match session_maybe {
    Some(session) => session,
    None => { return Err(format!("Session is required to delete an item.").into()); }
  };

  if &db.item.get(&request.id)?.owner_id != &session.user_id {
    return Err(format!("User '{}' does not own item '{}'.", session.user_id, request.id).into());
  }

  if db.item.get_children(&request.id)?.len() > 0 {
    let child_ids: Vec<&String> = db.item.get_children(&request.id)?.iter().map(|itm| &itm.id).collect();
    return Err(format!("Cannot delete item '{}' because it has one or more associated children: {:?}", request.id, child_ids).into());
  }

  if db.item.get_attachments(&request.id)?.len() > 0 {
    let attachment_ids: Vec<&String> = db.item.get_attachments(&request.id)?.iter().map(|itm| &itm.id).collect();
    return Err(format!("Cannot delete item '{}' because it has one or more associated attachments: {:?}", request.id, attachment_ids).into());
  }

  let item = db.item.get(&request.id)?;

  if is_image_item(&item) {
    let num_removed = storage_cache::delete_all(image_cache, &session.user_id, &request.id).await?;
    debug!("Deleted all {} entries related to item '{}' from image cache.", num_removed, request.id);
  }

  if is_data_item_type(item.item_type) {
    object::delete(object_store.clone(), &session.user_id, &request.id).await?;
    debug!("Deleted item '{}' from object store.", request.id);
  }

  let _item = db.item.remove(&request.id).await?;
  debug!("Deleted item '{}' from database.", request.id);

  Ok(())
}

async fn handle_empty_trash<'a>(
    db: &Arc<tokio::sync::Mutex<Db>>,
    object_store: Arc<object::ObjectStore>,
    image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
    session_maybe: &Option<Session>) -> InfuResult<Option<String>> {
  let mut db = db.lock().await;

  let session = match session_maybe {
    Some(session) => session,
    None => { return Err(format!("A session is required to empty trash.").into()); }
  };

  let trash_page_id;
  {
    let user = db.user.get(&session.user_id).ok_or(format!("user not found").as_str())?;
    trash_page_id = user.trash_page_id.clone();
  }

  let mut count = 0;
  let mut img_cache_count = 0;
  let mut object_count = 0;
  delete_recursive(&mut db, object_store, image_cache, &session.user_id, trash_page_id, false, &mut count, &mut img_cache_count, &mut object_count).await?;

  let mut result = serde_json::Map::new();
  result.insert("itemCount".to_owned(), Value::Number(count.into()));
  result.insert("imageCacheCount".to_owned(), Value::Number(img_cache_count.into()));
  result.insert("objectCount".to_owned(), Value::Number(object_count.into()));

  Ok(Some(serde_json::to_string(&result)?))
}

#[async_recursion]
async fn delete_recursive(
    db: &mut MutexGuard<'_, Db>,
    object_store: Arc<object::ObjectStore>,
    image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
    user_id: &Uid,
    item_id: Uid,
    delete_item: bool,
    count: &mut u64,
    img_cache_count: &mut u64,
    object_count: &mut u64) -> InfuResult<()> {
  for attachment_id in db.item.get_attachment_ids(&item_id)? {
    delete_recursive(db, object_store.clone(), image_cache.clone(), user_id, attachment_id, true, count, img_cache_count, object_count).await?;
  }
  for child_id in db.item.get_children_ids(&item_id)? {
    delete_recursive(db, object_store.clone(), image_cache.clone(), user_id, child_id, true, count, img_cache_count, object_count).await?;
  }

  if delete_item {
    let item = db.item.get(&item_id)?.clone();

    if is_image_item(&item) {
      let num_removed = storage_cache::delete_all(image_cache, &user_id, &item.id).await?;
      debug!("Deleted all {} entries related to item '{}' from image cache.", num_removed, item.id);
      *img_cache_count = *img_cache_count + num_removed as u64;
    }

    if is_data_item_type(item.item_type) {
      object::delete(object_store.clone(), &user_id, &item.id).await?;
      debug!("Deleted item '{}' from object store.", item.id);
      *object_count = *object_count + 1;
    }

    let _item = db.item.remove(&item_id).await?;
    debug!("Deleted item '{}' from database.", item_id);

    *count = *count + 1;
  }

  Ok(())
}

#[derive(Deserialize, Serialize)]
pub struct SearchRequest {
  #[serde(rename="pageId")]
  pub page_id: Option<Uid>,
  pub text: String,
  #[serde(rename="numResults")]
  pub num_results: i64,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SearchPathElement {
  #[serde(rename="itemType")]
  item_type: String,
  title: Option<String>,
  id: Uid,
}

#[derive(Deserialize, Serialize)]
pub struct SearchResult {
  #[serde(rename="path")]
  pub path: Vec<SearchPathElement>,
}

async fn handle_search(
    db: &Arc<tokio::sync::Mutex<Db>>,
    json_data: &str,
    session_maybe: &Option<Session>) -> InfuResult<Option<String>> {
  let session = match session_maybe {
    None => return Err("Sessionless search not supported".into()),
    Some(s) => s
  };

  let request: SearchRequest = serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;

  let mut db = db.lock().await;

  let page_id = if let Some(request_page_id) = request.page_id {
    request_page_id
  } else {
    let user = db.user.get(&session.user_id).ok_or(format!("Unknown user '{}", session.user_id))?;
    user.home_page_id.clone()
  };

  let mut results: Vec<SearchResult> = vec![];
  let mut current_path: Vec<SearchPathElement> = vec![];
  search_recursive(&mut db, &request.text.to_lowercase(), page_id, &session.user_id.clone(), request.num_results, &mut current_path, &mut results)?;

  let serialized_results = serde_json::to_string(&results)?;

  debug!("Executed 'add-item' command for user '{}'.", session.user_id);

  Ok(Some(serialized_results))
}


fn search_recursive(db: &mut MutexGuard<'_, Db>, search_text: &str, item_id: Uid, user_id: &Uid, num_results: i64, current_path: &mut Vec<SearchPathElement>, results: &mut Vec<SearchResult>) -> InfuResult<()> {

  {
    let item = db.item.get(&item_id)?;
    if &item.owner_id != user_id { return Ok(()); } // paranoid.
    if item.item_type != ItemType::Password {
      match &item.title {
        None => {},
        Some(title) => {
          if title.to_lowercase().contains(search_text) {
            let mut path: Vec<SearchPathElement> = current_path.iter().map(|a| (*a).clone()).collect();
            path.push(SearchPathElement {
              item_type: item.item_type.as_str().to_owned(),
              title: item.title.to_owned(),
              id: item.id.to_owned()
            });
            results.push(SearchResult { path });
          }
        }
      };
    }

    if results.len() >= num_results as usize {
      return Ok(());
    }

    current_path.push(SearchPathElement { item_type: item.item_type.as_str().to_owned(), title: item.title.clone(), id: item.id.clone() });
  }

  let child_ids = db.item.get_children_ids(&item_id)?;
  for child_id in child_ids {
    search_recursive(db, search_text, child_id, user_id, num_results, current_path, results)?;
  }

  let attachment_ids = db.item.get_attachment_ids(&item_id)?;
  for attachment_id in attachment_ids {
    search_recursive(db, search_text, attachment_id, user_id, num_results, current_path, results)?;
  }

  current_path.pop();

  Ok(())
}
