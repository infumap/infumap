#![allow(dead_code)]

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
  pub text: String,
}

pub fn item_title_fragment_for_item(db: &Db, item: &Item) -> InfuResult<Option<ItemTitleFragment>> {
  if item.item_type == ItemType::Password {
    return Ok(None);
  }

  let Some(title) = normalized_text(item.title.as_deref()) else {
    return Ok(None);
  };
  let attachment_text = item_attachment_title_text(db, item)?;

  let context_title = parent_title_for_item(db, item, false);
  let mut lines = Vec::new();
  lines.push(title);
  if let Some(context_title) = context_title {
    if !lines.iter().any(|line| normalized_text_eq(line, &context_title)) {
      lines.push(context_title);
    }
  }
  if let Some(attachment_text) = attachment_text {
    lines.push(attachment_text);
  }

  Ok(Some(ItemTitleFragment {
    item_id: item.id.clone(),
    ordinal: ITEM_TITLE_FRAGMENT_ORDINAL,
    source_kind: ITEM_TITLE_SOURCE_KIND,
    text: lines.join("\n"),
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

fn normalized_text_eq(left: &str, right: &str) -> bool {
  left.to_lowercase() == right.to_lowercase()
}
