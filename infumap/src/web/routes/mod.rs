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

use infusdk::{
  item::{
    ArrangeAlgorithm, Item, ItemType, LIST_PAGE_PIN_BOTTOM_FLAG, LIST_PAGE_PIN_TOP_FLAG, RelationshipToParent,
    TableColumn,
  },
  util::{
    geometry::{GRID_SIZE, Vector},
    infu::InfuResult,
    uid::Uid,
  },
};
use sha2::{Digest, Sha256};

use crate::storage::db::Db;
use crate::util::ordering::new_ordering_at_end;

pub mod account;
pub mod admin;
pub mod command;
pub mod favicons;
pub mod files;
pub mod ingest;
pub mod link_titles;

pub fn default_home_page(
  owner_id: &str,
  title: &str,
  home_page_id: Uid,
  inner_spatial_width_br: i64,
  natural_aspect: f64,
) -> Item {
  let mut item = Item::new_page(
    None,
    vec![128],
    Vector { x: 0, y: 0 },
    60 * GRID_SIZE,
    RelationshipToParent::NoParent,
    title,
    "",
    0,
    0,
    0,
    natural_aspect,
    inner_spatial_width_br * GRID_SIZE,
    ArrangeAlgorithm::SpatialStretch,
    4,
    1.5,
    36,
    7.0,
    1.0,
    vec![TableColumn { width_gr: 480, name: "Title".to_owned() }],
    1,
  );

  item.owner_id = String::from(owner_id);
  item.id = home_page_id;

  item
}

pub fn default_trash_page(owner_id: &str, trash_page_id: Uid, natural_aspect: f64) -> Item {
  let inner_spatial_width_br: i64 = 60;

  let mut item = Item::new_page(
    None,
    vec![128],
    Vector { x: 0, y: 0 },
    inner_spatial_width_br * GRID_SIZE,
    RelationshipToParent::NoParent,
    "Trash",
    "",
    0,
    0,
    0,
    natural_aspect,
    inner_spatial_width_br * GRID_SIZE,
    ArrangeAlgorithm::SpatialStretch,
    4,
    1.5,
    36,
    7.0,
    1.0,
    vec![TableColumn { width_gr: 480, name: "Title".to_owned() }],
    1,
  );

  item.owner_id = String::from(owner_id);
  item.id = trash_page_id;

  item
}

pub fn default_dock_page(owner_id: &str, dock_page_id: Uid, natural_aspect: f64) -> Item {
  let inner_spatial_width_br: i64 = 60;

  let mut item = Item::new_page(
    None,
    vec![128],
    Vector { x: 0, y: 0 },
    inner_spatial_width_br * GRID_SIZE,
    RelationshipToParent::NoParent,
    "Dock",
    "",
    0,
    0,
    0,
    natural_aspect,
    inner_spatial_width_br * GRID_SIZE,
    ArrangeAlgorithm::SpatialStretch,
    1,
    1.5,
    36,
    7.0,
    1.0,
    vec![TableColumn { width_gr: 480, name: "Title".to_owned() }],
    1,
  );

  item.owner_id = String::from(owner_id);
  item.id = dock_page_id;

  item
}

pub fn default_queries_page(owner_id: &str, queries_page_id: Uid, natural_aspect: f64) -> Item {
  let inner_spatial_width_br: i64 = 60;

  let mut item = Item::new_page(
    None,
    vec![128],
    Vector { x: 0, y: 0 },
    inner_spatial_width_br * GRID_SIZE,
    RelationshipToParent::NoParent,
    "Queries",
    "",
    0,
    0,
    0,
    natural_aspect,
    inner_spatial_width_br * GRID_SIZE,
    ArrangeAlgorithm::List,
    1,
    1.5,
    36,
    7.0,
    1.0,
    vec![TableColumn { width_gr: 480, name: "Title".to_owned() }],
    1,
  );

  item.owner_id = String::from(owner_id);
  item.id = queries_page_id;

  item
}

