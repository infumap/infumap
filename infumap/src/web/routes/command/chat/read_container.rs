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
use crate::ai::fragment::read_item_fragment_metadata;
use futures_util::{StreamExt, stream};
use sha2::{Digest, Sha256};

const DEFAULT_MAX_ITEMS: usize = 100;
const MAX_ITEMS: usize = 200;
const MAX_OUTLINE_ITEMS: usize = 50_000;
const MAX_DEPTH: usize = 64;
const MAX_TITLE_CHARS: usize = 4_000;
const RESPONSE_CHARS: usize = 32_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Arguments {
  container_id: Uid,
  cursor: Option<String>,
  max_items: Option<usize>,
}

#[derive(Deserialize, Serialize)]
struct ContainerCursor {
  container_id: Uid,
  snapshot: String,
  index: usize,
  title_offset: usize,
}

/// `item` owns the placement; `content` is the locally readable link target (or the item itself).
/// Paths distinguish repeated appearances of a target's children and attachments.
struct Entry<'a> {
  item: &'a Item,
  content: Option<&'a Item>,
  parent: &'a Item,
  path: Vec<Uid>,
  order: usize,
  expansion_cycle: bool,
}

pub(super) fn tool_spec() -> OpenAiToolSpec {
  OpenAiToolSpec {
    tool_type: "function".to_owned(),
    function: OpenAiToolFunctionSpec {
      name: "read_container".to_owned(),
      description: "Inspect an Infumap page, table, or composite without a search query. Returns native note text \
        in title, item IDs, ancestors, explicit groups, attachments, nested composites/tables, and layout. Child pages remain \
        references; document bodies are not included. textSource tells how to fetch available document fragments. \
        Spatial coordinates are stored page-grid placement, not rendered pixels. Follow nextCursor with the same \
        containerId until hasMore is false; long titles continue at titleOffset on the same placementPath. \
        Group members can span responses. Use containingContainerId from search to inspect an item's surroundings."
        .to_owned(),
      parameters: serde_json::json!({
        "type": "object",
        "properties": {
          "containerId": { "type": "string", "description": "ID of a page, table, or composite to inspect." },
          "cursor": {
            "type": ["string", "null"],
            "description": "Opaque nextCursor from the previous response. Omit for the first response."
          },
          "maxItems": {
            "type": "integer", "minimum": 1, "maximum": MAX_ITEMS,
            "description": "Maximum item records per response; defaults to 100. A text budget also applies."
          }
        },
        "required": ["containerId"],
        "additionalProperties": false
      }),
    },
  }
}

pub(super) async fn execute(
  db: &Arc<tokio::sync::Mutex<Db>>,
  session: &Session,
  tool_call: &OpenAiToolCall,
) -> InfuResult<String> {
  let result = async {
    let args: Arguments = serde_json::from_value(tool_call_arguments_value(tool_call)?)
      .map_err(|e| format!("Could not parse read_container arguments: {e}"))?;
    if !is_uid(&args.container_id) {
      return Err("read_container requires a valid containerId.".into());
    }
    let max_items = args.max_items.unwrap_or(DEFAULT_MAX_ITEMS);
    if !(1..=MAX_ITEMS).contains(&max_items) {
      return Err(format!("maxItems must be between 1 and {MAX_ITEMS}.").into());
    }
    let cursor = args.cursor.as_deref().map(decode_cursor).transpose()?;
    let (mut response, data_dir, sources) = {
      let db = db.lock().await;
      build_outline(&db, &session.user_id, &args.container_id, cursor.as_ref(), max_items)?
    };

    // Only inspect manifests for returned records, outside the database lock. Repeated links share a lookup.
    let metadata = stream::iter(sources.into_iter().map(|item_id| {
      let data_dir = &data_dir;
      let user_id = &session.user_id;
      async move {
        let source = match read_item_fragment_metadata(data_dir, user_id, &item_id).await {
          Ok(Some(metadata)) => serde_json::json!({
            "status": "available", "itemId": item_id, "tool": "get_fragment",
            "sourceKind": metadata.source_kind, "fragmentCount": metadata.fragment_count,
            "firstFragmentOrdinal": 0
          }),
          Ok(None) => serde_json::json!({ "status": "unavailable" }),
          Err(_) => serde_json::json!({ "status": "error" }),
        };
        (item_id, source)
      }
    }))
    .buffer_unordered(8)
    .collect::<HashMap<_, _>>()
    .await;
    for item in response["items"].as_array_mut().expect("outline items are an array") {
      let content_id = item.get("targetItemId").unwrap_or(&item["itemId"]).as_str().unwrap_or("");
      if let Some(source) = metadata.get(content_id) {
        item["textSource"] = source.clone();
      }
    }
    Ok::<_, infusdk::util::infu::InfuError>(response.to_string())
  }
  .await;
  Ok(result.unwrap_or_else(|e| tool_error_json(&e.to_string())))
}

