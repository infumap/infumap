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
    if is_data_item_type(queued_item.item_type) {
      record_object_store_backed_item_upload(&queued_item.id);
    }
    enqueue_item_title_index_reconcile_for_user(&queued_item.owner_id);
    if should_tag_image_item(&queued_item) {
      enqueue_image_semantic_pipeline_item_if_active(&queued_item);
    }
    enqueue_pdf_item_if_active(&queued_item);
    enqueue_document_fragment_item_if_active(&queued_item);
    return json_with_sync_ack(sync_ack, Some(serialized_item));
  }
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
  validate_group_id_for_item(&db, &item)?;

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
  enqueue_fragment_index_rebuild_for_user(&owner_id);

  json_with_sync_ack(sync_ack, None)
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
  enqueue_fragment_index_rebuild_for_user(&user_id);

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
