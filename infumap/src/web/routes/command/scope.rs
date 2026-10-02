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

//! Named scopes for search and chat, defined by items under the user's scopes page.
//!
//! Each child page of the scopes page is a scope, named by its title. The scope page's link
//! children are include roots. Links inside a child container titled "Exclude" (case-insensitive)
//! are exclude roots. A scope covers its include roots and their descendants (children and
//! attachments, never link targets), minus the exclude roots and their descendants. Exclusion
//! wins over inclusion. A scope with no include links covers the user's home page tree; a scope
//! whose include links all fail to resolve covers nothing.

use super::*;

const MAX_LINK_DEPTH: usize = 64;
const EXCLUDE_CONTAINER_TITLE: &str = "exclude";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum ScopeProblem {
  /// A link in the scope, or in one of its Exclude containers, has no readable target.
  #[serde(rename_all = "camelCase")]
  UnresolvedLink { item_id: Uid, exclude: bool },
  /// A container that is not an Exclude container. Its contents do not affect the scope.
  #[serde(rename_all = "camelCase")]
  IgnoredContainer { item_id: Uid, title: Option<String> },
  /// The scope has more than one Exclude container. The links in all of them are excluded.
  MultipleExcludeContainers,
  /// The scope has include links, but none of them resolve, so it covers nothing.
  NoResolvedIncludes,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScopeSummary<'a> {
  id: &'a Uid,
  name: &'a str,
  /// Null when the scope has no include links and so covers the home page tree.
  include_count: Option<usize>,
  exclude_count: usize,
  problems: &'a [ScopeProblem],
}

#[derive(Serialize)]
struct ListScopesResponse<'a> {
  scopes: Vec<ScopeSummary<'a>>,
}

pub(super) struct ResolvedScope {
  pub id: Uid,
  pub name: String,
  home_page_id: Uid,
  /// None means the home page tree.
  include_roots: Option<HashSet<Uid>>,
  exclude_roots: HashSet<Uid>,
  pub problems: Vec<ScopeProblem>,
}

impl ResolvedScope {
  pub fn include_root_count(&self) -> Option<usize> {
    self.include_roots.as_ref().map(HashSet::len)
  }

  pub fn exclude_root_count(&self) -> usize {
    self.exclude_roots.len()
  }

  /// Whether the item lies within the scope. Ownership and item type are not checked here.
  pub fn contains(&self, db: &Db, item: &Item) -> bool {
    let mut included = false;
    let mut seen = HashSet::new();
    let mut current = item;
    loop {
      if !seen.insert(&current.id) || self.exclude_roots.contains(&current.id) {
        return false;
      }
      included = included
        || match &self.include_roots {
          Some(include_roots) => include_roots.contains(&current.id),
          None => current.id == self.home_page_id,
        };
      let Some(parent_id) = current.parent_id.as_ref().filter(|parent_id| !is_empty_uid(parent_id)) else {
        return included;
      };
      let Ok(parent) = db.item.get(parent_id) else {
        return false;
      };
      current = parent;
    }
  }

  /// The ids of all readable items in the scope, sorted.
  pub fn allowed_item_ids(&self, db: &Db, user_id: &Uid) -> InfuResult<Vec<Uid>> {
    let home_roots = HashSet::from([self.home_page_id.clone()]);
    let mut roots = Vec::new();
    for root_id in self.include_roots.as_ref().unwrap_or(&home_roots) {
      // An include root inside an excluded subtree is excluded, but walking down from it would
      // never encounter the exclude root above it.
      if self.contains(db, db.item.get(root_id)?) {
        roots.push(root_id.clone());
      }
    }
    subtree_item_ids(db, roots, &self.exclude_roots, user_id)
  }
}

pub(super) fn readable(item: &Item, user_id: &str) -> bool {
  item.owner_id == user_id && item.item_type != ItemType::Password
}

/// Follows links to the item they display, or None if any step is missing, unreadable or cyclic.
pub(super) fn resolve_content<'a>(db: &'a Db, item: &'a Item, user_id: &str) -> Option<&'a Item> {
  let mut current = item;
  let mut seen = HashSet::new();
  for _ in 0..MAX_LINK_DEPTH {
    if !readable(current, user_id) || !seen.insert(&current.id) {
      return None;
    }
    if current.item_type != ItemType::Link {
      return Some(current);
    }
    current = db.item.get(current.link_to.as_ref()?).ok()?;
  }
  None
}