fn decode_cursor(value: &str) -> InfuResult<ContainerCursor> {
  if value.len() > 1024 {
    return Err("Invalid read_container cursor; restart without a cursor.".into());
  }
  let bytes = general_purpose::URL_SAFE_NO_PAD
    .decode(value)
    .map_err(|_| "Invalid read_container cursor; restart without a cursor.")?;
  serde_json::from_slice(&bytes).map_err(|_| "Invalid read_container cursor; restart without a cursor.".into())
}

fn readable(item: &Item, user_id: &str) -> bool {
  item.owner_id == user_id && item.item_type != ItemType::Password
}

fn resolve_content<'a>(db: &'a Db, item: &'a Item, user_id: &str) -> Option<&'a Item> {
  let mut current = item;
  let mut seen = HashSet::new();
  for _ in 0..MAX_DEPTH {
    if !readable(current, user_id) || !seen.insert(&current.id) {
      return None;
    }
    if current.item_type != ItemType::Link {
      return Some(current);
    }
    current = db.item.get(current.link_to.as_ref()?).ok()?;
  }
  None
}

fn brief_item(item: &Item) -> Value {
  let (title, truncated) = clamp_text_chars(item.title.as_deref().unwrap_or(""), 500);
  serde_json::json!({
    "itemId": item.id, "itemType": item.item_type.as_str(),
    "title": title, "titleTruncated": truncated, "linkUrl": format!("infumap://{}", item.id)
  })
}

fn ancestors<'a>(db: &'a Db, item: &'a Item, user_id: &str) -> InfuResult<Vec<&'a Item>> {
  let mut result = Vec::new();
  let mut seen = HashSet::from([&item.id]);
  let mut current = item;
  while let Some(parent_id) = current.parent_id.as_ref() {
    if is_empty_uid(parent_id) {
      break;
    }
    current = db.item.get(parent_id).map_err(|_| "Could not read page hierarchy.")?;
    if !readable(current, user_id) {
      return Err("Page was not found.".into());
    }
    if !seen.insert(&current.id) || result.len() >= MAX_DEPTH {
      return Err("Page hierarchy is cyclic or too deep.".into());
    }
    result.push(current);
  }
  result.reverse();
  Ok(result)
}

fn title_ordered(item: &Item) -> bool {
  item.arrange_algorithm != Some(ArrangeAlgorithm::Document) && item.order_children_by.as_deref() == Some("title[ASC]")
}

fn sorted_related<'a>(db: &'a Db, parent: &'a Item, user_id: &str, attachments: bool) -> InfuResult<Vec<&'a Item>> {
  let mut items = if attachments { db.item.get_attachments(&parent.id)? } else { db.item.get_children(&parent.id)? };
  if !attachments && title_ordered(parent) {
    items.sort_by_cached_key(|item| {
      let content = resolve_content(db, item, user_id);
      (content.is_none(), content.and_then(|item| item.title.as_deref()).unwrap_or("").to_lowercase(), item.id.clone())
    });
  } else {
    items.sort_by(|a, b| a.ordering.cmp(&b.ordering).then_with(|| a.id.cmp(&b.id)));
  }
  Ok(items)
}

