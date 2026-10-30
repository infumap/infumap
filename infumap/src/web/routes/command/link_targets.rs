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

//! Link target candidates: the user's items whose titles match what has been typed into a link's target field.
//!
//! Every word typed must be a prefix of some word in the title. The user's items are scanned on each request rather
//! than indexed, so this costs no memory beyond the items already loaded. Links (which do not chain), passwords,
//! untitled items and items in the trash are not candidates. Items owned by other users and remote items are not
//! considered.

use super::search::{SearchPathElement, item_path};
use super::*;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};

/// Fewer characters than this match too many items to be useful.
const MIN_QUERY_CHARS: usize = 2;
const MAX_CANDIDATES: usize = 20;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LinkTargetCandidatesRequest {
  text: String,
  limit: usize,
  item_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LinkTargetCandidate {
  pub id: Uid,
  pub item_type: String,
  pub title: String,
  /// The containers from a root page down to the item's parent.
  pub path: Vec<SearchPathElement>,
}

#[derive(Serialize)]
struct LinkTargetCandidatesResponse {
  candidates: Vec<LinkTargetCandidate>,
}

pub(super) async fn handle_link_target_candidates(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to get link target candidates.")?;
  let started = Instant::now();
  let response = link_target_candidates_json(&*db.lock().await, &session.user_id, json_data)?;
  debug!("Executed 'link-target-candidates' command for user '{}' in {:?}.", session.user_id, started.elapsed());
  Ok(Some(response))
}

fn link_target_candidates_json(db: &Db, user_id: &Uid, json_data: &str) -> InfuResult<String> {
  let request: LinkTargetCandidatesRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;
  let candidates = match request.item_type.as_deref() {
    None => link_target_candidates(db, user_id, &request.text, request.limit)?,
    item_type => link_target_candidates_matching_type(db, user_id, &request.text, request.limit, item_type)?,
  };
  let response = LinkTargetCandidatesResponse { candidates };
  Ok(serde_json::to_string(&response)?)
}

/// Lowercased words, split on anything that is not alphanumeric.
fn words(text: &str) -> Vec<String> {
  text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_owned).collect()
}

/// Smaller is better. Exact matches come first, then pages and tables, then titles starting with the query, then
/// shorter titles, then the most recently modified.
type RankKey<'a> = (bool, bool, bool, usize, Reverse<i64>, &'a Uid);

/// The rank of the item if its title matches the query words, else None.
fn rank<'a>(item: &'a Item, title: &str, query: &[String]) -> Option<RankKey<'a>> {
  let title_words = words(title);
  if !query.iter().all(|q| title_words.iter().any(|w| w.starts_with(q.as_str()))) {
    return None;
  }
  let exact = title_words == query;
  let (last, init) = query.split_last()?;
  let starts_with = title_words.len() >= query.len()
    && title_words[..init.len()] == *init
    && title_words[init.len()].starts_with(last.as_str());
  let container = matches!(item.item_type, ItemType::Page | ItemType::Table);
  Some((!exact, !container, !starts_with, title.chars().count(), Reverse(item.last_modified_date), &item.id))
}

/// Whether the item is the trash page or inside it. Items whose parent chain is broken are treated as unreachable.
fn in_trash_or_unreachable(db: &Db, item: &Item, trash_page_id: &Uid) -> bool {
  let mut seen = HashSet::new();
  let mut current = item;
  loop {
    if &current.id == trash_page_id || !seen.insert(&current.id) {
      return true;
    }
    let Some(parent_id) = current.parent_id.as_ref() else {
      return false;
    };
    match db.item.get(parent_id) {
      Ok(parent) => current = parent,
      Err(_) => return true,
    }
  }
}

/// The user's best `limit` (at most MAX_CANDIDATES) link targets for the text, best first.
pub(super) fn link_target_candidates(
  db: &Db,
  user_id: &Uid,
  text: &str,
  limit: usize,
) -> InfuResult<Vec<LinkTargetCandidate>> {
  link_target_candidates_matching_type(db, user_id, text, limit, None)
}

