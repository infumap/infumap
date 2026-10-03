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

//! Backlinks: the user's links and notes that refer to an item.
//!
//! A link refers to its target. A note refers to the items its infumap:// urls point to. Links do
//! not chain, so a link to a link to the item is not a backlink. Links and notes owned by other
//! users, those in the trash and links to remote items are not reported.

use super::search::{SearchPathElement, item_path};
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum BacklinkKind {
  Link,
  Note,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Backlink {
  /// The link or note.
  pub item_id: Uid,
  pub kind: BacklinkKind,
  /// The containers from a root page down to the link or note's parent.
  pub path: Vec<SearchPathElement>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetBacklinksRequest {
  item_id: Uid,
}

#[derive(Serialize)]
struct GetBacklinksResponse {
  backlinks: Vec<Backlink>,
}

pub(super) async fn handle_get_backlinks(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to get backlinks.")?;
  let response = get_backlinks_json(&*db.lock().await, &session.user_id, json_data)?;
  debug!("Executed 'get-backlinks' command for user '{}'.", session.user_id);
  Ok(Some(response))
}

fn get_backlinks_json(db: &Db, user_id: &Uid, json_data: &str) -> InfuResult<String> {
  let request: GetBacklinksRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;
  let response = GetBacklinksResponse { backlinks: backlinks(db, user_id, &request.item_id)? };
  Ok(serde_json::to_string(&response)?)
}

/// The user's links and notes that refer to the target, sorted by path. The target must be owned by the user.
pub(super) fn backlinks(db: &Db, user_id: &Uid, target_id: &Uid) -> InfuResult<Vec<Backlink>> {
  let target = db.item.get(target_id)?;
  if &target.owner_id != user_id {
    return Err(format!("Item '{}' is not owned by user '{}'.", target_id, user_id).into());
  }
  let user = db.user.get(user_id).ok_or(format!("Unknown user '{}'.", user_id))?;

  let mut result = Vec::new();
  for item_id in db.item.get_linked_from_ids(target_id) {
    let kind = match db.item.get(&item_id)?.item_type {
      ItemType::Link => BacklinkKind::Link,
      ItemType::Note => BacklinkKind::Note,
      _ => continue,
    };
    let Some(mut path) = item_path(db, &item_id, user_id)? else {
      continue;
    };
    if path.first().is_some_and(|root| root.id == user.trash_page_id) {
      continue;
    }
    path.pop();
    result.push(Backlink { item_id, kind, path });
  }
  result.sort_by_cached_key(|backlink| {
    let titles: Vec<String> =
      backlink.path.iter().map(|element| element.title.as_deref().unwrap_or("").to_lowercase()).collect();
    (titles, backlink.item_id.clone())
  });
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::super::scope::test_db::TestDb;
  use super::*;
  use crate::storage::db::user::User;
  use crate::web::routes::default_home_page;
  use infusdk::item::NoteFlags;

  fn titles(backlink: &Backlink) -> Vec<&str> {
    backlink.path.iter().map(|element| element.title.as_deref().unwrap_or("")).collect()
  }

  #[tokio::test]
  async fn backlinks_are_the_users_links_outside_the_trash() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let trash = t.trash_id.clone();
    let target = t.page(&home, "Target").await;
    let beta = t.page(&home, "beta").await;
    let alpha = t.page(&home, "Alpha").await;
    let alpha_inner = t.page(&alpha, "Inner").await;

    let from_beta = t.link(&beta, &target).await;
    let from_alpha_inner = t.link(&alpha_inner, &target).await;
    let from_home = t.link(&home, &target).await;
    t.link(&trash, &target).await;
    t.link(&home, &beta).await;

    let found = backlinks(&t.db, &t.user_id, &target).unwrap();
    assert_eq!(
      found.iter().map(|backlink| &backlink.item_id).collect::<Vec<_>>(),
      vec![&from_home, &from_alpha_inner, &from_beta],
      "sorted by path, case-insensitively"
    );
    assert_eq!(titles(&found[1]), vec!["test", "Alpha", "Inner"]);
    assert_eq!(found[1].path.first().unwrap().id, home, "the path starts at a root page");
    assert_eq!(found[1].path.last().unwrap().id, alpha_inner, "and ends at the link's parent");

    assert!(backlinks(&t.db, &t.user_id, &alpha).unwrap().is_empty());
  }

  #[tokio::test]
  async fn other_users_links_are_not_backlinks() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let target = t.page(&home, "Target").await;

    let other = User { id: new_uid(), username: "other".to_owned(), ..t.db.user.get(&t.user_id).unwrap().clone() };
    let other_home = new_uid();
    t.db.user.add(other.clone()).await.unwrap();
    t.db.item.load_user_items(&other.id, true).await.unwrap();
    t.db.item.add(default_home_page(&other.id, "other", other_home.clone(), 60, 2.0)).await.unwrap();
    let mut link = Item::new_link(
      &other_home,
      vec![128],
      Vector { x: 0, y: 0 },
      GRID_SIZE,
      GRID_SIZE,
      RelationshipToParent::Child,
      &target,
    );
    link.owner_id = other.id.clone();
    t.db.item.add(link).await.unwrap();

    assert_eq!(t.db.item.get_linked_from_ids(&target).len(), 1);
    assert!(backlinks(&t.db, &t.user_id, &target).unwrap().is_empty());
    assert!(backlinks(&t.db, &other.id, &target).is_err(), "the target must be owned by the user");
  }

  #[tokio::test]
  async fn notes_with_infumap_urls_are_backlinks() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let target = t.page(&home, "Target").await;
    let link = t.link(&home, &target).await;
    let note = Item::new_note(
      &home,
      vec![],
      Vector { x: 0, y: 0 },
      GRID_SIZE,
      RelationshipToParent::Child,
      "see target",
      NoteFlags::None,
      Some(format!("infumap://{}", target)),
    );
    let note = t.add(note).await;

    let found = backlinks(&t.db, &t.user_id, &target).unwrap();
    let mut kinds = found.iter().map(|backlink| (backlink.item_id.clone(), backlink.kind)).collect::<Vec<_>>();
    kinds.sort_by(|a, b| a.0.cmp(&b.0));
    let mut expected = vec![(link, BacklinkKind::Link), (note, BacklinkKind::Note)];
    expected.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(kinds, expected);
  }

  #[tokio::test]
  async fn get_backlinks_json_shape() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let target = t.page(&home, "Target").await;
    let link = t.link(&home, &target).await;

    let request = serde_json::json!({ "itemId": target }).to_string();
    let response: Value = serde_json::from_str(&get_backlinks_json(&t.db, &t.user_id, &request).unwrap()).unwrap();
    assert_eq!(
      response,
      serde_json::json!({ "backlinks": [{ "itemId": link, "kind": "link", "path": [{ "itemType": "page", "title": "test", "id": home }] }] })
    );

    assert!(get_backlinks_json(&t.db, &t.user_id, r#"{"id": "x"}"#).is_err(), "unknown fields are rejected");
  }
}