pub fn default_query_item(owner_id: &str, queries_page_id: &Uid, query_item_id: Uid, _page_width_bl: i64) -> Item {
  let mut item = Item::new_query(
    queries_page_id,
    vec![128],
    Vector { x: 9 * GRID_SIZE, y: GRID_SIZE },
    6 * GRID_SIZE,
    RelationshipToParent::Child,
  );

  item.owner_id = String::from(owner_id);
  item.id = query_item_id;
  item.flags = Some(item.flags.unwrap_or(0) | LIST_PAGE_PIN_TOP_FLAG);

  item
}

/// The scopes page is derived from the user id, rather than stored on the user record, so that
/// existing users can be given one without a user log migration.
pub fn scopes_page_id(user_id: &str) -> Uid {
  let mut hasher = Sha256::new();
  hasher.update(b"infumap-scopes-page-id-v1");
  hasher.update([0]);
  hasher.update(user_id.as_bytes());
  hasher.finalize().iter().take(16).map(|byte| format!("{:02x}", byte)).collect()
}

pub fn is_scopes_page_item(item: &Item) -> bool {
  item.item_type == ItemType::Page
    && item.relationship_to_parent == RelationshipToParent::Child
    && item.id == scopes_page_id(&item.owner_id)
}

pub fn default_scopes_page(owner_id: &str, queries_page_id: &Uid, ordering: Vec<u8>, natural_aspect: f64) -> Item {
  let inner_spatial_width_br: i64 = 60;

  let mut item = Item::new_page(
    Some(queries_page_id),
    ordering,
    Vector { x: GRID_SIZE, y: GRID_SIZE },
    3 * GRID_SIZE,
    RelationshipToParent::Child,
    "Scopes",
    "",
    0,
    0,
    0,
    natural_aspect,
    inner_spatial_width_br * GRID_SIZE,
    ArrangeAlgorithm::List,
    1,
    1.5,
    36,
    7.0,
    1.0,
    vec![TableColumn { width_gr: 480, name: "Title".to_owned() }],
    1,
  );

  item.owner_id = String::from(owner_id);
  item.id = scopes_page_id(owner_id);
  item.flags = Some(item.flags.unwrap_or(0) | LIST_PAGE_PIN_BOTTOM_FLAG);

  item
}

/// Adds the scopes page to the end of the user's queries page if it does not exist yet.
/// Returns true if it was created.
pub async fn ensure_scopes_page(db: &mut Db, user_id: &Uid) -> InfuResult<bool> {
  let scopes_page_id = scopes_page_id(user_id);
  if db.item.get(&scopes_page_id).is_ok() {
    return Ok(false);
  }

  let user = db.user.get(user_id).ok_or(format!("Unknown user '{}'.", user_id))?;
  let queries_page_id = user.queries_page_id.clone();
  let natural_aspect = user.default_page_natural_aspect;
  let ordering =
    new_ordering_at_end(db.item.get_children(&queries_page_id)?.iter().map(|item| item.ordering.clone()).collect());
  db.item.add(default_scopes_page(user_id, &queries_page_id, ordering, natural_aspect)).await?;
  Ok(true)
}

#[cfg(test)]
mod tests {
  use super::*;
  use infusdk::util::uid::is_uid;

  #[test]
  fn scopes_page_id_is_a_stable_per_user_uid() {
    let user_a = "0123456789abcdef0123456789abcdef";
    let user_b = "fedcba9876543210fedcba9876543210";
    assert!(is_uid(&scopes_page_id(user_a)));
    assert_eq!(scopes_page_id(user_a), scopes_page_id(user_a));
    assert_ne!(scopes_page_id(user_a), scopes_page_id(user_b));
  }

  #[test]
  fn default_scopes_page_is_pinned_to_bottom_of_queries_page() {
    let owner_id = "0123456789abcdef0123456789abcdef";
    let queries_page_id = "00000000000000000000000000000001".to_owned();
    let page = default_scopes_page(owner_id, &queries_page_id, vec![200], 2.0);
    assert!(is_scopes_page_item(&page));
    assert_eq!(page.parent_id.as_ref(), Some(&queries_page_id));
    assert_eq!(page.title.as_deref(), Some("Scopes"));
    assert_ne!(page.flags.unwrap_or(0) & LIST_PAGE_PIN_BOTTOM_FLAG, 0);
    assert_eq!(page.flags.unwrap_or(0) & LIST_PAGE_PIN_TOP_FLAG, 0);
  }
}
