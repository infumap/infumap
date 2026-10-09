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

use async_recursion::async_recursion;
use base64::{Engine as _, engine::general_purpose};
use bytes::Bytes;
use config::Config;
use http_body_util::combinators::BoxBody;
use hyper::{Request, Response};
use image::ImageReader;
use infusdk::item::{
  ArrangeAlgorithm, Item, ItemType, LIST_PAGE_PIN_BOTTOM_FLAG, PAGE_DISABLE_LINE_ITEM_EXPAND_FLAG,
  PAGE_SHOW_TABLE_COL_HEADER_FLAG, PermissionFlags, RelationshipToParent, SavedPageSettings, SavedTableSettings,
  TableColumn, TableFlags, embedded_table_size_from_page, is_attachments_item_type, is_composite_item,
  is_container_item_type, is_data_item_type, is_flags_item_type, is_image_item, is_link_item, is_page_item,
  is_permission_flags_item_type, is_positionable_type, is_table_item, page_width_from_table,
};
use infusdk::util::geometry::{Dimensions, GRID_SIZE, Vector};
use infusdk::util::infu::InfuResult;
use infusdk::util::json;
use infusdk::util::time::unix_now_secs_i64;
use infusdk::util::time::unix_now_secs_u64;
use infusdk::util::uid::{EMPTY_UID, Uid, is_empty_uid, is_uid, new_uid};
use infusdk::web::WebApiJsonSerializable;
use log::{debug, error, warn};
use once_cell::sync::Lazy;
use prometheus::{IntCounterVec, opts};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Cursor;
use std::str;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::MutexGuard;

use super::link_titles;
use crate::ai::document_pipeline::{
  dequeue_document_fragment_item_if_active, enqueue_document_fragment_item_if_active, is_document_fragment_item,
};
use crate::ai::fragment::{ITEM_TITLE_SOURCE_KIND, delete_item_fragment_artifacts, is_markdown_document_source_kind};
use crate::ai::fragment_indexing::enqueue_item_search_index_removal;
use crate::ai::geo::delete_item_geo_artifacts;
use crate::ai::image_pipeline::{
  dequeue_image_background_pipeline_item_if_active, enqueue_image_background_pipeline_item_if_active,
};
use crate::ai::image_tagging::{delete_item_image_tag_dir, should_tag_image_item};
use crate::ai::lexical_index::{
  FragmentLexicalHit, index_word, natural_text_word_count, open_user_document_fragment_lexical_index,
  open_user_item_title_lexical_index, user_document_fragment_lexical_index_exists,
  user_item_title_lexical_index_exists,
};
use crate::ai::metrics::{METRIC_SEARCH_BACKEND_DURATION_SECONDS, METRIC_SEARCH_BACKEND_FAILURES_TOTAL};
use crate::ai::search_status::{
  SearchStatusPageKind, SearchStatusView, search_attention_page_id, search_processing_page_id, search_status_link_id,
  search_status_page_id, search_status_page_kind_for_route_id,
};
use crate::ai::text_extraction::{delete_item_text_dir, dequeue_pdf_item_if_active, enqueue_pdf_item_if_active};
use crate::ai::title_indexing::enqueue_item_title_index_update;
use crate::storage::cache as storage_cache;
use crate::storage::db::Db;
use crate::storage::db::container_sync::{ContainerSyncDelta, ContainerSyncLookup, ContainerSyncVersion};
use crate::storage::db::session::Session;
use crate::storage::db::user::ROOT_USER_NAME;
use crate::storage::object;
use crate::util::image::{
  IMAGE_PROCESSING_SEMAPHORE, adjust_image_for_exif_orientation, create_image_placeholder, get_exif_orientation,
};
use crate::util::mime::{detect_mime_type, mime_type_from_title_extension};
use crate::util::ordering::{new_ordering, new_ordering_after, new_ordering_at_end};
use crate::web::routes::{is_scopes_page_item, scopes_page_id};
use crate::web::serve::{cors_response, incoming_json_with_limit, json_response};
use crate::web::session::get_and_validate_session;
use std::collections::{HashMap, HashSet};

mod chat;
mod backlinks;
mod item_ops;
mod scope;
mod search;

pub(crate) use chat::{chat_tool_servers_from_config, llama_servers_from_config, validate_chat_backend_config};
pub use chat::{serve_chat_models_route, serve_chat_stream_route, serve_chat_tool_approval_route};
pub use item_ops::add_item_for_user;

// Uploads are sent as base64 inside JSON. 256 MiB request limit supports roughly
// 190+ MiB raw files while remaining bounded.
const COMMAND_REQUEST_MAX_BYTES: usize = 256 * 1024 * 1024;
const SEARCH_STATUS_PAGE_BACKGROUND_COLOR_INDEX: i64 = 7;
const SEARCH_STATUS_CONTAINER_VERSION_MULTIPLIER: u64 = 1_000_000_000;
/// Deliberate trade-off: during large backlogs a search status page lists only
/// this many items (its title gives the full count). Listing every item made
/// the page megabytes large and it was resent whenever an item finished; the
/// progress log gives the full picture.
const SEARCH_STATUS_PAGE_MAX_LINKS: usize = 200;

pub static METRIC_COMMAND_REQUESTS_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(
    opts!("command_requests_total", "Total number of times a command has been called (by command name)."),
    &["name"],
  )
  .expect("Could not create METRIC_COMMAND_REQUESTS_TOTAL")
});

pub static METRIC_COMMAND_FAILURES_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(
    opts!("command_failures_total", "Total number of times a command has been called and failed (by command name)."),
    &["name"],
  )
  .expect("Could not create METRIC_COMMAND_FAILURES_TOTAL")
});

#[derive(Deserialize, Serialize)]
pub struct CommandRequest {
  pub command: String,
  #[serde(rename = "jsonData")]
  pub json_data: String,
  #[serde(rename = "base64Data")]
  pub base64_data: Option<String>,
}

const REASON_SERVER: &str = "server";
const REASON_CLIENT: &str = "client";
const REASON_AUTH: &str = "auth";
const REASON_NOT_FOUND: &str = "not-found";

#[derive(Deserialize, Serialize, Debug)]
pub struct CommandResponse {
  pub success: bool,
  #[serde(rename = "failReason")]
  pub fail_reason: Option<String>,
  #[serde(rename = "jsonData")]
  pub json_data: Option<String>,
}

enum CommandErrorKind {
  Auth,
  Client,
  NotFound,
  Server,
}

fn classify_command_error(e: &infusdk::util::infu::InfuError) -> CommandErrorKind {
  let msg = e.message();
  if msg.contains("Not authorized") {
    CommandErrorKind::Auth
  } else if msg.contains("Invalid link URL") {
    CommandErrorKind::Client
  } else if msg.contains("is missing") || msg.contains("does not exist") || msg.contains("not found") {
    CommandErrorKind::NotFound
  } else {
    CommandErrorKind::Server
  }
}