/// The ids of readable items reachable from the roots through children and attachments, sorted.
/// Items in `pruned` are skipped along with everything below them.
pub(super) fn subtree_item_ids(db: &Db, roots: Vec<Uid>, pruned: &HashSet<Uid>, user_id: &Uid) -> InfuResult<Vec<Uid>> {
  let mut pending = roots;
  let mut seen = HashSet::new();
  let mut item_ids = Vec::new();
  while let Some(item_id) = pending.pop() {
    if pruned.contains(&item_id) || !seen.insert(item_id.clone()) {
      continue;
    }
    if !readable(db.item.get(&item_id)?, user_id) {
      continue;
    }

    pending.extend(db.item.get_children_ids(&item_id)?);
    pending.extend(db.item.get_attachment_ids(&item_id)?);
    item_ids.push(item_id);
  }
  item_ids.sort();
  Ok(item_ids)
}

pub(super) fn resolve_scope(db: &Db, user_id: &Uid, scope_id: &Uid) -> InfuResult<ResolvedScope> {
  let scope_page =
    db.item.get(scope_id).ok().filter(|item| is_scope_page(item, user_id)).ok_or("Scope was not found.")?;
  resolve_scope_page(db, user_id, scope_page)
}

/// All of the user's scopes, in the order they appear on the scopes page.
pub(super) fn list_scopes(db: &Db, user_id: &Uid) -> InfuResult<Vec<ResolvedScope>> {
  sorted_children(db, &scopes_page_id(user_id))?
    .into_iter()
    .filter(|item| is_scope_page(item, user_id))
    .map(|scope_page| resolve_scope_page(db, user_id, scope_page))
    .collect()
}

pub(super) async fn handle_list_scopes(
  db: &Arc<tokio::sync::Mutex<Db>>,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to list scopes.")?;
  let response = list_scopes_json(&*db.lock().await, &session.user_id)?;
  debug!("Executed 'list-scopes' command for user '{}'.", session.user_id);
  Ok(Some(response))
}

fn list_scopes_json(db: &Db, user_id: &Uid) -> InfuResult<String> {
  let scopes = list_scopes(db, user_id)?;
  let response = ListScopesResponse {
    scopes: scopes
      .iter()
      .map(|scope| ScopeSummary {
        id: &scope.id,
        name: &scope.name,
        include_count: scope.include_root_count(),
        exclude_count: scope.exclude_root_count(),
        problems: &scope.problems,
      })
      .collect(),
  };
  Ok(serde_json::to_string(&response)?)
}

fn is_scope_page(item: &Item, user_id: &Uid) -> bool {
  &item.owner_id == user_id
    && item.item_type == ItemType::Page
    && item.relationship_to_parent == RelationshipToParent::Child
    && item.parent_id.as_ref() == Some(&scopes_page_id(user_id))
}

fn is_exclude_container(item: &Item) -> bool {
  is_container_item_type(item.item_type)
    && item.title.as_deref().is_some_and(|title| title.trim().eq_ignore_ascii_case(EXCLUDE_CONTAINER_TITLE))
}

fn sorted_children<'a>(db: &'a Db, parent_id: &Uid) -> InfuResult<Vec<&'a Item>> {
  let mut children = db.item.get_children(parent_id)?;
  children.sort_by(|a, b| a.ordering.cmp(&b.ordering).then_with(|| a.id.cmp(&b.id)));
  Ok(children)
}

fn ignored_container_problem(item: &Item) -> ScopeProblem {
  ScopeProblem::IgnoredContainer { item_id: item.id.clone(), title: item.title.clone() }
}

fn resolve_root(
  db: &Db,
  user_id: &Uid,
  link: &Item,
  exclude: bool,
  roots: &mut HashSet<Uid>,
  problems: &mut Vec<ScopeProblem>,
) {
  match resolve_content(db, link, user_id) {
    Some(target) => {
      roots.insert(target.id.clone());
    }
    None => problems.push(ScopeProblem::UnresolvedLink { item_id: link.id.clone(), exclude }),
  }
}

