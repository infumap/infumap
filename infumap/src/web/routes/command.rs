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
use image::ImageFormat;
use image::ImageReader;
use image::imageops::FilterType;
use infusdk::item::{
  ArrangeAlgorithm, Item, ItemType, PermissionFlags, RelationshipToParent, TableColumn, is_attachments_item_type,
  is_composite_item, is_container_item_type, is_data_item_type, is_flags_item_type, is_format_item_type, is_image_item,
  is_page_item, is_permission_flags_item_type, is_positionable_type, is_table_item,
};
use infusdk::util::geometry::{Dimensions, GRID_SIZE, Vector};
use infusdk::util::infu::InfuResult;
use infusdk::util::json;
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
use crate::ai::fragment::{
  ITEM_TITLE_SOURCE_KIND, delete_item_fragment_artifacts, is_lexical_search_source_kind,
  is_markdown_document_source_kind,
};
use crate::ai::geo::delete_item_geo_artifacts;
use crate::ai::gpu_tools::{GPU_TOOL_TEXT_EMBED, resolve_configured_gpu_tool_url};
use crate::ai::image_pipeline::{
  dequeue_image_semantic_pipeline_item_if_active, enqueue_image_semantic_pipeline_item_if_active,
};
use crate::ai::image_tagging::{delete_item_image_tag_dir, should_tag_image_item};
use crate::ai::indexing::delete_item_fragment_index_entries;
use crate::ai::lexical_index::{
  FragmentLexicalHit, open_user_document_fragment_lexical_index, open_user_item_title_lexical_index,
  user_document_fragment_lexical_index_exists, user_item_title_lexical_index_exists,
};
use crate::ai::metrics::{METRIC_SEARCH_BACKEND_DURATION_SECONDS, METRIC_SEARCH_BACKEND_FAILURES_TOTAL};
use crate::ai::search_status::{
  SearchStatusArtifact, SearchStatusPageKind, read_search_status_artifact, search_failed_page_id,
  search_pending_page_id, search_status_link_id, search_status_page_id, search_status_page_kind_for_route_id,
};
use crate::ai::text_embedding::{
  TextEmbeddingInput, embed_texts, text_embedding_vector_fingerprint, text_embedding_vector_norm,
  validate_text_embedding_vector,
};
use crate::ai::text_extraction::{delete_item_text_dir, dequeue_pdf_item_if_active, enqueue_pdf_item_if_active};
use crate::ai::title_indexing::enqueue_item_title_index_reconcile_for_user;
use crate::ai::vector_db::{
  FragmentVectorDbBackend, FragmentVectorHit, open_user_fragment_vector_db, user_fragment_vector_db_exists,
};
use crate::storage::cache as storage_cache;
use crate::storage::db::Db;
use crate::storage::db::container_sync::{ContainerSyncDelta, ContainerSyncLookup, ContainerSyncVersion};
use crate::storage::db::session::Session;
use crate::storage::db::user::ROOT_USER_NAME;
use crate::storage::object;
use crate::util::image::{adjust_image_for_exif_orientation, get_exif_orientation};
use crate::util::mime::{detect_mime_type, mime_type_from_title_extension};
use crate::util::ordering::{new_ordering, new_ordering_after, new_ordering_at_end};
use crate::web::serve::{cors_response, incoming_json_with_limit, json_response};
use crate::web::session::get_and_validate_session;
use std::collections::{HashMap, HashSet};

