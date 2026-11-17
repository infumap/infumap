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

//! Adding items to a collection and removing them, from collection mode.
//!
//! Membership is a collection page's direct link children, so these create and delete links. They run on the server,
//! rather than as client item edits, so the collection page need not be loaded on the client and de-duplication by
//! target is atomic. Responses carry no sync ack: the client has not seen the links made here, and a sync ack would
//! tell it it had. Its next container sync fetches them, if it shows the collection page.

use super::scope::{ancestor_chain, collection_member_targets, collection_page, resolve_content};
use super::*;
use crate::ai::search_eligibility::is_in_trash;

/// The most items one request can add or remove: more than one selection is likely to hold.
const MAX_MEMBERSHIP_ITEMS: usize = 1000;
/// On a spatial collection page, each new link goes this far below the lowest child, so they do not pile up.
const NEW_LINK_SPACING_GR: i64 = 3 * GRID_SIZE;
const NEW_LINK_WIDTH_GR: i64 = 4 * GRID_SIZE;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MembershipRequest {
  collection_id: Uid,
  item_ids: Vec<Uid>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkippedItem {
  item_id: Uid,
  /// The first line of the item's title, when it can be read, so the user can be told which.
  title: Option<String>,
  reason: &'static str,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AddResponse {
  /// Requested ids that became members, each a link as its target.
  added: Vec<Uid>,
  /// Requested ids whose target was already a direct member.
  already_members: Vec<Uid>,
  skipped: Vec<SkippedItem>,
  member_count: usize,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct InheritedItem {
  item_id: Uid,
  via_id: Uid,
  via_title: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoveResponse {
  /// Requested ids whose membership was removed: every direct link to their target.
  removed: Vec<Uid>,
  /// Requested ids that were not direct members but stay covered through a member above them.
  inherited: Vec<InheritedItem>,
  /// Requested ids that were neither.
  not_members: Vec<Uid>,
  member_count: usize,
}

fn parse_request(json_data: &str) -> InfuResult<MembershipRequest> {
  let request: MembershipRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;
  if request.item_ids.len() > MAX_MEMBERSHIP_ITEMS {
    return Err(format!("At most {MAX_MEMBERSHIP_ITEMS} items can be added or removed at once.").into());
  }
  Ok(request)
}

fn first_title_line(item: &Item) -> Option<String> {
  item.title.as_deref().and_then(|title| title.lines().map(str::trim).find(|line| !line.is_empty())).map(str::to_owned)
}

/// The collection, or a message for the user. The bar shows it, so it names the collection where it can.
fn writable_collection(db: &Db, user_id: &Uid, collection_id: &Uid) -> InfuResult<Item> {
  collection_page(db, user_id, collection_id).cloned().map_err(|_| {
    match db.item.get(collection_id).ok().filter(|item| &item.owner_id == user_id).and_then(first_title_line) {
      Some(title) => format!("\"{title}\" is no longer a collection.").into(),
      None => "This collection no longer exists.".into(),
    }
  })
}

pub(super) async fn handle_collection_add(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to add to a collection.")?;
  let request = parse_request(json_data)?;
  let (response, new_link_ids) = {
    let mut db = db.lock().await;
    add_members(&mut db, &session.user_id, &request.collection_id, &request.item_ids).await?
  };
  // Links are indexed by title, as add-item does for them, so search can leave one out when its target is hidden.
  for link_id in new_link_ids {
    enqueue_item_title_index_update(&session.user_id, &link_id);
  }
  debug!("Executed 'collection-add' command for user '{}'.", session.user_id);
  Ok(Some(serde_json::to_string(&response)?))
}

async fn add_members(
  db: &mut MutexGuard<'_, Db>,
  user_id: &Uid,
  collection_id: &Uid,
  item_ids: &[Uid],
) -> InfuResult<(AddResponse, Vec<Uid>)> {
  let collection = writable_collection(db, user_id, collection_id)?;
  let mut members = collection_member_targets(db, user_id, &collection)?.into_iter().collect::<HashSet<_>>();
  let children = db.item.get_children(&collection.id)?;
  let mut orderings = children.iter().map(|child| child.ordering.clone()).collect::<Vec<_>>();
  let mut next_y = children
    .iter()
    .filter_map(|child| child.spatial_position_gr.as_ref().map(|position| position.y + NEW_LINK_SPACING_GR))
    .max()
    .unwrap_or(GRID_SIZE);

  let mut response = AddResponse { added: vec![], already_members: vec![], skipped: vec![], member_count: 0 };
  let mut new_links = Vec::new();
  for item_id in item_ids {
    let skip = |item: Option<&Item>, reason| SkippedItem {
      item_id: item_id.clone(),
      title: item.and_then(first_title_line),
      reason,
    };
    let Some(item) = db.item.get(item_id).ok().filter(|item| &item.owner_id == user_id) else {
      response.skipped.push(skip(None, "It no longer exists."));
      continue;
    };
    if item.item_type == ItemType::Password {
      response.skipped.push(skip(Some(item), "A password can't be in a collection."));
      continue;
    }
    let Some(target) = resolve_content(db, item, user_id) else {
      response.skipped.push(skip(Some(item), "It is a link to an item that no longer exists, or to another link."));
      continue;
    };
    if target.id == collection.id {
      response.skipped.push(skip(Some(target), "A collection can't be a member of itself."));
      continue;
    }
    if is_in_trash(db, target) {
      response.skipped.push(skip(Some(target), "It is in the trash."));
      continue;
    }
    if !members.insert(target.id.clone()) {
      response.already_members.push(item_id.clone());
      continue;
    }
    let ordering = new_ordering_at_end(orderings.clone());
    orderings.push(ordering.clone());
    let mut link = Item::new_link(
      &collection.id,
      ordering,
      Vector { x: GRID_SIZE, y: next_y },
      NEW_LINK_WIDTH_GR,
      NEW_LINK_WIDTH_GR,
      RelationshipToParent::Child,
      &target.id,
    );
    next_y += NEW_LINK_SPACING_GR;
    link.owner_id = user_id.clone();
    new_links.push(link);
    response.added.push(item_id.clone());
  }

  let mut touched_container_ids = HashSet::new();
  let mut new_link_ids = Vec::new();
  for link in new_links {
    new_link_ids.push(link.id.clone());
    db.item.add(link.clone()).await?;
    let delta = build_child_upsert_delta(db, &link)?;
    record_container_delta(db, user_id, &collection.id, delta, &mut touched_container_ids);
  }
  response.member_count = members.len();
  Ok((response, new_link_ids))
}

pub(super) async fn handle_collection_remove(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to remove from a collection.")?;
  let request = parse_request(json_data)?;
  let (response, removed_link_ids) = {
    let mut db = db.lock().await;
    remove_members(&mut db, &session.user_id, &request.collection_id, &request.item_ids).await?
  };
  for link_id in removed_link_ids {
    enqueue_item_search_index_removal(&session.user_id, &link_id);
  }
  debug!("Executed 'collection-remove' command for user '{}'.", session.user_id);
  Ok(Some(serde_json::to_string(&response)?))
}

async fn remove_members(
  db: &mut MutexGuard<'_, Db>,
  user_id: &Uid,
  collection_id: &Uid,
  item_ids: &[Uid],
) -> InfuResult<(RemoveResponse, Vec<Uid>)> {
  let collection = writable_collection(db, user_id, collection_id)?;
  let mut response = RemoveResponse { removed: vec![], inherited: vec![], not_members: vec![], member_count: 0 };
  let mut removed_link_ids = Vec::new();
  let mut touched_container_ids = HashSet::new();
  for item_id in item_ids {
    let Some(target_id) =
      db.item.get(item_id).ok().and_then(|item| resolve_content(db, item, user_id)).map(|target| target.id.clone())
    else {
      response.not_members.push(item_id.clone());
      continue;
    };
    // Every direct link to the target, should the page hold more than one. A link with attachments is left alone,
    // as delete-item would refuse it; it stays a member.
    let link_ids = db
      .item
      .get_children(&collection.id)?
      .into_iter()
      .filter(|child| child.item_type == ItemType::Link && child.link_to.as_ref() == Some(&target_id))
      .filter(|child| db.item.get_attachment_ids(&child.id).is_ok_and(|ids| ids.is_empty()))
      .map(|child| child.id.clone())
      .collect::<Vec<_>>();
    if !link_ids.is_empty() {
      for link_id in link_ids {
        db.item.remove(&link_id).await?;
        let mut delta = ContainerSyncDelta::default();
        delta.add_child_delete(&link_id);
        record_container_delta(db, user_id, &collection.id, delta, &mut touched_container_ids);
        removed_link_ids.push(link_id);
      }
      response.removed.push(item_id.clone());
      continue;
    }
    let members = collection_member_targets(db, user_id, &collection)?.into_iter().collect::<HashSet<_>>();
    match db
      .item
      .get(&target_id)
      .ok()
      .and_then(|target| ancestor_chain(db, target).into_iter().skip(1).find(|ancestor| members.contains(&ancestor.id)))
    {
      Some(via) => response.inherited.push(InheritedItem {
        item_id: item_id.clone(),
        via_id: via.id.clone(),
        via_title: first_title_line(via),
      }),
      None => response.not_members.push(item_id.clone()),
    }
  }
  response.member_count = collection_member_targets(db, user_id, &collection)?.len();
  Ok((response, removed_link_ids))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::web::routes::command::scope::test_db::TestDb;

  type LockedDb = tokio::sync::Mutex<Db>;

  async fn add(db: &LockedDb, user_id: &Uid, collection: &Uid, ids: &[&Uid]) -> AddResponse {
    let ids = ids.iter().map(|id| (*id).clone()).collect::<Vec<_>>();
    add_members(&mut db.lock().await, user_id, collection, &ids).await.unwrap().0
  }

  async fn remove(db: &LockedDb, user_id: &Uid, collection: &Uid, ids: &[&Uid]) -> RemoveResponse {
    let ids = ids.iter().map(|id| (*id).clone()).collect::<Vec<_>>();
    remove_members(&mut db.lock().await, user_id, collection, &ids).await.unwrap().0
  }

  async fn targets(db: &LockedDb, user_id: &Uid, collection: &Uid) -> Vec<Uid> {
    let db = db.lock().await;
    collection_member_targets(&db, user_id, db.item.get(collection).unwrap()).unwrap()
  }

  #[tokio::test]
  async fn add_makes_targets_members_once_and_says_why_others_were_skipped() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let a = t.page(&home, "A").await;
    let b = t.page(&home, "B").await;
    let link_to_b = t.link(&home, &b).await;
    let broken = t.link(&home, &new_uid()).await;
    let password = t
      .non_note(&home, "", |item| {
        item.item_type = ItemType::Password;
        item.title = None;
        item.text = Some("hunter2".to_owned());
      })
      .await;
    let trashed = t.note(&t.trash_id.clone(), "old", RelationshipToParent::Child).await;
    let c = t.page(&home, "C").await;
    let collection = t.collection(&home, "Key sources").await;
    t.link(&collection, &a).await;
    let user_id = t.user_id.clone();
    let db = tokio::sync::Mutex::new(t.db);
    let missing = new_uid();

    let response =
      add(&db, &user_id, &collection, &[&a, &link_to_b, &b, &broken, &password, &trashed, &collection, &missing]).await;
    assert_eq!(response.added, vec![link_to_b.clone()], "a link adds its target, once");
    assert_eq!(response.already_members, vec![a.clone(), b.clone()]);
    let skipped = response.skipped.iter().map(|skip| (skip.item_id.clone(), skip.reason)).collect::<Vec<_>>();
    assert_eq!(
      skipped,
      vec![
        (broken.clone(), "It is a link to an item that no longer exists, or to another link."),
        (password.clone(), "A password can't be in a collection."),
        (trashed.clone(), "It is in the trash."),
        (collection.clone(), "A collection can't be a member of itself."),
        (missing.clone(), "It no longer exists."),
      ]
    );
    assert_eq!(response.skipped[2].title.as_deref(), Some("old"), "the user is told which item it was");
    assert_eq!(response.member_count, 2);
    assert_eq!(targets(&db, &user_id, &collection).await, vec![a.clone(), b.clone()], "appended after the last child");

    // New links go below the existing children of a spatial page, not on top of them.
    add(&db, &user_id, &collection, &[&c]).await;
    let db_locked = db.lock().await;
    let ys = db_locked
      .item
      .get_children(&collection)
      .unwrap()
      .iter()
      .map(|child| child.spatial_position_gr.as_ref().unwrap().y)
      .collect::<HashSet<_>>();
    assert_eq!(ys.len(), 3, "each link has its own place: {ys:?}");
  }

  #[tokio::test]
  async fn remove_deletes_every_link_to_a_target_and_names_the_member_covering_the_rest() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let financials = t.page(&home, "Financials").await;
    let q1 = t.note(&financials, "Q1", RelationshipToParent::Child).await;
    let other = t.page(&home, "Other").await;
    let collection = t.collection(&home, "Key sources").await;
    t.link(&collection, &financials).await;
    t.link(&collection, &financials).await;
    t.link(&collection, &other).await;
    let annotation = t.note(&collection, "why", RelationshipToParent::Child).await;
    let user_id = t.user_id.clone();
    let db = tokio::sync::Mutex::new(t.db);

    let response = remove(&db, &user_id, &collection, &[&q1, &other, &annotation]).await;
    assert_eq!(response.removed, vec![other.clone()]);
    assert_eq!(
      response.inherited,
      vec![InheritedItem { item_id: q1.clone(), via_id: financials.clone(), via_title: Some("Financials".to_owned()) }]
    );
    assert_eq!(response.not_members, vec![annotation.clone()]);
    assert_eq!(response.member_count, 1);

    let response = remove(&db, &user_id, &collection, &[&financials]).await;
    assert_eq!(response.removed, vec![financials.clone()]);
    assert_eq!(response.member_count, 0);
    assert!(targets(&db, &user_id, &collection).await.is_empty(), "both links to Financials went");
    assert_eq!(db.lock().await.item.get_children(&collection).unwrap().len(), 1, "the annotation stays");
  }

  #[tokio::test]
  async fn an_unavailable_collection_is_refused_by_name() {
    let mut t = TestDb::new().await;
    let a = t.page(&t.home_id.clone(), "A").await;
    let trashed = t.collection(&t.trash_id.clone(), "Old\nmore").await;
    let user_id = t.user_id.clone();
    let db = tokio::sync::Mutex::new(t.db);
    let error = add_members(&mut db.lock().await, &user_id, &trashed, &[a.clone()]).await;
    assert_eq!(error.err().map(|e| e.message().to_owned()).as_deref(), Some("\"Old\" is no longer a collection."));
  }
}