fn resolve_scope_page(db: &Db, user_id: &Uid, scope_page: &Item) -> InfuResult<ResolvedScope> {
  let user = db.user.get(user_id).ok_or(format!("Unknown user '{}'.", user_id))?;
  let mut problems = Vec::new();
  let mut include_links = Vec::new();
  let mut exclude_containers = Vec::new();
  for child in sorted_children(db, &scope_page.id)? {
    if child.item_type == ItemType::Link {
      include_links.push(child);
    } else if is_exclude_container(child) {
      exclude_containers.push(child);
    } else if is_container_item_type(child.item_type) {
      problems.push(ignored_container_problem(child));
    }
  }

  let include_roots = if include_links.is_empty() {
    None
  } else {
    let mut include_roots = HashSet::new();
    for link in include_links {
      resolve_root(db, user_id, link, false, &mut include_roots, &mut problems);
    }
    if include_roots.is_empty() {
      problems.push(ScopeProblem::NoResolvedIncludes);
    }
    Some(include_roots)
  };

  if exclude_containers.len() > 1 {
    problems.push(ScopeProblem::MultipleExcludeContainers);
  }
  let mut exclude_roots = HashSet::new();
  for exclude_container in exclude_containers {
    for child in sorted_children(db, &exclude_container.id)? {
      if child.item_type == ItemType::Link {
        resolve_root(db, user_id, child, true, &mut exclude_roots, &mut problems);
      } else if is_container_item_type(child.item_type) {
        problems.push(ignored_container_problem(child));
      }
    }
  }

  Ok(ResolvedScope {
    id: scope_page.id.clone(),
    name: scope_page.title.clone().unwrap_or_default(),
    home_page_id: user.home_page_id.clone(),
    include_roots,
    exclude_roots,
    problems,
  })
}

/// A database in a temporary directory, holding one user with the standard pages.
#[cfg(test)]
pub(super) mod test_db {
  use super::*;
  use crate::storage::db::user::User;
  use crate::web::routes::{
    default_dock_page, default_home_page, default_queries_page, default_trash_page, ensure_scopes_page,
  };
  use infusdk::item::NoteFlags;
  use std::path::PathBuf;

  pub(crate) struct TestDb {
    pub db: Db,
    pub user_id: Uid,
    pub home_id: Uid,
    pub trash_id: Uid,
    pub dir: TempDir,
  }