pub async fn serve_command_route(
  db: &Arc<tokio::sync::Mutex<Db>>,
  object_store: &Arc<object::ObjectStore>,
  image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
  request: Request<hyper::body::Incoming>,
) -> Response<BoxBody<Bytes, hyper::Error>> {
  if request.method() == "OPTIONS" {
    debug!("Serving OPTIONS request, assuming CORS query.");
    return cors_response();
  }

  let session_maybe = get_and_validate_session(&request, db).await;

  let request: CommandRequest = match incoming_json_with_limit(request, COMMAND_REQUEST_MAX_BYTES).await {
    Ok(r) => r,
    Err(e) => {
      error!("An error occurred parsing command payload for user: {}", e);
      METRIC_COMMAND_REQUESTS_TOTAL.with_label_values(&["unknown"]).inc();
      METRIC_COMMAND_FAILURES_TOTAL.with_label_values(&["unknown"]).inc();
      return json_response(&CommandResponse {
        success: false,
        fail_reason: Some(REASON_CLIENT.to_owned()),
        json_data: None,
      });
    }
  };

  if let Some(session) = &session_maybe {
    debug!("Received '{}' command from user '{}'.", request.command, session.user_id);
  } else {
    debug!("Received '{}' command from sessionless user.", request.command);
  }

  let response_data_maybe = match request.command.as_str() {
    "get-items" => handle_get_items(db, &request.json_data, &session_maybe).await,
    "get-attachments" => item_ops::handle_get_attachments(db, &request.json_data, &session_maybe).await,
    "add-item" => {
      item_ops::handle_add_item(db, object_store.clone(), &request.json_data, &request.base64_data, &session_maybe)
        .await
    }
    "add-link-note" => {
      item_ops::handle_add_link_note(db, object_store.clone(), &request.json_data, &session_maybe).await
    }
    "update-item" => item_ops::handle_update_item(db, &request.json_data, &session_maybe).await,
    "convert-page-table" => item_ops::handle_convert_page_table(db, &request.json_data, &session_maybe).await,
    "delete-item" => {
      item_ops::handle_delete_item(db, object_store.clone(), image_cache, &request.json_data, &session_maybe).await
    }
    "sync-containers" => handle_sync_containers(db, &request.json_data, &session_maybe).await,
    "search" => search::handle_search(db, &request.json_data, &session_maybe).await,
    "list-scopes" => scope::handle_list_scopes(db, &session_maybe).await,
    "get-backlinks" => backlinks::handle_get_backlinks(db, &request.json_data, &session_maybe).await,
    "empty-trash" => item_ops::handle_empty_trash(db, object_store.clone(), image_cache, &session_maybe).await,
    "reprocess-item" => item_ops::handle_reprocess_item(db, &request.json_data, &session_maybe).await,
    _ => {
      if let Some(session) = &session_maybe {
        warn!("Unknown command '{}' issued by user '{}', session '{}'", request.command, session.user_id, session.id);
      } else {
        warn!("Unknown command '{}' issued by anonymous user", request.command);
      }
      METRIC_COMMAND_REQUESTS_TOTAL.with_label_values(&["invalid"]).inc();
      METRIC_COMMAND_FAILURES_TOTAL.with_label_values(&["invalid"]).inc();
      return json_response(&CommandResponse {
        success: false,
        fail_reason: Some(REASON_CLIENT.to_owned()),
        json_data: None,
      });
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
      METRIC_COMMAND_REQUESTS_TOTAL.with_label_values(&[&request.command]).inc();
      METRIC_COMMAND_FAILURES_TOTAL.with_label_values(&[&request.command]).inc();
      let fail_reason = match classify_command_error(&e) {
        CommandErrorKind::Auth => REASON_AUTH,
        CommandErrorKind::Client => REASON_CLIENT,
        CommandErrorKind::NotFound => REASON_NOT_FOUND,
        CommandErrorKind::Server => REASON_SERVER,
      };
      return json_response(&CommandResponse {
        success: false,
        fail_reason: Some(fail_reason.to_owned()),
        json_data: None,
      });
    }
  };

  METRIC_COMMAND_REQUESTS_TOTAL.with_label_values(&[&request.command]).inc();
  let r = CommandResponse { success: true, fail_reason: None, json_data: response_data };

  debug!("Successfully processed a '{}' command.", request.command);
  json_response(&r)
}

#[derive(Debug, PartialEq)]
pub enum GetItemsMode {
  ItemAndAttachmentsOnly,
  ItemAttachmentsChildrenAndTheirAttachments,
  ChildrenAndTheirAttachmentsOnly,
}

impl GetItemsMode {
  pub fn as_str(&self) -> &'static str {
    match self {
      GetItemsMode::ChildrenAndTheirAttachmentsOnly => "children-and-their-attachments-only",
      GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments => "item-attachments-children-and-their-attachments",
      GetItemsMode::ItemAndAttachmentsOnly => "item-and-attachments-only",
    }
  }

  pub fn from_str(s: &str) -> InfuResult<GetItemsMode> {
    match s {
      "children-and-their-attachments-only" => Ok(GetItemsMode::ChildrenAndTheirAttachmentsOnly),
      "item-attachments-children-and-their-attachments" => Ok(GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments),
      "item-and-attachments-only" => Ok(GetItemsMode::ItemAndAttachmentsOnly),
      other => Err(format!("Invalid GetItemsMode value: '{}'.", other).into()),
    }
  }
}

#[derive(Deserialize, Serialize)]
pub struct GetItemsRequest {
  pub id: String,
  pub mode: String,
}

/**
 * Access is authorized if and only if:
 * 1.  the session user owns the item.
 * 2.  the item is a page that is marked as public.
 * 3.  the item is in a page that is marked as public.
 * 4.  the item is in a table or composite child page in a page that is marked as public.
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
 * to item, and it's tree parent(s) as above.
 */
pub fn authorize_item(
  db: &MutexGuard<'_, Db>,
  item: &Item,
  session_user_id_maybe: &Option<String>,
  recursion_level: i32,
) -> InfuResult<()> {
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
      }
      // Should never occur.
      None => return Err(format!("Page item '{}' has no permissions flag property.", item.id).into()),
    }
  }

  // any item that has a parent page that is public
  if let Some(item_parent_id) = &item.parent_id {
    match item.relationship_to_parent {
      RelationshipToParent::Child => {
        let item_parent = db.item.get(&item_parent_id)?;
        if is_composite_item(item_parent) {
          // If the item is inside a composite, then what is effectively needed is authorization of the composite.
          match authorize_item(db, item_parent, session_user_id_maybe, recursion_level + 1) {
            Ok(_) => return Ok(()),
            Err(e) => {
              return Err(format!("Not authorized to access item '{}': {}", item.id, e.to_string()).into());
            }
          }
        } else {
          item_auth_common(db, &item.id, item_parent)?;
          return Ok(());
        }
      }

      RelationshipToParent::Attachment => {
        let attachment_parent = db.item.get(&item_parent_id)?;
        if item_auth_common(db, &item.id, attachment_parent).is_ok() {
          return Ok(());
        }
        let attachment_parent_parent = match &attachment_parent.parent_id {
          Some(p) => db.item.get(&p)?,
          None => {
            return Err(
              format!("Attachment parent item '{}' has no parent - cannot authorize.", attachment_parent.id).into(),
            );
          }
        };
        item_auth_common(db, &attachment_parent.id, attachment_parent_parent)?;
        return Ok(());
      }

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
      }
      // Should never occur.
      None => return Err(format!("Page item '{}' does not have a permissions flag property.", item_id).into()),
    }
  } else if is_table_item(item_parent) {
    let parent_parent_id = match &item_parent.parent_id {
      Some(parent_parent_id) => parent_parent_id,
      // Should never occur.
      None => return Err(format!("Expecting table '{}' to have a parent defined.", item_parent.id).into()),
    };
    let parent_parent = db.item.get(&parent_parent_id)?;
    if is_page_item(parent_parent) {
      match parent_parent.permission_flags {
        Some(flags) => {
          if flags == PermissionFlags::Public as i64 {
            return Ok(());
          }
          return Err(
            format!(
              "Not authorized to access parent page '{}' of table '{}' that contains item '{}'.",
              parent_parent.id, item_parent.id, item_id
            )
            .into(),
          );
        }
        // Should never occur.
        None => return Err(format!("Page item '{}' has no permissions flag property.", item_id).into()),
      }
    } else {
      return Err(
        format!("Expecting parent '{}' of table '{}' to be a page.", parent_parent_id, parent_parent_id).into(),
      );
    }
  } else {
    return Err(format!("Item '{}' has unexpected parent type.", item_id).into());
  }
}

