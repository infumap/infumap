// Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later

use super::*;
use crate::web::routes::prompts_page_id;
use chat::{Access, document_body_markdown, readable_children_in_display_order};

pub(super) const MAX_SKILLS_PER_MESSAGE: usize = 10;
const MAX_SKILL_BYTES_PER_MESSAGE: usize = 1024 * 1024;

#[derive(Serialize)]
pub(super) struct SkillSummary {
  pub id: Uid,
  pub name: String,
}

fn skill_name(user_id: &Uid, page_id: &Uid, item: &Item) -> Option<String> {
  if item.item_type != ItemType::Page
    || item.arrange_algorithm != Some(ArrangeAlgorithm::Document)
    || item.relationship_to_parent != RelationshipToParent::Child
    || item.parent_id.as_ref() != Some(page_id)
    || &item.owner_id != user_id
  {
    return None;
  }
  let name = item.title.as_deref()?.split_whitespace().collect::<Vec<_>>().join(" ");
  (!name.is_empty()).then_some(name)
}

pub(super) async fn handle_list_skills(
  db: &Arc<tokio::sync::Mutex<Db>>,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to list skills.")?;
  let db = db.lock().await;
  let page_id = prompts_page_id(&session.user_id);
  let access = Access { user_id: &session.user_id, scope: None };
  let mut skills = Vec::new();
  if let Ok(page) = db.item.get(&page_id) {
    for item in readable_children_in_display_order(&db, &access, page)? {
      if let Some(name) = skill_name(&session.user_id, &page_id, item) {
        skills.push(SkillSummary { id: item.id.clone(), name });
      }
    }
  }
  Ok(Some(serde_json::json!({ "skills": skills }).to_string()))
}

/// Resolve the chosen documents under one lock. They are explicit inputs, like attachments, so the chat's
/// retrieval scope does not constrain them.
pub(super) fn read_skills(db: &Db, user_id: &Uid, ids: &[Uid]) -> InfuResult<Vec<(String, String)>> {
  if ids.len() > MAX_SKILLS_PER_MESSAGE {
    return Err(format!("A message can use at most {MAX_SKILLS_PER_MESSAGE} skills.").into());
  }
  let mut seen = HashSet::new();
  let page_id = prompts_page_id(user_id);
  let access = Access { user_id, scope: None };
  let mut remaining = MAX_SKILL_BYTES_PER_MESSAGE;
  ids
    .iter()
    .map(|id| {
      if !seen.insert(id) {
        return Err("A skill can only be selected once per message.".into());
      }
      let unavailable = "A selected skill is unavailable. Remove it or choose it again from Skills.";
      let item = db.item.get(id).map_err(|_| unavailable)?;
      let name = skill_name(user_id, &page_id, item).ok_or(unavailable)?;
      let text = document_body_markdown(db, &access, item, remaining)?;
      if text.is_empty() {
        return Err(format!("Skill '{name}' has no instructions.").into());
      }
      remaining -= text.len();
      Ok((name, text))
    })
    .collect()
}
