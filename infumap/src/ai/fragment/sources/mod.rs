use std::io::ErrorKind;
use std::path::PathBuf;

use infusdk::item::{Item, RelationshipToParent};
use infusdk::util::infu::InfuResult;
use serde::de::DeserializeOwned;
use tokio::fs;

use crate::storage::db::Db;

use super::{FragmentInput, FragmentSource, FragmentSourceKind};

mod content;
mod image;
mod markdown;
mod pdf;

pub use content::content_fragment_source_for_item;
pub use image::image_fragment_source_for_item;
pub use markdown::markdown_fragment_source_for_item;
pub use pdf::pdf_fragment_source_for_item;

fn single_fragment_source(source_kind: FragmentSourceKind, text: String) -> FragmentSource {
  FragmentSource { source_kind, fragments: vec![FragmentInput::new(text)] }
}

async fn read_json_if_exists<T: DeserializeOwned>(path: &PathBuf, artifact_label: &str) -> InfuResult<Option<T>> {
  let bytes = match fs::read(path).await {
    Ok(bytes) => bytes,
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(format!("Could not read {} '{}': {}", artifact_label, path.display(), error).into()),
  };

  serde_json::from_slice(&bytes)
    .map(Some)
    .map_err(|error| format!("Could not parse {} '{}': {}", artifact_label, path.display(), error).into())
}

fn normalized_text(value: Option<&str>) -> Option<String> {
  let value = value?;
  let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
  if collapsed.is_empty() { None } else { Some(collapsed) }
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
