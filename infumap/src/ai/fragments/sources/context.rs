use std::cmp::Ordering;

use infusdk::item::{ArrangeAlgorithm, Item, ItemType, RelationshipToParent};

use crate::storage::db::Db;
use crate::util::ordering::compare_orderings;

use super::normalized_text;

pub(super) fn container_child_title_lines(db: &Db, item: &Item) -> Vec<String> {
  ordered_container_children(db, item)
    .into_iter()
    .flat_map(|child| fragment_lines_for_display_item(db, child))
    .collect()
}

fn ordered_container_children<'a>(db: &'a Db, item: &Item) -> Vec<&'a Item> {
  let mut children = db.item.get_children(&item.id).unwrap_or_default();
  match item.item_type {
    ItemType::Page => match item.arrange_algorithm {
      Some(ArrangeAlgorithm::SpatialStretch) => {
        children.sort_by(|a, b| compare_spatial_position(a, b).then_with(|| compare_item_order(a, b)));
      }
      Some(ArrangeAlgorithm::Calendar) => {
        children.sort_by(|a, b| a.datetime.cmp(&b.datetime).then_with(|| compare_item_order(a, b)));
      }
      _ => sort_children_for_display(db, item, &mut children),
    },
    ItemType::Table | ItemType::Composite => sort_children_for_display(db, item, &mut children),
    _ => {}
  }
  children
}

fn sort_children_for_display(db: &Db, container: &Item, children: &mut Vec<&Item>) {
  let order_children_by = container.order_children_by.as_deref().unwrap_or_default();
  let use_title_sort = order_children_by == "title[ASC]"
    && !(container.item_type == ItemType::Page && container.arrange_algorithm == Some(ArrangeAlgorithm::Document));

  if use_title_sort {
    children.sort_by(|a, b| compare_items_by_display_title(db, a, b));
  } else {
    children.sort_by(|a, b| compare_item_order(a, b));
  }
}

fn compare_items_by_display_title(db: &Db, a: &Item, b: &Item) -> Ordering {
  let a_resolved = resolved_link_target(db, a);
  let b_resolved = resolved_link_target(db, b);

  let a_is_unresolved = a.item_type == ItemType::Link && a_resolved.is_none();
  let b_is_unresolved = b.item_type == ItemType::Link && b_resolved.is_none();

  match (a_is_unresolved, b_is_unresolved) {
    (true, false) => Ordering::Greater,
    (false, true) => Ordering::Less,
    _ => display_title_for_sort(a_resolved.unwrap_or(a))
      .cmp(&display_title_for_sort(b_resolved.unwrap_or(b)))
      .then_with(|| a.id.cmp(&b.id)),
  }
}

fn compare_item_order(a: &Item, b: &Item) -> Ordering {
  compare_ordering_bytes(&a.ordering, &b.ordering).then_with(|| a.id.cmp(&b.id))
}

fn compare_spatial_position(a: &Item, b: &Item) -> Ordering {
  let (a_y, a_x) = item_position_sort_key(a);
  let (b_y, b_x) = item_position_sort_key(b);
  a_y.cmp(&b_y).then(a_x.cmp(&b_x))
}

fn item_position_sort_key(item: &Item) -> (i64, i64) {
  item.spatial_position_gr.as_ref().map(|pos| (pos.y, pos.x)).unwrap_or((0, 0))
}

fn compare_ordering_bytes(a: &Vec<u8>, b: &Vec<u8>) -> Ordering {
  match compare_orderings(a, b) {
    -1 => Ordering::Less,
    1 => Ordering::Greater,
    _ => Ordering::Equal,
  }
}

fn display_title_for_sort(item: &Item) -> String {
  item.title.as_deref().map(str::trim).filter(|title| !title.is_empty()).unwrap_or("").to_lowercase()
}

fn fragment_lines_for_display_item(db: &Db, item: &Item) -> Vec<String> {
  if item.item_type == ItemType::Link {
    return resolved_link_target(db, item)
      .map(|target| fragment_lines_for_non_link_item(db, target))
      .unwrap_or_default();
  }
  fragment_lines_for_non_link_item(db, item)
}

fn fragment_lines_for_non_link_item(db: &Db, item: &Item) -> Vec<String> {
  match item.item_type {
    ItemType::Composite => ordered_container_children(db, item)
      .into_iter()
      .flat_map(|child| fragment_lines_for_display_item(db, child))
      .collect(),
    _ => item
      .title
      .as_deref()
      .map(str::trim)
      .filter(|title| !title.is_empty())
      .map(|title| vec![title.to_owned()])
      .unwrap_or_default(),
  }
}

fn resolved_link_target<'a>(db: &'a Db, item: &Item) -> Option<&'a Item> {
  if item.item_type != ItemType::Link {
    return None;
  }
  item.link_to.as_ref().and_then(|target_id| db.item.get(target_id).ok())
}

pub(super) fn container_title_for_item(db: &Db, item: &Item) -> Option<String> {
  parent_title_for_item(db, item, false)
}

pub fn embedding_context_title_for_item(db: &Db, item: &Item) -> Option<String> {
  parent_title_for_item(db, item, true)
}

fn parent_title_for_item(db: &Db, item: &Item, include_attachment_parents: bool) -> Option<String> {
  match item.relationship_to_parent {
    RelationshipToParent::Child => titled_non_system_parent(db, item),
    RelationshipToParent::Attachment if include_attachment_parents => titled_non_system_parent(db, item),
    RelationshipToParent::Attachment | RelationshipToParent::NoParent => None,
  }
}

fn titled_non_system_parent(db: &Db, item: &Item) -> Option<String> {
  let parent_id = item.parent_id.as_ref()?;
  let user = db.user.get(&item.owner_id)?;
  if parent_id == &user.home_page_id || parent_id == &user.trash_page_id || parent_id == &user.dock_page_id {
    return None;
  }
  let parent = db.item.get(parent_id).ok()?;
  normalized_text(parent.title.as_deref())
}