// Uploads are sent as base64 inside JSON. 256 MiB request limit supports roughly
// 190+ MiB raw files while remaining bounded.
const COMMAND_REQUEST_MAX_BYTES: usize = 256 * 1024 * 1024;
const SEARCH_RRF_K: f64 = 60.0;
const SEARCH_TITLE_LEXICAL_WEIGHT: f64 = 1.35;
const SEARCH_LEXICAL_WEIGHT: f64 = 1.15;
const SEARCH_SEMANTIC_WEIGHT: f64 = 1.0;
const SEARCH_CANDIDATE_OVERFETCH: i64 = 50;
const SEARCH_LEXICAL_FRAGMENT_MULTIPLIER: usize = 4;
const SEARCH_LEXICAL_MATCHES_PER_RESULT: usize = 2;
const SEARCH_SEMANTIC_FRAGMENT_MULTIPLIER: usize = 4;
const SEARCH_EMBEDDING_TIMEOUT_SECS: u64 = 30;
const SEARCH_FRAGMENT_MATCH_MAX_CHARS: usize = 1250;
const SEARCH_MATCH_SNIPPET_MAX_SENTENCES: usize = 3;
const SEARCH_MATCH_SNIPPET_MAX_SENTENCE_CHARS: usize = 220;
const SEARCH_MATCH_SNIPPET_CONTEXT_BEFORE_CHARS: usize = 70;
const SEARCH_MATCH_SNIPPET_BOUNDARY_SLOP_CHARS: usize = 20;
const SEARCH_BM25_SCORE_SATURATION: f32 = 4.0;
const SEARCH_SNIPPET_ELLIPSIS: &str = "...";
const SEARCH_STATUS_PAGE_BACKGROUND_COLOR_INDEX: i64 = 7;
const SEARCH_STATUS_CONTAINER_VERSION_MULTIPLIER: u64 = 1_000_000_000;
const PDF_CATALOG_OMITTED_LABELS: [&str; 3] = ["document", "context", "section"];
const SEARCH_SNIPPET_STOP_WORDS: [&str; 32] = [
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he", "her", "his", "in", "is", "it", "its",
  "of", "on", "or", "she", "that", "the", "their", "this", "to", "was", "were", "with", "you", "your",
];

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
  config: Arc<Config>,
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
    "get-attachments" => handle_get_attachments(db, &request.json_data, &session_maybe).await,
    "add-item" => {
      handle_add_item(db, object_store.clone(), &request.json_data, &request.base64_data, &session_maybe).await
    }
    "add-link-note" => handle_add_link_note(db, object_store.clone(), &request.json_data, &session_maybe).await,
    "update-item" => handle_update_item(db, &request.json_data, &session_maybe).await,
    "delete-item" => {
      handle_delete_item(db, object_store.clone(), image_cache, &request.json_data, &session_maybe).await
    }
    "sync-containers" => handle_sync_containers(db, &request.json_data, &session_maybe).await,
    "search" => handle_search(config, db, &request.json_data, &session_maybe).await,
    "empty-trash" => handle_empty_trash(db, object_store.clone(), image_cache, &session_maybe).await,
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
  search_status_artifact_maybe: Option<&SearchStatusArtifact>,
) -> InfuResult<SyncContainerSnapshot> {
  let child_items = get_children_authorized(db, item_id, session_user_id_maybe)?;
  let mut children = child_items
    .iter()
    .map(|item| item.to_api_json().ok())
    .collect::<Option<Vec<_>>>()
    .ok_or(format!("Error occurred getting children for container '{}'.", item_id))?;
  append_virtual_search_status_pages_to_searches_snapshot(
    db,
    item_id,
    session_user_id_maybe,
    search_status_artifact_maybe,
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

fn append_virtual_search_status_pages_to_searches_snapshot(
  db: &MutexGuard<'_, Db>,
  item_id: &Uid,
  session_user_id_maybe: &Option<String>,
  search_status_artifact_maybe: Option<&SearchStatusArtifact>,
  child_items: &[&Item],
  children: &mut Vec<serde_json::Map<String, serde_json::Value>>,
) -> InfuResult<()> {
  let Some(session_user_id) = session_user_id_maybe else {
    return Ok(());
  };
  let user = db.user.get(session_user_id).ok_or(format!("Unknown user '{}'.", session_user_id))?;
  if &user.searches_page_id != item_id {
    return Ok(());
  }

  let empty_artifact = SearchStatusArtifact::empty();
  let search_status_artifact = search_status_artifact_maybe.unwrap_or(&empty_artifact);
  let mut ordering = new_ordering_at_end(child_items.iter().map(|item| item.ordering.clone()).collect());
  for page_kind in [SearchStatusPageKind::Failed, SearchStatusPageKind::Pending] {
    let child_count = virtual_search_status_page_child_count(db, session_user_id, page_kind, search_status_artifact);
    let item = virtual_search_status_page(session_user_id, page_kind, Some(item_id), ordering.clone(), child_count);
    children.push(item_to_api_json_map(&item)?);
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
  delta.add_child_upsert(item_to_api_json_map(child)?);
  if is_attachments_item_type(child.item_type) {
    delta.set_attachment_snapshot(&child.id, build_item_attachment_snapshot(db, &child.id)?);
  }
  Ok(delta)
}

fn maybe_container_id_for_child_item(item: &Item) -> Option<Uid> {
  if item.relationship_to_parent == RelationshipToParent::Child { item.parent_id.clone() } else { None }
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
  let mut search_status_artifact_for_session = None;
  if let Some(session) = session_maybe {
    if !virtual_search_status_subscriptions.is_empty() {
      let artifact = read_search_status_artifact_or_empty(db, &session.user_id).await?;
      {
        let db = db.lock().await;
        for (subscription, page_kind) in virtual_search_status_subscriptions {
          if let Some(update) =
            virtual_search_status_sync_update(&db, &session.user_id, &subscription, page_kind, &artifact)?
          {
            updates.push(update);
          }
        }
      }
      search_status_artifact_for_session = Some(artifact);
    }
  }

  let search_status_artifact_for_searches_snapshot = maybe_read_search_status_artifact_for_searches_subscription(
    db,
    &db_subscriptions,
    session_maybe,
    search_status_artifact_for_session.as_ref(),
  )
  .await?;

  let db = &mut db.lock().await;

  for subscription in db_subscriptions {
    let item = get_item_authorized(db, &subscription.id, &session_user_id_maybe)?.clone();
    if !is_container_item_type(item.item_type) {
      return Err(format!("Item '{}' is not a container and cannot be synced.", subscription.id).into());
    }

    let search_status_artifact_for_subscription = if let Some(session_user_id) = &session_user_id_maybe {
      match db.user.get(session_user_id) {
        Some(user) if user.searches_page_id == subscription.id => search_status_artifact_for_searches_snapshot.as_ref(),
        _ => None,
      }
    } else {
      None
    };

    if let Some(search_status_artifact) = search_status_artifact_for_subscription {
      let epoch = db.container_sync.epoch_for_user(&item.owner_id);
      let real_version = db.container_sync.version_for_container(&item.owner_id, &subscription.id);
      let version = searches_container_sync_version(real_version, search_status_artifact);
      db.container_sync.mark_client_access(&item.owner_id, &subscription.id);
      if subscription.known_epoch == Some(epoch) && subscription.known_version == Some(version) {
        continue;
      }
      updates.push(SyncContainerUpdate {
        id: subscription.id.clone(),
        epoch,
        version,
        strategy: String::from("snapshot"),
        children: None,
        child_deletes: None,
        attachment_upserts: None,
        attachment_deletes: None,
        snapshot: Some(build_authoritative_child_attachment_snapshot(
          db,
          &subscription.id,
          &session_user_id_maybe,
          Some(search_status_artifact),
        )?),
      });
      continue;
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
  artifact: &SearchStatusArtifact,
) -> InfuResult<Option<SyncContainerUpdate>> {
  let epoch = 0;
  let version = virtual_search_status_sync_version(artifact);
  if subscription.known_epoch == Some(epoch) && subscription.known_version == Some(version) {
    return Ok(None);
  }

  Ok(Some(SyncContainerUpdate {
    id: subscription.id.clone(),
    epoch,
    version,
    strategy: String::from("snapshot"),
    children: None,
    child_deletes: None,
    attachment_upserts: None,
    attachment_deletes: None,
    snapshot: Some(SyncContainerSnapshot {
      children: virtual_search_status_page_children(db, user_id, page_kind, artifact)?,
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

  let session_user_id_maybe = match &session_maybe {
    Some(session) => Some(session.user_id.clone()),
    None => None,
  };

  let mode = GetItemsMode::from_str(&request.mode)?;

  if let Some(response) = maybe_handle_get_virtual_search_status_page_items(db, &item_id, &mode, session_maybe).await? {
    debug!("Executed 'get-items' command for virtual search status item '{}' (mode {:?}).", item_id, mode);
    return Ok(Some(response));
  }

  let search_status_artifact_for_searches_snapshot = if get_items_mode_includes_children(&mode) {
    maybe_read_search_status_artifact_for_searches_container(db, &item_id, session_maybe).await?
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
      search_status_artifact_for_searches_snapshot.as_ref(),
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
    let item_json_map = match item.to_api_json() {
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
      Some(match search_status_artifact_for_searches_snapshot.as_ref() {
        Some(search_status_artifact) => searches_container_sync_version(real_version, search_status_artifact),
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

  let artifact = read_search_status_artifact_or_empty(db, &session.user_id).await?;
  let sync_version = virtual_search_status_sync_version(&artifact);

  let db = db.lock().await;
  let parent_id_maybe = search_status_page_parent_id(&db, &session.user_id);
  let ordering = match &parent_id_maybe {
    Some(parent_id) => virtual_search_status_page_ordering(&db, parent_id, page_kind)?,
    None => new_ordering(),
  };
  let child_items = if get_items_mode_includes_children(mode) {
    virtual_search_status_page_child_items(&db, &session.user_id, page_kind, &artifact)?
  } else {
    Vec::new()
  };
  let child_count = if get_items_mode_includes_children(mode) {
    child_items.len()
  } else {
    virtual_search_status_page_child_count(&db, &session.user_id, page_kind, &artifact)
  };
  let page = virtual_search_status_page(&session.user_id, page_kind, parent_id_maybe.as_ref(), ordering, child_count);
  let children = child_items.into_iter().map(|item| item_to_api_json_map(&item)).collect::<InfuResult<Vec<_>>>()?;

  let mut result = serde_json::Map::new();
  if get_items_mode_includes_item(mode) {
    result.insert(String::from("item"), Value::from(item_to_api_json_map(&page)?));
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

  let artifact = read_search_status_artifact_or_empty(db, &session.user_id).await?;
  let db = db.lock().await;
  let Some(link) = virtual_search_status_link_item_for_id(&db, &session.user_id, item_id, &artifact)? else {
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

async fn read_search_status_artifact_or_empty(
  db: &Arc<tokio::sync::Mutex<Db>>,
  user_id: &str,
) -> InfuResult<SearchStatusArtifact> {
  let data_dir = {
    let db = db.lock().await;
    db.item.data_dir().to_owned()
  };
  Ok(match read_search_status_artifact(&data_dir, user_id).await? {
    Some(artifact) => artifact,
    None => SearchStatusArtifact::empty(),
  })
}

async fn maybe_read_search_status_artifact_for_searches_container(
  db: &Arc<tokio::sync::Mutex<Db>>,
  item_id: &Uid,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<SearchStatusArtifact>> {
  let Some(session) = session_maybe else {
    return Ok(None);
  };

  let data_dir = {
    let db = db.lock().await;
    let user = db.user.get(&session.user_id).ok_or(format!("Unknown user '{}'.", session.user_id))?;
    if &user.searches_page_id != item_id {
      return Ok(None);
    }
    db.item.data_dir().to_owned()
  };

  Ok(Some(read_search_status_artifact(&data_dir, &session.user_id).await?.unwrap_or_else(SearchStatusArtifact::empty)))
}

async fn maybe_read_search_status_artifact_for_searches_subscription(
  db: &Arc<tokio::sync::Mutex<Db>>,
  subscriptions: &[SyncContainersSubscription],
  session_maybe: &Option<Session>,
  artifact_maybe: Option<&SearchStatusArtifact>,
) -> InfuResult<Option<SearchStatusArtifact>> {
  let Some(session) = session_maybe else {
    return Ok(None);
  };

  let data_dir = {
    let db = db.lock().await;
    let user = db.user.get(&session.user_id).ok_or(format!("Unknown user '{}'.", session.user_id))?;
    if !subscriptions.iter().any(|subscription| subscription.id == user.searches_page_id) {
      return Ok(None);
    }
    db.item.data_dir().to_owned()
  };

  if let Some(artifact) = artifact_maybe {
    return Ok(Some(artifact.clone()));
  }

  Ok(Some(read_search_status_artifact(&data_dir, &session.user_id).await?.unwrap_or_else(SearchStatusArtifact::empty)))
}

fn virtual_search_status_sync_version(artifact: &SearchStatusArtifact) -> u64 {
  artifact.updated_at_unix_secs.max(0) as u64
}

fn searches_container_sync_version(real_version: u64, search_status_artifact: &SearchStatusArtifact) -> u64 {
  virtual_search_status_sync_version(search_status_artifact)
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
  if item_id == search_failed_page_id(user_id) {
    return Some(SearchStatusPageKind::Failed);
  }
  if item_id == search_pending_page_id(user_id) {
    return Some(SearchStatusPageKind::Pending);
  }
  None
}

fn search_status_page_parent_id(db: &MutexGuard<'_, Db>, user_id: &str) -> Option<Uid> {
  db.user.get(&user_id.to_owned()).map(|user| user.searches_page_id.clone())
}

fn virtual_search_status_page_ordering(
  db: &MutexGuard<'_, Db>,
  parent_id: &Uid,
  page_kind: SearchStatusPageKind,
) -> InfuResult<Vec<u8>> {
  let failed_ordering =
    new_ordering_at_end(db.item.get_children(parent_id)?.iter().map(|item| item.ordering.clone()).collect());
  Ok(match page_kind {
    SearchStatusPageKind::Failed => failed_ordering,
    SearchStatusPageKind::Pending => new_ordering_after(&failed_ordering),
  })
}

fn virtual_search_status_page(
  user_id: &str,
  page_kind: SearchStatusPageKind,
  parent_id_maybe: Option<&Uid>,
  ordering: Vec<u8>,
  child_count: usize,
) -> Item {
  let page_width_bl = 60;
  let natural_aspect = 2.0;
  let title = search_status_page_title(page_kind, child_count);
  let mut item = Item::new_page(
    parent_id_maybe,
    ordering,
    Vector { x: 0, y: 0 },
    page_width_bl * GRID_SIZE,
    if parent_id_maybe.is_some() { RelationshipToParent::Child } else { RelationshipToParent::NoParent },
    &title,
    "",
    SEARCH_STATUS_PAGE_BACKGROUND_COLOR_INDEX,
    0,
    0,
    natural_aspect,
    page_width_bl * GRID_SIZE,
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
    SearchStatusPageKind::Failed => search_failed_page_id(user_id),
    SearchStatusPageKind::Pending => search_pending_page_id(user_id),
  };
  item
}

fn search_status_page_title(page_kind: SearchStatusPageKind, child_count: usize) -> String {
  format!("{} ({})", page_kind.title(), child_count)
}

fn virtual_search_status_page_children(
  db: &MutexGuard<'_, Db>,
  user_id: &str,
  page_kind: SearchStatusPageKind,
  artifact: &SearchStatusArtifact,
) -> InfuResult<Vec<serde_json::Map<String, serde_json::Value>>> {
  virtual_search_status_page_child_items(db, user_id, page_kind, artifact)?
    .into_iter()
    .map(|item| item_to_api_json_map(&item))
    .collect()
}

fn virtual_search_status_page_child_count(
  db: &MutexGuard<'_, Db>,
  user_id: &str,
  page_kind: SearchStatusPageKind,
  artifact: &SearchStatusArtifact,
) -> usize {
  let session_user_id_maybe = Some(user_id.to_owned());
  artifact
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
  artifact: &SearchStatusArtifact,
) -> InfuResult<Option<Item>> {
  for page_kind in [SearchStatusPageKind::Failed, SearchStatusPageKind::Pending] {
    if let Some(link) = virtual_search_status_page_child_items(db, user_id, page_kind, artifact)?
      .into_iter()
      .find(|link| &link.id == item_id)
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
  artifact: &SearchStatusArtifact,
) -> InfuResult<Vec<Item>> {
  let session_user_id_maybe = Some(user_id.to_owned());
  let mut target_items = artifact
    .item_ids_for_page_kind(page_kind)
    .iter()
    .filter_map(|item_id| db.item.get(item_id).ok())
    .filter(|item| authorize_item(db, item, &session_user_id_maybe, 0).is_ok())
    .collect::<Vec<_>>();
  target_items.sort_by(|a, b| {
    a.title
      .as_deref()
      .unwrap_or("")
      .to_lowercase()
      .cmp(&b.title.as_deref().unwrap_or("").to_lowercase())
      .then(a.id.cmp(&b.id))
  });

  let page_id = match page_kind {
    SearchStatusPageKind::Failed => search_failed_page_id(user_id),
    SearchStatusPageKind::Pending => search_pending_page_id(user_id),
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

#[derive(Deserialize, Serialize)]
pub struct GetAttachmentsRequest {
  #[serde(rename = "parentId")]
  pub parent_id_maybe: Option<String>,
}

async fn handle_get_attachments(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let db = db.lock().await;

  let request: GetAttachmentsRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;

  // TODO (MEDIUM): support sessionless get.
  let session = match session_maybe {
    Some(session) => session,
    None => {
      return Err(format!("Session is required to update an item.").into());
    }
  };

  let parent_id = match &request.parent_id_maybe {
    Some(parent_id) => parent_id,
    None => &db.user.get(&session.user_id).ok_or(format!("Unknown user '{}'.", &session.user_id))?.home_page_id,
  };

  let parent_item = db.item.get(parent_id)?;
  if &parent_item.owner_id != &session.user_id {
    return Err(format!("User '{}' does not own item '{}'.", &session.user_id, parent_id).into());
  }

  let attachment_items = db.item.get_attachments(parent_id)?;

  let attachments_result = attachment_items
    .iter()
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
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = match session_maybe {
    Some(session) => session,
    None => {
      return Err(format!("Session is required to add an item.").into());
    }
  };

  add_item_for_user(db, object_store, json_data, base64_data_maybe, &session.user_id).await
}

#[derive(Deserialize)]
struct AddLinkNoteRequest {
  url: String,
}

async fn handle_add_link_note(
  db: &Arc<tokio::sync::Mutex<Db>>,
  object_store: Arc<object::ObjectStore>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = match session_maybe {
    Some(session) => session,
    None => {
      return Err(format!("Session is required to add a link note.").into());
    }
  };

  let request: AddLinkNoteRequest =
    serde_json::from_str(json_data).map_err(|e| format!("Could not parse add link note request: {}", e))?;
  let normalized_url = link_titles::normalize_link_url(&request.url)?;
  let normalized_url_str = normalized_url.as_str().to_owned();
  let title = match link_titles::fetch_link_title(&normalized_url).await {
    Ok(Some(title)) => title,
    Ok(None) => normalized_url_str.clone(),
    Err(e) => {
      debug!("Could not resolve title for link '{}': {}", normalized_url_str, e);
      normalized_url_str.clone()
    }
  };

  let item_json = serde_json::json!({
    "itemType": "note",
    "title": title,
    "url": normalized_url_str,
    "iconMode": "auto",
    "spatialWidthGr": 8 * 60,
  })
  .to_string();
  let base64_data_maybe: Option<String> = None;
  add_item_for_user(db, object_store, &item_json, &base64_data_maybe, &session.user_id).await
}

pub async fn add_item_for_user(
  db: &Arc<tokio::sync::Mutex<Db>>,
  object_store: Arc<object::ObjectStore>,
  json_data: &str,
  base64_data_maybe: &Option<String>,
  session_user_id: &str,
) -> InfuResult<Option<String>> {
  let session_user_id = session_user_id.to_owned();

  let deserializer = serde_json::Deserializer::from_str(json_data);
  let mut iterator = deserializer.into_iter::<serde_json::Value>();
  let item_map_maybe = iterator.next().ok_or("Add item request has no item data.")??;
  let mut item_map = item_map_maybe.as_object().ok_or("Add item request body is not a JSON object.")?.clone();

  let item_type = String::from(
    item_map
      .get("itemType")
      .ok_or("Item type was not specified.")?
      .as_str()
      .ok_or("'itemType' field is not a string.")?,
  );
  // The JSON sent to an add-item command is more flexible than the item schema allows for.
  // First step is to prep/transform/add defaults to the received JSON map for deserialization into an item object.

  if !item_map.contains_key("id") {
    item_map.insert("id".to_owned(), Value::String(new_uid().to_owned()));
  }

  // ========================================================================
  // PHASE 1: Validation with database lock
  // Perform all validation that requires database access, then release lock.
  // ========================================================================
  let (mut item, object_encryption_key_maybe): (Item, Option<String>) = {
    let db = db.lock().await;

    if !item_map.contains_key("parentId") {
      item_map.insert(
        "parentId".to_owned(),
        Value::String(
          db.user.get(&session_user_id).ok_or(format!("No user with id '{}'.", &session_user_id))?.home_page_id.clone(),
        ),
      );
    }

    if !item_map.contains_key("ownerId") {
      item_map.insert("ownerId".to_owned(), Value::String(session_user_id.clone()));
    }

    if !item_map.contains_key("relationshipToParent") {
      item_map.insert("relationshipToParent".to_owned(), Value::String("child".to_owned()));
    }

    let unix_time_now = unix_now_secs_u64().unwrap();

    if !item_map.contains_key("creationDate") {
      item_map.insert("creationDate".to_owned(), Value::Number(unix_time_now.into()));
    }

    if !item_map.contains_key("lastModifiedDate") {
      item_map.insert("lastModifiedDate".to_owned(), Value::Number(unix_time_now.into()));
    }

    if !item_map.contains_key("dateTime") {
      item_map.insert("dateTime".to_owned(), Value::Number(unix_time_now.into()));
    }

    if !item_map.contains_key("spatialPositionGr") {
      if is_positionable_type(ItemType::from_str(&item_type)?) {
        item_map.insert("spatialPositionGr".to_owned(), json::vector_to_object(&Vector { x: 0, y: 0 }));
      }
    }

    if item_type == ItemType::Image.as_str() && !item_map.contains_key("imageSizePx") {
      item_map.insert("imageSizePx".to_owned(), json::dimensions_to_object(&Dimensions { w: -1, h: -1 }));
    }

    if item_type == ItemType::Image.as_str() && !item_map.contains_key("thumbnail") {
      item_map.insert("thumbnail".to_owned(), Value::String("".to_owned()));
    }

    // Temporary placeholder so item parsing succeeds before server-side MIME detection overwrites it.
    if is_data_item_type(ItemType::from_str(&item_type)?) && !item_map.contains_key("mimeType") {
      item_map.insert("mimeType".to_owned(), Value::String("application/octet-stream".to_owned()));
    }

    if is_format_item_type(ItemType::from_str(&item_type)?) && !item_map.contains_key("format") {
      item_map.insert("format".to_owned(), Value::String("".to_owned()));
    }

    if is_flags_item_type(ItemType::from_str(&item_type)?) && !item_map.contains_key("flags") {
      item_map.insert("flags".to_owned(), Value::Number(0.into()));
    }

    if is_permission_flags_item_type(ItemType::from_str(&item_type)?) && !item_map.contains_key("permissionFlags") {
      item_map.insert("permissionFlags".to_owned(), Value::Number(0.into()));
    }

    if !item_map.contains_key("ordering") {
      let parent_id_value = item_map.get("parentId").unwrap(); // should always exist at this point.
      let parent_id = parent_id_value.as_str().ok_or(format!(
        "Attempt was made by user '{}' to add an item with a parentId that is not of type String",
        &session_user_id
      ))?;
      if !is_uid(parent_id) {
        return Err(
          format!("Attempt was made by user '{}' to add an item with invalid parent id.", &session_user_id).into(),
        );
      }
      let orderings =
        db.item.get_children(&parent_id.to_owned())?.iter().map(|i| i.ordering.clone()).collect::<Vec<Vec<u8>>>();
      let ordering = new_ordering_at_end(orderings);
      item_map.insert(
        String::from("ordering"),
        Value::Array(ordering.iter().map(|v| Value::Number((*v).into())).collect::<Vec<_>>()),
      );
    }

    // 4. TODO (MEDIUM): triage destinations.

    let item: Item = Item::from_api_json(&item_map)?;
    let parent_id = item_map.get("parentId").unwrap().as_str().unwrap(); // by this point, should never fail.

    if parent_id == EMPTY_UID {
      return Err(
        format!("Attempt was made by user '{}' to add an item with an empty parent id.", &session_user_id).into(),
      );
    }

    let parent_item = db
      .item
      .get(&parent_id.to_owned())
      .map_err(|_| format!("Cannot add child item to '{}' because an item with that id does not exist.", parent_id))?;
    if &parent_item.owner_id != &session_user_id {
      return Err(format!("Cannot add child item to '{}' because user '{}' is not the owner.", &parent_item.id, &session_user_id,).into());
    }

    match item.relationship_to_parent {
      RelationshipToParent::Child => {
        if !is_container_item_type(parent_item.item_type) {
          return Err(
            format!("Attempt was made by user '{}' to add a child item to a non-container parent.", &session_user_id)
              .into(),
          );
        }
      }
      RelationshipToParent::Attachment => {
        if !is_attachments_item_type(parent_item.item_type) {
          return Err(
            format!(
              "Attempt was made by user '{}' to add an attachment item to a non-attachments parent.",
              &session_user_id
            )
            .into(),
          );
        }
      }
      RelationshipToParent::NoParent => {
        return Err(format!("Attempt was made by user '{}' to add a root level page.", &session_user_id).into());
      }
    };

    if is_empty_uid(&item.id) {
      return Err(format!("Attempt was made by user '{}' to add an item with an empty id.", &session_user_id).into());
    }

    if &item.owner_id != &session_user_id {
      return Err(
        format!(
          "Item owner_id '{}' mismatch with session user '{}' when adding item '{}'.",
          item.owner_id, &session_user_id, item.id
        )
        .into(),
      );
    }

    if db.item.get(&item.id).is_ok() {
      return Err(
        format!("Attempt was made to add item with id '{}', but an item with this id already exists.", item.id).into(),
      );
    }

    if item.ordering.len() == 0 {
      return Err(
        format!("Attempt was made by user '{}' to add an item with empty ordering.", &session_user_id).into(),
      );
    }

    if item.item_type == ItemType::Placeholder && item.relationship_to_parent != RelationshipToParent::Attachment {
      return Err(
        format!("Attempt was made to add a placeholder item where relationship to parent is not Attachment.").into(),
      );
    }

    // Get encryption key if needed for data items, clone it so we can use it outside the lock.
    let encryption_key = if is_data_item_type(item.item_type) {
      Some(
        db.user
          .get(&session_user_id)
          .ok_or(format!("User '{}' not found.", &session_user_id))?
          .object_encryption_key
          .clone(),
      )
    } else {
      None
    };

    (item, encryption_key)
    // Lock is released here when `db` goes out of scope.
  };

  // ========================================================================
  // PHASE 2: I/O Operations without database lock
  // These can be slow (especially object::put for large files) so we don't
  // hold the lock during these operations.
  // ========================================================================
  if is_data_item_type(item.item_type) {
    let base64_data = base64_data_maybe.as_ref().ok_or(format!(
      "Add item request has no base64 data, when this is expected for item of type {}.",
      item.item_type
    ))?;
    let decoded = general_purpose::STANDARD
      .decode(&base64_data)
      .map_err(|e| format!("There was a problem decoding base64 data for new item '{}': {}", item.id, e))?;
    if decoded.len()
      != item.file_size_bytes.ok_or(format!("File size was not specified for new data item '{}'.", item.id))? as usize
    {
      return Err(
        format!(
          "File size specified for new data item '{}' ({}) does not match the actual size of the data ({}).",
          item.id,
          item.file_size_bytes.unwrap(),
          decoded.len()
        )
        .into(),
      );
    }
    item.mime_type = Some(detect_data_item_mime_type(&item, &decoded));
    let object_encryption_key = object_encryption_key_maybe
      .as_ref()
      .ok_or("Internal error: encryption key should have been set for data item.")?;
    object::put(object_store.clone(), &session_user_id, &item.id, &decoded, object_encryption_key).await?;

    if is_image_item(&item) {
      let title = match &item.title {
        Some(title) => title,
        None => {
          return Err(format!("Image item '{}' has no title set.", item.id).into());
        }
      };
      // TODO (LOW): clone here seems a bit excessive.
      let exif_orientation = get_exif_orientation(decoded.clone(), title);
      let file_cursor = Cursor::new(decoded);
      let file_reader = ImageReader::new(file_cursor).with_guessed_format()?;
      let img = file_reader
        .decode()
        .ok()
        .ok_or(format!("Could not add new image item '{}' - could not interpret base64 data as an image.", item.id))?;
      let img = adjust_image_for_exif_orientation(img, exif_orientation, title);

      let width = img.width();
      let height = img.height();

      let img = img.resize_exact(8, 8, FilterType::Nearest);
      let buf = Vec::new();
      let mut cursor = Cursor::new(buf);
      img
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| format!("An error occurred creating the thumbnail png for new image '{}': {}.", item.id, e))?;
      let thumbnail_data = cursor.get_ref().to_vec();
      let thumbnail_base64 = general_purpose::STANDARD.encode(thumbnail_data);
      if item.thumbnail.unwrap() != "" {
        return Err(
          format!("Attempt was made by user '{}' to add an image item with a non-empty thumbnail.", &session_user_id)
            .into(),
        );
      }
      item.thumbnail = Some(thumbnail_base64);

      let img_size_px = &item.image_size_px.unwrap();
      if img_size_px.w != -1 && img_size_px.w != width as i64 {
        return Err(
          format!(
            "Image width specified for new image item '{}' ({:?}) does not match the actual width of the image ({}).",
            item.id, img_size_px, width
          )
          .into(),
        );
      }
      if img_size_px.h != -1 && img_size_px.h != height as i64 {
        return Err(
          format!(
            "Image height specified for new image item '{}' ({:?}) does not match the actual height of the image ({}).",
            item.id, img_size_px, height
          )
          .into(),
        );
      }
      item.image_size_px = Some(Dimensions { w: width as i64, h: height as i64 });
    }
  } else {
    if base64_data_maybe.is_some() {
      return Err("Add item request has base64 data, when this is not expected.".into());
    }
  }

  let serialized_item = item.to_api_json()?;

  // ========================================================================
  // PHASE 3: Database insert with lock
  // Re-acquire lock and re-check the item doesn't already exist (in case
  // of a race condition with another request using the same item ID).
  // ========================================================================
  {
    let mut db = db.lock().await;

    // Re-check that item ID still doesn't exist (race condition guard).
    if db.item.get(&item.id).is_ok() {
      return Err(
        format!("Attempt was made to add item with id '{}', but an item with this id already exists.", item.id).into(),
      );
    }

    let item_id = item.id.clone();
    let queued_item = item.clone();
    db.item.add(item).await?;
    let mut touched_container_ids = HashSet::new();
    match queued_item.relationship_to_parent {
      RelationshipToParent::Child => {
        if let Some(container_id) = queued_item.parent_id.clone() {
          let delta = build_child_upsert_delta(&db, &queued_item)?;
          record_container_delta(&mut db, &queued_item.owner_id, &container_id, delta, &mut touched_container_ids);
        }
      }
      RelationshipToParent::Attachment => {
        if let Some(parent_id) = queued_item.parent_id.clone() {
          if let Some(container_id) = maybe_container_id_for_attachment_parent(&db, &parent_id)? {
            let mut delta = ContainerSyncDelta::default();
            add_attachment_snapshot_delta_for_parent(&db, &mut delta, &parent_id)?;
            record_container_delta(&mut db, &queued_item.owner_id, &container_id, delta, &mut touched_container_ids);
          }
        }
      }
      RelationshipToParent::NoParent => {}
    }
    let sync_ack = build_sync_ack(&db, &queued_item.owner_id, &touched_container_ids);
    debug!("Executed 'add-item' command for item '{}'.", item_id);
    drop(db);
    enqueue_item_title_index_reconcile_for_user(&queued_item.owner_id);
    if should_tag_image_item(&queued_item) {
      enqueue_image_semantic_pipeline_item_if_active(&queued_item);
    }
    enqueue_pdf_item_if_active(&queued_item);
    enqueue_document_fragment_item_if_active(&queued_item);
    return json_with_sync_ack(sync_ack, Some(serialized_item));
  }
}

async fn handle_update_item(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let mut db = db.lock().await;

  let session = match session_maybe {
    Some(session) => session,
    None => {
      return Err(format!("Session is required to update an item.").into());
    }
  };

  let deserializer = serde_json::Deserializer::from_str(json_data);
  let mut iterator = deserializer.into_iter::<serde_json::Value>();
  let item_map_maybe = iterator.next().ok_or("Update item request has no item.")??;
  let item_map = item_map_maybe.as_object().ok_or("Update item request body is not a JSON object.")?;
  let item: Item = Item::from_api_json(item_map)?;
  let old_item = db.item.get(&item.id)?.clone();

  if &old_item.owner_id != &session.user_id {
    return Err(
      format!(
        "Item owner_id '{}' mismatch with session user '{}' when updating item '{}'.",
        item.owner_id, session.user_id, item.id
      )
      .into(),
    );
  }

  db.item.update(&item).await?;
  let mut deltas_by_container = HashMap::new();
  let snapshot_required_container_ids = HashSet::new();

  let old_child_container_id = maybe_container_id_for_child_item(&old_item);
  let new_child_container_id = maybe_container_id_for_child_item(&item);

  if let Some(old_container_id) = old_child_container_id.clone() {
    if new_child_container_id.as_ref() == Some(&old_container_id) {
      merge_container_delta(&mut deltas_by_container, &old_container_id, build_child_upsert_delta(&db, &item)?);
    } else {
      let mut delta = ContainerSyncDelta::default();
      delta.add_child_delete(&old_item.id);
      merge_container_delta(&mut deltas_by_container, &old_container_id, delta);
    }
  }

  if let Some(new_container_id) = new_child_container_id.clone() {
    if old_child_container_id.as_ref() != Some(&new_container_id) {
      merge_container_delta(&mut deltas_by_container, &new_container_id, build_child_upsert_delta(&db, &item)?);
    }
  }

  let old_attachment_parent_id =
    if old_item.relationship_to_parent == RelationshipToParent::Attachment { old_item.parent_id.clone() } else { None };
  let new_attachment_parent_id =
    if item.relationship_to_parent == RelationshipToParent::Attachment { item.parent_id.clone() } else { None };

  for attachment_parent_id in [old_attachment_parent_id, new_attachment_parent_id].into_iter().flatten() {
    if let Some(container_id) = maybe_container_id_for_attachment_parent(&db, &attachment_parent_id)? {
      let mut delta = ContainerSyncDelta::default();
      add_attachment_snapshot_delta_for_parent(&db, &mut delta, &attachment_parent_id)?;
      merge_container_delta(&mut deltas_by_container, &container_id, delta);
    }
  }

  let sync_ack =
    flush_container_sync_changes(&mut db, &item.owner_id, deltas_by_container, snapshot_required_container_ids);

  let owner_id = item.owner_id.clone();
  let image_fragment_context_dependents =
    image_fragment_context_dependents_for_parent_title_change(&db, &old_item, &item)?;
  debug!("Executed 'update-item' command for item '{}'.", item.id);
  drop(db);
  enqueue_item_title_index_reconcile_for_user(&owner_id);
  if should_tag_image_item(&item) {
    enqueue_image_semantic_pipeline_item_if_active(&item);
  } else if should_tag_image_item(&old_item) {
    dequeue_image_semantic_pipeline_item_if_active(&old_item.id);
  }
  for dependent in image_fragment_context_dependents {
    enqueue_image_semantic_pipeline_item_if_active(&dependent);
  }
  if should_fragment_document_item(&item) {
    enqueue_document_fragment_item_if_active(&item);
  }

  json_with_sync_ack(sync_ack, None)
}

fn image_fragment_context_dependents_for_parent_title_change(
  db: &Db,
  old_item: &Item,
  item: &Item,
) -> InfuResult<Vec<Item>> {
  if old_item.title == item.title {
    return Ok(Vec::new());
  }

  let mut dependents = Vec::new();
  dependents.extend(db.item.get_children(&item.id)?.into_iter().filter(|child| should_tag_image_item(child)).cloned());
  dependents.extend(
    db.item.get_attachments(&item.id)?.into_iter().filter(|attachment| should_tag_image_item(attachment)).cloned(),
  );
  Ok(dependents)
}

fn should_fragment_document_item(item: &Item) -> bool {
  is_document_fragment_item(item)
}

fn detect_data_item_mime_type(item: &Item, data: &[u8]) -> String {
  let detected_mime_type = detect_mime_type(data);
  if detected_mime_type == "text/plain" {
    if let Some(extension_mime_type) =
      item.title.as_deref().and_then(mime_type_from_title_extension).filter(|mime_type| mime_type == "text/markdown")
    {
      return extension_mime_type;
    }
  }
  detected_mime_type
}

#[derive(Deserialize)]
pub struct DeleteItemRequest {
  #[serde(rename = "id")]
  pub id: String,
}

async fn handle_delete_item<'a>(
  db: &Arc<tokio::sync::Mutex<Db>>,
  object_store: Arc<object::ObjectStore>,
  image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let mut db = db.lock().await;

  let request: DeleteItemRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;

  let session = match session_maybe {
    Some(session) => session,
    None => {
      return Err(format!("Session is required to delete an item.").into());
    }
  };

  if &db.item.get(&request.id)?.owner_id != &session.user_id {
    return Err(format!("User '{}' does not own item '{}'.", session.user_id, request.id).into());
  }

  if db.item.get_children(&request.id)?.len() > 0 {
    let child_ids: Vec<&String> = db.item.get_children(&request.id)?.iter().map(|itm| &itm.id).collect();
    return Err(
      format!("Cannot delete item '{}' because it has one or more associated children: {:?}", request.id, child_ids)
        .into(),
    );
  }

  if db.item.get_attachments(&request.id)?.len() > 0 {
    let attachment_ids: Vec<&String> = db.item.get_attachments(&request.id)?.iter().map(|itm| &itm.id).collect();
    return Err(
      format!(
        "Cannot delete item '{}' because it has one or more associated attachments: {:?}",
        request.id, attachment_ids
      )
      .into(),
    );
  }

  let data_dir = db.item.data_dir().to_owned();
  let item = db.item.get(&request.id)?.clone();
  let old_child_container_id = maybe_container_id_for_child_item(&item);
  let old_attachment_parent_id =
    if item.relationship_to_parent == RelationshipToParent::Attachment { item.parent_id.clone() } else { None };
  dequeue_image_semantic_pipeline_item_if_active(&request.id);
  dequeue_pdf_item_if_active(&request.id);
  dequeue_document_fragment_item_if_active(&request.id);

  if is_image_item(&item) {
    let num_removed = storage_cache::delete_all(image_cache, &session.user_id, &request.id).await?;
    debug!("Deleted all {} entries related to item '{}' from image cache.", num_removed, request.id);
  }

  if is_data_item_type(item.item_type) {
    object::delete(object_store.clone(), &session.user_id, &request.id).await?;
    debug!("Deleted item '{}' from object store.", request.id);
  }

  delete_item_text_dir(&data_dir, &session.user_id, &request.id).await?;
  delete_item_image_tag_dir(&data_dir, &session.user_id, &request.id).await?;
  delete_item_geo_artifacts(&data_dir, &session.user_id, &request.id).await?;
  delete_item_fragment_artifacts(&data_dir, &session.user_id, &request.id).await?;
  let deleted_index_fragments = delete_item_fragment_index_entries(&data_dir, &session.user_id, &request.id).await?;
  if deleted_index_fragments > 0 {
    debug!("Deleted {} fragment index row(s) for item '{}'.", deleted_index_fragments, request.id);
  }

  let _item = db.item.remove(&request.id).await?;
  let mut deltas_by_container = HashMap::new();
  let snapshot_required_container_ids = HashSet::new();
  if let Some(container_id) = old_child_container_id {
    let mut delta = ContainerSyncDelta::default();
    delta.add_child_delete(&item.id);
    merge_container_delta(&mut deltas_by_container, &container_id, delta);
  }
  if let Some(parent_id) = old_attachment_parent_id {
    if let Some(container_id) = maybe_container_id_for_attachment_parent(&db, &parent_id)? {
      let mut delta = ContainerSyncDelta::default();
      add_attachment_snapshot_delta_for_parent(&db, &mut delta, &parent_id)?;
      merge_container_delta(&mut deltas_by_container, &container_id, delta);
    }
  }
  let sync_ack =
    flush_container_sync_changes(&mut db, &item.owner_id, deltas_by_container, snapshot_required_container_ids);
  let owner_id = item.owner_id.clone();
  debug!("Deleted item '{}' from database.", request.id);
  drop(db);
  enqueue_item_title_index_reconcile_for_user(&owner_id);

  json_with_sync_ack(sync_ack, None)
}

async fn handle_empty_trash<'a>(
  db: &Arc<tokio::sync::Mutex<Db>>,
  object_store: Arc<object::ObjectStore>,
  image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let mut db = db.lock().await;

  let session = match session_maybe {
    Some(session) => session,
    None => {
      return Err(format!("A session is required to empty trash.").into());
    }
  };

  let trash_page_id;
  {
    let user = db.user.get(&session.user_id).ok_or(format!("user not found").as_str())?;
    trash_page_id = user.trash_page_id.clone();
  }

  let mut count = 0;
  let mut img_cache_count = 0;
  let mut object_count = 0;
  let mut touched_container_ids = HashSet::new();
  delete_recursive(
    &mut db,
    object_store,
    image_cache,
    &session.user_id,
    trash_page_id,
    false,
    &mut count,
    &mut img_cache_count,
    &mut object_count,
    &mut touched_container_ids,
  )
  .await?;
  let sync_ack = build_sync_ack(&db, &session.user_id, &touched_container_ids);
  let user_id = session.user_id.clone();
  drop(db);
  enqueue_item_title_index_reconcile_for_user(&user_id);

  let mut result = serde_json::Map::new();
  result.insert("itemCount".to_owned(), Value::Number(count.into()));
  result.insert("imageCacheCount".to_owned(), Value::Number(img_cache_count.into()));
  result.insert("objectCount".to_owned(), Value::Number(object_count.into()));
  insert_sync_ack(&mut result, sync_ack)?;

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
  object_count: &mut u64,
  touched_container_ids: &mut HashSet<Uid>,
) -> InfuResult<()> {
  for attachment_id in db.item.get_attachment_ids(&item_id)? {
    delete_recursive(
      db,
      object_store.clone(),
      image_cache.clone(),
      user_id,
      attachment_id,
      true,
      count,
      img_cache_count,
      object_count,
      touched_container_ids,
    )
    .await?;
  }
  for child_id in db.item.get_children_ids(&item_id)? {
    delete_recursive(
      db,
      object_store.clone(),
      image_cache.clone(),
      user_id,
      child_id,
      true,
      count,
      img_cache_count,
      object_count,
      touched_container_ids,
    )
    .await?;
  }

  if delete_item {
    let data_dir = db.item.data_dir().to_owned();
    let item = db.item.get(&item_id)?.clone();
    let old_child_container_id = maybe_container_id_for_child_item(&item);
    let old_attachment_parent_id =
      if item.relationship_to_parent == RelationshipToParent::Attachment { item.parent_id.clone() } else { None };
    dequeue_image_semantic_pipeline_item_if_active(&item_id);
    dequeue_pdf_item_if_active(&item_id);
    dequeue_document_fragment_item_if_active(&item_id);

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

    delete_item_text_dir(&data_dir, user_id, &item.id).await?;
    delete_item_image_tag_dir(&data_dir, user_id, &item.id).await?;
    delete_item_geo_artifacts(&data_dir, user_id, &item.id).await?;
    delete_item_fragment_artifacts(&data_dir, user_id, &item.id).await?;
    let deleted_index_fragments = delete_item_fragment_index_entries(&data_dir, user_id, &item.id).await?;
    if deleted_index_fragments > 0 {
      debug!("Deleted {} fragment index row(s) for item '{}'.", deleted_index_fragments, item.id);
    }

    let _item = db.item.remove(&item_id).await?;
    if let Some(container_id) = old_child_container_id {
      record_container_snapshot_required(db, user_id, &container_id, touched_container_ids);
    }
    if let Some(parent_id) = old_attachment_parent_id {
      if let Some(container_id) = maybe_container_id_for_attachment_parent(db, &parent_id)? {
        record_container_snapshot_required(db, user_id, &container_id, touched_container_ids);
      }
    }
    debug!("Deleted item '{}' from database.", item_id);

    *count = *count + 1;
  }

  Ok(())
}

#[derive(Deserialize, Serialize)]
pub struct SearchRequest {
  #[serde(rename = "pageId")]
  pub page_id: Option<Uid>,
  pub text: String,
  #[serde(rename = "numResults")]
  pub num_results: i64,
  #[serde(rename = "pageNum")]
  pub page_num: Option<i64>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SearchPathElement {
  #[serde(rename = "itemType")]
  item_type: String,
  title: Option<String>,
  id: Uid,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SearchResult {
  #[serde(rename = "path")]
  pub path: Vec<SearchPathElement>,
  pub score: f32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub stats: Option<SearchResultStats>,
  #[serde(rename = "fragmentMatch", skip_serializing_if = "Option::is_none")]
  pub fragment_match: Option<SearchFragmentMatch>,
  #[serde(rename = "additionalFragmentMatches", skip_serializing_if = "Vec::is_empty")]
  pub additional_fragment_matches: Vec<SearchFragmentMatch>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SearchResultStats {
  #[serde(rename = "totalChildren")]
  pub total_children: usize,
  #[serde(rename = "imageFileChildren")]
  pub image_file_children: usize,
  #[serde(rename = "totalBytes")]
  pub total_bytes: i64,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SearchFragmentMatch {
  #[serde(rename = "fragmentOrdinal")]
  pub fragment_ordinal: usize,
  #[serde(rename = "sourceKind")]
  pub source_kind: String,
  #[serde(rename = "semanticDistance", skip_serializing_if = "Option::is_none")]
  pub semantic_distance: Option<f32>,
  #[serde(rename = "lexicalScore", skip_serializing_if = "Option::is_none")]
  pub lexical_score: Option<f32>,
  pub score: f32,
  pub text: String,
  #[serde(rename = "textTruncated")]
  pub text_truncated: bool,
  #[serde(rename = "pageStart", skip_serializing_if = "Option::is_none")]
  pub page_start: Option<usize>,
  #[serde(rename = "pageEnd", skip_serializing_if = "Option::is_none")]
  pub page_end: Option<usize>,
}

#[derive(Serialize)]
pub struct SearchResponse {
  pub results: Vec<SearchResult>,
  #[serde(rename = "hasMore")]
  pub has_more: bool,
}

async fn handle_search(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = match session_maybe {
    None => return Err("Sessionless search not supported".into()),
    Some(s) => s,
  };

  let request: SearchRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;

  let full_user_search = request.page_id.is_none();
  let search_text = request.text.to_lowercase();

  let start_result = if let Some(page_num) = request.page_num { (page_num - 1) * request.num_results } else { 0 };
  let end_result = start_result + request.num_results + 1;

  let (data_dir, search_root_id) = {
    let db = db.lock().await;

    let page_id = if let Some(request_page_id) = request.page_id {
      request_page_id
    } else {
      let user = db.user.get(&session.user_id).ok_or(format!("Unknown user '{}", session.user_id))?;
      user.home_page_id.clone()
    };

    (db.item.data_dir().to_owned(), page_id)
  };

  let mut results = if full_user_search {
    let fragment_result_limit = usize::try_from(end_result.saturating_add(SEARCH_CANDIDATE_OVERFETCH).max(1))
      .map_err(|_| "Search result limit is too large.")?;
    let title_results = match title_lexical_search_results(
      db,
      &data_dir,
      &session.user_id,
      &search_root_id,
      &request.text,
      fragment_result_limit,
    )
    .await
    {
      Ok(results) => results,
      Err(e) => {
        warn!(
          "Title lexical search failed for user '{}'; falling back without title lexical results: {}",
          session.user_id, e
        );
        Vec::new()
      }
    };
    let lexical_results = match lexical_search_results(
      db,
      &data_dir,
      &session.user_id,
      &search_root_id,
      &request.text,
      fragment_result_limit,
    )
    .await
    {
      Ok(results) => results,
      Err(e) => {
        warn!(
          "Lexical fragment search failed for user '{}'; falling back without lexical fragment results: {}",
          session.user_id, e
        );
        Vec::new()
      }
    };
    let semantic_results = match semantic_search_results(
      config,
      db,
      &data_dir,
      &session.user_id,
      &search_root_id,
      &request.text,
      fragment_result_limit,
    )
    .await
    {
      Ok(results) => results,
      Err(e) => {
        warn!(
          "Semantic search failed for user '{}'; falling back without semantic fragment results: {}",
          session.user_id, e
        );
        Vec::new()
      }
    };
    let mixed = mix_search_results(title_results, lexical_results, semantic_results);
    paginate_mixed_results(mixed, start_result, end_result)
  } else {
    let mut db = db.lock().await;
    let started = Instant::now();
    let result =
      search_exact_paginated(&mut db, &search_text, search_root_id, &session.user_id, start_result, end_result);
    record_search_backend_metrics("exact", started, &result);
    result?
  };

  let has_more = results.len() > request.num_results as usize;
  if has_more {
    results.truncate(request.num_results as usize);
  }
  let serialized_results = serde_json::to_string(&SearchResponse { results, has_more })?;

  debug!("Executed 'search' command for user '{}'.", session.user_id);

  Ok(Some(serialized_results))
}

fn search_exact_paginated(
  db: &mut MutexGuard<'_, Db>,
  search_text: &str,
  page_id: Uid,
  user_id: &Uid,
  start_result: i64,
  end_result: i64,
) -> InfuResult<Vec<SearchResult>> {
  let mut results: Vec<SearchResult> = vec![];
  let mut current_path: Vec<SearchPathElement> = vec![];
  let mut current_result = 0;
  search_recursive(
    db,
    search_text,
    page_id,
    user_id,
    start_result,
    end_result,
    &mut current_path,
    &mut results,
    &mut current_result,
  )?;
  Ok(results)
}

fn record_search_backend_metrics<T>(backend: &'static str, started: Instant, result: &InfuResult<T>) {
  METRIC_SEARCH_BACKEND_DURATION_SECONDS.with_label_values(&[backend]).observe(started.elapsed().as_secs_f64());
  if result.is_err() {
    METRIC_SEARCH_BACKEND_FAILURES_TOTAL.with_label_values(&[backend]).inc();
  }
}

async fn title_lexical_search_results(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  search_root_id: &Uid,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  let started = Instant::now();
  let result = title_lexical_search_results_inner(db, data_dir, user_id, search_root_id, search_text, limit).await;
  record_search_backend_metrics("title", started, &result);
  result
}

async fn title_lexical_search_results_inner(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  search_root_id: &Uid,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  if limit == 0 || search_text.trim().is_empty() {
    return Ok(Vec::new());
  }

  if !user_item_title_lexical_index_exists(data_dir, user_id).await? {
    return Ok(Vec::new());
  }

  let title_index = open_user_item_title_lexical_index(data_dir, user_id)?;
  let Some(index_status) = title_index.rebuild_status().await? else {
    return Ok(Vec::new());
  };
  if !index_status.complete {
    return Ok(Vec::new());
  }

  let title_hits = title_index.search(search_text, limit).await?;
  if !title_hits.is_empty() {
    debug!(
      "Title lexical search top hits for user '{}': {}",
      user_id,
      title_hits
        .iter()
        .take(8)
        .map(|hit| format!("{}:{}@{:.6}", hit.item_id, hit.ordinal, hit.score))
        .collect::<Vec<_>>()
        .join(", ")
    );
  }

  let mut results = Vec::new();
  let db = db.lock().await;
  for hit in title_hits {
    if results.len() >= limit {
      break;
    }
    if let Some(mut result) = search_result_path_for_item(&db, &hit.item_id, user_id, search_root_id)? {
      let mut match_result = search_fragment_match_for_lexical_hit(&hit, search_text);
      let exact_title_score = result
        .path
        .last()
        .and_then(|element| element.title.as_deref())
        .map(|title| exact_title_search_score(title, search_text))
        .unwrap_or(0.0);
      match_result.score = match_result.score.max(exact_title_score);
      result.score = match_result.score;
      result.fragment_match = Some(match_result);
      results.push(result);
    }
  }
  Ok(results)
}

async fn lexical_search_results(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  search_root_id: &Uid,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  let started = Instant::now();
  let result = lexical_search_results_inner(db, data_dir, user_id, search_root_id, search_text, limit).await;
  record_search_backend_metrics("lexical", started, &result);
  result
}

async fn lexical_search_results_inner(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  search_root_id: &Uid,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  if limit == 0 || search_text.trim().is_empty() {
    return Ok(Vec::new());
  }

  if !user_document_fragment_lexical_index_exists(data_dir, user_id).await? {
    return Ok(Vec::new());
  }

  let lexical_index = open_user_document_fragment_lexical_index(data_dir, user_id)?;
  let Some(index_status) = lexical_index.rebuild_status().await? else {
    return Ok(Vec::new());
  };
  if !index_status.complete {
    return Ok(Vec::new());
  }

  let fragment_limit = limit.saturating_mul(SEARCH_LEXICAL_FRAGMENT_MULTIPLIER).max(limit);
  let fragment_hits = lexical_index
    .search(search_text, fragment_limit)
    .await?
    .into_iter()
    .filter(|hit| hit.source_kind != ITEM_TITLE_SOURCE_KIND)
    .collect::<Vec<_>>();
  if !fragment_hits.is_empty() {
    debug!(
      "Lexical fragment search top hits for user '{}': {}",
      user_id,
      fragment_hits
        .iter()
        .take(8)
        .map(|hit| format!("{}:{}@{:.6}", hit.item_id, hit.ordinal, hit.score))
        .collect::<Vec<_>>()
        .join(", ")
    );
  }
  let fragment_hit_groups = select_top_lexical_fragment_hits_per_item(fragment_hits, SEARCH_LEXICAL_MATCHES_PER_RESULT);

  let mut results = Vec::new();
  let db = db.lock().await;
  for hits in fragment_hit_groups {
    if results.len() >= limit {
      break;
    }
    let Some(best_hit) = hits.first() else {
      continue;
    };
    if let Some(mut result) = search_result_path_for_item(&db, &best_hit.item_id, user_id, search_root_id)? {
      let matches = hits.iter().map(|hit| search_fragment_match_for_lexical_hit(hit, search_text)).collect::<Vec<_>>();
      result.score = bm25_score_to_search_score(best_hit.score);
      result.fragment_match = matches.first().cloned();
      result.additional_fragment_matches = matches.into_iter().skip(1).collect();
      results.push(result);
    }
  }
  Ok(results)
}

async fn semantic_search_results(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  search_root_id: &Uid,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  let started = Instant::now();
  let result = semantic_search_results_inner(config, db, data_dir, user_id, search_root_id, search_text, limit).await;
  record_search_backend_metrics("semantic", started, &result);
  result
}

async fn semantic_search_results_inner(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  search_root_id: &Uid,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  if limit == 0 || search_text.trim().is_empty() {
    return Ok(Vec::new());
  }

  if !user_fragment_vector_db_exists(data_dir, user_id).await? {
    return Ok(Vec::new());
  }

  let vector_db = open_user_fragment_vector_db(data_dir, user_id, FragmentVectorDbBackend::SqliteVec)?;
  let Some(index_status) = vector_db.rebuild_status().await? else {
    return Ok(Vec::new());
  };
  if !index_status.complete {
    return Ok(Vec::new());
  }

  let Some(embed_url) = resolve_configured_gpu_tool_url(config.as_ref(), GPU_TOOL_TEXT_EMBED).await? else {
    return Ok(Vec::new());
  };
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(SEARCH_EMBEDDING_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build semantic search HTTP client: {}", e))?;
  let embedding_batch = embed_texts(
    &client,
    &embed_url,
    &[TextEmbeddingInput::retrieval_query(Some("search-query".to_owned()), search_text.to_owned())],
  )
  .await?;
  let query_embedding =
    embedding_batch.embeddings.into_iter().next().ok_or("Text embedding service returned no query embedding.")?;
  if query_embedding.is_empty() {
    return Ok(Vec::new());
  }
  validate_text_embedding_vector("Text embedding service returned query embedding", &query_embedding)?;
  debug!(
    "Semantic search query embedding for user '{}': dims={}, norm={:.6}, fingerprint={}",
    user_id,
    query_embedding.len(),
    text_embedding_vector_norm(&query_embedding),
    text_embedding_vector_fingerprint(&query_embedding)
  );

  let fragment_limit = limit.saturating_mul(SEARCH_SEMANTIC_FRAGMENT_MULTIPLIER).max(limit);
  let fragment_hits = vector_db
    .search(&query_embedding, fragment_limit)
    .await?
    .into_iter()
    .filter(|hit| !is_lexical_search_source_kind(&hit.source_kind))
    .collect::<Vec<_>>();
  if !fragment_hits.is_empty() {
    debug!(
      "Semantic search top fragment hits for user '{}': {}",
      user_id,
      fragment_hits
        .iter()
        .take(8)
        .map(|hit| format!("{}:{}@{:.6}", hit.item_id, hit.ordinal, hit.distance))
        .collect::<Vec<_>>()
        .join(", ")
    );
  }
  let fragment_hits = select_best_fragment_hit_per_item(fragment_hits);

  let mut results = Vec::new();
  let db = db.lock().await;
  for hit in fragment_hits {
    if results.len() >= limit {
      break;
    }
    if let Some(mut result) = search_result_path_for_item(&db, &hit.item_id, user_id, search_root_id)? {
      result.score = semantic_distance_to_search_score(hit.distance);
      result.fragment_match = Some(search_fragment_match_for_hit(&hit, search_text));
      results.push(result);
    }
  }
  Ok(results)
}

fn select_best_fragment_hit_per_item(fragment_hits: Vec<FragmentVectorHit>) -> Vec<FragmentVectorHit> {
  let mut best_by_item = HashMap::<String, FragmentVectorHit>::new();
  for hit in fragment_hits {
    match best_by_item.get(&hit.item_id) {
      Some(best) if best.distance <= hit.distance => {}
      _ => {
        best_by_item.insert(hit.item_id.clone(), hit);
      }
    }
  }

  let mut hits = best_by_item.into_values().collect::<Vec<_>>();
  hits.sort_by(|a, b| {
    a.distance.total_cmp(&b.distance).then_with(|| a.item_id.cmp(&b.item_id)).then_with(|| a.ordinal.cmp(&b.ordinal))
  });
  hits
}

fn select_top_lexical_fragment_hits_per_item(
  fragment_hits: Vec<FragmentLexicalHit>,
  max_hits_per_item: usize,
) -> Vec<Vec<FragmentLexicalHit>> {
  if max_hits_per_item == 0 {
    return Vec::new();
  }

  let mut hits_by_item = HashMap::<String, Vec<FragmentLexicalHit>>::new();
  for hit in fragment_hits {
    hits_by_item.entry(hit.item_id.clone()).or_default().push(hit);
  }

  let mut hit_groups = hits_by_item
    .into_values()
    .map(|mut hits| {
      hits.sort_by(|a, b| {
        b.score.total_cmp(&a.score).then_with(|| a.item_id.cmp(&b.item_id)).then_with(|| a.ordinal.cmp(&b.ordinal))
      });
      hits.truncate(max_hits_per_item);
      hits
    })
    .collect::<Vec<_>>();
  hit_groups.sort_by(|a, b| {
    let a = a.first();
    let b = b.first();
    match (a, b) {
      (Some(a), Some(b)) => {
        b.score.total_cmp(&a.score).then_with(|| a.item_id.cmp(&b.item_id)).then_with(|| a.ordinal.cmp(&b.ordinal))
      }
      (None, Some(_)) => std::cmp::Ordering::Greater,
      (Some(_), None) => std::cmp::Ordering::Less,
      (None, None) => std::cmp::Ordering::Equal,
    }
  });
  hit_groups.into_iter().filter(|hits| !hits.is_empty()).collect()
}

fn search_result_path_for_item(
  db: &MutexGuard<'_, Db>,
  item_id: &Uid,
  user_id: &Uid,
  search_root_id: &Uid,
) -> InfuResult<Option<SearchResult>> {
  let target_item = match db.item.get(item_id) {
    Ok(item) => item,
    Err(_) => return Ok(None),
  };
  if &target_item.owner_id != user_id || target_item.item_type == ItemType::Password {
    return Ok(None);
  }
  let stats = search_result_stats_for_item(db, target_item)?;

  let mut path = Vec::new();
  let mut current_id = item_id.clone();
  let mut seen = HashSet::new();

  loop {
    if !seen.insert(current_id.clone()) {
      return Err(format!("Cycle detected while building search path for item '{}'.", item_id).into());
    }
    let item = match db.item.get(&current_id) {
      Ok(item) => item,
      Err(_) => return Ok(None),
    };
    if &item.owner_id != user_id || item.item_type == ItemType::Password {
      return Ok(None);
    }
    path.push(SearchPathElement {
      item_type: item.item_type.as_str().to_owned(),
      title: item.title.clone(),
      id: item.id.clone(),
    });

    let Some(parent_id) = item.parent_id.clone() else {
      break;
    };
    current_id = parent_id;
  }

  path.reverse();
  if !search_result_is_under_root_path(&path, search_root_id) {
    return Ok(None);
  }
  Ok(Some(SearchResult { path, score: 0.0, stats, fragment_match: None, additional_fragment_matches: Vec::new() }))
}

fn search_result_stats_for_item(db: &Db, item: &Item) -> InfuResult<Option<SearchResultStats>> {
  if !is_container_item_type(item.item_type) {
    return Ok(None);
  }

  let children = db.item.get_children(&item.id)?;
  let mut stats = SearchResultStats { total_children: children.len(), image_file_children: 0, total_bytes: 0 };

  for child in children {
    if is_image_item(child) || is_data_item_type(child.item_type) {
      stats.image_file_children += 1;
      stats.total_bytes = stats.total_bytes.saturating_add(child.file_size_bytes.unwrap_or(0).max(0));
    }
  }

  Ok(Some(stats))
}

fn search_result_is_under_root_path(path: &[SearchPathElement], search_root_id: &Uid) -> bool {
  path.first().is_some_and(|element| &element.id == search_root_id)
}

#[derive(Clone)]
struct SearchMergeCandidate {
  result: SearchResult,
  rank_score: f64,
  best_rank: usize,
}

fn mix_search_results(
  title_results: Vec<SearchResult>,
  lexical_results: Vec<SearchResult>,
  semantic_results: Vec<SearchResult>,
) -> Vec<SearchResult> {
  let mut candidates: HashMap<Uid, SearchMergeCandidate> = HashMap::new();

  add_ranked_search_results(&mut candidates, title_results, SEARCH_TITLE_LEXICAL_WEIGHT);
  add_ranked_search_results(&mut candidates, lexical_results, SEARCH_LEXICAL_WEIGHT);
  add_ranked_search_results(&mut candidates, semantic_results, SEARCH_SEMANTIC_WEIGHT);

  let mut candidates = candidates.into_values().collect::<Vec<_>>();
  candidates.sort_by(|a, b| {
    b.rank_score
      .partial_cmp(&a.rank_score)
      .unwrap_or(std::cmp::Ordering::Equal)
      .then_with(|| a.best_rank.cmp(&b.best_rank))
      .then_with(|| search_result_item_id(&a.result).cmp(&search_result_item_id(&b.result)))
  });
  let max_rank_score = candidates.first().map(|candidate| candidate.rank_score).unwrap_or(0.0);
  candidates
    .into_iter()
    .map(|mut candidate| {
      candidate.result.score = merged_rank_score_to_search_score(candidate.rank_score, max_rank_score);
      candidate.result
    })
    .collect()
}

fn add_ranked_search_results(
  candidates: &mut HashMap<Uid, SearchMergeCandidate>,
  results: Vec<SearchResult>,
  weight: f64,
) {
  for (rank, result) in results.into_iter().enumerate() {
    let Some(item_id) = search_result_item_id(&result) else {
      continue;
    };
    let fragment_match = result.fragment_match.clone();
    let additional_fragment_matches = result.additional_fragment_matches.clone();
    let rank_score = weight / (SEARCH_RRF_K + rank as f64 + 1.0);
    let entry = candidates.entry(item_id).or_insert_with(|| SearchMergeCandidate {
      result: result.clone(),
      rank_score: 0.0,
      best_rank: rank,
    });
    let should_replace_fragment_result = rank < entry.best_rank;
    entry.rank_score += rank_score;
    entry.best_rank = entry.best_rank.min(rank);
    if should_replace_fragment_result {
      entry.result = result;
    } else if entry.result.fragment_match.is_none() {
      entry.result.fragment_match = fragment_match;
      entry.result.additional_fragment_matches = additional_fragment_matches;
    }
  }
}

fn paginate_mixed_results(results: Vec<SearchResult>, start_result: i64, end_result: i64) -> Vec<SearchResult> {
  let start = usize::try_from(start_result.max(0)).unwrap_or(0);
  let take = usize::try_from(end_result.saturating_sub(start_result).max(0)).unwrap_or(0);
  results.into_iter().skip(start).take(take).collect()
}

fn search_result_item_id(result: &SearchResult) -> Option<Uid> {
  result.path.last().map(|element| element.id.clone())
}

fn clamp_search_score(score: f32) -> f32 {
  if score.is_finite() { score.clamp(0.0, 1.0) } else { 0.0 }
}

fn merged_rank_score_to_search_score(rank_score: f64, max_rank_score: f64) -> f32 {
  if !rank_score.is_finite() || !max_rank_score.is_finite() || rank_score <= 0.0 || max_rank_score <= 0.0 {
    return 0.0;
  }
  clamp_search_score((rank_score / max_rank_score) as f32)
}

fn semantic_distance_to_search_score(distance: f32) -> f32 {
  clamp_search_score(1.0 - distance)
}

fn bm25_score_to_search_score(score: f32) -> f32 {
  if score <= 0.0 {
    return 0.0;
  }
  clamp_search_score(score / (score + SEARCH_BM25_SCORE_SATURATION))
}

fn exact_title_search_score(title: &str, search_text: &str) -> f32 {
  let query = search_text.trim().to_lowercase();
  if query.is_empty() {
    return 0.0;
  }

  let title = title.trim().to_lowercase();
  if title == query {
    return 1.0;
  }
  if title.split_whitespace().any(|term| term == query) {
    return 0.95;
  }
  if title.starts_with(&query) {
    return 0.9;
  }

  let title_chars = title.chars().count().max(1) as f32;
  let query_chars = query.chars().count() as f32;
  clamp_search_score(0.65 + 0.25 * (query_chars / title_chars).min(1.0)).min(0.89)
}

fn search_fragment_match_for_lexical_hit(hit: &FragmentLexicalHit, search_text: &str) -> SearchFragmentMatch {
  let (text, text_truncated) =
    search_match_excerpt(&hit.source_kind, &hit.text, search_text, SEARCH_FRAGMENT_MATCH_MAX_CHARS);
  SearchFragmentMatch {
    fragment_ordinal: hit.ordinal,
    source_kind: hit.source_kind.clone(),
    semantic_distance: None,
    lexical_score: Some(hit.score),
    score: bm25_score_to_search_score(hit.score),
    text,
    text_truncated,
    page_start: hit.page_start,
    page_end: hit.page_end,
  }
}

fn search_fragment_match_for_hit(
  hit: &crate::ai::vector_db::FragmentVectorHit,
  search_text: &str,
) -> SearchFragmentMatch {
  let (text, text_truncated) =
    search_match_excerpt(&hit.source_kind, &hit.text, search_text, SEARCH_FRAGMENT_MATCH_MAX_CHARS);
  SearchFragmentMatch {
    fragment_ordinal: hit.ordinal,
    source_kind: hit.source_kind.clone(),
    semantic_distance: Some(hit.distance),
    lexical_score: None,
    score: semantic_distance_to_search_score(hit.distance),
    text,
    text_truncated,
    page_start: hit.page_start,
    page_end: hit.page_end,
  }
}

fn search_match_excerpt(source_kind: &str, text: &str, search_text: &str, max_chars: usize) -> (String, bool) {
  let display_text = fragment_display_text(source_kind, text);
  if display_text.is_empty() {
    return (String::new(), false);
  }

  let query_terms = normalized_search_terms(search_text);
  let sentence_candidates = split_sentence_segments(&display_text);
  let mut selected_sentences = sentence_candidates
    .iter()
    .filter(|sentence| sentence_matches_query_terms(sentence, &query_terms))
    .take(SEARCH_MATCH_SNIPPET_MAX_SENTENCES)
    .cloned()
    .collect::<Vec<_>>();

  if selected_sentences.is_empty() {
    selected_sentences = sentence_candidates.into_iter().take(SEARCH_MATCH_SNIPPET_MAX_SENTENCES).collect();
  }

  let selected_windows = selected_sentences
    .iter()
    .map(|sentence| search_snippet_sentence_window(sentence, &query_terms))
    .filter(|sentence| !sentence.is_empty())
    .collect::<Vec<_>>();

  let excerpt = ellipsis_sentence_excerpt(&selected_windows);
  clamp_text_chars(&excerpt, max_chars)
}

fn fragment_display_text(source_kind: &str, text: &str) -> String {
  let lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
  let display_lines = if is_markdown_document_source_kind(source_kind) {
    lines.filter(|line| !is_pdf_catalog_omitted_line(line)).collect::<Vec<_>>()
  } else {
    lines.collect::<Vec<_>>()
  };
  display_lines.join("\n")
}

fn is_pdf_catalog_omitted_line(line: &str) -> bool {
  let Some((label, _)) = line.split_once(':') else {
    return false;
  };
  PDF_CATALOG_OMITTED_LABELS.iter().any(|omitted| label.trim().eq_ignore_ascii_case(omitted))
}

fn split_sentence_segments(text: &str) -> Vec<String> {
  let mut segments = Vec::new();
  let mut start = 0;
  let mut chars = text.char_indices().peekable();
  while let Some((idx, ch)) = chars.next() {
    if ch == '\n' {
      push_sentence_segment(&mut segments, &text[start..idx]);
      start = idx + ch.len_utf8();
      continue;
    }
    let is_sentence_end = matches!(ch, '.' | '!' | '?')
      && chars
        .peek()
        .map(|(_, next_ch)| next_ch.is_whitespace() || matches!(next_ch, '"' | '\'' | ')' | ']'))
        .unwrap_or(true);
    if is_sentence_end {
      let end = idx + ch.len_utf8();
      push_sentence_segment(&mut segments, &text[start..end]);
      start = end;
    }
  }
  if start < text.len() {
    push_sentence_segment(&mut segments, &text[start..]);
  }
  if segments.is_empty() {
    push_sentence_segment(&mut segments, text);
  }
  segments
}

fn push_sentence_segment(segments: &mut Vec<String>, segment: &str) {
  let cleaned = trim_snippet_sentence_punctuation(&collapse_whitespace(segment));
  if !cleaned.is_empty() {
    segments.push(cleaned);
  }
}

fn trim_snippet_sentence_punctuation(segment: &str) -> String {
  segment.trim_end_matches(['.', '!', '?']).trim_end().to_owned()
}

fn ellipsis_sentence_excerpt(sentences: &[String]) -> String {
  if sentences.is_empty() {
    return String::new();
  }
  format!(
    "{} {} {}",
    SEARCH_SNIPPET_ELLIPSIS,
    sentences.join(&format!(" {} ", SEARCH_SNIPPET_ELLIPSIS)),
    SEARCH_SNIPPET_ELLIPSIS
  )
}

fn search_snippet_sentence_window(sentence: &str, query_terms: &[String]) -> String {
  let sentence = sentence.trim();
  let total_chars = sentence.chars().count();
  if total_chars <= SEARCH_MATCH_SNIPPET_MAX_SENTENCE_CHARS {
    return sentence.to_owned();
  }

  let match_range = first_query_term_match_char_range(sentence, query_terms);
  let match_start = match_range.map(|(start, _)| start).unwrap_or(0);
  let match_end = match_range.map(|(_, end)| end).unwrap_or(match_start);
  let mut start = match_start.saturating_sub(SEARCH_MATCH_SNIPPET_CONTEXT_BEFORE_CHARS);
  let mut end = (start + SEARCH_MATCH_SNIPPET_MAX_SENTENCE_CHARS).min(total_chars);
  if end == total_chars {
    start = end.saturating_sub(SEARCH_MATCH_SNIPPET_MAX_SENTENCE_CHARS);
  }
  start = adjust_window_start_to_word_boundary(sentence, start, match_start);
  end = adjust_window_end_to_word_boundary(sentence, end, match_end, total_chars);

  let start_byte = byte_index_at_char(sentence, start);
  let end_byte = byte_index_at_char(sentence, end);
  trim_snippet_sentence_punctuation(&collapse_whitespace(&sentence[start_byte..end_byte]))
}

fn first_query_term_match_char_range(text: &str, query_terms: &[String]) -> Option<(usize, usize)> {
  if query_terms.is_empty() {
    return None;
  }

  let mut current = String::new();
  let mut current_start_char = 0;
  for (char_idx, ch) in text.chars().enumerate() {
    if ch.is_alphanumeric() {
      if current.is_empty() {
        current_start_char = char_idx;
      }
      current.extend(ch.to_lowercase());
    } else if !current.is_empty() {
      let stem = light_stem_search_term(&current);
      if query_terms.iter().any(|term| term == &stem) {
        return Some((current_start_char, char_idx));
      }
      current.clear();
    }
  }

  if !current.is_empty() {
    let total_chars = text.chars().count();
    let stem = light_stem_search_term(&current);
    if query_terms.iter().any(|term| term == &stem) {
      return Some((current_start_char, total_chars));
    }
  }
  None
}

fn adjust_window_start_to_word_boundary(text: &str, start_char: usize, match_start_char: usize) -> usize {
  if start_char == 0 {
    return start_char;
  }

  text
    .chars()
    .enumerate()
    .skip(start_char)
    .take(match_start_char.saturating_sub(start_char))
    .find_map(|(idx, ch)| {
      if idx.saturating_sub(start_char) <= SEARCH_MATCH_SNIPPET_BOUNDARY_SLOP_CHARS && ch.is_whitespace() {
        Some(idx + 1)
      } else {
        None
      }
    })
    .unwrap_or(start_char)
}

fn adjust_window_end_to_word_boundary(text: &str, end_char: usize, match_end_char: usize, total_chars: usize) -> usize {
  if end_char >= total_chars {
    return end_char;
  }

  text
    .chars()
    .enumerate()
    .skip(match_end_char)
    .take(end_char.saturating_sub(match_end_char))
    .filter_map(|(idx, ch)| {
      if end_char.saturating_sub(idx) <= SEARCH_MATCH_SNIPPET_BOUNDARY_SLOP_CHARS && ch.is_whitespace() {
        Some(idx)
      } else {
        None
      }
    })
    .last()
    .unwrap_or(end_char)
}

fn byte_index_at_char(text: &str, char_idx: usize) -> usize {
  if char_idx == 0 {
    return 0;
  }
  text.char_indices().nth(char_idx).map(|(idx, _)| idx).unwrap_or(text.len())
}

fn normalized_search_terms(search_text: &str) -> Vec<String> {
  let mut raw_terms = tokenize_search_text(search_text)
    .into_iter()
    .map(|term| light_stem_search_term(&term))
    .filter(|term| !term.is_empty())
    .collect::<Vec<_>>();
  raw_terms.sort();
  raw_terms.dedup();

  let mut meaningful_terms = raw_terms
    .iter()
    .filter(|term| term.len() > 1 && !SEARCH_SNIPPET_STOP_WORDS.contains(&term.as_str()))
    .cloned()
    .collect::<Vec<_>>();
  if meaningful_terms.is_empty() {
    meaningful_terms = raw_terms;
  }
  meaningful_terms
}

fn sentence_matches_query_terms(sentence: &str, query_terms: &[String]) -> bool {
  if query_terms.is_empty() {
    return false;
  }
  let sentence_terms =
    tokenize_search_text(sentence).into_iter().map(|term| light_stem_search_term(&term)).collect::<HashSet<_>>();
  query_terms.iter().any(|term| sentence_terms.contains(term))
}

fn tokenize_search_text(text: &str) -> Vec<String> {
  let mut terms = Vec::new();
  let mut current = String::new();
  for ch in text.chars() {
    if ch.is_alphanumeric() {
      current.extend(ch.to_lowercase());
    } else if !current.is_empty() {
      terms.push(std::mem::take(&mut current));
    }
  }
  if !current.is_empty() {
    terms.push(current);
  }
  terms
}

fn light_stem_search_term(term: &str) -> String {
  let mut stem = term.to_owned();
  if stem.len() > 5 && stem.ends_with("ies") {
    stem.truncate(stem.len() - 3);
    stem.push('y');
  } else if stem.len() > 5 && stem.ends_with("ing") {
    stem.truncate(stem.len() - 3);
    remove_doubled_trailing_consonant(&mut stem);
  } else if stem.len() > 4 && stem.ends_with("ed") {
    stem.truncate(stem.len() - 2);
    remove_doubled_trailing_consonant(&mut stem);
  } else if stem.len() > 4
    && (stem.ends_with("ches") || stem.ends_with("shes") || stem.ends_with("sses") || stem.ends_with("xes"))
  {
    stem.truncate(stem.len() - 2);
  } else if stem.len() > 3 && stem.ends_with('s') {
    stem.truncate(stem.len() - 1);
  }
  stem
}

fn remove_doubled_trailing_consonant(term: &mut String) {
  let mut chars = term.chars().rev();
  let Some(last) = chars.next() else {
    return;
  };
  let Some(previous) = chars.next() else {
    return;
  };
  if last == previous && !"aeiou".contains(last) {
    term.truncate(term.len() - last.len_utf8());
  }
}

fn collapse_whitespace(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clamp_text_chars(text: &str, max_chars: usize) -> (String, bool) {
  let mut chars = text.chars();
  let clamped = chars.by_ref().take(max_chars).collect::<String>();
  (clamped, chars.next().is_some())
}

fn search_recursive(
  db: &mut MutexGuard<'_, Db>,
  search_text: &str,
  item_id: Uid,
  user_id: &Uid,
  start_result: i64,
  end_result: i64,
  current_path: &mut Vec<SearchPathElement>,
  results: &mut Vec<SearchResult>,
  current_result: &mut i64,
) -> InfuResult<()> {
  if results.len() >= (end_result - start_result) as usize {
    return Ok(());
  }

  {
    let item = db.item.get(&item_id)?;
    if &item.owner_id != user_id {
      return Ok(());
    } // paranoid.
    if item.item_type != ItemType::Password {
      match &item.title {
        None => {}
        Some(title) => {
          if title.to_lowercase().contains(search_text) {
            if *current_result >= start_result && *current_result < end_result {
              let mut path: Vec<SearchPathElement> = current_path.iter().map(|a| (*a).clone()).collect();
              path.push(SearchPathElement {
                item_type: item.item_type.as_str().to_owned(),
                title: item.title.to_owned(),
                id: item.id.to_owned(),
              });
              let stats = search_result_stats_for_item(db, item)?;
              results.push(SearchResult {
                path,
                score: exact_title_search_score(title, search_text),
                stats,
                fragment_match: None,
                additional_fragment_matches: Vec::new(),
              });
            }
            *current_result += 1;
            if results.len() >= (end_result - start_result) as usize {
              return Ok(());
            }
          }
        }
      };
    }

    current_path.push(SearchPathElement {
      item_type: item.item_type.as_str().to_owned(),
      title: item.title.clone(),
      id: item.id.clone(),
    });
  }

  let child_ids = db.item.get_children_ids(&item_id)?;
  for child_id in child_ids {
    search_recursive(
      db,
      search_text,
      child_id,
      user_id,
      start_result,
      end_result,
      current_path,
      results,
      current_result,
    )?;
    if results.len() >= (end_result - start_result) as usize {
      return Ok(());
    }
  }

  let attachment_ids = db.item.get_attachment_ids(&item_id)?;
  for attachment_id in attachment_ids {
    search_recursive(
      db,
      search_text,
      attachment_id,
      user_id,
      start_result,
      end_result,
      current_path,
      results,
      current_result,
    )?;
    if results.len() >= (end_result - start_result) as usize {
      return Ok(());
    }
  }

  current_path.pop();

  Ok(())
}
