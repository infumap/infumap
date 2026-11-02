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

//! The user's prompts: text kept on the prompts page of the queries page, to be inserted into a chat message.
//!
//! Each note or composite on the prompts page, or link to one, is a prompt; anything else there is not. A note reads
//! as Markdown, as a document page shows it. A composite's notes and dividers are joined as Markdown paragraphs, so
//! a prompt pasted as Markdown (which makes a composite) reads back as it was pasted. Other items in a composite are
//! left out. The text is read from the live database whenever prompts are listed, so edits show up at once.

use super::*;
use crate::web::routes::prompts_page_id;
use chat::{Access, document_note_markdown, readable_children_in_display_order};

/// A prompt longer than this is listed, but without its text.
const PROMPT_MAX_BYTES: usize = 64 * 1024;
const PROMPT_NAME_MAX_CHARS: usize = 80;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptSummary {
  /// The item on the prompts page, which may be a link to the prompt.
  id: Uid,
  /// The first line of the first note.
  name: String,
  /// Absent when the prompt is too long.
  #[serde(skip_serializing_if = "Option::is_none")]
  text: Option<String>,
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  too_long: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListPromptsResponse {
  prompts_page_id: Uid,
  prompts: Vec<PromptSummary>,
}

pub(super) async fn handle_list_prompts(
  db: &Arc<tokio::sync::Mutex<Db>>,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to list prompts.")?;
  let response = ListPromptsResponse {
    prompts_page_id: prompts_page_id(&session.user_id),
    prompts: list_prompts(&*db.lock().await, &session.user_id)?,
  };
  debug!("Executed 'list-prompts' command for user '{}'.", session.user_id);
  Ok(Some(serde_json::to_string(&response)?))
}

/// The prompts in the order the prompts page shows them. Empty ones are left out.
fn list_prompts(db: &Db, user_id: &Uid) -> InfuResult<Vec<PromptSummary>> {
  let access = Access { user_id, scope: None };
  let Ok(page) = db.item.get(&prompts_page_id(user_id)) else {
    return Ok(Vec::new());
  };
  let mut prompts = Vec::new();
  for placement in readable_children_in_display_order(db, &access, page)? {
    let Some(content) = access.content(db, placement) else { continue };
    if !matches!(content.item_type, ItemType::Note | ItemType::Composite) {
      continue;
    }
    let mut blocks = Vec::new();
    let mut name = None;
    prompt_blocks(db, &access, content, 0, &mut HashSet::new(), &mut blocks, &mut name)?;
    let text = blocks.join("\n\n");
    let Some(name) = name.filter(|_| !text.trim().is_empty()) else { continue };
    let too_long = text.len() > PROMPT_MAX_BYTES;
    prompts.push(PromptSummary { id: placement.id.clone(), name, text: (!too_long).then_some(text), too_long });
  }
  Ok(prompts)
}

/// Adds `content`'s Markdown blocks, and sets `name` from the first note with any text.
fn prompt_blocks(
  db: &Db,
  access: &Access,
  content: &Item,
  depth: usize,
  active: &mut HashSet<Uid>,
  blocks: &mut Vec<String>,
  name: &mut Option<String>,
) -> InfuResult<()> {
  match content.item_type {
    ItemType::Note => {
      let text = content.title.as_deref().unwrap_or("");
      if text.trim().is_empty() {
        return Ok(());
      }
      if name.is_none() {
        *name = text.lines().map(str::trim).find(|line| !line.is_empty()).map(prompt_name);
      }
      blocks.push(document_note_markdown(content));
    }
    ItemType::Divider => blocks.push("---".to_owned()),
    // A link can place a composite inside itself.
    ItemType::Composite if depth < MAX_DEPTH && active.insert(content.id.clone()) => {
      for member in readable_children_in_display_order(db, access, content)? {
        if let Some(member) = access.content(db, member) {
          prompt_blocks(db, access, member, depth + 1, active, blocks, name)?;
        }
      }
      active.remove(&content.id);
    }
    _ => {}
  }
  Ok(())
}

fn prompt_name(line: &str) -> String {
  if line.chars().count() <= PROMPT_NAME_MAX_CHARS {
    return line.to_owned();
  }
  format!("{}…", line.chars().take(PROMPT_NAME_MAX_CHARS - 1).collect::<String>().trim_end())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::web::routes::command::scope::test_db::TestDb;
  use infusdk::item::NoteFlags;

  impl TestDb {
    fn prompts(&self) -> Vec<PromptSummary> {
      list_prompts(&self.db, &self.user_id).unwrap()
    }

    fn prompts_id(&self) -> Uid {
      prompts_page_id(&self.user_id)
    }

    async fn composite_in(&mut self, parent_id: &Uid) -> Uid {
      self
        .non_note(parent_id, "", |item| {
          item.item_type = ItemType::Composite;
          item.title = None;
        })
        .await
    }

    async fn styled_note(&mut self, parent_id: &Uid, title: &str, flags: NoteFlags) -> Uid {
      self.note_with(parent_id, title, |item| item.flags = Some(flags.bits())).await
    }
  }

  #[tokio::test]
  async fn notes_composites_and_links_to_them_are_prompts_in_page_order() {
    let mut t = TestDb::new().await;
    let prompts = t.prompts_id();
    let home = t.home_id.clone();
    let summarize = t.note(&prompts, "Summarize the attached", RelationshipToParent::Child).await;
    let review = t.composite_in(&prompts).await;
    t.styled_note(&review, "Code review", NoteFlags::Heading2).await;
    t.note(&review, "Look for:", RelationshipToParent::Child).await;
    t.styled_note(&review, "bugs", NoteFlags::Bullet1).await;
    t.styled_note(&review, "fn main() {}", NoteFlags::Code).await;
    t.page(&prompts, "Not a prompt").await;
    t.note(&prompts, "  \n ", RelationshipToParent::Child).await;
    let elsewhere = t.note(&home, "Translate to French", RelationshipToParent::Child).await;
    let link = t.link(&prompts, &elsewhere).await;
    let deleted_target = t.note(&home, "gone", RelationshipToParent::Child).await;
    t.link(&prompts, &deleted_target).await;
    t.db.item.remove(&deleted_target).await.unwrap();

    let listed = t.prompts();
    let summary = listed.iter().map(|p| (p.id.clone(), p.name.as_str(), p.text.as_deref())).collect::<Vec<_>>();
    assert_eq!(
      summary,
      vec![
        (summarize, "Summarize the attached", Some("Summarize the attached")),
        (review, "Code review", Some("## Code review\n\nLook for:\n\n- bugs\n\n```\nfn main() {}\n```")),
        (link, "Translate to French", Some("Translate to French")),
      ]
    );
  }

  #[tokio::test]
  async fn the_name_is_the_first_line_and_a_long_prompt_has_no_text() {
    let mut t = TestDb::new().await;
    let prompts = t.prompts_id();
    let composite = t.composite_in(&prompts).await;
    t.note(&composite, "", RelationshipToParent::Child).await;
    t.note(&composite, "\n  First line  \nsecond", RelationshipToParent::Child).await;
    t.note(&prompts, &"x".repeat(PROMPT_MAX_BYTES + 1), RelationshipToParent::Child).await;

    let listed = t.prompts();
    assert_eq!(listed[0].name, "First line");
    assert_eq!(listed[0].text.as_deref(), Some("\n  First line  \nsecond"));
    assert!(listed[1].too_long && listed[1].text.is_none());
    assert_eq!(listed[1].name.chars().count(), PROMPT_NAME_MAX_CHARS);
    let json = serde_json::to_value(&listed[1]).unwrap();
    assert_eq!(json["tooLong"], true);
    assert!(json.get("text").is_none());
    assert!(serde_json::to_value(&listed[0]).unwrap().get("tooLong").is_none());
  }

  #[tokio::test]
  async fn a_composite_linked_inside_itself_is_read_once() {
    let mut t = TestDb::new().await;
    let prompts = t.prompts_id();
    let composite = t.composite_in(&prompts).await;
    t.note(&composite, "Once", RelationshipToParent::Child).await;
    t.link(&composite, &composite).await;

    assert_eq!(t.prompts()[0].text.as_deref(), Some("Once"));
  }
}
