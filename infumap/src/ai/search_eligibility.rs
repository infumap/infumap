use std::collections::HashSet;

use infusdk::item::Item;

use crate::storage::db::Db;

/// Follow containment, including attachments, rather than links: a link in trash must not exclude its target.
pub fn is_in_trash(db: &Db, item: &Item) -> bool {
  let Some(user) = db.user.get(&item.owner_id) else { return false };
  let mut current = item;
  let mut seen = HashSet::new();
  loop {
    if current.id == user.trash_page_id {
      return true;
    }
    // Invalid containment must not loop forever or admit items into search.
    if !seen.insert(&current.id) {
      return true;
    }
    let Some(parent_id) = current.parent_id.as_ref() else { return false };
    let Ok(parent) = db.item.get(parent_id) else { return false };
    current = parent;
  }
}
