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

//! Snapshots of item text for chat messages. A pasted reference prepares an attachment before sending, independent of
//! retrieval scope. The older item-scope protocol attaches each item the first time it is in scope. Models can skip
//! tool reads or answer after the first fragment, so both paths send the text with the message.
//!
//! A note or data item is its whole text. A page or table is its listing, then the whole text of each note the
//! listing cuts short and each data item in it. Pages and tables inside it are listed but not read, so choosing a
//! large tree does not fill the context. Oversized text is rejected for pasted references. The older protocol returns
//! a note about tool reads in place of the attachment's body.

use super::container_fragments::{self, Access};
use super::transcript::ChatAttachment;
use super::*;
use crate::ai::fragment::sources::{
  is_local_text_copy_item, load_pdf_markdown_artifact, read_or_create_local_text_copy,
};
use crate::ai::fragment::{CHAT_SOURCE_KIND, FragmentSourceKind, read_item_fragments};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DraftItemAttachment {
  title: String,
  mime_type: String,
  text: String,
}

/// A snapshot the user explicitly attached. Read access is independent of the chat's retrieval scope.
pub(super) async fn draft_item_attachment(
  db: &Arc<tokio::sync::Mutex<Db>>,
  object_store: Arc<object::ObjectStore>,
  session: &Session,
  item_id: &Uid,
) -> Result<DraftItemAttachment, String> {
  let access = Access { user_id: &session.user_id, scope: None };
  let (item, data_dir, encryption_key) = {
    let db = db.lock().await;
    let item = db
      .item
      .get(item_id)
      .ok()
      .filter(|item| access.can_read(&db, item))
      .and_then(|item| access.content(&db, item))
      .ok_or("No readable item matches that link or ID.")?;
    let user = db.user.get(&session.user_id).ok_or("Could not read the item.")?;
    (item.clone(), db.item.data_dir().to_owned(), user.object_encryption_key.clone())
  };
  let title = container_fragments::item_label(&item).replace(char::is_control, " ");
  let unreadable = || format!("Could not read the text of {title}.");
  let no_text = || format!("{title} has no readable text to attach.");
  let mime_type = item.mime_type.as_deref().unwrap_or("");
  let (text, mime_type) = match item.item_type {
    ItemType::Note => (container_fragments::note_text(&item), "text/markdown"),
    ItemType::Page | ItemType::Table | ItemType::Composite => {
      let listing = container_attachment_text(db, &access, &item.id).await.map_err(|_| unreadable())?;
      (
        format!(
          "This listing covers the direct contents. Nested pages and tables are listed by reference.\n\n{listing}"
        ),
        "text/markdown",
      )
    }
    ItemType::Text | ItemType::File if mime_type.starts_with("text/") => {
      if item.file_size_bytes.is_some_and(|bytes| bytes > CHAT_ATTACHMENT_MAX_BYTES as i64) {
        return Err(format!("{title} is larger than the 1 MB attachment limit."));
      }
      let bytes = if is_local_text_copy_item(&item) {
        read_or_create_local_text_copy(&data_dir, object_store, &item, &encryption_key, "text file").await
      } else {
        object::get(object_store, item.owner_id.clone(), item.id.clone(), &encryption_key).await
      }
      .map_err(|_| unreadable())?;
      (String::from_utf8(bytes).map_err(|_| no_text())?, mime_type)
    }
    ItemType::File if mime_type == "application/pdf" => {
      let text = load_pdf_markdown_artifact(&data_dir, &item.owner_id, &item.id)
        .await
        .map_err(|_| unreadable())?
        .ok_or_else(no_text)?;
      (text, "text/markdown")
    }
    ItemType::Image | ItemType::Search | ItemType::Text
      if item.item_type != ItemType::Text || mime_type == CHAT_TRANSCRIPT_MIME_TYPE =>
    {
      let mut fragments = read_item_fragments(&data_dir, &item.owner_id, &item.id).await.map_err(|_| no_text())?;
      if ![
        CHAT_SOURCE_KIND,
        FragmentSourceKind::ImageContents.as_str(),
        FragmentSourceKind::ImageDocumentContents.as_str(),
      ]
      .contains(&fragments.source_kind.as_str())
      {
        return Err(no_text());
      }
      fragments.records.sort_by_key(|record| record.ordinal);
      (fragments.records.into_iter().map(|record| record.text).collect::<Vec<_>>().join("\n\n"), "text/markdown")
    }
    _ => return Err(no_text()),
  };
  if text.trim().is_empty() || text.contains('\0') {
    return Err(no_text());
  }
  if text.len() > CHAT_ATTACHMENT_MAX_BYTES {
    return Err(format!("{title} has more than 1 MB of text and cannot be attached in full."));
  }
  Ok(DraftItemAttachment { title, mime_type: mime_type.to_owned(), text })
}