fn collect_entries<'a>(
  db: &'a Db,
  parent: &'a Item,
  user_id: &str,
  path: &[Uid],
  active: &mut HashSet<Uid>,
  include_children: bool,
  entries: &mut Vec<Entry<'a>>,
) -> InfuResult<()> {
  if path.len() > MAX_DEPTH {
    return Err("Container outline is too deeply nested.".into());
  }
  for attachments in [false, true] {
    if !attachments && !include_children {
      continue;
    }
    for (order, item) in sorted_related(db, parent, user_id, attachments)?.into_iter().enumerate() {
      // Preserve attachment slots (table columns) even when an unreadable cell is omitted.
      if !readable(item, user_id) {
        continue;
      }
      if entries.len() >= MAX_OUTLINE_ITEMS {
        return Err("Container outline exceeds 50000 placements; inspect a smaller container.".into());
      }
      let content = resolve_content(db, item, user_id);
      let mut child_path = path.to_vec();
      child_path.push(item.id.clone());
      let expansion_cycle = content.is_some_and(|content| active.contains(&content.id));
      entries.push(Entry { item, content, parent, path: child_path.clone(), order, expansion_cycle });
      if let Some(content) = content.filter(|_| !expansion_cycle) {
        active.insert(content.id.clone());
        collect_entries(
          db,
          content,
          user_id,
          &child_path,
          active,
          matches!(content.item_type, ItemType::Composite | ItemType::Table),
          entries,
        )?;
        active.remove(&content.id);
      }
    }
  }
  Ok(())
}

fn layout(item: &Item) -> Value {
  let mode = match item.item_type {
    ItemType::Page => item.arrange_algorithm.map(|mode| mode.as_str()).unwrap_or("unknown"),
    ItemType::Composite => "composite",
    ItemType::Table => "table",
    _ => "none",
  };
  let mut result = serde_json::json!({
    "mode": mode,
    "orderChildrenBy": item.order_children_by.as_deref().unwrap_or(""),
    "returnedOrder": if title_ordered(item) { "title-unicode" } else { "stored" }
  });
  if mode == "spatial-stretch" {
    result["coordinates"] = serde_json::json!({
      "frameItemId": item.id, "units": "grid", "gridUnitsPerBlock": GRID_SIZE,
      "origin": "top-left", "xDirection": "right", "yDirection": "down",
      "width": item.inner_spatial_width_gr, "naturalAspect": item.natural_aspect,
      "geometry": "stored-placement"
    });
  }
  if let Some(columns) = item.table_columns.as_ref().filter(|columns| !columns.is_empty()) {
    result["columns"] = serde_json::json!(
      columns
        .iter()
        .enumerate()
        .map(|(index, column)| { serde_json::json!({ "index": index, "name": column.name }) })
        .collect::<Vec<_>>()
    );
  }
  result
}