fn get_item_authorized<'a>(
  db: &'a MutexGuard<'_, Db>,
  id: &Uid,
  session_user_id_maybe: &Option<String>,
) -> InfuResult<&'a Item> {
  let item = db.item.get(&id)?;
  authorize_item(db, item, session_user_id_maybe, 0).map_err(|_| format!("Not authorized to access item '{}'.", id))?;
  Ok(item)
}

fn get_children_authorized<'a>(
  db: &'a MutexGuard<'_, Db>,
  id: &Uid,
  session_user_id_maybe: &Option<String>,
) -> InfuResult<Vec<&'a Item>> {
  let children = db.item.get_children(id)?;
  for child in &children {
    // TODO (LOW): redundant, but doesn't hurt..
    authorize_item(db, child, session_user_id_maybe, 0)
      .map_err(|_| format!("Not authorized to access item '{}'.", id))?;
  }
  Ok(children)
}

fn get_attachments_authorized<'a>(
  db: &'a MutexGuard<'_, Db>,
  id: &Uid,
  session_user_id_maybe: &Option<String>,
) -> InfuResult<Vec<&'a Item>> {
  let attachments = db.item.get_attachments(id)?;
  for attachment in &attachments {
    // TODO (LOW): redundant, but doesn't hurt..
    authorize_item(db, attachment, session_user_id_maybe, 0)
      .map_err(|_| format!("Not authorized to access item '{}'.", id))?;
  }
  Ok(attachments)
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ContainerSyncAckContainer {
  pub id: Uid,
  pub epoch: u64,
  pub version: u64,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ContainerSyncAck {
  pub containers: Vec<ContainerSyncAckContainer>,
}

#[derive(Deserialize, Serialize)]
pub struct SyncContainersSubscription {
  pub id: Uid,
  #[serde(rename = "knownEpoch")]
  pub known_epoch: Option<u64>,
  #[serde(rename = "knownVersion")]
  pub known_version: Option<u64>,
  #[serde(rename = "knownItemType")]
  pub known_item_type: Option<String>,
  #[serde(rename = "knownLastModifiedDate")]
  pub known_last_modified_date: Option<i64>,
}

#[derive(Deserialize, Serialize)]
pub struct SyncContainersRequest {
  pub subscriptions: Vec<SyncContainersSubscription>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct SyncContainerSnapshot {
  pub children: Vec<serde_json::Map<String, serde_json::Value>>,
  pub attachments: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct SyncContainerUpdate {
  pub id: Uid,
  pub epoch: u64,
  pub version: u64,
  pub strategy: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub item: Option<serde_json::Map<String, serde_json::Value>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub children: Option<Vec<serde_json::Map<String, serde_json::Value>>>,
  #[serde(rename = "childDeletes", skip_serializing_if = "Option::is_none")]
  pub child_deletes: Option<Vec<Uid>>,
  #[serde(rename = "attachmentUpserts", skip_serializing_if = "Option::is_none")]
  pub attachment_upserts: Option<serde_json::Map<String, serde_json::Value>>,
  #[serde(rename = "attachmentDeletes", skip_serializing_if = "Option::is_none")]
  pub attachment_deletes: Option<serde_json::Map<String, serde_json::Value>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub snapshot: Option<SyncContainerSnapshot>,
}

#[derive(Deserialize, Serialize)]
pub struct SyncContainersResponse {
  pub updates: Vec<SyncContainerUpdate>,
}

fn item_to_api_json_map(item: &Item) -> InfuResult<serde_json::Map<String, serde_json::Value>> {
  item.to_api_json().map_err(|e| format!("Error occurred converting item '{}' to API JSON: {}", item.id, e).into())
}

fn readonly_item_capabilities_json() -> Value {
  let mut capabilities = serde_json::Map::new();
  capabilities.insert(String::from("edit"), Value::Bool(false));
  capabilities.insert(String::from("move"), Value::Bool(false));
  capabilities.insert(String::from("resize"), Value::Bool(false));
  Value::Object(capabilities)
}

fn non_movable_item_capabilities_json() -> Value {
  let mut capabilities = serde_json::Map::new();
  capabilities.insert(String::from("move"), Value::Bool(false));
  capabilities.insert(String::from("resize"), Value::Bool(false));
  Value::Object(capabilities)
}

fn queries_page_query_item_position_gr() -> Vector<i64> {
  Vector { x: 9 * GRID_SIZE, y: GRID_SIZE }
}

fn queries_page_query_item_width_gr() -> i64 {
  6 * GRID_SIZE
}

fn is_queries_page_item(db: &MutexGuard<'_, Db>, item: &Item) -> bool {
  item.item_type == ItemType::Page && db.user.get(&item.owner_id).is_some_and(|user| user.queries_page_id == item.id)
}

fn is_queries_page_query_item(db: &MutexGuard<'_, Db>, item: &Item) -> bool {
  item.item_type == ItemType::Search
    && item.relationship_to_parent == RelationshipToParent::Child
    && item
      .parent_id
      .as_ref()
      .is_some_and(|parent_id| db.user.get(&item.owner_id).is_some_and(|user| &user.queries_page_id == parent_id))
}

fn item_spatial_position_matches(item: &Item, position_gr: &Vector<i64>) -> bool {
  item.spatial_position_gr.as_ref().is_some_and(|item_position_gr| item_position_gr == position_gr)
}

fn item_move_fields_changed_to_disallowed_layout(old_item: &Item, new_item: &Item) -> bool {
  old_item.parent_id != new_item.parent_id
    || old_item.relationship_to_parent != new_item.relationship_to_parent
    || old_item.ordering != new_item.ordering
    || (old_item.spatial_position_gr != new_item.spatial_position_gr
      && !item_spatial_position_matches(new_item, &queries_page_query_item_position_gr()))
}

fn item_resize_fields_changed_to_disallowed_layout(old_item: &Item, new_item: &Item) -> bool {
  old_item.spatial_width_gr != new_item.spatial_width_gr
    && new_item.spatial_width_gr != Some(queries_page_query_item_width_gr())
}

fn queries_page_arrange_algorithm_allowed(item: &Item) -> bool {
  item.arrange_algorithm.as_ref() == Some(&ArrangeAlgorithm::List)
}

/// The scopes page may be renamed or rearranged, but must stay pinned to the bottom of the queries page.
fn scopes_page_update_disallowed(old_item: &Item, new_item: &Item) -> bool {
  old_item.item_type != new_item.item_type
    || old_item.parent_id != new_item.parent_id
    || old_item.relationship_to_parent != new_item.relationship_to_parent
    || new_item.flags.unwrap_or(0) & LIST_PAGE_PIN_BOTTOM_FLAG == 0
}

fn item_to_api_json_map_with_capabilities(
  db: &MutexGuard<'_, Db>,
  item: &Item,
) -> InfuResult<serde_json::Map<String, serde_json::Value>> {
  let mut item_json = item_to_api_json_map(item)?;
  if is_queries_page_item(db, item) {
    item_json.insert(String::from("arrangeAlgorithm"), Value::String(ArrangeAlgorithm::List.as_str().to_owned()));
  }
  if is_queries_page_query_item(db, item) || is_scopes_page_item(item) {
    item_json.insert(String::from("capabilities"), non_movable_item_capabilities_json());
  }
  if is_queries_page_query_item(db, item) {
    item_json.insert(String::from("spatialPositionGr"), json::vector_to_object(&queries_page_query_item_position_gr()));
    item_json.insert(String::from("spatialWidthGr"), Value::Number(queries_page_query_item_width_gr().into()));
  }
  Ok(item_json)
}

fn virtual_search_status_item_to_api_json_map(item: &Item) -> InfuResult<serde_json::Map<String, serde_json::Value>> {
  let mut item_json = item_to_api_json_map(item)?;
  item_json.insert(String::from("capabilities"), readonly_item_capabilities_json());
  Ok(item_json)
}

fn attachments_to_api_json(items: Vec<&Item>) -> InfuResult<Vec<serde_json::Map<String, serde_json::Value>>> {
  items
    .iter()
    .map(|item| item.to_api_json().ok())
    .collect::<Option<Vec<_>>>()
    .ok_or("Error occurred converting one or more attachment items to API JSON.".into())
}

fn build_authoritative_child_attachment_snapshot(
  db: &MutexGuard<'_, Db>,
  item_id: &Uid,
  session_user_id_maybe: &Option<String>,
  search_status_view_maybe: Option<&SearchStatusView>,
) -> InfuResult<SyncContainerSnapshot> {
  let child_items = get_children_authorized(db, item_id, session_user_id_maybe)?;
  let mut children = child_items
    .iter()
    .map(|item| item_to_api_json_map_with_capabilities(db, item))
    .collect::<InfuResult<Vec<_>>>()
    .map_err(|e| format!("Error occurred getting children for container '{}': {}", item_id, e))?;
  append_virtual_search_status_pages_to_queries_snapshot(
    db,
    item_id,
    session_user_id_maybe,
    search_status_view_maybe,
    &child_items,
    &mut children,
  )?;

  let mut attachments = serde_json::Map::new();
  for child in &child_items {
    if !is_attachments_item_type(child.item_type) {
      continue;
    }
    let item_attachments = attachments_to_api_json(get_attachments_authorized(db, &child.id, session_user_id_maybe)?)?;
    attachments
      .insert(child.id.clone(), Value::Array(item_attachments.into_iter().map(Value::from).collect::<Vec<_>>()));
  }

  Ok(SyncContainerSnapshot { children, attachments })
}

fn append_virtual_search_status_pages_to_queries_snapshot(
  db: &MutexGuard<'_, Db>,
  item_id: &Uid,
  session_user_id_maybe: &Option<String>,
  search_status_view_maybe: Option<&SearchStatusView>,
  child_items: &[&Item],
  children: &mut Vec<serde_json::Map<String, serde_json::Value>>,
) -> InfuResult<()> {
  let Some(session_user_id) = session_user_id_maybe else {
    return Ok(());
  };
  let user = db.user.get(session_user_id).ok_or(format!("Unknown user '{}'.", session_user_id))?;
  if &user.queries_page_id != item_id {
    return Ok(());
  }

  let empty_view = SearchStatusView::empty();
  let search_status_view = search_status_view_maybe.unwrap_or(&empty_view);
  let mut ordering = new_ordering_at_end(child_items.iter().map(|item| item.ordering.clone()).collect());
  for page_kind in [SearchStatusPageKind::Attention, SearchStatusPageKind::Processing] {
    let child_count = virtual_search_status_page_child_count(db, session_user_id, page_kind, search_status_view);
    let item = virtual_search_status_page(
      session_user_id,
      page_kind,
      Some(item_id),
      ordering.clone(),
      child_count,
      search_status_view.checking,
    );
    children.push(virtual_search_status_item_to_api_json_map(&item)?);
    ordering = new_ordering_after(&ordering);
  }
  Ok(())
}

fn build_item_attachment_snapshot_authorized(
  db: &MutexGuard<'_, Db>,
  item_id: &Uid,
  session_user_id_maybe: &Option<String>,
) -> InfuResult<Vec<serde_json::Map<String, serde_json::Value>>> {
  attachments_to_api_json(get_attachments_authorized(db, item_id, session_user_id_maybe)?)
}

fn build_item_attachment_snapshot(
  db: &MutexGuard<'_, Db>,
  item_id: &Uid,
) -> InfuResult<Vec<serde_json::Map<String, serde_json::Value>>> {
  attachments_to_api_json(db.item.get_attachments(item_id)?)
}

fn build_child_upsert_delta(db: &MutexGuard<'_, Db>, child: &Item) -> InfuResult<ContainerSyncDelta> {
  let mut delta = ContainerSyncDelta::default();
  delta.add_child_upsert(item_to_api_json_map_with_capabilities(db, child)?);
  if is_attachments_item_type(child.item_type) {
    delta.set_attachment_snapshot(&child.id, build_item_attachment_snapshot(db, &child.id)?);
  }
  Ok(delta)
}

fn maybe_container_id_for_child_item(item: &Item) -> Option<Uid> {
  if item.relationship_to_parent == RelationshipToParent::Child { item.parent_id.clone() } else { None }
}

fn validate_group_id_for_item(db: &MutexGuard<'_, Db>, item: &Item) -> InfuResult<()> {
  if item.group_id.is_none() {
    return Ok(());
  }
  if item.relationship_to_parent != RelationshipToParent::Child {
    return Err(format!("Item '{}' has a groupId, but is not a child item.", item.id).into());
  }
  let parent_id = item.parent_id.as_ref().ok_or(format!("Item '{}' has a groupId, but no parentId.", item.id))?;
  let parent_item = db.item.get(parent_id)?;
  if parent_item.item_type != ItemType::Page {
    return Err(format!("Item '{}' has a groupId, but its parent '{}' is not a page.", item.id, parent_id).into());
  }
  Ok(())
}

/// Links do not chain: a link may not target another link. Missing and remote targets are allowed.
fn validate_link_target_for_item(db: &Db, item: &Item) -> InfuResult<()> {
  if !is_link_item(item) {
    return Ok(());
  }
  let link_to = match &item.link_to {
    Some(link_to) => link_to,
    None => return Ok(()),
  };
  if link_to == &item.id || db.item.get(link_to).is_ok_and(is_link_item) {
    return Err(format!("Link '{}' cannot target link '{}'.", item.id, link_to).into());
  }
  Ok(())
}

/// Composites do not nest: the client flattens a composite dropped into another composite.
fn validate_composite_parent_for_item(db: &MutexGuard<'_, Db>, item: &Item) -> InfuResult<()> {
  if !is_composite_item(item) || item.relationship_to_parent != RelationshipToParent::Child {
    return Ok(());
  }
  let parent_id = match &item.parent_id {
    Some(parent_id) => parent_id,
    None => return Ok(()),
  };
  if is_composite_item(db.item.get(parent_id)?) {
    return Err(format!("Composite '{}' cannot be a child of composite '{}'.", item.id, parent_id).into());
  }
  Ok(())
}

fn maybe_container_id_for_attachment_parent(db: &MutexGuard<'_, Db>, parent_id: &Uid) -> InfuResult<Option<Uid>> {
  let parent_item = db.item.get(parent_id)?;
  if parent_item.relationship_to_parent == RelationshipToParent::Child {
    Ok(parent_item.parent_id.clone())
  } else {
    Ok(None)
  }
}

fn add_attachment_snapshot_delta_for_parent(
  db: &MutexGuard<'_, Db>,
  delta: &mut ContainerSyncDelta,
  parent_id: &Uid,
) -> InfuResult<()> {
  delta.set_attachment_snapshot(parent_id, build_item_attachment_snapshot(db, parent_id)?);
  Ok(())
}

fn record_container_delta(
  db: &mut MutexGuard<'_, Db>,
  user_id: &Uid,
  container_id: &Uid,
  delta: ContainerSyncDelta,
  touched_container_ids: &mut HashSet<Uid>,
) {
  if delta.is_empty() {
    return;
  }
  db.container_sync.record_delta(user_id, container_id, delta);
  touched_container_ids.insert(container_id.clone());
}

fn record_container_snapshot_required(
  db: &mut MutexGuard<'_, Db>,
  user_id: &Uid,
  container_id: &Uid,
  touched_container_ids: &mut HashSet<Uid>,
) {
  db.container_sync.record_snapshot_required(user_id, container_id);
  touched_container_ids.insert(container_id.clone());
}

fn merge_container_delta(
  deltas_by_container: &mut HashMap<Uid, ContainerSyncDelta>,
  container_id: &Uid,
  delta: ContainerSyncDelta,
) {
  if delta.is_empty() {
    return;
  }
  deltas_by_container.entry(container_id.clone()).or_default().merge(&delta);
}

fn flush_container_sync_changes(
  db: &mut MutexGuard<'_, Db>,
  user_id: &Uid,
  deltas_by_container: HashMap<Uid, ContainerSyncDelta>,
  snapshot_required_container_ids: HashSet<Uid>,
) -> Option<ContainerSyncAck> {
  let mut touched_container_ids = HashSet::new();

  for container_id in &snapshot_required_container_ids {
    record_container_snapshot_required(db, user_id, container_id, &mut touched_container_ids);
  }

  for (container_id, delta) in deltas_by_container {
    if snapshot_required_container_ids.contains(&container_id) {
      continue;
    }
    record_container_delta(db, user_id, &container_id, delta, &mut touched_container_ids);
  }

  build_sync_ack(db, user_id, &touched_container_ids)
}

fn build_sync_ack(
  db: &MutexGuard<'_, Db>,
  user_id: &Uid,
  touched_container_ids: &HashSet<Uid>,
) -> Option<ContainerSyncAck> {
  if touched_container_ids.is_empty() {
    return None;
  }

  Some(ContainerSyncAck {
    containers: db
      .container_sync
      .versions_for_containers(user_id, touched_container_ids.iter().cloned())
      .into_iter()
      .map(|entry: ContainerSyncVersion| ContainerSyncAckContainer {
        id: entry.id,
        epoch: entry.epoch,
        version: entry.version,
      })
      .collect::<Vec<_>>(),
  })
}

fn json_with_sync_ack(
  sync_ack: Option<ContainerSyncAck>,
  item_maybe: Option<serde_json::Map<String, serde_json::Value>>,
) -> InfuResult<Option<String>> {
  let mut result = serde_json::Map::new();
  if let Some(item) = item_maybe {
    result.insert(String::from("item"), Value::from(item));
  }
  insert_sync_ack(&mut result, sync_ack)?;
  Ok(Some(serde_json::to_string(&result)?))
}

fn insert_sync_ack(
  result: &mut serde_json::Map<String, serde_json::Value>,
  sync_ack: Option<ContainerSyncAck>,
) -> InfuResult<()> {
  if let Some(sync_ack) = sync_ack {
    result.insert(String::from("syncAck"), Value::from(serde_json::to_value(sync_ack)?));
  }
  Ok(())
}

async fn handle_sync_containers(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let request: SyncContainersRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;

  let session_user_id_maybe = match &session_maybe {
    Some(session) => Some(session.user_id.clone()),
    None => None,
  };

  let mut virtual_search_status_subscriptions = Vec::new();
  let mut db_subscriptions = Vec::new();
  for subscription in request.subscriptions {
    if let Some(session) = session_maybe {
      if let Some(page_kind) = search_status_page_kind_for_id(&session.user_id, &subscription.id) {
        virtual_search_status_subscriptions.push((subscription, page_kind));
        continue;
      }
    }
    db_subscriptions.push(subscription);
  }

  let mut updates = Vec::new();
  let mut search_status_view_for_session = None;
  if let Some(session) = session_maybe {
    if !virtual_search_status_subscriptions.is_empty() {
      let view = SearchStatusView::for_user(&session.user_id);
      {
        let db = db.lock().await;
        for (subscription, page_kind) in virtual_search_status_subscriptions {
          if let Some(update) =
            virtual_search_status_sync_update(&db, &session.user_id, &subscription, page_kind, &view)?
          {
            updates.push(update);
          }
        }
      }
      search_status_view_for_session = Some(view);
    }
  }

  let search_status_view_for_queries_snapshot = maybe_search_status_view_for_queries_subscription(
    db,
    &db_subscriptions,
    session_maybe,
    search_status_view_for_session.as_ref(),
  )
  .await?;

  let db = &mut db.lock().await;

  for subscription in db_subscriptions {
    let item = get_item_authorized(db, &subscription.id, &session_user_id_maybe)?.clone();
    if !is_container_item_type(item.item_type) {
      return Err(format!("Item '{}' is not a container and cannot be synced.", subscription.id).into());
    }

    let search_status_view_for_subscription = if let Some(session_user_id) = &session_user_id_maybe {
      match db.user.get(session_user_id) {
        Some(user) if user.queries_page_id == subscription.id => search_status_view_for_queries_snapshot.as_ref(),
        _ => None,
      }
    } else {
      None
    };

    if let Some(search_status_view) = search_status_view_for_subscription {
      let epoch = db.container_sync.epoch_for_user(&item.owner_id);
      let real_version = db.container_sync.version_for_container(&item.owner_id, &subscription.id);
      let version = queries_container_sync_version(real_version, search_status_view);
      db.container_sync.mark_client_access(&item.owner_id, &subscription.id);
      if subscription.known_epoch == Some(epoch) && subscription.known_version == Some(version) {
        continue;
      }
      updates.push(SyncContainerUpdate {
        id: subscription.id.clone(),
        epoch,
        version,
        strategy: String::from("snapshot"),
        item: None,
        children: None,
        child_deletes: None,
        attachment_upserts: None,
        attachment_deletes: None,
        snapshot: Some(build_authoritative_child_attachment_snapshot(
          db,
          &subscription.id,
          &session_user_id_maybe,
          Some(search_status_view),
        )?),
      });
      continue;
    }

    // A container's own type can change without advancing its children/attachments
    // version. Send the authoritative item as well as a snapshot in that case.
    if subscription.known_item_type.is_some() || subscription.known_last_modified_date.is_some() {
      let item_json = item_to_api_json_map_with_capabilities(db, &item)?;
      let type_changed = subscription.known_item_type.as_deref().is_some_and(|known| {
        item_json.get("itemType").and_then(Value::as_str) != Some(known)
      });
      let modified_date_changed = subscription.known_last_modified_date.is_some_and(|known| {
        item_json.get("lastModifiedDate").and_then(Value::as_i64) != Some(known)
      });
      if type_changed || modified_date_changed {
        let epoch = db.container_sync.epoch_for_user(&item.owner_id);
        let version = db.container_sync.version_for_container(&item.owner_id, &subscription.id);
        db.container_sync.mark_client_access(&item.owner_id, &subscription.id);
        updates.push(SyncContainerUpdate {
          id: subscription.id.clone(),
          epoch,
          version,
          strategy: String::from("snapshot"),
          item: Some(item_json),
          children: None,
          child_deletes: None,
          attachment_upserts: None,
          attachment_deletes: None,
          snapshot: Some(build_authoritative_child_attachment_snapshot(
            db,
            &subscription.id,
            &session_user_id_maybe,
            None,
          )?),
        });
        continue;
      }
    }

    match db.container_sync.sync_lookup(
      &item.owner_id,
      &subscription.id,
      subscription.known_epoch,
      subscription.known_version,
    ) {
      ContainerSyncLookup::UpToDate => {}
      ContainerSyncLookup::Delta { version, delta } => {
        let epoch = db.container_sync.epoch_for_user(&item.owner_id);
        let children = delta.child_upserts();
        let child_deletes = delta.child_deletes();
        let attachment_upserts = delta.attachment_snapshots_json();
        updates.push(SyncContainerUpdate {
          id: subscription.id,
          epoch,
          version,
          strategy: String::from("delta"),
          item: None,
          children: if children.is_empty() { None } else { Some(children) },
          child_deletes: if child_deletes.is_empty() { None } else { Some(child_deletes) },
          attachment_upserts: if attachment_upserts.is_empty() { None } else { Some(attachment_upserts) },
          attachment_deletes: None,
          snapshot: None,
        });
      }
      ContainerSyncLookup::Snapshot { version } => {
        let epoch = db.container_sync.epoch_for_user(&item.owner_id);
        updates.push(SyncContainerUpdate {
          id: subscription.id.clone(),
          epoch,
          version,
          strategy: String::from("snapshot"),
          item: None,
          children: None,
          child_deletes: None,
          attachment_upserts: None,
          attachment_deletes: None,
          snapshot: Some(build_authoritative_child_attachment_snapshot(
            db,
            &subscription.id,
            &session_user_id_maybe,
            None,
          )?),
        });
      }
    }
  }

  Ok(Some(serde_json::to_string(&SyncContainersResponse { updates })?))
}

fn virtual_search_status_sync_update(
  db: &MutexGuard<'_, Db>,
  user_id: &str,
  subscription: &SyncContainersSubscription,
  page_kind: SearchStatusPageKind,
  view: &SearchStatusView,
) -> InfuResult<Option<SyncContainerUpdate>> {
  let epoch = 0;
  let version = view.sync_version();
  if subscription.known_epoch == Some(epoch) && subscription.known_version == Some(version) {
    return Ok(None);
  }

  Ok(Some(SyncContainerUpdate {
    id: subscription.id.clone(),
    epoch,
    version,
    strategy: String::from("snapshot"),
    item: None,
    children: None,
    child_deletes: None,
    attachment_upserts: None,
    attachment_deletes: None,
    snapshot: Some(SyncContainerSnapshot {
      children: virtual_search_status_page_children(db, user_id, page_kind, view)?,
      attachments: serde_json::Map::new(),
    }),
  }))
}

async fn handle_get_items(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let request: GetItemsRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;
  let item_id = resolve_get_items_request_item_id(db, &request.id, session_maybe).await?;
  // A group is not an item. Its id loads the page holding it, and the response names the group to highlight.
  let (item_id, group_id) = {
    let db = db.lock().await;
    match db.item.get(&item_id).is_err().then(|| db.item.group_container_id(&item_id)).flatten() {
      Some(page_id) => (page_id, Some(item_id)),
      None => (item_id, None),
    }
  };

  let session_user_id_maybe = match &session_maybe {
    Some(session) => Some(session.user_id.clone()),
    None => None,
  };

  let mode = GetItemsMode::from_str(&request.mode)?;

  if let Some(response) = maybe_handle_get_virtual_search_status_page_items(db, &item_id, &mode, session_maybe).await? {
    debug!("Executed 'get-items' command for virtual search status item '{}' (mode {:?}).", item_id, mode);
    return Ok(Some(response));
  }

  let search_status_view_for_queries_snapshot = if get_items_mode_includes_children(&mode) {
    maybe_search_status_view_for_queries_container(db, &item_id, session_maybe).await?
  } else {
    None
  };

  let mut db_guard = db.lock().await;
  let item = match db_guard.item.get(&item_id) {
    Ok(item) => {
      authorize_item(&db_guard, item, &session_user_id_maybe, 0)
        .map_err(|_| format!("Not authorized to access item '{}'.", item_id))?;
      item.clone()
    }
    Err(e) => {
      drop(db_guard);
      if let Some(response) =
        maybe_handle_get_virtual_search_status_link_items(db, &item_id, &mode, session_maybe).await?
      {
        debug!("Executed 'get-items' command for virtual search status link '{}' (mode {:?}).", item_id, mode);
        return Ok(Some(response));
      }
      return Err(e);
    }
  };
  let db = &mut db_guard;

  if matches!(
    mode,
    GetItemsMode::ChildrenAndTheirAttachmentsOnly | GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments
  ) && is_container_item_type(item.item_type)
  {
    db.container_sync.mark_client_access(&item.owner_id, &item_id);
  }

  let mut attachments_result = serde_json::Map::new();
  let children_result;
  if mode == GetItemsMode::ChildrenAndTheirAttachmentsOnly
    || mode == GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments
  {
    let snapshot = build_authoritative_child_attachment_snapshot(
      db,
      &item_id,
      &session_user_id_maybe,
      search_status_view_for_queries_snapshot.as_ref(),
    )?;
    children_result = snapshot.children;
    attachments_result = snapshot.attachments;
  } else {
    children_result = vec![];
  }

  if mode == GetItemsMode::ItemAndAttachmentsOnly || mode == GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments {
    if is_attachments_item_type(item.item_type) {
      let item_attachments_result = build_item_attachment_snapshot_authorized(db, &item_id, &session_user_id_maybe)?;
      attachments_result.insert(
        item_id.clone(),
        Value::Array(item_attachments_result.into_iter().map(Value::from).collect::<Vec<_>>()),
      );
    }
  }

  let mut result = serde_json::Map::new();
  if mode == GetItemsMode::ItemAndAttachmentsOnly || mode == GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments {
    let item_json_map = match item_to_api_json_map_with_capabilities(db, &item) {
      Ok(r) => r,
      Err(e) => return Err(format!("Error occurred getting item {}: {}", item_id, e).into()),
    };
    result.insert(String::from("item"), Value::from(item_json_map));
  }
  result.insert(String::from("children"), Value::from(children_result));
  result.insert(String::from("attachments"), Value::from(attachments_result));
  let sync_version = match mode {
    GetItemsMode::ChildrenAndTheirAttachmentsOnly | GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments => {
      let real_version = db.container_sync.version_for_container(&item.owner_id, &item_id);
      Some(match search_status_view_for_queries_snapshot.as_ref() {
        Some(search_status_view) => queries_container_sync_version(real_version, search_status_view),
        None => real_version,
      })
    }
    GetItemsMode::ItemAndAttachmentsOnly => None,
  };
  let sync_epoch = match mode {
    GetItemsMode::ChildrenAndTheirAttachmentsOnly | GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments => {
      Some(db.container_sync.epoch_for_user(&item.owner_id))
    }
    GetItemsMode::ItemAndAttachmentsOnly => None,
  };
  result.insert(
    String::from("syncVersion"),
    match sync_version {
      Some(version) => Value::Number(version.into()),
      None => Value::Null,
    },
  );
  result.insert(
    String::from("syncEpoch"),
    match sync_epoch {
      Some(epoch) => Value::Number(epoch.into()),
      None => Value::Null,
    },
  );

  if let Some(group_id) = group_id {
    result.insert(String::from("groupId"), Value::String(group_id));
  }

  debug!("Executed 'get-items' command for item '{}' (mode {:?}).", item_id, mode);

  Ok(Some(serde_json::to_string(&result)?))
}

async fn resolve_get_items_request_item_id(
  db: &Arc<tokio::sync::Mutex<Db>>,
  request_id: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Uid> {
  if let Some(page_kind) = search_status_page_kind_for_route_id(request_id) {
    let Some(session) = session_maybe else {
      return Err(format!("Not authorized to access search status page '{}'.", request_id).into());
    };
    return Ok(search_status_page_id(&session.user_id, page_kind));
  }

  let parts = request_id.split('/').collect::<Vec<&str>>();
  if parts.len() != 1 {
    // TODO (MEDIUM): implement ids of the form: /{username}/{item_label}.
    return Err(format!("Get items request id '{}' has unexpected format.", request_id).into());
  }

  if is_uid(request_id) {
    return Ok(request_id.to_owned());
  }

  let username = if request_id.len() == 0 { ROOT_USER_NAME } else { request_id };
  match db.lock().await.user.get_by_username_case_insensitive(username) {
    Some(u) => Ok(u.home_page_id.to_owned()),
    None => Err(format!("User '{}' is unknown.", request_id).into()),
  }
}

async fn maybe_handle_get_virtual_search_status_page_items(
  db: &Arc<tokio::sync::Mutex<Db>>,
  item_id: &Uid,
  mode: &GetItemsMode,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let Some(session) = session_maybe else {
    return Ok(None);
  };
  let Some(page_kind) = search_status_page_kind_for_id(&session.user_id, item_id) else {
    return Ok(None);
  };

  let view = SearchStatusView::for_user(&session.user_id);
  let sync_version = view.sync_version();

  let db = db.lock().await;
  let parent_id_maybe = search_status_page_parent_id(&db, &session.user_id);
  let ordering = match &parent_id_maybe {
    Some(parent_id) => virtual_search_status_page_ordering(&db, parent_id, page_kind)?,
    None => new_ordering(),
  };
  let child_items = if get_items_mode_includes_children(mode) {
    virtual_search_status_page_child_items(&db, &session.user_id, page_kind, &view)?
  } else {
    Vec::new()
  };
  // The listed children are capped; the title reports the full count.
  let child_count = virtual_search_status_page_child_count(&db, &session.user_id, page_kind, &view);
  let page = virtual_search_status_page(
    &session.user_id,
    page_kind,
    parent_id_maybe.as_ref(),
    ordering,
    child_count,
    view.checking,
  );
  let children = child_items
    .into_iter()
    .map(|item| virtual_search_status_item_to_api_json_map(&item))
    .collect::<InfuResult<Vec<_>>>()?;

  let mut result = serde_json::Map::new();
  if get_items_mode_includes_item(mode) {
    result.insert(String::from("item"), Value::from(virtual_search_status_item_to_api_json_map(&page)?));
  }
  result.insert(String::from("children"), Value::from(children));
  result.insert(String::from("attachments"), Value::from(serde_json::Map::new()));
  result.insert(
    String::from("syncVersion"),
    match mode {
      GetItemsMode::ChildrenAndTheirAttachmentsOnly | GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments => {
        Value::Number(sync_version.into())
      }
      GetItemsMode::ItemAndAttachmentsOnly => Value::Null,
    },
  );
  result.insert(
    String::from("syncEpoch"),
    match mode {
      GetItemsMode::ChildrenAndTheirAttachmentsOnly | GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments => {
        Value::Number(0.into())
      }
      GetItemsMode::ItemAndAttachmentsOnly => Value::Null,
    },
  );

  Ok(Some(serde_json::to_string(&result)?))
}

async fn maybe_handle_get_virtual_search_status_link_items(
  db: &Arc<tokio::sync::Mutex<Db>>,
  item_id: &Uid,
  mode: &GetItemsMode,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let Some(session) = session_maybe else {
    return Ok(None);
  };

  let view = SearchStatusView::for_user(&session.user_id);
  let db = db.lock().await;
  let Some(link) = virtual_search_status_link_item_for_id(&db, &session.user_id, item_id, &view)? else {
    return Ok(None);
  };

  let mut result = serde_json::Map::new();
  if get_items_mode_includes_item(mode) {
    result.insert(String::from("item"), Value::from(item_to_api_json_map(&link)?));
  }
  result.insert(String::from("children"), Value::from(Vec::<serde_json::Map<String, serde_json::Value>>::new()));
  result.insert(String::from("attachments"), Value::from(serde_json::Map::new()));
  result.insert(
    String::from("syncVersion"),
    match mode {
      GetItemsMode::ChildrenAndTheirAttachmentsOnly | GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments => {
        Value::Number(0.into())
      }
      GetItemsMode::ItemAndAttachmentsOnly => Value::Null,
    },
  );
  result.insert(
    String::from("syncEpoch"),
    match mode {
      GetItemsMode::ChildrenAndTheirAttachmentsOnly | GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments => {
        Value::Number(0.into())
      }
      GetItemsMode::ItemAndAttachmentsOnly => Value::Null,
    },
  );

  Ok(Some(serde_json::to_string(&result)?))
}

async fn maybe_search_status_view_for_queries_container(
  db: &Arc<tokio::sync::Mutex<Db>>,
  item_id: &Uid,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<SearchStatusView>> {
  let Some(session) = session_maybe else {
    return Ok(None);
  };

  let db = db.lock().await;
  let user = db.user.get(&session.user_id).ok_or(format!("Unknown user '{}'.", session.user_id))?;
  if &user.queries_page_id != item_id {
    return Ok(None);
  }
  Ok(Some(SearchStatusView::for_user(&session.user_id)))
}

async fn maybe_search_status_view_for_queries_subscription(
  db: &Arc<tokio::sync::Mutex<Db>>,
  subscriptions: &[SyncContainersSubscription],
  session_maybe: &Option<Session>,
  view_maybe: Option<&SearchStatusView>,
) -> InfuResult<Option<SearchStatusView>> {
  let Some(session) = session_maybe else {
    return Ok(None);
  };

  let db = db.lock().await;
  let user = db.user.get(&session.user_id).ok_or(format!("Unknown user '{}'.", session.user_id))?;
  if !subscriptions.iter().any(|subscription| subscription.id == user.queries_page_id) {
    return Ok(None);
  }
  Ok(Some(view_maybe.cloned().unwrap_or_else(|| SearchStatusView::for_user(&session.user_id))))
}

fn queries_container_sync_version(real_version: u64, search_status_view: &SearchStatusView) -> u64 {
  search_status_view
    .sync_version()
    .saturating_mul(SEARCH_STATUS_CONTAINER_VERSION_MULTIPLIER)
    .saturating_add(real_version)
    .saturating_add(1)
}

fn get_items_mode_includes_children(mode: &GetItemsMode) -> bool {
  matches!(
    mode,
    GetItemsMode::ChildrenAndTheirAttachmentsOnly | GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments
  )
}

fn get_items_mode_includes_item(mode: &GetItemsMode) -> bool {
  matches!(mode, GetItemsMode::ItemAndAttachmentsOnly | GetItemsMode::ItemAttachmentsChildrenAndTheirAttachments)
}

fn search_status_page_kind_for_id(user_id: &str, item_id: &str) -> Option<SearchStatusPageKind> {
  if item_id == search_attention_page_id(user_id) {
    return Some(SearchStatusPageKind::Attention);
  }
  if item_id == search_processing_page_id(user_id) {
    return Some(SearchStatusPageKind::Processing);
  }
  None
}

fn search_status_page_parent_id(db: &MutexGuard<'_, Db>, user_id: &str) -> Option<Uid> {
  db.user.get(&user_id.to_owned()).map(|user| user.queries_page_id.clone())
}

fn virtual_search_status_page_ordering(
  db: &MutexGuard<'_, Db>,
  parent_id: &Uid,
  page_kind: SearchStatusPageKind,
) -> InfuResult<Vec<u8>> {
  let attention_ordering =
    new_ordering_at_end(db.item.get_children(parent_id)?.iter().map(|item| item.ordering.clone()).collect());
  Ok(match page_kind {
    SearchStatusPageKind::Attention => attention_ordering,
    SearchStatusPageKind::Processing => new_ordering_after(&attention_ordering),
  })
}

fn virtual_search_status_page(
  user_id: &str,
  page_kind: SearchStatusPageKind,
  parent_id_maybe: Option<&Uid>,
  ordering: Vec<u8>,
  child_count: usize,
  checking: bool,
) -> Item {
  let spatial_page_width_bl = 3;
  let inner_page_width_bl = 60;
  let spatial_position_gr = match page_kind {
    SearchStatusPageKind::Attention => Vector { x: 5 * GRID_SIZE, y: GRID_SIZE },
    SearchStatusPageKind::Processing => Vector { x: GRID_SIZE, y: GRID_SIZE },
  };
  let natural_aspect = 2.0;
  let title = search_status_page_title(page_kind, child_count, checking);
  let mut item = Item::new_page(
    parent_id_maybe,
    ordering,
    spatial_position_gr,
    spatial_page_width_bl * GRID_SIZE,
    if parent_id_maybe.is_some() { RelationshipToParent::Child } else { RelationshipToParent::NoParent },
    &title,
    "",
    SEARCH_STATUS_PAGE_BACKGROUND_COLOR_INDEX,
    0,
    0,
    natural_aspect,
    inner_page_width_bl * GRID_SIZE,
    ArrangeAlgorithm::Grid,
    6,
    1.5,
    36,
    7.0,
    1.0,
    vec![TableColumn { width_gr: 480, name: "Title".to_owned() }],
    1,
  );
  item.owner_id = user_id.to_owned();
  item.id = match page_kind {
    SearchStatusPageKind::Attention => search_attention_page_id(user_id),
    SearchStatusPageKind::Processing => search_processing_page_id(user_id),
  };
  item.flags = Some(item.flags.unwrap_or(0) | LIST_PAGE_PIN_BOTTOM_FLAG | PAGE_DISABLE_LINE_ITEM_EXPAND_FLAG);
  item
}

fn search_status_page_title(page_kind: SearchStatusPageKind, child_count: usize, checking: bool) -> String {
  let mut notes = vec![child_count.to_string()];
  if child_count > SEARCH_STATUS_PAGE_MAX_LINKS {
    notes.push(format!("showing {}", SEARCH_STATUS_PAGE_MAX_LINKS));
  }
  if checking {
    notes.push("checking".to_owned());
  }
  format!("{} ({})", page_kind.title(), notes.join(", "))
}

fn virtual_search_status_page_children(
  db: &MutexGuard<'_, Db>,
  user_id: &str,
  page_kind: SearchStatusPageKind,
  view: &SearchStatusView,
) -> InfuResult<Vec<serde_json::Map<String, serde_json::Value>>> {
  virtual_search_status_page_child_items(db, user_id, page_kind, view)?
    .into_iter()
    .map(|item| virtual_search_status_item_to_api_json_map(&item))
    .collect()
}

fn virtual_search_status_page_child_count(
  db: &MutexGuard<'_, Db>,
  user_id: &str,
  page_kind: SearchStatusPageKind,
  view: &SearchStatusView,
) -> usize {
  let session_user_id_maybe = Some(user_id.to_owned());
  view
    .item_ids_for_page_kind(page_kind)
    .iter()
    .filter_map(|item_id| db.item.get(item_id).ok())
    .filter(|item| authorize_item(db, item, &session_user_id_maybe, 0).is_ok())
    .count()
}

fn virtual_search_status_link_item_for_id(
  db: &MutexGuard<'_, Db>,
  user_id: &str,
  item_id: &Uid,
  view: &SearchStatusView,
) -> InfuResult<Option<Item>> {
  for page_kind in [SearchStatusPageKind::Attention, SearchStatusPageKind::Processing] {
    if let Some(link) =
      virtual_search_status_page_child_items(db, user_id, page_kind, view)?.into_iter().find(|link| &link.id == item_id)
    {
      return Ok(Some(link));
    }
  }
  Ok(None)
}

fn virtual_search_status_page_child_items(
  db: &MutexGuard<'_, Db>,
  user_id: &str,
  page_kind: SearchStatusPageKind,
  view: &SearchStatusView,
) -> InfuResult<Vec<Item>> {
  let session_user_id_maybe = Some(user_id.to_owned());
  // Sort keys are computed once, and only the listed items are fully sorted.
  let mut keyed_items = view
    .item_ids_for_page_kind(page_kind)
    .iter()
    .filter_map(|item_id| db.item.get(item_id).ok())
    .filter(|item| authorize_item(db, item, &session_user_id_maybe, 0).is_ok())
    .map(|item| ((item.title.as_deref().unwrap_or("").to_lowercase(), item.id.clone()), item))
    .collect::<Vec<_>>();
  if keyed_items.len() > SEARCH_STATUS_PAGE_MAX_LINKS {
    keyed_items.select_nth_unstable_by(SEARCH_STATUS_PAGE_MAX_LINKS - 1, |a, b| a.0.cmp(&b.0));
    keyed_items.truncate(SEARCH_STATUS_PAGE_MAX_LINKS);
  }
  keyed_items.sort_by(|a, b| a.0.cmp(&b.0));
  let target_items = keyed_items.into_iter().map(|(_, item)| item).collect::<Vec<_>>();

  let page_id = match page_kind {
    SearchStatusPageKind::Attention => search_attention_page_id(user_id),
    SearchStatusPageKind::Processing => search_processing_page_id(user_id),
  };
  let mut ordering = new_ordering();
  let mut children = Vec::with_capacity(target_items.len());
  for target_item in target_items {
    let mut link = Item::new_link(
      &page_id,
      ordering.clone(),
      Vector { x: 0, y: 0 },
      12 * GRID_SIZE,
      4 * GRID_SIZE,
      RelationshipToParent::Child,
      &target_item.id,
    );
    link.owner_id = user_id.to_owned();
    link.id = search_status_link_id(user_id, page_kind, &target_item.id);
    children.push(link);
    ordering = new_ordering_after(&ordering);
  }
  Ok(children)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::web::routes::command::scope::test_db::TestDb;
  use crate::web::routes::default_scopes_page;

  #[test]
  fn scopes_page_update_allows_rename_but_not_move_or_unpin() {
    let owner_id = "0123456789abcdef0123456789abcdef";
    let queries_page_id = "00000000000000000000000000000001".to_owned();
    let old_item = default_scopes_page(owner_id, &queries_page_id, vec![200], 2.0);

    let mut renamed = old_item.clone();
    renamed.title = Some("My scopes".to_owned());
    assert!(!scopes_page_update_disallowed(&old_item, &renamed));

    let mut moved = old_item.clone();
    moved.parent_id = Some("00000000000000000000000000000002".to_owned());
    assert!(scopes_page_update_disallowed(&old_item, &moved));

    let mut unpinned = old_item.clone();
    unpinned.flags = Some(unpinned.flags.unwrap_or(0) & !LIST_PAGE_PIN_BOTTOM_FLAG);
    assert!(scopes_page_update_disallowed(&old_item, &unpinned));
  }

  #[tokio::test]
  async fn links_cannot_target_links() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let page = t.page(&home, "Page").await;
    let link_to_page = t.link(&home, &page).await;

    let validate = |t: &TestDb, link_to: &str| {
      let mut link = t.db.item.get(&link_to_page).unwrap().clone();
      link.link_to = Some(link_to.to_owned());
      validate_link_target_for_item(&t.db, &link)
    };
    assert!(validate(&t, &page).is_ok());
    assert!(validate(&t, &link_to_page).is_err(), "link to a link");
    let mut self_link = t.db.item.get(&link_to_page).unwrap().clone();
    self_link.id = new_uid();
    self_link.link_to = Some(self_link.id.clone());
    assert!(validate_link_target_for_item(&t.db, &self_link).is_err(), "link to itself, not yet added");
    assert!(validate(&t, &new_uid()).is_ok(), "missing target");
    assert!(validate(&t, "https://example.com/0123456789abcdef0123456789abcdef").is_ok(), "remote target");

    let not_a_link = t.db.item.get(&page).unwrap().clone();
    assert!(validate_link_target_for_item(&t.db, &not_a_link).is_ok());
  }
}