/// Attachments for the items in `item_ids` that are still readable, in order.
pub(super) async fn scope_item_attachments(
  db: &Arc<tokio::sync::Mutex<Db>>,
  user_id: &str,
  scope: &ResolvedScope,
  item_ids: &[Uid],
) -> Vec<ChatAttachment> {
  let access = Access { user_id, scope: Some(scope) };
  let mut attachments = Vec::new();
  for item_id in item_ids {
    let Some((title, text)) = item_attachment_text(db, &access, item_id).await else { continue };
    let text =
      if text.len() > CHAT_ATTACHMENT_MAX_BYTES { too_large_text(db, &access, item_id, &text).await } else { text };
    attachments.push(ChatAttachment {
      id: new_uid(),
      item_id: Some(item_id.clone()),
      title,
      mime_type: "text/markdown".to_owned(),
      size_bytes: text.len(),
      text,
    });
  }
  attachments
}

/// The attachment title and text of an item, or None if the chat cannot read it.
async fn item_attachment_text(
  db: &Arc<tokio::sync::Mutex<Db>>,
  access: &Access<'_>,
  item_id: &Uid,
) -> Option<(String, String)> {
  let (title, is_container) = {
    let db = db.lock().await;
    let content = db.item.get(item_id).ok().and_then(|item| access.content(&db, item))?;
    (container_fragments::item_label(content), is_container_item_type(content.item_type))
  };
  if !is_container {
    let (heading, location, text) = item_text(db, access, item_id).await?;
    return Some((title, format!("{heading}{location}\n{}", body_or_none(&text))));
  }
  let text = match container_attachment_text(db, access, item_id).await {
    Ok(text) => text,
    Err(e) => format!("{} could not be read: {}", title, e.message()),
  };
  Some((title, text))
}

async fn container_attachment_text(
  db: &Arc<tokio::sync::Mutex<Db>>,
  access: &Access<'_>,
  item_id: &Uid,
) -> InfuResult<String> {
  let (listing, untold_item_ids) = container_fragments::whole_container(db, access, item_id).await?;
  let mut parts = vec![listing];
  for untold_item_id in untold_item_ids {
    // The listing gives each item's location, so only its heading is repeated.
    if let Some((heading, _, text)) = item_text(db, access, &untold_item_id).await {
      parts.push(format!("{heading}\n{}", body_or_none(&text)));
    }
  }
  Ok(parts.join("\n\n"))
}

/// The heading, location and text of a note or data item. The text is empty for an item without any, such as an image
/// or a file whose text has not been extracted yet, and for other kinds of item.
async fn item_text(
  db: &Arc<tokio::sync::Mutex<Db>>,
  access: &Access<'_>,
  item_id: &Uid,
) -> Option<(String, String, String)> {
  let (heading, location, note_text, data_dir) = {
    let db = db.lock().await;
    let content = db.item.get(item_id).ok().and_then(|item| access.content(&db, item))?;
    let (heading, location) = container_fragments::item_heading(&db, access, content);
    if !is_data_item_type(content.item_type)
      && content.item_type != ItemType::Note
      && content.item_type != ItemType::Search
    {
      return Some((heading, location, String::new()));
    }
    let note_text = (content.item_type == ItemType::Note).then(|| container_fragments::note_text(content));
    (heading, location, note_text, db.item.data_dir().to_owned())
  };
  let text = match note_text {
    Some(text) => text,
    None => match read_item_fragments(&data_dir, access.user_id, item_id).await {
      Ok(mut fragments) => {
        fragments.records.sort_by_key(|record| record.ordinal);
        fragments.records.into_iter().map(|record| record.text).collect::<Vec<_>>().join("\n\n")
      }
      Err(_) => String::new(),
    },
  };
  Some((heading, location, text))
}