fn entry_json(entry: &Entry<'_>, title_offset: usize) -> InfuResult<(Value, usize, bool)> {
  let item = entry.item;
  let content = entry.content;
  let title = content.and_then(|content| content.title.as_deref()).unwrap_or("");
  if title_offset > title.chars().count() {
    return Err("Invalid title offset in read_container cursor.".into());
  }
  let mut chars = title.chars().skip(title_offset);
  let title_part: String = chars.by_ref().take(MAX_TITLE_CHARS).collect();
  let next_title_offset = title_offset + title_part.chars().count();
  let title_truncated = chars.next().is_some();
  let mut result = serde_json::json!({
    "itemId": item.id, "itemType": item.item_type.as_str(), "linkUrl": format!("infumap://{}", item.id),
    "parentId": item.parent_id, "relationshipToParent": item.relationship_to_parent.as_str(),
    "placementPath": entry.path, "order": entry.order,
    "title": title_part, "titleOffset": title_offset, "titleTruncated": title_truncated
  });
  if let Some(group_id) = &item.group_id {
    result["groupId"] = serde_json::json!(group_id);
  }
  if item.item_type == ItemType::Link {
    result["linkTo"] = serde_json::json!(item.link_to);
    result["targetStatus"] = serde_json::json!(if content.is_some() { "available" } else { "unavailable" });
    if let Some(target) = content {
      result["targetItemId"] = serde_json::json!(target.id);
      result["targetItemType"] = serde_json::json!(target.item_type.as_str());
      result["targetLinkUrl"] = serde_json::json!(format!("infumap://{}", target.id));
    }
  }
  if item.relationship_to_parent == RelationshipToParent::Child
    && entry.parent.item_type == ItemType::Page
    && entry.parent.arrange_algorithm == Some(ArrangeAlgorithm::SpatialStretch)
  {
    if let Some(position) = &item.spatial_position_gr {
      let mut spatial = serde_json::json!({ "frameItemId": entry.parent.id, "x": position.x, "y": position.y });
      if let Some(width) = item.spatial_width_gr {
        spatial["width"] = serde_json::json!(width);
      }
      // Most heights are computed by the client. Only expose a stored height when the type uses it.
      if content.is_some_and(|content| {
        infusdk::item::is_y_sizeable_item_type(content.item_type)
          || (content.item_type == ItemType::Note
            && content.flags.unwrap_or(0) & infusdk::item::NoteFlags::ExplicitHeight.bits() != 0)
      }) {
        if let Some(height) = item.spatial_height_gr {
          spatial["height"] = serde_json::json!(height);
        }
      }
      result["spatial"] = spatial;
    }
  }
  if entry.parent.arrange_algorithm == Some(ArrangeAlgorithm::Calendar) {
    result["dateTime"] = serde_json::json!(item.datetime);
    result["endDateTime"] = serde_json::json!(item.end_datetime);
  }
  if let Some(content) = content {
    if is_container_item_type(content.item_type) {
      result["layout"] = layout(content);
      result["childrenStatus"] = serde_json::json!(if entry.expansion_cycle {
        "cycle"
      } else if content.item_type == ItemType::Page {
        "reference"
      } else {
        "expanded"
      });
    }
    if entry.expansion_cycle {
      result["attachmentsStatus"] = serde_json::json!("cycle");
    }
    if content.item_type == ItemType::Note {
      result["textSource"] = serde_json::json!({ "status": "inline", "field": "title", "sourceKind": "item_title" });
      if let Some(urls) = &content.urls {
        // Note annotation offsets use JavaScript UTF-16 indices; pagination uses Unicode characters.
        let utf16_start = title.chars().take(title_offset).map(char::len_utf16).sum::<usize>() as i64;
        let utf16_end = utf16_start + title_part.encode_utf16().count() as i64;
        result["urls"] = serde_json::json!(
          urls
            .iter()
            .filter(|url| { url.end > utf16_start && url.start < utf16_end })
            .map(|url| serde_json::json!({ "start": url.start, "end": url.end, "url": url.url }))
            .collect::<Vec<_>>()
        );
      }
    }
    if content.item_type == ItemType::Rating {
      result["rating"] = serde_json::json!(content.rating);
      result["ratingType"] = serde_json::json!(content.rating_type.map(|kind| kind.as_str()));
    }
    if let Some(mime_type) = &content.mime_type {
      result["mimeType"] = serde_json::json!(mime_type);
    }
  }
  Ok((result, next_title_offset, title_truncated))
}