  /// Removes the database directory when dropped.
  pub(crate) struct TempDir(PathBuf);

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  impl TestDb {
    pub async fn new() -> TestDb {
      let dir = std::env::temp_dir().join(format!("infumap-scope-test-{}", new_uid()));
      std::fs::create_dir_all(&dir).unwrap();
      let mut db = Db::new(dir.to_str().unwrap()).await.unwrap();
      let user = User {
        id: new_uid(),
        username: "test".to_owned(),
        password_hash: String::new(),
        password_salt: String::new(),
        totp_secret: None,
        home_page_id: new_uid(),
        trash_page_id: new_uid(),
        dock_page_id: new_uid(),
        queries_page_id: new_uid(),
        default_page_width_bl: 60,
        default_page_natural_aspect: 2.0,
        object_encryption_key: String::new(),
      };
      db.user.add(user.clone()).await.unwrap();
      db.item.load_user_items(&user.id, true).await.unwrap();
      db.item.add(default_home_page(&user.id, "test", user.home_page_id.clone(), 60, 2.0)).await.unwrap();
      db.item.add(default_trash_page(&user.id, user.trash_page_id.clone(), 2.0)).await.unwrap();
      db.item.add(default_dock_page(&user.id, user.dock_page_id.clone(), 2.0)).await.unwrap();
      db.item.add(default_queries_page(&user.id, user.queries_page_id.clone(), 2.0)).await.unwrap();
      ensure_scopes_page(&mut db, &user.id).await.unwrap();
      TestDb {
        db,
        user_id: user.id.clone(),
        home_id: user.home_page_id,
        trash_id: user.trash_page_id,
        dir: TempDir(dir),
      }
    }

    pub fn scopes_id(&self) -> Uid {
      scopes_page_id(&self.user_id)
    }

    pub async fn add(&mut self, mut item: Item) -> Uid {
      item.owner_id = self.user_id.clone();
      let parent_id = item.parent_id.clone().unwrap();
      let siblings = if item.relationship_to_parent == RelationshipToParent::Attachment {
        self.db.item.get_attachments(&parent_id).unwrap()
      } else {
        self.db.item.get_children(&parent_id).unwrap()
      };
      item.ordering = new_ordering_at_end(siblings.iter().map(|item| item.ordering.clone()).collect());
      let id = item.id.clone();
      self.db.item.add(item).await.unwrap();
      id
    }

    pub async fn page(&mut self, parent_id: &Uid, title: &str) -> Uid {
      let item = Item::new_page(
        Some(parent_id),
        vec![],
        Vector { x: 0, y: 0 },
        GRID_SIZE,
        RelationshipToParent::Child,
        title,
        "",
        0,
        0,
        0,
        2.0,
        60 * GRID_SIZE,
        ArrangeAlgorithm::List,
        1,
        1.5,
        36,
        7.0,
        1.0,
        vec![TableColumn { width_gr: 480, name: "Title".to_owned() }],
        1,
      );
      self.add(item).await
    }

    pub async fn note(&mut self, parent_id: &Uid, title: &str, relationship: RelationshipToParent) -> Uid {
      let item =
        Item::new_note(parent_id, vec![], Vector { x: 0, y: 0 }, GRID_SIZE, relationship, title, NoteFlags::None, None);
      self.add(item).await
    }

    pub async fn link(&mut self, parent_id: &Uid, link_to: &Uid) -> Uid {
      let item = Item::new_link(
        parent_id,
        vec![],
        Vector { x: 0, y: 0 },
        GRID_SIZE,
        GRID_SIZE,
        RelationshipToParent::Child,
        link_to,
      );
      self.add(item).await
    }
  }
}

#[cfg(test)]
mod tests {
  use super::test_db::TestDb;
  use super::*;

  impl TestDb {
    fn resolve(&self, scope_id: &Uid) -> ResolvedScope {
      resolve_scope(&self.db, &self.user_id, scope_id).unwrap()
    }

    fn contains(&self, scope: &ResolvedScope, item_id: &Uid) -> bool {
      scope.contains(&self.db, self.db.item.get(item_id).unwrap())
    }

    /// Checks that contains() and allowed_item_ids() agree on every item the user owns.
    fn assert_consistent(&self, scope: &ResolvedScope) {
      let allowed = scope.allowed_item_ids(&self.db, &self.user_id).unwrap().into_iter().collect::<HashSet<_>>();
      for item_key in self.db.item.all_loaded_items().into_iter().filter(|key| key.user_id == self.user_id) {
        let item = self.db.item.get(&item_key.item_id).unwrap();
        assert_eq!(
          allowed.contains(&item.id),
          readable(item, &self.user_id) && scope.contains(&self.db, item),
          "contains() and allowed_item_ids() disagree on '{:?}'",
          item.title
        );
      }
    }
  }

  #[tokio::test]
  async fn include_roots_cover_their_descendants_only() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let projects = t.page(&home, "Projects").await;
    let project_note = t.note(&projects, "plan", RelationshipToParent::Child).await;
    let attachment = t.note(&project_note, "attached", RelationshipToParent::Attachment).await;
    let other = t.page(&home, "Other").await;
    let outside_link = t.link(&projects, &other).await;
    let scope = t.page(&t.scopes_id(), "Work").await;
    t.link(&scope, &projects).await;

