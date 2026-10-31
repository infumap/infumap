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

use super::*;
use crate::ai::document_pipeline::requeue_document_fragment_item_now;
use crate::ai::fragment_indexing::enqueue_fragment_lexical_index_update;
use crate::ai::image_pipeline::requeue_image_background_pipeline_item_now;
use crate::ai::text_extraction::{MAX_PDF_CONVERSION_TIMEOUT_SECS, requeue_pdf_item_now};

#[derive(Deserialize)]
pub struct GetAttachmentsRequest {
  #[serde(rename = "parentId")]
  pub parent_id_maybe: Option<String>,
}

pub(super) async fn handle_get_attachments(
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

pub(super) async fn handle_add_item(
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

pub(super) async fn handle_add_link_note(
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

  let title_len = title.encode_utf16().count();
  let item_json = serde_json::json!({
    "itemType": "note",
    "title": title,
    "urls": [{
      "start": 0,
      "end": title_len,
      "url": normalized_url_str,
    }],
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
  add_item_for_user_with_mime_type(db, object_store, json_data, base64_data_maybe, session_user_id, None).await
}

/// Adds an item as `add_item_for_user` does. A data item gets `mime_type` if given, rather than one detected from its
/// data, for formats detection cannot tell apart, such as a chat transcript (JSONL, which detects as text/plain).
pub(super) async fn add_item_for_user_with_mime_type(
  db: &Arc<tokio::sync::Mutex<Db>>,
  object_store: Arc<object::ObjectStore>,
  json_data: &str,
  base64_data_maybe: &Option<String>,
  session_user_id: &str,
  mime_type: Option<&str>,
) -> InfuResult<Option<String>> {
  let upload_started = Instant::now();
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

    if item_type == ItemType::Divider.as_str() {
      if !item_map.contains_key("dividerDirection") {
        item_map.insert("dividerDirection".to_owned(), Value::String("horizontal".to_owned()));
      }
      if !item_map.contains_key("spatialWidthGr") {
        item_map.insert("spatialWidthGr".to_owned(), Value::Number((4 * GRID_SIZE).into()));
      }
      if !item_map.contains_key("spatialHeightGr") {
        item_map.insert("spatialHeightGr".to_owned(), Value::Number(GRID_SIZE.into()));
      }
    }

    // Temporary placeholder so item parsing succeeds before server-side MIME detection overwrites it.
    if is_data_item_type(ItemType::from_str(&item_type)?) && !item_map.contains_key("mimeType") {
      item_map.insert("mimeType".to_owned(), Value::String("application/octet-stream".to_owned()));
    }

    if item_type == ItemType::Note.as_str() && !item_map.contains_key("inlineMarks") {
      item_map.insert("inlineMarks".to_owned(), Value::Array(vec![]));
    }

    if item_type == ItemType::Note.as_str() && !item_map.contains_key("urls") {
      let title = json::get_string_field(&item_map, "title")?.unwrap_or_default();
      let legacy_url = json::get_string_field(&item_map, "url")?.unwrap_or_default();
      let urls = if !title.is_empty() && !legacy_url.trim().is_empty() {
        serde_json::json!([{ "start": 0, "end": title.encode_utf16().count(), "url": legacy_url }])
      } else {
        Value::Array(vec![])
      };
      item_map.insert("urls".to_owned(), urls);
      item_map.remove("url");
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
    validate_group_id_for_item(&db, &item)?;
    validate_composite_parent_for_item(&db, &item)?;
    validate_link_target_for_item(&db, &item)?;

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
  let validation_ms = upload_started.elapsed().as_millis();
  let mut decode_ms = 0;
  let mut storage_ms = 0;
  let mut image_ms = 0;

  // ========================================================================
  // PHASE 2: I/O Operations without database lock
  // These can be slow (especially object::put for large files) so we don't
  // hold the lock during these operations.
  // ========================================================================
  if is_data_item_type(item.item_type) {
    let decode_started = Instant::now();
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
    item.mime_type = Some(mime_type.map(str::to_owned).unwrap_or_else(|| detect_data_item_mime_type(&item, &decoded)));
    decode_ms = decode_started.elapsed().as_millis();
    let object_encryption_key = object_encryption_key_maybe
      .as_ref()
      .ok_or("Internal error: encryption key should have been set for data item.")?;

    // Images are validated before their data is stored, so one that can't be decoded doesn't leave an orphaned
    // object behind.
    let decoded = if is_image_item(&item) {
      let image_started = Instant::now();
      let title = match &item.title {
        Some(title) => title,
        None => {
          return Err(format!("Image item '{}' has no title set.", item.id).into());
        }
      };
      // Decoding is CPU intensive, so is done on a blocking thread. The permit is moved into the task so it is
      // held until the work completes, even if this request future is dropped.
      let permit = IMAGE_PROCESSING_SEMAPHORE
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| format!("Image processing semaphore closed: {}", e))?;
      let item_id = item.id.clone();
      let title = title.clone();
      let (width, height, placeholder, decoded) =
        tokio::task::spawn_blocking(move || -> InfuResult<(u32, u32, Vec<u8>, Vec<u8>)> {
          let _permit = permit;
          // TODO (LOW): clone here seems a bit excessive.
          let exif_orientation = get_exif_orientation(decoded.clone(), &title);
          let file_reader = ImageReader::new(Cursor::new(decoded.as_slice())).with_guessed_format()?;
          let img = file_reader.decode().ok().ok_or(format!(
            "Could not add new image item '{}' - could not interpret base64 data as an image.",
            item_id
          ))?;
          let img = adjust_image_for_exif_orientation(img, exif_orientation, &title);
          let placeholder = create_image_placeholder(&img)
            .map_err(|e| format!("An error occurred creating the placeholder for new image '{}': {}.", item_id, e))?;
          Ok((img.width(), img.height(), placeholder, decoded))
        })
        .await
        .map_err(|e| format!("Image processing task for new image '{}' failed: {}", item.id, e))??;

      let thumbnail_base64 = general_purpose::STANDARD.encode(placeholder);
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
      image_ms = image_started.elapsed().as_millis();
      decoded
    } else {
      decoded
    };

    let storage_started = Instant::now();
    object::put(object_store.clone(), &session_user_id, &item.id, &decoded, object_encryption_key).await?;
    storage_ms = storage_started.elapsed().as_millis();
  } else {
    if base64_data_maybe.is_some() {
      return Err("Add item request has base64 data, when this is not expected.".into());
    }
  }

  let serialized_item = item.to_api_json()?;
  let database_started = Instant::now();

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
    enqueue_item_title_index_update(&queued_item.owner_id, &queued_item.id);
    if should_tag_image_item(&queued_item) {
      enqueue_image_background_pipeline_item_if_active(&queued_item);
    }
    enqueue_pdf_item_if_active(&queued_item);
    enqueue_document_fragment_item_if_active(&queued_item);
    if is_data_item_type(queued_item.item_type) {
      info!(
        "Upload item '{}' completed: validation={} ms, decode={} ms, storage={} ms, image={} ms, database={} ms, total={} ms",
        item_id,
        validation_ms,
        decode_ms,
        storage_ms,
        image_ms,
        database_started.elapsed().as_millis(),
        upload_started.elapsed().as_millis()
      );
    }
    return json_with_sync_ack(sync_ack, Some(serialized_item));
  }
}

/// Sets an item's title, only if it is still `expected_title`, so a title someone set meanwhile is kept. Syncs and
/// reindexes like `update-item`. Returns the item's title afterwards.
pub(super) async fn set_item_title_if_unchanged(
  db: &Arc<tokio::sync::Mutex<Db>>,
  user_id: &Uid,
  item_id: &Uid,
  expected_title: &str,
  title: &str,
) -> InfuResult<String> {
  let mut db = db.lock().await;
  let mut item = db.item.get(item_id)?.clone();
  if &item.owner_id != user_id {
    return Err(format!("User '{}' does not own item '{}'.", user_id, item_id).into());
  }
  let current = item.title.clone().unwrap_or_default();
  if current != expected_title {
    return Ok(current);
  }
  item.title = Some(title.to_owned());
  db.item.update(&item).await?;
  let mut deltas_by_container = HashMap::new();
  if let Some(container_id) = maybe_container_id_for_child_item(&item) {
    merge_container_delta(&mut deltas_by_container, &container_id, build_child_upsert_delta(&db, &item)?);
  }
  flush_container_sync_changes(&mut db, user_id, deltas_by_container, HashSet::new());
  drop(db);
  enqueue_item_title_index_update(user_id, item_id);
  Ok(title.to_owned())
}

pub(super) async fn handle_update_item(
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
  if search_status_page_kind_for_id(&session.user_id, &item.id).is_some() {
    return Err(format!("Virtual search status page '{}' cannot be updated.", item.id).into());
  }
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
  if (is_queries_page_item(&db, &old_item) || is_queries_page_item(&db, &item))
    && !queries_page_arrange_algorithm_allowed(&item)
  {
    return Err(format!("Queries page '{}' must use list arrangement.", item.id).into());
  }
  let chat_moved_to_trash = is_chat_moved_to_trash(&db, &old_item, &item);
  let chat_restored_from_trash = is_chat_restored_from_trash(&db, &old_item, &item);
  if chat_moved_to_trash && chat::chat_turn_running(&session.user_id, &item.id) {
    return Err(format!("Chat '{}' cannot be deleted while a response is running.", item.id).into());
  }
  if is_query_item_moved_from_trash_elsewhere(&db, &old_item, &item) {
    return Err(format!("Query item '{}' can only be restored from the trash to the Queries page.", item.id).into());
  }
  let chat_trash_move = chat_moved_to_trash || chat_restored_from_trash;
  if !chat_trash_move
    && (is_queries_page_query_item(&db, &old_item) || is_queries_page_query_item(&db, &item))
    && item_move_fields_changed_to_disallowed_layout(&old_item, &item)
  {
    return Err(format!("Queries page query item '{}' cannot be moved.", item.id).into());
  }
  if !chat_trash_move
    && (is_queries_page_query_item(&db, &old_item) || is_queries_page_query_item(&db, &item))
    && item_resize_fields_changed_to_disallowed_layout(&old_item, &item)
  {
    return Err(format!("Queries page query item '{}' cannot be resized.", item.id).into());
  }
  if is_scopes_page_item(&old_item) && scopes_page_update_disallowed(&old_item, &item) {
    return Err(format!("Scopes page '{}' cannot be moved, converted or unpinned.", item.id).into());
  }
  validate_group_id_for_item(&db, &item)?;
  if old_item.parent_id != item.parent_id || old_item.relationship_to_parent != item.relationship_to_parent {
    validate_composite_parent_for_item(&db, &item)?;
  }
  // only on retarget, so an existing link to a link can still be moved or resized.
  if old_item.link_to != item.link_to {
    validate_link_target_for_item(&db, &item)?;
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
  let old_title_parent_id = old_item.parent_id.clone().filter(|parent_id| item.parent_id.as_ref() != Some(parent_id));
  let image_fragment_context_dependents =
    image_fragment_context_dependents_for_parent_title_change(&db, &old_item, &item)?;
  debug!("Executed 'update-item' command for item '{}'.", item.id);
  drop(db);
  // Deliberate trade-off: most updates (moving, resizing, restyling) change
  // nothing search depends on, so only queue work when a search input changed.
  // Title fragments use the title, type, parent context and attachments; image
  // fragments also use the title and parent context; document fragments use
  // only their local text and kind.
  let title_inputs_changed = old_item.title != item.title
    || old_item.item_type != item.item_type
    || old_item.parent_id != item.parent_id
    || old_item.relationship_to_parent != item.relationship_to_parent;
  let mime_type_changed = old_item.mime_type != item.mime_type;
  if title_inputs_changed {
    enqueue_item_title_index_update(&owner_id, &item.id);
  }
  if let Some(parent_id) = old_title_parent_id {
    enqueue_item_title_index_update(&owner_id, &parent_id);
  }
  if should_tag_image_item(&item) {
    if title_inputs_changed || mime_type_changed || !should_tag_image_item(&old_item) {
      enqueue_image_background_pipeline_item_if_active(&item);
    }
  } else if should_tag_image_item(&old_item) {
    dequeue_image_background_pipeline_item_if_active(&old_item.id);
  }
  for dependent in image_fragment_context_dependents {
    enqueue_image_background_pipeline_item_if_active(&dependent);
  }
  if should_fragment_document_item(&item) && (mime_type_changed || !should_fragment_document_item(&old_item)) {
    enqueue_document_fragment_item_if_active(&item);
  }

  json_with_sync_ack(sync_ack, None)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConvertPageTableRequest {
  id: Uid,
  expected_item_type: String,
  target_item_type: String,
  default_page_aspect: Option<f64>,
}

pub(super) async fn handle_convert_page_table(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to convert an item.")?;
  let request: ConvertPageTableRequest =
    serde_json::from_str(json_data).map_err(|e| format!("Could not parse page/table conversion request: {}", e))?;
  let expected_type = ItemType::from_str(&request.expected_item_type)?;
  let target_type = ItemType::from_str(&request.target_item_type)?;
  if !matches!((expected_type, target_type), (ItemType::Page, ItemType::Table) | (ItemType::Table, ItemType::Page)) {
    return Err("Page/table conversion requires opposite page and table types.".into());
  }

  let mut db = db.lock().await;
  let (source, parent) = convertible_source_and_parent(&db, session, &request.id, expected_type)?;
  let parent_id = &parent.id;
  if source.item_type == ItemType::Page {
    if source.arrange_algorithm != Some(ArrangeAlgorithm::Table) {
      return Err(format!("Page '{}' must use table arrangement before conversion.", request.id).into());
    }
  }

  let mut converted = source.clone();
  converted.last_modified_date = unix_now_secs_i64()?.max(source.last_modified_date.saturating_add(1));
  match target_type {
    ItemType::Table => convert_page_to_table(&source, &parent, &mut converted)?,
    ItemType::Page => convert_table_to_page(&source, &mut converted, request.default_page_aspect)?,
    _ => unreachable!(),
  }

  // Validate the complete destination and prepare the response before persisting.
  let item_json = item_to_api_json_map(&converted)?;
  let parent_delta = build_child_upsert_delta(&db, &converted)?;
  db.item.replace_type(&converted).await?;
  let mut deltas_by_container = HashMap::new();
  merge_container_delta(&mut deltas_by_container, parent_id, parent_delta);
  let sync_ack = flush_container_sync_changes(&mut db, &source.owner_id, deltas_by_container, HashSet::new());

  debug!("Executed 'convert-page-table' command for item '{}'.", source.id);
  drop(db);
  enqueue_item_title_index_update(&source.owner_id, &source.id);
  json_with_sync_ack(sync_ack, Some(item_json))
}

/// The source of a container type conversion and its parent page, both owned by the session user.
fn convertible_source_and_parent(
  db: &MutexGuard<'_, Db>,
  session: &Session,
  id: &Uid,
  expected_type: ItemType,
) -> InfuResult<(Item, Item)> {
  let user = db.user.get(&session.user_id).ok_or(format!("Unknown user '{}'.", session.user_id))?;
  let protected_ids =
    [user.home_page_id.clone(), user.trash_page_id.clone(), user.dock_page_id.clone(), user.queries_page_id.clone()];
  if protected_ids.contains(id)
    || *id == scopes_page_id(&session.user_id)
    || search_status_page_kind_for_id(&session.user_id, id).is_some()
  {
    return Err(format!("Special page '{}' cannot be converted.", id).into());
  }

  let source = db.item.get(id)?.clone();
  if source.owner_id != session.user_id || source.item_type != expected_type {
    return Err(format!("Item '{}' is not an owned '{}' item.", id, expected_type).into());
  }
  if source.relationship_to_parent != RelationshipToParent::Child {
    return Err(format!("Item '{}' must be an ordinary child to be converted.", id).into());
  }
  let parent_id = source.parent_id.as_ref().ok_or(format!("Item '{}' has no parent.", id))?;
  if protected_ids[1..].contains(parent_id) {
    return Err(format!("Item '{}' is inside a special page and cannot be converted.", id).into());
  }
  let parent = db.item.get(parent_id)?.clone();
  if parent.item_type != ItemType::Page || parent.owner_id != session.user_id {
    return Err(format!("Item '{}' must have an owned page as its parent.", id).into());
  }
  Ok((source, parent))
}

/// Width of a composite made from a document page: 2.5 times the default note width. The page's document width
/// isn't used, because it reflects reading the page full width, not as one item among others in the parent.
const COMPOSITE_FROM_PAGE_WIDTH_BL: i64 = 25;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConvertPageCompositeRequest {
  id: Uid,
  expected_item_type: String,
  target_item_type: String,
  default_page_aspect: Option<f64>,
}

/// Converts a composite that has grown too big into a document page in its place, or a document page that has become
/// short back into a composite. Children are kept as they are; only the container's type changes.
pub(super) async fn handle_convert_page_composite(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to convert an item.")?;
  let request: ConvertPageCompositeRequest =
    serde_json::from_str(json_data).map_err(|e| format!("Could not parse page/composite conversion request: {}", e))?;
  let expected_type = ItemType::from_str(&request.expected_item_type)?;
  let target_type = ItemType::from_str(&request.target_item_type)?;
  if !matches!(
    (expected_type, target_type),
    (ItemType::Page, ItemType::Composite) | (ItemType::Composite, ItemType::Page)
  ) {
    return Err("Page/composite conversion requires opposite page and composite types.".into());
  }

  let mut db = db.lock().await;
  let (source, parent) = convertible_source_and_parent(&db, session, &request.id, expected_type)?;
  let mut converted = source.clone();
  converted.last_modified_date = unix_now_secs_i64()?.max(source.last_modified_date.saturating_add(1));
  let mut promoted_note = None;
  match target_type {
    ItemType::Page => {
      promoted_note = promotable_heading_note(&db, &source)?;
      let aspect = validated_default_page_aspect(request.default_page_aspect)?;
      convert_composite_to_page(&source, &parent, promoted_note.as_ref(), &mut converted, aspect)?;
    }
    ItemType::Composite => {
      if source.arrange_algorithm != Some(ArrangeAlgorithm::Document) {
        return Err(format!("Page '{}' must use document arrangement before conversion.", request.id).into());
      }
      // Composites can't have attachments or contain composites, and an empty one has nothing to show.
      if !db.item.get_attachments(&source.id)?.is_empty() {
        return Err(format!("Page '{}' has attachments and cannot be converted to a composite.", request.id).into());
      }
      let children = db.item.get_children(&source.id)?;
      if children.is_empty() {
        return Err(format!("Page '{}' is empty and cannot be converted to a composite.", request.id).into());
      }
      if children.iter().any(|child| is_composite_item(child)) {
        return Err(format!("Page '{}' contains a composite and cannot be converted to one.", request.id).into());
      }
      convert_page_to_composite(&source, &mut converted)?;
    }
    _ => unreachable!(),
  }

  // Validate the complete destination and prepare the response before persisting.
  let mut result = serde_json::Map::new();
  result.insert(String::from("item"), Value::from(item_to_api_json_map(&converted)?));
  let parent_delta = build_child_upsert_delta(&db, &converted)?;
  db.item.replace_type(&converted).await?;
  let mut deltas_by_container = HashMap::new();
  merge_container_delta(&mut deltas_by_container, &parent.id, parent_delta);

  // The note goes after the page holds its title, so a failure here leaves the heading twice rather than not at all.
  // As a note, it has no object or image cache entries to delete.
  if let Some(note) = &promoted_note {
    let data_dir = db.item.data_dir().to_owned();
    dequeue_document_fragment_item_if_active(&note.id);
    delete_item_text_dir(&data_dir, &note.owner_id, &note.id).await?;
    delete_item_image_tag_dir(&data_dir, &note.owner_id, &note.id).await?;
    delete_item_geo_artifacts(&data_dir, &note.owner_id, &note.id).await?;
    delete_item_fragment_artifacts(&data_dir, &note.owner_id, &note.id).await?;
    enqueue_item_search_index_removal(&note.owner_id, &note.id);
    db.item.remove(&note.id).await?;
    let mut delta = ContainerSyncDelta::default();
    delta.add_child_delete(&note.id);
    merge_container_delta(&mut deltas_by_container, &source.id, delta);
    result.insert(String::from("removedItemId"), Value::String(note.id.clone()));
  }
  let sync_ack = flush_container_sync_changes(&mut db, &source.owner_id, deltas_by_container, HashSet::new());

  debug!("Executed 'convert-page-composite' command for item '{}'.", source.id);
  drop(db);
  enqueue_item_title_index_update(&source.owner_id, &source.id);
  insert_sync_ack(&mut result, sync_ack)?;
  Ok(Some(serde_json::to_string(&result)?))
}

/// The composite's first child, when it is a plain heading note that can become the title of the page the composite
/// is converted to. A big composite usually starts with such a heading, and keeping it would repeat the page title
/// directly beneath itself. Notes that would lose something when removed are left alone.
fn promotable_heading_note(db: &MutexGuard<'_, Db>, composite: &Item) -> InfuResult<Option<Item>> {
  if composite.title.as_deref().unwrap_or("").trim() != "" {
    return Ok(None);
  }
  // Only in ordering order is the first child by ordering the one shown first.
  if composite.order_children_by.as_deref().unwrap_or("") != "" {
    return Ok(None);
  }
  let children = db.item.get_children(&composite.id)?;
  let first = match children.into_iter().min_by(|a, b| a.ordering.cmp(&b.ordering).then_with(|| a.id.cmp(&b.id))) {
    Some(first) => first,
    None => return Ok(None),
  };
  let heading_flags = (NoteFlags::Heading1 | NoteFlags::Heading2 | NoteFlags::Heading3 | NoteFlags::Heading4).bits();
  let promotable = first.item_type == ItemType::Note
    && first.owner_id == composite.owner_id
    && first.flags.unwrap_or(0) & heading_flags != 0
    && first.title.as_deref().unwrap_or("").trim() != ""
    && first.url.as_deref().unwrap_or("") == ""
    && first.urls.as_ref().is_none_or(|urls| urls.is_empty())
    && db.item.get_attachments(&first.id)?.is_empty()
    && db.item.get_linked_from_ids(&first.id).is_empty();
  Ok(if promotable { Some(first.clone()) } else { None })
}

fn convert_composite_to_page(
  composite: &Item,
  parent: &Item,
  promoted_note: Option<&Item>,
  page: &mut Item,
  natural_aspect: f64,
) -> InfuResult<()> {
  let composite_flags = composite.flags.ok_or("Composite has no flags.")?;
  let composite_title = composite.title.clone().unwrap_or_default();
  let title = match promoted_note {
    Some(note) => note.title.clone().unwrap_or_default().trim().to_owned(),
    None => composite_title.clone(),
  };
  let mut flags = composite_flags & (LIST_PAGE_PIN_TOP_FLAG | LIST_PAGE_PIN_BOTTOM_FLAG);
  // A title the composite deliberately hid stays hidden.
  if composite_title.trim() != "" && composite_flags & CompositeFlags::ShowTitle.bits() == 0 {
    flags |= PAGE_HIDE_DOCUMENT_TITLE_FLAG;
  }
  let mut settings = default_converted_page_settings(natural_aspect);
  // Children of a composite are visible exactly when its parent page is. Carry that over to the new page.
  settings.permission_flags = parent.permission_flags.ok_or("Parent page has no permissionFlags.")?;

  page.item_type = ItemType::Page;
  page.title = Some(title);
  page.spatial_width_gr = Some(settings.spatial_width_gr);
  page.spatial_height_gr = None;
  page.flags = Some(flags);
  page.table_columns = Some(vec![TableColumn { width_gr: 8 * GRID_SIZE, name: String::from("Title"), align: None }]);
  page.number_of_visible_columns = Some(1);
  page.saved_page_settings = None;
  page.saved_table_settings = None;
  set_page_fields(page, settings, ArrangeAlgorithm::Document);
  Ok(())
}

fn convert_page_to_composite(page: &Item, composite: &mut Item) -> InfuResult<()> {
  let page_flags = page.flags.ok_or("Page has no flags.")?;
  let title = page.title.clone().unwrap_or_default();
  let mut flags = page_flags & (LIST_PAGE_PIN_TOP_FLAG | LIST_PAGE_PIN_BOTTOM_FLAG);
  if title.trim() != "" && page_flags & PAGE_HIDE_DOCUMENT_TITLE_FLAG == 0 {
    flags |= CompositeFlags::ShowTitle.bits();
  }

  composite.item_type = ItemType::Composite;
  composite.title = Some(title);
  composite.spatial_width_gr = Some(COMPOSITE_FROM_PAGE_WIDTH_BL * GRID_SIZE);
  composite.spatial_height_gr = None;
  composite.flags = Some(flags);
  // A document lays out its children in ordering order whatever its sort setting, so the composite must too.
  composite.order_children_by = Some(String::new());
  composite.table_columns = None;
  composite.number_of_visible_columns = None;
  composite.saved_page_settings = None;
  composite.saved_table_settings = None;
  clear_page_fields(composite);
  Ok(())
}

fn convert_page_to_table(page: &Item, parent: &Item, table: &mut Item) -> InfuResult<()> {
  let size = embedded_table_size_from_page(page, parent)?;
  let saved_page = SavedPageSettings::from_page(page)?;
  let mut flags = page.saved_table_settings.as_ref().map(|saved| saved.flags).unwrap_or(0);
  for (page_flag, table_flag) in PAGE_TABLE_FLAG_PAIRS {
    if saved_page.flags & page_flag != 0 {
      flags |= table_flag.bits();
    } else {
      flags &= !table_flag.bits();
    }
  }

  table.item_type = ItemType::Table;
  table.spatial_width_gr = Some(size.w);
  table.spatial_height_gr = Some(size.h);
  table.flags = Some(flags);
  table.saved_page_settings = Some(saved_page);
  table.saved_table_settings = None;
  clear_page_fields(table);
  Ok(())
}

fn convert_table_to_page(table: &Item, page: &mut Item, default_page_aspect: Option<f64>) -> InfuResult<()> {
  let saved_table = SavedTableSettings::from_table(table)?;
  let saved_page = if let Some(settings) = &table.saved_page_settings {
    settings.clone()
  } else {
    default_converted_page_settings(validated_default_page_aspect(default_page_aspect)?)
  };
  let mut flags = saved_page.flags;
  for (page_flag, table_flag) in PAGE_TABLE_FLAG_PAIRS {
    if saved_table.flags & table_flag.bits() != 0 {
      flags |= page_flag;
    } else {
      flags &= !page_flag;
    }
  }

  page.item_type = ItemType::Page;
  page.spatial_width_gr = Some(page_width_from_table(table)?);
  page.spatial_height_gr = None;
  page.flags = Some(flags);
  page.saved_page_settings = None;
  page.saved_table_settings = Some(saved_table);
  set_page_fields(page, saved_page, ArrangeAlgorithm::Table);
  Ok(())
}

fn validated_default_page_aspect(default_page_aspect: Option<f64>) -> InfuResult<f64> {
  let aspect = default_page_aspect.ok_or("A screen aspect is required to convert to a page without saved settings.")?;
  if !aspect.is_finite() || aspect <= 0.0 {
    return Err("Conversion to a page requires a positive screen aspect.".into());
  }
  Ok(aspect)
}

/// Page-only fields, other than spatial width and flags, which every conversion sets separately.
fn set_page_fields(page: &mut Item, settings: SavedPageSettings, arrange_algorithm: ArrangeAlgorithm) {
  page.permission_flags = Some(settings.permission_flags);
  page.background_color_index = Some(settings.background_color_index);
  page.natural_aspect = Some(settings.natural_aspect);
  page.inner_spatial_width_gr = Some(settings.inner_spatial_width_gr);
  page.list_width_gr = settings.list_width_gr;
  page.arrange_algorithm = Some(arrange_algorithm);
  page.default_popup_position_gr = Some(settings.default_popup_position_gr);
  page.default_popup_width_gr = Some(settings.default_popup_width_gr);
  page.popup_position_gr = settings.popup_position_gr;
  page.popup_width_gr = settings.popup_width_gr;
  page.default_cell_popup_position_norm = settings.default_cell_popup_position_norm;
  page.default_cell_popup_width_norm = settings.default_cell_popup_width_norm;
  page.cell_popup_position_norm = settings.cell_popup_position_norm;
  page.cell_popup_width_norm = settings.cell_popup_width_norm;
  page.grid_number_of_columns = Some(settings.grid_number_of_columns);
  page.grid_cell_aspect = Some(settings.grid_cell_aspect);
  page.doc_width_bl = Some(settings.doc_width_bl);
  page.justified_row_aspect = Some(settings.justified_row_aspect);
  page.calendar_day_row_height_bl = settings.calendar_day_row_height_bl;
}

fn clear_page_fields(item: &mut Item) {
  item.permission_flags = None;
  item.background_color_index = None;
  item.natural_aspect = None;
  item.inner_spatial_width_gr = None;
  item.list_width_gr = None;
  item.arrange_algorithm = None;
  item.default_popup_position_gr = None;
  item.default_popup_width_gr = None;
  item.popup_position_gr = None;
  item.popup_width_gr = None;
  item.default_cell_popup_position_norm = None;
  item.default_cell_popup_width_norm = None;
  item.cell_popup_position_norm = None;
  item.cell_popup_width_norm = None;
  item.grid_number_of_columns = None;
  item.grid_cell_aspect = None;
  item.doc_width_bl = None;
  item.justified_row_aspect = None;
  item.calendar_day_row_height_bl = None;
}

fn default_converted_page_settings(natural_aspect: f64) -> SavedPageSettings {
  SavedPageSettings {
    spatial_width_gr: 4 * GRID_SIZE,
    flags: 0,
    permission_flags: 0,
    natural_aspect,
    background_color_index: 0,
    inner_spatial_width_gr: 60 * GRID_SIZE,
    list_width_gr: Some(8 * GRID_SIZE),
    default_popup_position_gr: Vector { x: 30 * GRID_SIZE, y: 15 * GRID_SIZE },
    default_popup_width_gr: 10 * GRID_SIZE,
    popup_position_gr: None,
    popup_width_gr: None,
    default_cell_popup_position_norm: Some(Vector { x: 0.5, y: 0.5 }),
    default_cell_popup_width_norm: Some(0.6),
    cell_popup_position_norm: None,
    cell_popup_width_norm: None,
    grid_number_of_columns: 6,
    grid_cell_aspect: 1.5,
    doc_width_bl: 30,
    justified_row_aspect: 7.0,
    calendar_day_row_height_bl: Some(1.0),
  }
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

pub(super) async fn handle_delete_item<'a>(
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

  if request.id == scopes_page_id(&session.user_id) {
    return Err(format!("Scopes page '{}' cannot be deleted.", request.id).into());
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
  dequeue_image_background_pipeline_item_if_active(&request.id);
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
  chat::delete_query_item_transcript(&data_dir, &session.user_id, &item).await;
  enqueue_item_search_index_removal(&session.user_id, &request.id);

  let _item = db.item.remove(&request.id).await?;
  let mut deltas_by_container = HashMap::new();
  let snapshot_required_container_ids = HashSet::new();
  if let Some(container_id) = old_child_container_id {
    let mut delta = ContainerSyncDelta::default();
    delta.add_child_delete(&item.id);
    merge_container_delta(&mut deltas_by_container, &container_id, delta);
  }
  if let Some(parent_id) = old_attachment_parent_id.as_ref() {
    if let Some(container_id) = maybe_container_id_for_attachment_parent(&db, &parent_id)? {
      let mut delta = ContainerSyncDelta::default();
      add_attachment_snapshot_delta_for_parent(&db, &mut delta, parent_id)?;
      merge_container_delta(&mut deltas_by_container, &container_id, delta);
    }
  }
  let sync_ack =
    flush_container_sync_changes(&mut db, &item.owner_id, deltas_by_container, snapshot_required_container_ids);
  let owner_id = item.owner_id.clone();
  let title_parent_id = old_attachment_parent_id;
  debug!("Deleted item '{}' from database.", request.id);
  drop(db);
  if let Some(parent_id) = title_parent_id {
    enqueue_item_title_index_update(&owner_id, &parent_id);
  }

  json_with_sync_ack(sync_ack, None)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReprocessItemRequest {
  pub id: String,
  /// Overrides the GPU service's PDF conversion limit for this attempt only.
  #[serde(default)]
  pub pdf_conversion_timeout_secs: Option<u64>,
}

/// Discard generated search outputs for an item and queue every stage again.
/// Extracted text and image descriptions (including manual edits) are replaced
/// using the current GPU service. Location output depends only on the image's
/// coordinates and is kept. Old content index entries are removed by the local
/// content index worker, without waiting for GPU tools.
///
/// Deliberate trade-off: reprocessing is explicit and per item. There is no
/// automatic invalidation or model-version tracking when GPU tools are
/// upgraded, so an upgrade never triggers corpus-wide GPU work.
pub(super) async fn handle_reprocess_item(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let request: ReprocessItemRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;
  let session = session_maybe.as_ref().ok_or("Session is required to reprocess an item.")?;
  if let Some(secs) = request.pdf_conversion_timeout_secs {
    if secs == 0 || secs > MAX_PDF_CONVERSION_TIMEOUT_SECS {
      return Err(
        format!("PDF conversion timeout must be from 1 to {} seconds.", MAX_PDF_CONVERSION_TIMEOUT_SECS).into(),
      );
    }
  }

  let (item, data_dir) = {
    let db = db.lock().await;
    let item = db.item.get(&request.id)?.clone();
    if item.owner_id != session.user_id {
      return Err(format!("User '{}' does not own item '{}'.", session.user_id, request.id).into());
    }
    if request.pdf_conversion_timeout_secs.is_some() && item.mime_type.as_deref() != Some("application/pdf") {
      return Err(format!("Item '{}' is not a PDF; a PDF conversion timeout does not apply.", request.id).into());
    }
    (item, db.item.data_dir().to_owned())
  };

  delete_item_text_dir(&data_dir, &item.owner_id, &item.id).await?;
  delete_item_image_tag_dir(&data_dir, &item.owner_id, &item.id).await?;
  delete_item_fragment_artifacts(&data_dir, &item.owner_id, &item.id).await?;

  enqueue_fragment_lexical_index_update(&item.owner_id, &item.id);
  enqueue_item_title_index_update(&item.owner_id, &item.id);
  requeue_image_background_pipeline_item_now(&item).await;
  requeue_pdf_item_now(&item, request.pdf_conversion_timeout_secs).await;
  requeue_document_fragment_item_now(&item).await;
  log::info!("Queued item '{}' for search reprocessing; its generated text and fragments were removed.", item.id);

  Ok(None)
}

pub(super) async fn handle_empty_trash<'a>(
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
  let mut deleted_item_ids = vec![];
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
    &mut deleted_item_ids,
  )
  .await?;
  let sync_ack = build_sync_ack(&db, &session.user_id, &touched_container_ids);
  drop(db);

  let mut result = serde_json::Map::new();
  result.insert("itemCount".to_owned(), Value::Number(count.into()));
  result.insert("imageCacheCount".to_owned(), Value::Number(img_cache_count.into()));
  result.insert("objectCount".to_owned(), Value::Number(object_count.into()));
  result.insert(
    "deletedItemIds".to_owned(),
    Value::Array(deleted_item_ids.into_iter().map(Value::String).collect()),
  );
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
  deleted_item_ids: &mut Vec<Uid>,
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
      deleted_item_ids,
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
      deleted_item_ids,
    )
    .await?;
  }

  if delete_item {
    let data_dir = db.item.data_dir().to_owned();
    let item = db.item.get(&item_id)?.clone();
    let old_child_container_id = maybe_container_id_for_child_item(&item);
    let old_attachment_parent_id =
      if item.relationship_to_parent == RelationshipToParent::Attachment { item.parent_id.clone() } else { None };
    dequeue_image_background_pipeline_item_if_active(&item_id);
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
    chat::delete_query_item_transcript(&data_dir, user_id, &item).await;
    enqueue_item_search_index_removal(user_id, &item.id);

    let _item = db.item.remove(&item_id).await?;
    if let Some(parent_id) = old_attachment_parent_id.as_ref() {
      enqueue_item_title_index_update(user_id, parent_id);
    }
    if let Some(container_id) = old_child_container_id {
      record_container_snapshot_required(db, user_id, &container_id, touched_container_ids);
    }
    if let Some(parent_id) = old_attachment_parent_id {
      if let Some(container_id) = maybe_container_id_for_attachment_parent(db, &parent_id)? {
        record_container_snapshot_required(db, user_id, &container_id, touched_container_ids);
      }
    }
    debug!("Deleted item '{}' from database.", item_id);

    deleted_item_ids.push(item_id);
    *count = *count + 1;
  }

  Ok(())
}
