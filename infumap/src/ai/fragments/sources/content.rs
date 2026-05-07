use infusdk::item::{Item, ItemType};

use crate::storage::db::Db;

use super::context::{container_child_title_lines, container_title_for_item};
use super::{FragmentSource, FragmentSourceKind, build_titled_fragment_text, normalized_text, single_fragment_source};

pub fn content_fragment_source_for_item(db: &Db, item: &Item) -> Option<FragmentSource> {
  match item.item_type {
    ItemType::Page => container_fragment_source(db, item, FragmentSourceKind::PageContents),
    ItemType::Table => container_fragment_source(db, item, FragmentSourceKind::TableContents),
    _ => None,
  }
}

fn container_fragment_source(db: &Db, item: &Item, source_kind: FragmentSourceKind) -> Option<FragmentSource> {
  let own_title = normalized_text(item.title.as_deref());
  let lines = container_child_title_lines(db, item);
  if lines.is_empty() && own_title.is_none() {
    return None;
  }

  Some(single_fragment_source(
    source_kind,
    build_titled_fragment_text(lines.join("\n"), own_title.or_else(|| container_title_for_item(db, item))),
  ))
}
