use infusdk::item::{Item, ItemType};
use infusdk::util::infu::InfuResult;

use crate::storage::db::Db;

use super::super::ITEM_TITLE_SOURCE_KIND;
use super::{normalized_text, parent_title_for_item};

pub const ITEM_TITLE_FRAGMENT_ORDINAL: usize = 1_000_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemTitleFragment {
  pub item_id: String,
  pub ordinal: usize,
  pub source_kind: &'static str,
  /// The item's own title and its attachments' titles.
  pub text: String,
  /// Its parent's title: where the item is, which helps it match but cannot match it alone.
  pub context: Option<String>,
}

pub fn item_title_fragment_for_item(db: &Db, item: &Item) -> InfuResult<Option<ItemTitleFragment>> {
  if item.item_type == ItemType::Password {
    return Ok(None);
  }

  let Some(title) = normalized_text(item.title.as_deref()) else {
    return Ok(None);
  };
  let mut lines = vec![title];
  lines.extend(item_attachment_title_text(db, item)?);

  Ok(Some(ItemTitleFragment {
    item_id: item.id.clone(),
    ordinal: ITEM_TITLE_FRAGMENT_ORDINAL,
    source_kind: ITEM_TITLE_SOURCE_KIND,
    text: lines.join("\n"),
    context: parent_title_for_item(db, item, false),
  }))
}

fn item_attachment_title_text(db: &Db, item: &Item) -> InfuResult<Option<String>> {
  let attachment_titles = db
    .item
    .get_attachments(&item.id)?
    .into_iter()
    .filter(|attachment| attachment.item_type != ItemType::Password)
    .filter_map(|attachment| normalized_text(attachment.title.as_deref()))
    .collect::<Vec<_>>();
  if attachment_titles.is_empty() { Ok(None) } else { Ok(Some(attachment_titles.join(", "))) }
}
