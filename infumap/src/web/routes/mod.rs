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
  item::{ArrangeAlgorithm, Item, ItemType, PinnedTo, RelationshipToParent, TableColumn},
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
    vec![TableColumn { width_gr: 480, name: "Title".to_owned(), align: None }],
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
    vec![TableColumn { width_gr: 480, name: "Title".to_owned(), align: None }],
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
    vec![TableColumn { width_gr: 480, name: "Title".to_owned(), align: None }],
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
    vec![TableColumn { width_gr: 480, name: "Title".to_owned(), align: None }],
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
  item.pinned_to = Some(PinnedTo::Top);

  item
}

/// Skills keeps the former Prompts page ID so existing links and items keep their placement.
///
/// Earlier versions also had a Scopes page, derived from `b"infumap-scopes-page-id-v1"`. Collections replaced it.
/// Existing ones are left as ordinary pages; that domain must not be reused for another page.
pub fn prompts_page_id(user_id: &str) -> Uid {
  queries_subpage_id(b"infumap-prompts-page-id-v1", user_id)
}

fn queries_subpage_id(domain: &[u8], user_id: &str) -> Uid {
  let mut hasher = Sha256::new();
  hasher.update(domain);
  hasher.update([0]);
  hasher.update(user_id.as_bytes());
  hasher.finalize().iter().take(16).map(|byte| format!("{:02x}", byte)).collect()
}

const SKILLS_PAGE_TITLE: &str = "Skills";

/// The name of the system page pinned to the bottom of Queries.
pub fn queries_subpage_name(user_id: &str, id: &str) -> Option<&'static str> {
  (id == prompts_page_id(user_id)).then_some(SKILLS_PAGE_TITLE)
}

pub fn is_queries_subpage_item(item: &Item) -> bool {
  item.item_type == ItemType::Page
    && item.relationship_to_parent == RelationshipToParent::Child
    && queries_subpage_name(&item.owner_id, &item.id).is_some()
}

pub fn default_prompts_page(owner_id: &str, queries_page_id: &Uid, ordering: Vec<u8>, natural_aspect: f64) -> Item {
  default_queries_subpage(
    owner_id,
    queries_page_id,
    prompts_page_id(owner_id),
    SKILLS_PAGE_TITLE,
    ordering,
    natural_aspect,
  )
}

fn default_queries_subpage(
  owner_id: &str,
  queries_page_id: &Uid,
  id: Uid,
  title: &str,
  ordering: Vec<u8>,
  natural_aspect: f64,
) -> Item {
  let inner_spatial_width_br: i64 = 60;

  let mut item = Item::new_page(
    Some(queries_page_id),
    ordering,
    Vector { x: GRID_SIZE, y: GRID_SIZE },
    3 * GRID_SIZE,
    RelationshipToParent::Child,
    title,
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
    vec![TableColumn { width_gr: 480, name: "Title".to_owned(), align: None }],
    1,
  );

  item.owner_id = String::from(owner_id);
  item.id = id;
  item.pinned_to = Some(PinnedTo::Bottom);

  item
}

/// Places Skills at the end of Queries, keeping the original page ID and its children.
pub async fn ensure_prompts_page(db: &mut Db, user_id: &Uid) -> InfuResult<bool> {
  let prompts_page_id = prompts_page_id(user_id);
  let user = db.user.get(user_id).ok_or(format!("Unknown user '{}'.", user_id))?;
  let queries_page_id = user.queries_page_id.clone();
  let natural_aspect = user.default_page_natural_aspect;
  if let Ok(page) = db.item.get(&prompts_page_id) {
    let bottom = db
      .item
      .get_children(&queries_page_id)?
      .into_iter()
      .filter(|item| item.id != page.id && item.pinned_to == Some(PinnedTo::Bottom));
    let later_pins = bottom
      .filter(|item| (&item.ordering, &item.id) >= (&page.ordering, &page.id))
      .map(|item| item.ordering.clone())
      .collect::<Vec<_>>();
    if page.title.as_deref() != Some(SKILLS_PAGE_TITLE)
      || page.arrange_algorithm != Some(ArrangeAlgorithm::List)
      || !later_pins.is_empty()
    {
      let mut page = page.clone();
      page.title = Some(SKILLS_PAGE_TITLE.to_owned());
      page.arrange_algorithm = Some(ArrangeAlgorithm::List);
      if !later_pins.is_empty() {
        page.ordering = new_ordering_at_end(later_pins);
      }
      db.item.update(&page).await?;
    }
    return Ok(false);
  }
  let ordering =
    new_ordering_at_end(db.item.get_children(&queries_page_id)?.iter().map(|item| item.ordering.clone()).collect());
  db.item.add(default_prompts_page(user_id, &queries_page_id, ordering, natural_aspect)).await?;
  Ok(true)
}

#[cfg(test)]
mod tests {
  use super::*;
  use infusdk::util::uid::is_uid;

  #[test]
  fn queries_subpage_ids_are_stable_per_user_uids() {
    let user_a = "0123456789abcdef0123456789abcdef";
    let user_b = "fedcba9876543210fedcba9876543210";
    assert!(is_uid(&prompts_page_id(user_a)));
    assert_eq!(prompts_page_id(user_a), prompts_page_id(user_a));
    assert_ne!(prompts_page_id(user_a), prompts_page_id(user_b));
    // The retired Scopes page is an ordinary page now.
    let old_scopes_page_id = queries_subpage_id(b"infumap-scopes-page-id-v1", user_a);
    assert_ne!(old_scopes_page_id, prompts_page_id(user_a));
    assert_eq!(queries_subpage_name(user_a, &old_scopes_page_id), None);
  }

  #[test]
  fn queries_subpages_are_pinned_to_bottom_of_queries_page() {
    let owner_id = "0123456789abcdef0123456789abcdef";
    let queries_page_id = "00000000000000000000000000000001".to_owned();
    for (page, title) in [(default_prompts_page(owner_id, &queries_page_id, vec![190], 2.0), "Prompts")] {
      assert!(is_queries_subpage_item(&page));
      assert_eq!(queries_subpage_name(owner_id, &page.id), Some(title));
      assert_eq!(page.parent_id.as_ref(), Some(&queries_page_id));
      assert_eq!(page.title.as_deref(), Some(title));
      assert_eq!(page.pinned_to, Some(PinnedTo::Bottom));
    }
  }
}