fn body_or_none(text: &str) -> &str {
  if text.trim().is_empty() { "(no readable text)" } else { text }
}

/// What the model gets in place of an item too large to attach: its header, and that it is to be read with the tools.
async fn too_large_text(db: &Arc<tokio::sync::Mutex<Db>>, access: &Access<'_>, item_id: &Uid, text: &str) -> String {
  let header = {
    let db = db.lock().await;
    let content = db.item.get(item_id).ok().and_then(|item| access.content(&db, item));
    content.map(|content| {
      let (heading, location) = container_fragments::item_heading(&db, access, content);
      format!("{heading}{location}")
    })
  };
  format!(
    "{}\nThis item is too large to include here ({} characters). Read it with infumap_get_fragment, or search within \
    it with infumap_search.",
    header.unwrap_or_default(),
    text.chars().count()
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::web::routes::command::scope::resolve_item_scope;
  use crate::web::routes::command::scope::test_db::TestDb;

  async fn attachments(t: TestDb, item_ids: &[Uid]) -> Vec<ChatAttachment> {
    let user_id = t.user_id.clone();
    let scope = resolve_item_scope(&t.db, &user_id, item_ids).unwrap();
    let db = Arc::new(tokio::sync::Mutex::new(t.db));
    scope_item_attachments(&db, &user_id, &scope, item_ids).await
  }

  #[tokio::test]
  async fn a_note_is_attached_whole_after_its_header() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let text = format!("Meeting notes\n\n{}", "word ".repeat(2_000));
    let note = t.note(&home, &text, RelationshipToParent::Child).await;
    let attached = attachments(t, &[note.clone()]).await;
    assert_eq!(attached.len(), 1);
    assert_eq!(attached[0].item_id.as_ref(), Some(&note));
    assert!(attached[0].title.starts_with("Meeting notes · word"));
    let (header, body) = attached[0].text.split_once('\n').unwrap();
    assert!(header.contains(&format!("(infumap://{note}) (note)")), "{header}");
    assert_eq!(body, text.trim());
    assert_eq!(attached[0].size_bytes, attached[0].text.len());
  }

  #[tokio::test]
  async fn a_page_is_its_listing_then_the_notes_it_cuts_but_not_the_pages_inside_it() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let page = t.page(&home, "Project").await;
    t.note(&page, "short note", RelationshipToParent::Child).await;
    let long_text = format!("Long note\n{}end of long note", "lorem ipsum ".repeat(100));
    let long = t.note(&page, &long_text, RelationshipToParent::Child).await;
    let inner = t.page(&page, "Inner").await;
    t.note(&inner, "inside the inner page", RelationshipToParent::Child).await;
    let attached = attachments(t, &[page.clone()]).await;
    assert_eq!(attached.len(), 1);
    assert_eq!(attached[0].title, "Project");
    let text = &attached[0].text;
    assert!(text.starts_with(&format!("[Project](infumap://{page}) (page, list layout)")), "{text}");
    assert!(text.contains("short note"));
    assert!(text.contains(&format!("[Inner](infumap://{inner}) (page, 1 item)")), "{text}");
    assert!(!text.contains("inside the inner page"));
    // The listing cuts the long note; its whole text follows the listing, once.
    let (listing, rest) = text.split_once("end of long note").unwrap();
    assert!(listing.contains("(truncated;"), "{listing}");
    assert!(!rest.contains("end of long note"));
    assert!(text.contains(&format!("(infumap://{long}) (note)\n{}", long_text.trim())), "{text}");
  }

  #[tokio::test]
  async fn an_item_too_large_to_attach_says_to_read_it_with_the_tools() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let note = t.note(&home, &"x".repeat(CHAT_ATTACHMENT_MAX_BYTES + 1), RelationshipToParent::Child).await;
    let gone = new_uid();
    let attached = attachments(t, &[note.clone(), gone]).await;
    assert_eq!(attached.len(), 1);
    let text = &attached[0].text;
    assert!(text.contains(&format!("(infumap://{note}) (note)")), "{text}");
    assert!(text.contains("too large to include here") && text.contains("infumap_get_fragment"), "{text}");
    assert!(text.len() < 1_000);
  }
}