    let resolved = t.resolve(&scope);
    assert_eq!(resolved.name, "Work");
    assert_eq!(resolved.include_root_count(), Some(1));
    assert!(resolved.problems.is_empty());
    assert!(t.contains(&resolved, &projects));
    assert!(t.contains(&resolved, &project_note));
    assert!(t.contains(&resolved, &attachment));
    assert!(t.contains(&resolved, &outside_link));
    assert!(!t.contains(&resolved, &other), "link targets are not followed");
    assert!(!t.contains(&resolved, &home), "ancestors of include roots are not included");
    t.assert_consistent(&resolved);
  }

  #[tokio::test]
  async fn no_include_links_means_home_tree_minus_excludes() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let trash = t.trash_id.clone();
    let journal = t.page(&home, "Journal").await;
    let entry = t.note(&journal, "entry", RelationshipToParent::Child).await;
    let notes = t.page(&home, "Notes").await;
    let trashed = t.note(&trash, "trashed", RelationshipToParent::Child).await;
    let scope = t.page(&t.scopes_id(), "No journal").await;
    let exclude = t.page(&scope, "Exclude").await;
    t.link(&exclude, &journal).await;

    let resolved = t.resolve(&scope);
    assert_eq!(resolved.include_root_count(), None);
    assert_eq!(resolved.exclude_root_count(), 1);
    assert!(t.contains(&resolved, &home));
    assert!(t.contains(&resolved, &notes));
    assert!(!t.contains(&resolved, &journal));
    assert!(!t.contains(&resolved, &entry));
    assert!(!t.contains(&resolved, &trashed), "everything means the home tree");
    t.assert_consistent(&resolved);
  }

  #[tokio::test]
  async fn exclude_wins_whichever_root_is_nested() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let archive = t.page(&home, "Archive").await;
    let taxes = t.page(&archive, "Taxes").await;
    let receipt = t.note(&taxes, "receipt", RelationshipToParent::Child).await;
    let old = t.note(&archive, "old", RelationshipToParent::Child).await;

    let carve_out = t.page(&t.scopes_id(), "Archive without taxes").await;
    t.link(&carve_out, &archive).await;
    let exclude = t.page(&carve_out, "Exclude").await;
    t.link(&exclude, &taxes).await;
    let resolved = t.resolve(&carve_out);
    assert!(t.contains(&resolved, &old));
    assert!(!t.contains(&resolved, &receipt));
    t.assert_consistent(&resolved);

    let carve_in = t.page(&t.scopes_id(), "Taxes only").await;
    t.link(&carve_in, &taxes).await;
    let exclude = t.page(&carve_in, "Exclude").await;
    t.link(&exclude, &archive).await;
    let resolved = t.resolve(&carve_in);
    assert!(!t.contains(&resolved, &taxes));
    assert!(!t.contains(&resolved, &receipt));
    assert!(resolved.allowed_item_ids(&t.db, &t.user_id).unwrap().is_empty());
    t.assert_consistent(&resolved);
  }

  #[tokio::test]
  async fn exclude_container_title_is_case_insensitive_and_multiple_are_combined() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let a = t.page(&home, "A").await;
    let b = t.page(&home, "B").await;
    let scope = t.page(&t.scopes_id(), "Scope").await;
    let first = t.page(&scope, "eXcLuDe").await;
    t.link(&first, &a).await;
    let second = t.page(&scope, " exclude ").await;
    t.link(&second, &b).await;

    let resolved = t.resolve(&scope);
    assert_eq!(resolved.exclude_root_count(), 2);
    assert_eq!(resolved.problems, vec![ScopeProblem::MultipleExcludeContainers]);
    assert!(!t.contains(&resolved, &a));
    assert!(!t.contains(&resolved, &b));
  }

  #[tokio::test]
  async fn other_children_are_ignored_and_containers_reported() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let a = t.page(&home, "A").await;
    let scope = t.page(&t.scopes_id(), "Scope").await;
    t.note(&scope, "a description", RelationshipToParent::Child).await;
    let misnamed = t.page(&scope, "Excludes").await;
    t.link(&misnamed, &a).await;
    let exclude = t.page(&scope, "Exclude").await;
    let nested = t.page(&exclude, "Nested").await;

    let resolved = t.resolve(&scope);
    assert_eq!(resolved.include_root_count(), None);
    assert_eq!(resolved.exclude_root_count(), 0);
    assert_eq!(
      resolved.problems,
      vec![
        ScopeProblem::IgnoredContainer { item_id: misnamed, title: Some("Excludes".to_owned()) },
        ScopeProblem::IgnoredContainer { item_id: nested, title: Some("Nested".to_owned()) },
      ]
    );
    assert!(t.contains(&resolved, &a));
  }

  #[tokio::test]
  async fn broken_links_are_reported_and_never_widen_the_scope() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let a = t.page(&home, "A").await;
    let b = t.page(&home, "B").await;

    let partly_broken = t.page(&t.scopes_id(), "Partly broken").await;
    t.link(&partly_broken, &a).await;
    let broken_include = t.link(&partly_broken, &new_uid()).await;
    let exclude = t.page(&partly_broken, "Exclude").await;
    let broken_exclude = t.link(&exclude, &new_uid()).await;
    let resolved = t.resolve(&partly_broken);
    assert_eq!(
      resolved.problems,
      vec![
        ScopeProblem::UnresolvedLink { item_id: broken_include, exclude: false },
        ScopeProblem::UnresolvedLink { item_id: broken_exclude, exclude: true },
      ]
    );
    assert!(t.contains(&resolved, &a));
    assert!(!t.contains(&resolved, &b));

    let all_broken = t.page(&t.scopes_id(), "All broken").await;
    let broken = t.link(&all_broken, &new_uid()).await;
    let resolved = t.resolve(&all_broken);
    assert_eq!(resolved.include_root_count(), Some(0));
    assert_eq!(
      resolved.problems,
      vec![ScopeProblem::UnresolvedLink { item_id: broken, exclude: false }, ScopeProblem::NoResolvedIncludes]
    );
    assert!(!t.contains(&resolved, &home));
    assert!(resolved.allowed_item_ids(&t.db, &t.user_id).unwrap().is_empty());
  }

  #[tokio::test]
  async fn links_to_links_resolve_to_the_final_target() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let target = t.page(&home, "Target").await;
    let elsewhere = t.page(&home, "Elsewhere").await;
    let intermediate = t.link(&elsewhere, &target).await;
    let scope = t.page(&t.scopes_id(), "Scope").await;
    t.link(&scope, &intermediate).await;

    let resolved = t.resolve(&scope);
    assert!(t.contains(&resolved, &target));
    assert!(!t.contains(&resolved, &elsewhere));
  }

  #[tokio::test]
  async fn scopes_are_listed_in_order_and_lookups_are_restricted_to_scope_pages() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let not_a_scope = t.page(&home, "Not a scope").await;
    let scopes_id = t.scopes_id();
    let first = t.page(&scopes_id, "First").await;
    t.note(&scopes_id, "not a scope either", RelationshipToParent::Child).await;
    let second = t.page(&scopes_id, "Second").await;

    let listed = list_scopes(&t.db, &t.user_id).unwrap();
    assert_eq!(listed.iter().map(|scope| scope.id.clone()).collect::<Vec<_>>(), vec![first, second]);
    assert!(resolve_scope(&t.db, &t.user_id, &not_a_scope).is_err());
    assert!(resolve_scope(&t.db, &t.user_id, &new_uid()).is_err());
    assert!(resolve_scope(&t.db, &t.user_id, &scopes_id).is_err());
  }

  #[tokio::test]
  async fn list_scopes_json_summarizes_each_scope() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let a = t.page(&home, "A").await;
    let b = t.page(&home, "B").await;
    let scopes_id = t.scopes_id();
    let everything = t.page(&scopes_id, "Everything").await;
    let work = t.page(&scopes_id, "Work").await;
    t.link(&work, &a).await;
    let broken = t.link(&work, &new_uid()).await;
    let exclude = t.page(&work, "Exclude").await;
    t.link(&exclude, &b).await;
    let misnamed = t.page(&work, "Notes").await;

    let response: Value = serde_json::from_str(&list_scopes_json(&t.db, &t.user_id).unwrap()).unwrap();
    assert_eq!(
      response,
      serde_json::json!({ "scopes": [
        { "id": everything, "name": "Everything", "includeCount": null, "excludeCount": 0, "problems": [] },
        { "id": work, "name": "Work", "includeCount": 1, "excludeCount": 1, "problems": [
          { "kind": "ignoredContainer", "itemId": misnamed, "title": "Notes" },
          { "kind": "unresolvedLink", "itemId": broken, "exclude": false },
        ]},
      ]})
    );
  }
}