fn build_outline(
  db: &Db,
  user_id: &str,
  container_id: &Uid,
  cursor: Option<&ContainerCursor>,
  max_items: usize,
) -> InfuResult<(Value, String, HashSet<Uid>)> {
  let container = db.item.get(container_id).map_err(|_| "Container was not found.")?;
  if !readable(container, user_id) {
    return Err("Container was not found.".into());
  }
  if !is_container_item_type(container.item_type) {
    return Err("read_container containerId must identify a page, table, or composite.".into());
  }
  let ancestors = ancestors(db, container, user_id)?;
  let mut entries = Vec::new();
  collect_entries(
    db,
    container,
    user_id,
    &[container.id.clone()],
    &mut HashSet::from([container.id.clone()]),
    true,
    &mut entries,
  )?;
  let mut hasher = Sha256::new();
  for item in ancestors.iter().copied().chain(std::iter::once(container)) {
    hasher.update(item.hash());
  }
  for entry in &entries {
    hasher.update(entry.item.hash());
    hasher.update(entry.order.to_le_bytes());
    for id in &entry.path {
      hasher.update(id);
    }
    if let Some(content) = entry.content {
      hasher.update(content.hash());
    }
  }
  let snapshot = format!("{:x}", hasher.finalize());
  if let Some(cursor) = cursor {
    if cursor.container_id != *container_id || cursor.snapshot != snapshot {
      return Err(
        "The container outline changed or the cursor belongs to another container; restart without a cursor.".into(),
      );
    }
    if cursor.index >= entries.len() {
      return Err("Invalid item offset in read_container cursor.".into());
    }
  }
  let start = cursor.map(|cursor| cursor.index).unwrap_or(0);
  let mut index = start;
  let mut title_offset = cursor.map(|cursor| cursor.title_offset).unwrap_or(0);
  let mut items = Vec::new();
  let mut chars = 0;
  let mut sources = HashSet::new();
  while index < entries.len() && items.len() < max_items {
    let entry = &entries[index];
    let (item, next_offset, title_truncated) = entry_json(entry, title_offset)?;
    // Reserve room for document metadata, fetched after releasing the lock.
    let item_chars = item.to_string().chars().count() + 300;
    if !items.is_empty() && chars + item_chars > RESPONSE_CHARS {
      break;
    }
    chars += item_chars;
    if let Some(content) = entry.content.filter(|content| is_data_item_type(content.item_type)) {
      sources.insert(content.id.clone());
    }
    items.push(item);
    if title_truncated {
      title_offset = next_offset;
      break;
    }
    title_offset = 0;
    index += 1;
  }
  let has_more = index < entries.len();
  let next_cursor = if has_more {
    Some(general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&ContainerCursor {
      container_id: container_id.clone(),
      snapshot: snapshot.clone(),
      index,
      title_offset,
    })?))
  } else {
    None
  };
  let mut groups = std::collections::BTreeMap::<&str, Vec<&str>>::new();
  for entry in &entries {
    if entry.parent.id == container.id {
      if let Some(group_id) = entry.item.group_id.as_deref() {
        groups.entry(group_id).or_default().push(&entry.item.id);
      }
    }
  }
  // A groupId held by only one child is not a group (the other members were moved or deleted).
  groups.retain(|_, members| members.len() >= 2);
  for item in items.iter_mut() {
    let is_group_member = item["groupId"].as_str().is_some_and(|group_id| groups.contains_key(group_id));
    if !is_group_member {
      if let Some(item) = item.as_object_mut() {
        item.remove("groupId");
      }
    }
  }
  let returned_ids: HashSet<&str> = items.iter().filter_map(|item| item["itemId"].as_str()).collect();
  let groups: Vec<Value> = groups
    .into_iter()
    .filter_map(|(group_id, members)| {
      let returned: Vec<_> = members.iter().filter(|id| returned_ids.contains(**id)).copied().collect();
      if returned.is_empty() {
        return None;
      }
      Some(serde_json::json!({
        "groupId": group_id, "parentId": container.id, "memberCount": members.len(),
        "returnedMemberIds": returned, "membershipComplete": returned.len() == members.len()
      }))
    })
    .collect();
  let mut container_info = brief_item(container);
  container_info["layout"] = layout(container);
  Ok((
    serde_json::json!({
      "container": container_info,
      "ancestors": ancestors.into_iter().map(brief_item).collect::<Vec<_>>(),
      "scope": {
        "includes": "container children, attachments, nested composites and tables",
        "childPagesExpanded": false, "documentBodiesIncluded": false, "passwordItemsIncluded": false
      },
      "snapshot": snapshot, "totalItems": entries.len(), "startIndex": start,
      "items": items, "groups": groups, "hasMore": has_more, "nextCursor": next_cursor
    }),
    db.item.data_dir().to_owned(),
    sources,
  ))
}

pub(super) fn tool_activity(parsed: Option<&Value>) -> (String, Value) {
  let title = parsed
    .and_then(|result| result.get("container"))
    .and_then(|container| json_object_str(container, "title"))
    .unwrap_or("Container");
  let title = clamp_text_chars(title, CHAT_TOOL_SUMMARY_QUERY_MAX_CHARS).0;
  let count = parsed.and_then(|result| result.get("items")).and_then(Value::as_array).map(Vec::len).unwrap_or(0);
  let has_more = parsed.and_then(|result| result.get("hasMore")).and_then(Value::as_bool).unwrap_or(false);
  let summary =
    format!("{title} · {count} item{}{}", if count == 1 { "" } else { "s" }, if has_more { " · more" } else { "" });
  (
    summary,
    serde_json::json!({
      "container": parsed.and_then(|result| result.get("container")), "returnedItems": count,
      "totalItems": parsed.and_then(|result| result.get("totalItems")), "hasMore": has_more
    }),
  )
}