fn link_target_candidates_matching_type(
  db: &Db,
  user_id: &Uid,
  text: &str,
  limit: usize,
  item_type: Option<&str>,
) -> InfuResult<Vec<LinkTargetCandidate>> {
  let query = words(text);
  let limit = limit.min(MAX_CANDIDATES);
  if limit == 0 || query.iter().map(|w| w.chars().count()).sum::<usize>() < MIN_QUERY_CHARS {
    return Ok(vec![]);
  }
  let user = db.user.get(user_id).ok_or(format!("Unknown user '{}'.", user_id))?;

  // A max-heap on rank, so the worst of the best `limit` so far is the one dropped.
  let mut best = BinaryHeap::<RankKey>::with_capacity(limit + 1);
  for item in db.item.user_items(user_id) {
    // Filter before ranking and limiting, so other item types cannot crowd out matching notes.
    if item_type.is_some_and(|wanted| item.item_type.as_str() != wanted) {
      continue;
    }
    // passwords cannot have a title, but are excluded explicitly in case that changes.
    if matches!(item.item_type, ItemType::Link | ItemType::Password) {
      continue;
    }
    let Some(title) = item.title.as_deref().filter(|t| !t.trim().is_empty()) else {
      continue;
    };
    let Some(key) = rank(item, title, &query) else {
      continue;
    };
    if best.len() == limit && best.peek().is_some_and(|worst| key >= *worst) {
      continue;
    }
    if in_trash_or_unreachable(db, item, &user.trash_page_id) {
      continue;
    }
    best.push(key);
    if best.len() > limit {
      best.pop();
    }
  }

  let mut result = Vec::with_capacity(best.len());
  for (.., id) in best.into_sorted_vec() {
    let Some(mut path) = item_path(db, id, user_id)? else {
      continue;
    };
    path.pop();
    let item = db.item.get(id)?;
    result.push(LinkTargetCandidate {
      id: id.clone(),
      item_type: item.item_type.as_str().to_owned(),
      title: item.title.clone().unwrap_or_default(),
      path,
    });
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::super::scope::test_db::TestDb;
  use super::*;
  use crate::storage::db::user::User;
  use crate::web::routes::default_home_page;

  fn ids(t: &TestDb, text: &str) -> Vec<Uid> {
    link_target_candidates(&t.db, &t.user_id, text, MAX_CANDIDATES).unwrap().into_iter().map(|c| c.id).collect()
  }

  #[tokio::test]
  async fn every_query_word_must_prefix_a_title_word() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let page = t.page(&home, "Project meeting-notes").await;

    assert_eq!(ids(&t, "proj notes"), vec![page.clone()]);
    assert_eq!(ids(&t, "NOTES proj"), vec![page.clone()], "case-insensitive and in any order");
    assert_eq!(ids(&t, "meeting"), vec![page.clone()], "punctuation separates words");
    assert!(ids(&t, "roject").is_empty(), "words match by prefix, not substring");
    assert!(ids(&t, "proj minutes").is_empty(), "all query words must match");
  }

  #[tokio::test]
  async fn links_untitled_trash_and_other_users_are_not_candidates() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let trash = t.trash_id.clone();
    let target = t.page(&home, "Zebra target").await;
    t.link(&home, &target).await;
    t.non_note(&home, "Zebra", |item| item.title = None).await;
    let trashed_page = t.page(&trash, "Zebra trashed").await;
    t.note(&trashed_page, "Zebra inside trashed", RelationshipToParent::Child).await;

    let other = User { id: new_uid(), username: "other".to_owned(), ..t.db.user.get(&t.user_id).unwrap().clone() };
    let other_home = new_uid();
    t.db.user.add(other.clone()).await.unwrap();
    t.db.item.load_user_items(&other.id, true).await.unwrap();
    t.db.item.add(default_home_page(&other.id, "Zebra other", other_home, 60, 2.0)).await.unwrap();

    assert_eq!(ids(&t, "zebra"), vec![target]);
  }

  #[tokio::test]
  async fn ranking() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let older = t.note_with(&home, "Recipes old", |item| item.last_modified_date = 1).await;
    let newer = t.note_with(&home, "Recipes new", |item| item.last_modified_date = 2).await;
    let longer = t.note_with(&home, "Recipes longer", |item| item.last_modified_date = 3).await;
    let not_starting = t.note_with(&home, "Old recipes", |item| item.last_modified_date = 3).await;
    let page = t.page(&home, "Family recipes collection").await;
    let table = t.non_note(&home, "My recipes", |item| item.item_type = ItemType::Table).await;
    let exact = t.note(&home, "Recipes", RelationshipToParent::Child).await;

    assert_eq!(
      ids(&t, "recipes"),
      vec![exact, table, page, newer, older, longer, not_starting],
      "exact, then pages and tables (shorter first), then starting with the query, then shorter, then more recent"
    );
  }

  #[tokio::test]
  async fn starts_with_allows_the_last_word_to_be_partial() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let not_starting = t.note(&home, "Travel ideas", RelationshipToParent::Child).await;
    let starting = t.note(&home, "Ideas for travelling", RelationshipToParent::Child).await;

    assert_eq!(ids(&t, "ideas for trav"), vec![starting.clone()]);
    assert_eq!(ids(&t, "ideas trav"), vec![not_starting, starting], "not a prefix of either, so shorter first");
  }

  #[tokio::test]
  async fn limit_and_short_queries() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    for i in 0..(MAX_CANDIDATES + 5) {
      t.note(&home, &format!("Item {i}"), RelationshipToParent::Child).await;
    }

    assert_eq!(link_target_candidates(&t.db, &t.user_id, "item", 3).unwrap().len(), 3);
    assert_eq!(link_target_candidates(&t.db, &t.user_id, "item", 1000).unwrap().len(), MAX_CANDIDATES);
    assert!(link_target_candidates(&t.db, &t.user_id, "item", 0).unwrap().is_empty());
    assert!(ids(&t, "i").is_empty(), "too short");
    assert!(ids(&t, " - ").is_empty(), "no words");
  }

  #[tokio::test]
  async fn link_target_candidates_json_shape() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let parent = t.page(&home, "Parent").await;
    let child = t.note(&parent, "Child note", RelationshipToParent::Child).await;

    let request = serde_json::json!({ "text": "child", "limit": 5 }).to_string();
    let response: Value =
      serde_json::from_str(&link_target_candidates_json(&t.db, &t.user_id, &request).unwrap()).unwrap();
    assert_eq!(
      response,
      serde_json::json!({ "candidates": [{
        "id": child,
        "itemType": "note",
        "title": "Child note",
        "path": [
          { "itemType": "page", "title": "test", "id": home },
          { "itemType": "page", "title": "Parent", "id": parent },
        ],
      }] })
    );

    assert!(
      link_target_candidates_json(&t.db, &t.user_id, r#"{"text": "x", "limit": 5, "id": "x"}"#).is_err(),
      "unknown fields are rejected"
    );
  }
}
