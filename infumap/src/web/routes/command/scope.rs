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

//! Scopes for search and chat: everything, a collection, everything except a collection, or items chosen in a chat.
//!
//! A collection is a page with the Collection flag. Its direct link children are its members; its other children
//! are annotations and cover nothing. A member covers its target and the target's descendants (children and
//! attachments, never link targets). Excluding a collection hides that coverage from everything else, and exclusion
//! wins over any other way an item could be reached. A collection that is missing, trashed or no longer flagged
//! covers nothing, whichever way it is used: a broken reference must never broaden retrieval.
//!
//! A chat can instead be limited to items chosen in it. Each covers itself and its descendants, as a member would.

use super::*;
use crate::ai::search_eligibility::is_in_trash;
use crate::query_configuration::ScopeRef;
use infusdk::item::PAGE_COLLECTION_FLAG;

/// The most items a chat can be limited to.
pub(super) const MAX_SCOPE_ITEMS: usize = 32;
const SCOPE_ITEM_TITLE_MAX_CHARS: usize = 120;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum ScopeProblem {
  /// An item chosen in a chat is missing or unreadable, or is a link to another link.
  #[serde(rename_all = "camelCase")]
  UnresolvedItem { item_id: Uid },
  /// The referenced collection is missing, in the trash, or not a collection page. The title is the item's, when it
  /// still exists, so the user can be told which collection it was.
  #[serde(rename_all = "camelCase")]
  UnavailableCollection { collection_id: Uid, title: Option<String> },
  /// The reference was a bare scope page id, saved before collections.
  RetiredScope,
}

/// What a scope was resolved from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ScopeSource {
  /// Default retrieval, including earlier query chats, with any per-run exclusions.
  All,
  /// Items chosen in a chat: each one that resolved, a link as its target, in the order chosen.
  Items(Vec<Uid>),
  /// A collection's members, named by the collection page's title.
  Collection { id: Uid, name: String },
  /// Default retrieval minus a collection's members, named by the collection page's title.
  Except { id: Uid, name: String },
  /// A reference that does not resolve. Covers nothing; `problems` says why.
  Unavailable,
}

pub(super) struct ResolvedScope {
  pub source: ScopeSource,
  home_page_id: Uid,
  /// None means the home page tree and query chats.
  include_roots: Option<HashSet<Uid>>,
  exclude_roots: HashSet<Uid>,
  pub problems: Vec<ScopeProblem>,
}

impl ResolvedScope {
  /// Reuse the same scope checks for search, direct reads, resolved links and container listings.
  pub fn for_chat(db: &Db, user_id: &Uid, scope: Option<Self>, excluded: HashSet<Uid>) -> InfuResult<Self> {
    let mut scope = match scope {
      Some(scope) => scope,
      None => Self {
        source: ScopeSource::All,
        home_page_id: db.user.get(user_id).ok_or("The user was not found.")?.home_page_id.clone(),
        include_roots: None,
        exclude_roots: HashSet::new(),
        problems: Vec::new(),
      },
    };
    scope.exclude_roots.extend(excluded);
    Ok(scope)
  }

  /// Why a chat cannot run with this scope, when what it refers to is gone, as a message for the user. A run would
  /// otherwise search nothing, and the model would report what it could not see as absent. None when it resolved.
  pub fn unavailable_message(&self) -> Option<String> {
    if self.source != ScopeSource::Unavailable {
      return None;
    }
    let first_line = |title: &str| title.lines().map(str::trim).find(|line| !line.is_empty()).map(str::to_owned);
    Some(match self.problems.first() {
      Some(ScopeProblem::UnavailableCollection { title: Some(title), .. }) if first_line(title).is_some() => {
        let name = first_line(title).unwrap_or_default().chars().take(SCOPE_ITEM_TITLE_MAX_CHARS).collect::<String>();
        format!("\"{name}\" is no longer a collection. Choose another scope.")
      }
      Some(ScopeProblem::RetiredScope) => {
        "Scope pages are no longer used. Choose a collection or Everything as the scope.".to_owned()
      }
      _ => "The collection this chat is limited to no longer exists. Choose another scope.".to_owned(),
    })
  }

  #[cfg(test)]
  pub fn include_root_count(&self) -> Option<usize> {
    self.include_roots.as_ref().map(HashSet::len)
  }

  #[cfg(test)]
  pub fn exclude_root_count(&self) -> usize {
    self.exclude_roots.len()
  }

  /// Whether the item lies within the scope. Ownership and item type are not checked here.
  pub fn contains(&self, db: &Db, item: &Item) -> bool {
    // An unscoped run can still directly read any owned item, as before. Its default search roots remain
    // home and query chats; the runtime scope only adds exclusions to those otherwise unrestricted reads.
    // Everything except a collection is the same, with the collection's members as further exclusions.
    let mut included = matches!(&self.source, ScopeSource::All | ScopeSource::Except { .. });
    let mut seen = HashSet::new();
    let mut current = item;
    loop {
      if !seen.insert(&current.id) || self.exclude_roots.contains(&current.id) {
        return false;
      }
      included = included
        || match &self.include_roots {
          Some(include_roots) => include_roots.contains(&current.id),
          None => current.id == self.home_page_id || is_query_chat(db, current),
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
    let mut home_roots = HashSet::from([self.home_page_id.clone()]);
    if self.include_roots.is_none() {
      let user = db.user.get(user_id).ok_or("The user was not found.")?;
      home_roots.extend(
        db.item
          .get_children(&user.queries_page_id)?
          .into_iter()
          .filter(|item| item.item_type == ItemType::Search)
          .map(|item| item.id.clone()),
      );
    }
    let mut roots = Vec::new();
    for root_id in self.include_roots.as_ref().unwrap_or(&home_roots) {
      // An include root inside an excluded subtree is excluded, but walking down from it would
      // never encounter the exclude root above it.
      if self.contains(db, db.item.get(root_id)?) {
        roots.push(root_id.clone());
      }
    }
    let mut ids = subtree_item_ids(db, roots, &self.exclude_roots, user_id)?;
    // A link to an excluded conversation must not return its title as a search hit either.
    ids.retain(|id| {
      db.item.get(id).is_ok_and(|item| {
        item.item_type != ItemType::Link
          || resolve_content(db, item, user_id).is_some_and(|target| self.contains(db, target))
      })
    });
    Ok(ids)
  }
}

pub(super) fn is_query_chat(db: &Db, item: &Item) -> bool {
  item.item_type == ItemType::Search
    && db.user.get(&item.owner_id).is_some_and(|user| item.parent_id.as_ref() == Some(&user.queries_page_id))
}

pub(super) fn readable(item: &Item, user_id: &str) -> bool {
  item.owner_id == user_id && item.item_type != ItemType::Password
}

/// The item a placement displays: the item itself, or a link's target. None if either is unreadable, the
/// target is missing, or the target is another link (links do not chain).
pub(super) fn resolve_content<'a>(db: &'a Db, item: &'a Item, user_id: &str) -> Option<&'a Item> {
  if !readable(item, user_id) {
    return None;
  }
  if item.item_type != ItemType::Link {
    return Some(item);
  }
  let target = db.item.get(item.link_to.as_ref()?).ok()?;
  (readable(target, user_id) && target.item_type != ItemType::Link).then_some(target)
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DescribeScopeItemsRequest {
  item_ids: Vec<Uid>,
}

/// An item chosen as a chat's scope, as it resolves now: a link is described as its target.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScopeItemDescription {
  id: Uid,
  /// False if the item is missing or unreadable, or is a link to another link: it would be left out of the scope.
  resolved: bool,
  /// The first line of the title. None when untitled or unresolved.
  title: Option<String>,
  item_type: Option<String>,
}

#[derive(Serialize)]
struct DescribeScopeItemsResponse {
  items: Vec<ScopeItemDescription>,
}

/// Titles and availability of items chosen as a chat's scope, which the client may not have loaded.
pub(super) async fn handle_describe_scope_items(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to describe scope items.")?;
  let request: DescribeScopeItemsRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;
  if request.item_ids.len() > MAX_SCOPE_ITEMS {
    return Err(format!("At most {MAX_SCOPE_ITEMS} scope items can be described.").into());
  }
  let items = describe_scope_items(&*db.lock().await, &session.user_id, &request.item_ids);
  debug!("Executed 'describe-scope-items' command for user '{}'.", session.user_id);
  Ok(Some(serde_json::to_string(&DescribeScopeItemsResponse { items })?))
}

/// In the order given, with the same resolution as `resolve_item_scope`.
fn describe_scope_items(db: &Db, user_id: &Uid, item_ids: &[Uid]) -> Vec<ScopeItemDescription> {
  item_ids
    .iter()
    .map(|item_id| match db.item.get(item_id).ok().and_then(|item| resolve_content(db, item, user_id)) {
      Some(target) => ScopeItemDescription {
        id: item_id.clone(),
        resolved: true,
        title: target
          .title
          .as_deref()
          .and_then(|title| title.lines().map(str::trim).find(|line| !line.is_empty()))
          .map(|line| line.chars().take(SCOPE_ITEM_TITLE_MAX_CHARS).collect()),
        item_type: Some(target.item_type.as_str().to_owned()),
      },
      None => ScopeItemDescription { id: item_id.clone(), resolved: false, title: None, item_type: None },
    })
    .collect()
}

fn sorted_children<'a>(db: &'a Db, parent_id: &Uid) -> InfuResult<Vec<&'a Item>> {
  let mut children = db.item.get_children(parent_id)?;
  children.sort_by(|a, b| a.ordering.cmp(&b.ordering).then_with(|| a.id.cmp(&b.id)));
  Ok(children)
}

/// The scope of items chosen in a chat. An item that does not resolve is reported as a problem; if none
/// resolve, this is an error for the user, since the chat would otherwise search nothing without saying so.
pub(super) fn resolve_item_scope(db: &Db, user_id: &Uid, item_ids: &[Uid]) -> InfuResult<ResolvedScope> {
  let user = db.user.get(user_id).ok_or(format!("Unknown user '{}'.", user_id))?;
  let mut problems = Vec::new();
  let mut roots = Vec::new();
  for item_id in item_ids {
    match db.item.get(item_id).ok().and_then(|item| resolve_content(db, item, user_id)) {
      Some(target) => {
        if !roots.contains(&target.id) {
          roots.push(target.id.clone());
        }
      }
      None => problems.push(ScopeProblem::UnresolvedItem { item_id: item_id.clone() }),
    }
  }
  if roots.is_empty() {
    return Err("None of the items in scope exist any more. Remove them or add others.".into());
  }
  Ok(ResolvedScope {
    include_roots: Some(roots.iter().cloned().collect()),
    source: ScopeSource::Items(roots),
    home_page_id: user.home_page_id.clone(),
    exclude_roots: HashSet::new(),
    problems,
  })
}

/// The collection page `id` names: the user's own page with the Collection flag, outside the trash.
fn collection_page<'a>(db: &'a Db, user_id: &Uid, id: &Uid) -> Result<&'a Item, ScopeProblem> {
  let item = db.item.get(id).ok().filter(|item| &item.owner_id == user_id);
  match item {
    Some(page)
      if page.item_type == ItemType::Page
        && page.flags.is_some_and(|flags| flags & PAGE_COLLECTION_FLAG != 0)
        && !is_in_trash(db, page) =>
    {
      Ok(page)
    }
    _ => Err(ScopeProblem::UnavailableCollection {
      collection_id: id.clone(),
      title: item.and_then(|item| item.title.clone()),
    }),
  }
}

/// The targets of a collection's direct link children, each once, in page order. Other children are annotations
/// and cover nothing. A link with no readable target, or that targets another link, is left out without a problem:
/// it already renders as broken in the collection page, where it is removed like any other member.
///
/// A member that is itself a collection page covers that page's subtree, as any page member does. Its members are
/// links, and coverage never follows link targets, so membership does not compose.
pub(super) fn collection_member_targets(db: &Db, user_id: &Uid, collection: &Item) -> InfuResult<Vec<Uid>> {
  let mut targets = Vec::new();
  for child in sorted_children(db, &collection.id)? {
    if child.item_type != ItemType::Link {
      continue;
    }
    if let Some(target) = resolve_content(db, child, user_id)
      && !targets.contains(&target.id)
    {
      targets.push(target.id.clone());
    }
  }
  Ok(targets)
}

/// The scope a saved reference covers now, from live data.
pub(super) fn resolve_scope_ref(db: &Db, user_id: &Uid, scope: &ScopeRef) -> InfuResult<ResolvedScope> {
  let user = db.user.get(user_id).ok_or(format!("Unknown user '{}'.", user_id))?;
  let covers_nothing = |problem: ScopeProblem| ResolvedScope {
    source: ScopeSource::Unavailable,
    home_page_id: user.home_page_id.clone(),
    include_roots: Some(HashSet::new()),
    exclude_roots: HashSet::new(),
    problems: vec![problem],
  };
  let (id, except) = match scope {
    ScopeRef::Everything => return ResolvedScope::for_chat(db, user_id, None, HashSet::new()),
    ScopeRef::Collection { id } => (id, false),
    ScopeRef::EverythingExcept { id } => (id, true),
    ScopeRef::Unavailable => return Ok(covers_nothing(ScopeProblem::RetiredScope)),
  };
  let collection = match collection_page(db, user_id, id) {
    Ok(collection) => collection,
    // An unavailable exclusion covers nothing too, not everything: what it should have hidden is unknown.
    Err(problem) => return Ok(covers_nothing(problem)),
  };
  let targets = collection_member_targets(db, user_id, collection)?.into_iter().collect::<HashSet<_>>();
  let name = collection.title.clone().unwrap_or_default();
  Ok(match except {
    // Both empty cases fall out of the sets: an empty collection includes nothing, and excludes nothing.
    false => ResolvedScope {
      source: ScopeSource::Collection { id: id.clone(), name },
      home_page_id: user.home_page_id.clone(),
      include_roots: Some(targets),
      exclude_roots: HashSet::new(),
      problems: Vec::new(),
    },
    true => ResolvedScope {
      source: ScopeSource::Except { id: id.clone(), name },
      home_page_id: user.home_page_id.clone(),
      include_roots: None,
      exclude_roots: targets,
      problems: Vec::new(),
    },
  })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListCollectionsRequest {
  /// The page being viewed, which ranks collections near it. Null ranks none.
  #[serde(deserialize_with = "Option::deserialize")]
  current_page_id: Option<Uid>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectionSummary {
  id: Uid,
  title: String,
  /// Titles of the pages above the collection, outermost first, without the home page.
  path: Vec<String>,
  /// Distinct targets of its links that resolve, the same members that `collection_member_targets` gives.
  member_count: usize,
  /// How many levels below its root page the collection's nearest common ancestor with the current page is: the
  /// deeper, the nearer the collection is to where the user is. None when the only common ancestor is a root page,
  /// such as Home, or there is none.
  here_depth: Option<usize>,
}

#[derive(Serialize)]
struct ListCollectionsResponse {
  collections: Vec<CollectionSummary>,
}

pub(super) async fn handle_list_collections(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to list collections.")?;
  let request: ListCollectionsRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;
  let collections = list_collections(&*db.lock().await, &session.user_id, request.current_page_id.as_ref())?;
  debug!("Executed 'list-collections' command for user '{}'.", session.user_id);
  Ok(Some(serde_json::to_string(&ListCollectionsResponse { collections })?))
}

/// The item and the items above it, nearest first, up to its root page. Stops at a cycle or a missing parent.
fn ancestor_chain<'a>(db: &'a Db, item: &'a Item) -> Vec<&'a Item> {
  let mut chain = vec![item];
  let mut seen = HashSet::from([&item.id]);
  let mut current = item;
  while let Some(parent) = current
    .parent_id
    .as_ref()
    .filter(|parent_id| !is_empty_uid(parent_id))
    .and_then(|parent_id| db.item.get(parent_id).ok())
  {
    if !seen.insert(&parent.id) {
      break;
    }
    chain.push(parent);
    current = parent;
  }
  chain
}

/// All of the user's collections, sorted by title and then path, each ranked against the current page.
///
/// Ranking walks up from each collection and from the current page, never down, so a collection kept in a subpage
/// of a project (Northstar / Collections / Key sources) ranks highly while the user is anywhere in that project.
/// Every item is scanned for the flag: an index is not worth keeping until this measures slow.
fn list_collections(db: &Db, user_id: &Uid, current_page_id: Option<&Uid>) -> InfuResult<Vec<CollectionSummary>> {
  let user = db.user.get(user_id).ok_or(format!("Unknown user '{}'.", user_id))?;
  let current_chain = current_page_id
    .and_then(|id| db.item.get(id).ok())
    .filter(|item| &item.owner_id == user_id)
    .map(|item| ancestor_chain(db, item).into_iter().map(|item| &item.id).collect::<Vec<_>>())
    .unwrap_or_default();
  let mut collections = Vec::new();
  for item in db.item.user_items(user_id) {
    if item.item_type != ItemType::Page || !item.flags.is_some_and(|flags| flags & PAGE_COLLECTION_FLAG != 0) {
      continue;
    }
    let Ok(collection) = collection_page(db, user_id, &item.id) else {
      continue;
    };
    let chain = ancestor_chain(db, collection);
    let here_depth = chain.iter().position(|ancestor| current_chain.contains(&&ancestor.id)).and_then(|index| {
      // Levels below the root: the ancestor's own chain is the rest of this one.
      let depth = chain.len() - 1 - index;
      (depth > 0).then_some(depth)
    });
    collections.push(CollectionSummary {
      id: collection.id.clone(),
      title: collection.title.clone().unwrap_or_default(),
      path: chain[1..]
        .iter()
        .rev()
        .filter(|ancestor| ancestor.id != user.home_page_id)
        .map(|ancestor| ancestor.title.clone().unwrap_or_default())
        .collect(),
      member_count: collection_member_targets(db, user_id, collection)?.len(),
      here_depth,
    });
  }
  let key = |summary: &CollectionSummary| (summary.title.to_lowercase(), summary.path.join("\u{0}").to_lowercase());
  collections.sort_by(|a, b| key(a).cmp(&key(b)).then_with(|| a.id.cmp(&b.id)));
  Ok(collections)
}

/// The most items one coverage request can ask about: more than a screen of rendered items.
const MAX_COVERAGE_ITEMS: usize = 2000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CollectionCoverageRequest {
  collection_id: Uid,
  item_ids: Vec<Uid>,
}

/// How a collection covers an item, for collection-mode marks.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ItemCoverage {
  /// The item, or a link's target, is a member.
  Direct,
  /// The nearest member above the item, through children and attachments.
  #[serde(rename_all = "camelCase")]
  Inherited { via_id: Uid, via_title: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectionCoverageResponse {
  /// False when the collection is missing, trashed or no longer flagged. Nothing is covered then.
  available: bool,
  /// By requested id. Items that are not covered, missing or unreadable are left out.
  items: HashMap<Uid, ItemCoverage>,
}

pub(super) async fn handle_collection_coverage(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = session_maybe.as_ref().ok_or("Session is required to check collection coverage.")?;
  let request: CollectionCoverageRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;
  if request.item_ids.len() > MAX_COVERAGE_ITEMS {
    return Err(format!("At most {MAX_COVERAGE_ITEMS} items can be checked at once.").into());
  }
  let response = collection_coverage(&*db.lock().await, &session.user_id, &request.collection_id, &request.item_ids)?;
  debug!("Executed 'collection-coverage' command for user '{}'.", session.user_id);
  Ok(Some(serde_json::to_string(&response)?))
}

/// Coverage is worked out per item by walking up from it, as `ResolvedScope::contains` does, so the client needs no
/// ancestors loaded: it often has none for a link target that lives elsewhere.
fn collection_coverage(
  db: &Db,
  user_id: &Uid,
  collection_id: &Uid,
  item_ids: &[Uid],
) -> InfuResult<CollectionCoverageResponse> {
  let Ok(collection) = collection_page(db, user_id, collection_id) else {
    return Ok(CollectionCoverageResponse { available: false, items: HashMap::new() });
  };
  let members = collection_member_targets(db, user_id, collection)?.into_iter().collect::<HashSet<_>>();
  let mut items = HashMap::new();
  for item_id in item_ids {
    let Some(target) = db.item.get(item_id).ok().and_then(|item| resolve_content(db, item, user_id)) else {
      continue;
    };
    if members.contains(&target.id) {
      items.insert(item_id.clone(), ItemCoverage::Direct);
      continue;
    }
    if let Some(via) = ancestor_chain(db, target).into_iter().skip(1).find(|ancestor| members.contains(&ancestor.id)) {
      items.insert(item_id.clone(), ItemCoverage::Inherited { via_id: via.id.clone(), via_title: via.title.clone() });
    }
  }
  Ok(CollectionCoverageResponse { available: true, items })
}

/// A database in a temporary directory, holding one user with the standard pages.
#[cfg(test)]
pub(super) mod test_db {
  use super::*;
  use crate::storage::db::user::User;
  use crate::web::routes::{
    default_dock_page, default_home_page, default_queries_page, default_trash_page, ensure_prompts_page,
  };
  use infusdk::item::NoteFlags;
  use std::path::PathBuf;

  pub(crate) struct TestDb {
    pub db: Db,
    pub user_id: Uid,
    pub home_id: Uid,
    pub trash_id: Uid,
    /// Outside the home page tree, so collections kept here are not in the default search universe.
    pub dock_id: Uid,
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
        query_profiles: None,
      };
      db.user.add(user.clone()).await.unwrap();
      db.item.load_user_items(&user.id, true).await.unwrap();
      db.item.add(default_home_page(&user.id, "test", user.home_page_id.clone(), 60, 2.0)).await.unwrap();
      db.item.add(default_trash_page(&user.id, user.trash_page_id.clone(), 2.0)).await.unwrap();
      db.item.add(default_dock_page(&user.id, user.dock_page_id.clone(), 2.0)).await.unwrap();
      db.item.add(default_queries_page(&user.id, user.queries_page_id.clone(), 2.0)).await.unwrap();
      ensure_prompts_page(&mut db, &user.id).await.unwrap();
      TestDb {
        db,
        user_id: user.id.clone(),
        home_id: user.home_page_id,
        trash_id: user.trash_page_id,
        dock_id: user.dock_page_id,
        dir: TempDir(dir),
      }
    }

    /// A collection in the dock, linking to each member.
    pub async fn collection_of(&mut self, title: &str, members: &[&Uid]) -> Uid {
      let id = self.collection(&self.dock_id.clone(), title).await;
      for member in members {
        self.link(&id, member).await;
      }
      id
    }

    /// The scope of a collection of `members` that also hides `hidden`. A collection alone cannot say both; this
    /// adds the exclusions as a chat run adds its own transcript.
    pub async fn scope_hiding(&mut self, members: &[&Uid], hidden: &[&Uid]) -> ResolvedScope {
      let id = self.collection_of("Scope", members).await;
      let scope = resolve_scope_ref(&self.db, &self.user_id, &ScopeRef::Collection { id }).unwrap();
      let hidden = hidden.iter().map(|id| (*id).clone()).collect();
      ResolvedScope::for_chat(&self.db, &self.user_id, Some(scope), hidden).unwrap()
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
        vec![TableColumn { width_gr: 480, name: "Title".to_owned(), align: None }],
        1,
      );
      self.add(item).await
    }

    pub async fn collection(&mut self, parent_id: &Uid, title: &str) -> Uid {
      let id = self.page(parent_id, title).await;
      self.set_page_flags(&id, PAGE_COLLECTION_FLAG).await;
      id
    }

    pub async fn set_page_flags(&mut self, page_id: &Uid, flags: i64) {
      let mut page = self.db.item.get(page_id).unwrap().clone();
      page.flags = Some(flags);
      self.db.item.update(&page).await.unwrap();
    }

    pub async fn note(&mut self, parent_id: &Uid, title: &str, relationship: RelationshipToParent) -> Uid {
      let item =
        Item::new_note(parent_id, vec![], Vector { x: 0, y: 0 }, GRID_SIZE, relationship, title, NoteFlags::None, None);
      self.add(item).await
    }

    /// Composites and files have no constructor here, so they start as notes with the note-only fields cleared.
    pub async fn non_note(&mut self, parent_id: &Uid, title: &str, edit: impl FnOnce(&mut Item)) -> Uid {
      self
        .note_with(parent_id, title, |item| {
          item.urls = None;
          item.url = None;
          item.emoji = None;
          item.icon_mode = None;
          item.inline_marks = None;
          item.flags = Some(0);
          edit(item);
        })
        .await
    }

    pub async fn note_with(&mut self, parent_id: &Uid, title: &str, edit: impl FnOnce(&mut Item)) -> Uid {
      let mut item = Item::new_note(
        parent_id,
        vec![],
        Vector { x: 0, y: 0 },
        GRID_SIZE,
        RelationshipToParent::Child,
        title,
        NoteFlags::None,
        None,
      );
      edit(&mut item);
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
    fn contains(&self, scope: &ResolvedScope, item_id: &Uid) -> bool {
      scope.contains(&self.db, self.db.item.get(item_id).unwrap())
    }

    /// Checks that contains() and allowed_item_ids() agree on every item the user owns. A link inside the scope is
    /// left out of the allowed ids when its target is outside it, so its title is never a hit for hidden content.
    fn assert_consistent(&self, scope: &ResolvedScope) {
      let allowed = scope.allowed_item_ids(&self.db, &self.user_id).unwrap().into_iter().collect::<HashSet<_>>();
      for item_key in self.db.item.all_loaded_items().into_iter().filter(|key| key.user_id == self.user_id) {
        let item = self.db.item.get(&item_key.item_id).unwrap();
        let target_allowed = item.item_type != ItemType::Link
          || resolve_content(&self.db, item, &self.user_id).is_some_and(|target| scope.contains(&self.db, target));
        assert_eq!(
          allowed.contains(&item.id),
          readable(item, &self.user_id) && scope.contains(&self.db, item) && target_allowed,
          "contains() and allowed_item_ids() disagree on '{:?}'",
          item.title
        );
      }
    }
  }

  #[tokio::test]
  async fn members_cover_their_descendants_but_not_link_targets_or_ancestors() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let projects = t.page(&home, "Projects").await;
    let project_note = t.note(&projects, "plan", RelationshipToParent::Child).await;
    let attachment = t.note(&project_note, "attached", RelationshipToParent::Attachment).await;
    let other = t.page(&home, "Other").await;
    let outside_link = t.link(&projects, &other).await;
    let work = t.collection_of("Work", &[&projects]).await;

    let resolved = t.resolve_ref(&collection(&work));
    assert_eq!(resolved.include_root_count(), Some(1));
    assert!(resolved.problems.is_empty());
    for inside in [&projects, &project_note, &attachment, &outside_link] {
      assert!(t.contains(&resolved, inside));
    }
    assert!(!t.contains(&resolved, &other), "link targets are not followed");
    assert!(!t.contains(&resolved, &home), "ancestors of members are not covered");
    assert!(
      !resolved.allowed_item_ids(&t.db, &t.user_id).unwrap().contains(&outside_link),
      "a link to something outside is not a hit either"
    );
    t.assert_consistent(&resolved);
  }

  #[tokio::test]
  async fn exclusions_win_whichever_root_is_nested() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let archive = t.page(&home, "Archive").await;
    let taxes = t.page(&archive, "Taxes").await;
    let receipt = t.note(&taxes, "receipt", RelationshipToParent::Child).await;
    let old = t.note(&archive, "old", RelationshipToParent::Child).await;

    let carve_out = t.scope_hiding(&[&archive], &[&taxes]).await;
    assert!(t.contains(&carve_out, &old));
    assert!(!t.contains(&carve_out, &receipt));
    t.assert_consistent(&carve_out);

    let carve_in = t.scope_hiding(&[&taxes], &[&archive]).await;
    assert!(!t.contains(&carve_in, &taxes));
    assert!(!t.contains(&carve_in, &receipt));
    assert!(carve_in.allowed_item_ids(&t.db, &t.user_id).unwrap().is_empty());
    t.assert_consistent(&carve_in);
  }

  #[tokio::test]
  async fn chosen_items_cover_their_descendants_and_links_resolve_to_their_targets() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let projects = t.page(&home, "Projects").await;
    let plan = t.note(&projects, "plan", RelationshipToParent::Child).await;
    let attachment = t.note(&plan, "attached", RelationshipToParent::Attachment).await;
    let reading = t.page(&home, "Reading").await;
    let book = t.note(&reading, "book", RelationshipToParent::Child).await;
    let other = t.page(&home, "Other").await;
    let link_to_reading = t.link(&other, &reading).await;

    // The link and its target are the same root, and the first occurrence keeps its place.
    let resolved =
      resolve_item_scope(&t.db, &t.user_id, &[link_to_reading.clone(), projects.clone(), reading.clone()]).unwrap();
    assert_eq!(resolved.source, ScopeSource::Items(vec![reading.clone(), projects.clone()]));
    assert_eq!(resolved.include_root_count(), Some(2));
    assert_eq!(resolved.exclude_root_count(), 0);
    assert!(resolved.problems.is_empty());
    for inside in [&projects, &plan, &attachment, &reading, &book] {
      assert!(t.contains(&resolved, inside));
    }
    assert!(!t.contains(&resolved, &other), "the link's parent is not chosen");
    assert!(!t.contains(&resolved, &link_to_reading));
    assert!(!t.contains(&resolved, &home));
    t.assert_consistent(&resolved);
  }

  #[tokio::test]
  async fn chosen_items_that_do_not_resolve_are_reported_and_none_resolving_is_an_error() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let a = t.page(&home, "A").await;
    let b = t.page(&home, "B").await;
    let link_to_a = t.link(&home, &a).await;
    let link_to_link = t.link(&home, &link_to_a).await;
    let missing = new_uid();

    let resolved = resolve_item_scope(&t.db, &t.user_id, &[missing.clone(), a.clone(), link_to_link.clone()]).unwrap();
    assert_eq!(resolved.source, ScopeSource::Items(vec![a.clone()]));
    assert_eq!(
      resolved.problems,
      vec![
        ScopeProblem::UnresolvedItem { item_id: missing.clone() },
        ScopeProblem::UnresolvedItem { item_id: link_to_link.clone() }
      ]
    );
    assert!(t.contains(&resolved, &a));
    assert!(!t.contains(&resolved, &b));

    assert!(resolve_item_scope(&t.db, &t.user_id, &[missing, link_to_link]).is_err());
    assert!(resolve_item_scope(&t.db, &t.user_id, &[]).is_err());
  }

  #[tokio::test]
  async fn scope_items_are_described_in_order_as_they_resolve() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let projects = t.page(&home, "  Projects\nsecond line").await;
    let untitled = t.note(&home, "", RelationshipToParent::Child).await;
    let link = t.link(&home, &projects).await;
    let link_to_link = t.link(&home, &link).await;
    let missing = new_uid();

    let described =
      describe_scope_items(&t.db, &t.user_id, &[link.clone(), untitled.clone(), missing.clone(), link_to_link.clone()]);
    let page = |id: &Uid| ScopeItemDescription {
      id: id.clone(),
      resolved: true,
      title: Some("Projects".to_owned()),
      item_type: Some("page".to_owned()),
    };
    let unresolved = |id: &Uid| ScopeItemDescription { id: id.clone(), resolved: false, title: None, item_type: None };
    assert_eq!(
      described,
      vec![
        page(&link),
        ScopeItemDescription { id: untitled, resolved: true, title: None, item_type: Some("note".to_owned()) },
        unresolved(&missing),
        unresolved(&link_to_link),
      ]
    );
  }

  impl TestDb {
    fn resolve_ref(&self, scope: &ScopeRef) -> ResolvedScope {
      resolve_scope_ref(&self.db, &self.user_id, scope).unwrap()
    }

    fn covers_nothing(&self, scope: &ResolvedScope) -> bool {
      scope.allowed_item_ids(&self.db, &self.user_id).unwrap().is_empty() && !self.contains(scope, &self.home_id)
    }
  }

  fn collection(id: &Uid) -> ScopeRef {
    ScopeRef::Collection { id: id.clone() }
  }

  fn except(id: &Uid) -> ScopeRef {
    ScopeRef::EverythingExcept { id: id.clone() }
  }

  #[tokio::test]
  async fn a_collection_covers_its_members_and_their_descendants_not_its_annotations() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let research = t.page(&home, "Research").await;
    let financials = t.page(&research, "Financials").await;
    let q1 = t.note(&financials, "Q1", RelationshipToParent::Child).await;
    let q1_attachment = t.note(&q1, "Q1 detail", RelationshipToParent::Attachment).await;
    let interviews = t.page(&research, "Interviews").await;
    let interview = t.note(&interviews, "CEO", RelationshipToParent::Child).await;
    let elsewhere = t.page(&home, "Elsewhere").await;
    let report = t.note(&elsewhere, "Industry report", RelationshipToParent::Child).await;

    let key_sources = t.collection(&research, "Key sources").await;
    t.link(&key_sources, &financials).await;
    t.link(&key_sources, &report).await;
    // The same target again, through another link to it, is not another member.
    let link_to_financials = t.link(&elsewhere, &financials).await;
    t.link(&key_sources, &financials).await;
    let annotation = t.note(&key_sources, "why these", RelationshipToParent::Child).await;
    let annotation_page = t.page(&key_sources, "Maybe later").await;
    t.link(&annotation_page, &interviews).await;

    assert_eq!(
      collection_member_targets(&t.db, &t.user_id, t.db.item.get(&key_sources).unwrap()).unwrap(),
      vec![financials.clone(), report.clone()]
    );
    let resolved = t.resolve_ref(&collection(&key_sources));
    assert_eq!(resolved.source, ScopeSource::Collection { id: key_sources.clone(), name: "Key sources".to_owned() });
    assert_eq!(resolved.include_root_count(), Some(2));
    assert!(resolved.problems.is_empty());
    for inside in [&financials, &q1, &q1_attachment, &report] {
      assert!(t.contains(&resolved, inside));
    }
    for outside in [&home, &research, &interviews, &interview, &elsewhere, &key_sources, &annotation, &annotation_page]
    {
      assert!(!t.contains(&resolved, outside));
    }
    assert!(!t.contains(&resolved, &link_to_financials), "a link is covered by where it is, not what it targets");
    t.assert_consistent(&resolved);
  }

  #[tokio::test]
  async fn an_empty_collection_covers_nothing_and_excludes_nothing() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let notes = t.page(&home, "Notes").await;
    let empty = t.collection(&home, "Empty").await;
    t.note(&empty, "not a member", RelationshipToParent::Child).await;
    let broken = t.collection(&home, "Broken").await;
    t.link(&broken, &new_uid()).await;
    let link_to_notes = t.link(&home, &notes).await;
    t.link(&broken, &link_to_notes).await;

    for id in [&empty, &broken] {
      let resolved = t.resolve_ref(&collection(id));
      assert_eq!(resolved.include_root_count(), Some(0));
      assert!(resolved.problems.is_empty(), "broken links are shown in the page, not reported");
      assert!(t.covers_nothing(&resolved));

      let resolved = t.resolve_ref(&except(id));
      assert_eq!(resolved.exclude_root_count(), 0);
      assert!(t.contains(&resolved, &home));
      assert!(t.contains(&resolved, &notes));
    }
  }

  #[tokio::test]
  async fn everything_except_a_collection_hides_its_members_however_they_are_reached() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let private = t.page(&home, "Private").await;
    let diary = t.note(&private, "diary", RelationshipToParent::Child).await;
    let notes = t.page(&home, "Notes").await;
    let link_to_private = t.link(&notes, &private).await;
    let link_to_diary = t.link(&notes, &diary).await;
    let hidden = t.collection(&notes, "Hidden").await;
    t.link(&hidden, &private).await;

    let resolved = t.resolve_ref(&except(&hidden));
    assert_eq!(resolved.source, ScopeSource::Except { id: hidden.clone(), name: "Hidden".to_owned() });
    assert_eq!(resolved.include_root_count(), None);
    assert_eq!(resolved.exclude_root_count(), 1);
    assert!(t.contains(&resolved, &home));
    assert!(t.contains(&resolved, &notes));
    assert!(t.contains(&resolved, &hidden), "the collection page itself is not excluded");
    assert!(!t.contains(&resolved, &private));
    assert!(!t.contains(&resolved, &diary));
    let allowed = resolved.allowed_item_ids(&t.db, &t.user_id).unwrap();
    assert!(allowed.contains(&notes));
    for excluded in [&private, &diary, &link_to_private, &link_to_diary] {
      assert!(!allowed.contains(excluded), "links to excluded items must not surface as hits");
    }
    // Like everything, direct reads of items outside the home tree are still allowed; only exclusions apply.
    let trashed = t.note(&t.trash_id.clone(), "trashed", RelationshipToParent::Child).await;
    assert!(t.contains(&resolved, &trashed));
    assert!(!allowed.contains(&trashed));
  }

  #[tokio::test]
  async fn an_unavailable_collection_covers_nothing_used_either_way() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let trash = t.trash_id.clone();
    let notes = t.page(&home, "Notes").await;

    let trashed_parent = t.page(&trash, "Old project").await;
    let trashed = t.collection(&trashed_parent, "Trashed").await;
    t.link(&trashed, &notes).await;
    let unflagged = t.collection(&home, "Unflagged").await;
    t.link(&unflagged, &notes).await;
    t.set_page_flags(&unflagged, 0).await;
    let flagged_note = t.note_with(&home, "Flagged note", |item| item.flags = Some(PAGE_COLLECTION_FLAG)).await;
    let missing = new_uid();

    let cases = [
      (trashed.clone(), Some("Trashed")),
      (unflagged.clone(), Some("Unflagged")),
      (flagged_note.clone(), Some("Flagged note")),
      (missing.clone(), None),
    ];
    for (id, title) in cases {
      for scope in [collection(&id), except(&id)] {
        let resolved = t.resolve_ref(&scope);
        assert_eq!(resolved.source, ScopeSource::Unavailable);
        assert_eq!(
          resolved.problems,
          vec![ScopeProblem::UnavailableCollection { collection_id: id.clone(), title: title.map(str::to_owned) }]
        );
        assert!(t.covers_nothing(&resolved), "{scope:?} must not broaden retrieval");
        assert!(!t.contains(&resolved, &notes));
      }
    }

    let resolved = t.resolve_ref(&ScopeRef::Unavailable);
    assert_eq!(resolved.problems, vec![ScopeProblem::RetiredScope]);
    assert!(t.covers_nothing(&resolved));

    // Restoring the page, or flagging it again, makes the same reference work again.
    t.set_page_flags(&unflagged, PAGE_COLLECTION_FLAG).await;
    assert!(t.contains(&t.resolve_ref(&collection(&unflagged)), &notes));
  }

  #[tokio::test]
  async fn a_collection_that_is_a_member_covers_only_its_own_page() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let financials = t.page(&home, "Financials").await;
    let inner = t.collection(&home, "Inner").await;
    let inner_link = t.link(&inner, &financials).await;
    let inner_note = t.note(&inner, "about inner", RelationshipToParent::Child).await;
    let outer = t.collection(&home, "Outer").await;
    t.link(&outer, &inner).await;

    let resolved = t.resolve_ref(&collection(&outer));
    assert!(t.contains(&resolved, &inner));
    assert!(t.contains(&resolved, &inner_note));
    assert!(!t.contains(&resolved, &financials), "membership does not compose");
    let allowed = resolved.allowed_item_ids(&t.db, &t.user_id).unwrap();
    assert_eq!(allowed, {
      let mut ids = vec![inner.clone(), inner_note.clone()];
      ids.sort();
      ids
    });
    assert!(!allowed.contains(&inner_link));
  }

  #[tokio::test]
  async fn everything_resolves_to_default_retrieval() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let notes = t.page(&home, "Notes").await;
    let resolved = t.resolve_ref(&ScopeRef::Everything);
    assert_eq!(resolved.source, ScopeSource::All);
    assert_eq!(resolved.include_root_count(), None);
    assert_eq!(resolved.exclude_root_count(), 0);
    assert!(t.contains(&resolved, &notes));
  }

  #[test]
  fn scope_refs_serialize_with_a_kind() {
    let id = new_uid();
    for (scope, json) in [
      (ScopeRef::Everything, serde_json::json!({ "kind": "everything" })),
      (collection(&id), serde_json::json!({ "kind": "collection", "id": id })),
      (except(&id), serde_json::json!({ "kind": "everythingExcept", "id": id })),
      (ScopeRef::Unavailable, serde_json::json!({ "kind": "unavailable" })),
    ] {
      assert_eq!(serde_json::to_value(&scope).unwrap(), json);
      assert_eq!(serde_json::from_value::<ScopeRef>(json).unwrap(), scope);
    }
    assert!(serde_json::from_value::<ScopeRef>(serde_json::json!({ "kind": "collection" })).is_err());
    assert!(serde_json::from_value::<ScopeRef>(serde_json::json!(id)).is_err());
  }

  #[tokio::test]
  async fn collections_are_listed_with_paths_and_ranked_by_their_nearest_common_ancestor() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let research = t.page(&home, "Research").await;
    let northstar = t.page(&research, "Northstar").await;
    let financials = t.page(&northstar, "Financials").await;
    let q1 = t.page(&financials, "Q1").await;
    let folder = t.page(&northstar, "Collections").await;
    let key_sources = t.collection(&folder, "Key sources").await;
    t.link(&key_sources, &financials).await;
    t.link(&key_sources, &financials).await;
    t.link(&key_sources, &new_uid()).await;
    let risks = t.collection(&research, "risks").await;
    let personal = t.collection(&home, "Personal").await;
    t.collection(&t.trash_id.clone(), "Trashed").await;
    let unflagged = t.collection(&home, "Unflagged").await;
    t.set_page_flags(&unflagged, 0).await;

    let summary =
      |id: &Uid, title: &str, path: &[&str], member_count: usize, here_depth: Option<usize>| CollectionSummary {
        id: id.clone(),
        title: title.to_owned(),
        path: path.iter().map(|title| (*title).to_owned()).collect(),
        member_count,
        here_depth,
      };
    // Browsing Q1: Key sources shares Northstar (depth 2), risks shares Research (depth 1), Personal only Home.
    assert_eq!(
      list_collections(&t.db, &t.user_id, Some(&q1)).unwrap(),
      vec![
        summary(&key_sources, "Key sources", &["Research", "Northstar", "Collections"], 1, Some(2)),
        summary(&personal, "Personal", &[], 0, None),
        summary(&risks, "risks", &["Research"], 0, Some(1)),
      ]
    );
    // Inside a collection page, it is its own nearest common ancestor.
    let ranked = list_collections(&t.db, &t.user_id, Some(&key_sources)).unwrap();
    assert_eq!(ranked[0].here_depth, Some(4));
    // No current page, or one that is not the user's, ranks nothing.
    for current in [None, Some(new_uid())] {
      let listed = list_collections(&t.db, &t.user_id, current.as_ref()).unwrap();
      assert!(listed.iter().all(|summary| summary.here_depth.is_none()));
    }
  }

  #[tokio::test]
  async fn an_unavailable_scope_explains_itself_and_others_do_not() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let named = t.collection(&t.trash_id.clone(), "  \n  Key sources\nmore").await;
    let untitled = t.collection(&t.trash_id.clone(), "").await;
    let available = t.collection(&home, "Fine").await;
    let message = |scope: ScopeRef| t.resolve_ref(&scope).unavailable_message();
    assert_eq!(
      message(collection(&named)).as_deref(),
      Some("\"Key sources\" is no longer a collection. Choose another scope.")
    );
    for scope in [collection(&untitled), except(&new_uid())] {
      assert_eq!(
        message(scope).as_deref(),
        Some("The collection this chat is limited to no longer exists. Choose another scope.")
      );
    }
    assert_eq!(
      message(ScopeRef::Unavailable).as_deref(),
      Some("Scope pages are no longer used. Choose a collection or Everything as the scope.")
    );
    for scope in [ScopeRef::Everything, collection(&available), except(&available)] {
      assert_eq!(message(scope), None);
    }
  }

  #[tokio::test]
  async fn coverage_marks_members_directly_and_their_contents_through_the_nearest_member() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let research = t.page(&home, "Research").await;
    let financials = t.page(&research, "Financials").await;
    let q1 = t.page(&financials, "Q1").await;
    let note = t.note(&q1, "revenue", RelationshipToParent::Child).await;
    let attached = t.note(&note, "source", RelationshipToParent::Attachment).await;
    let other = t.page(&home, "Other").await;
    let link_to_q1 = t.link(&other, &q1).await;
    let key_sources = t.collection_of("Key sources", &[&financials, &q1]).await;

    let ids = [&research, &financials, &q1, &note, &attached, &other, &link_to_q1, &new_uid()].map(|id| id.clone());
    let coverage = collection_coverage(&t.db, &t.user_id, &key_sources, &ids).unwrap();
    assert!(coverage.available);
    let inherited =
      |via: &Uid, title: &str| ItemCoverage::Inherited { via_id: via.clone(), via_title: Some(title.to_owned()) };
    assert_eq!(
      coverage.items,
      HashMap::from([
        (financials.clone(), ItemCoverage::Direct),
        (q1.clone(), ItemCoverage::Direct),
        (note.clone(), inherited(&q1, "Q1")),
        (attached.clone(), inherited(&q1, "Q1")),
        // A link shows its target, so it is marked as its target is, wherever it appears.
        (link_to_q1.clone(), ItemCoverage::Direct),
      ])
    );

    let missing = collection_coverage(&t.db, &t.user_id, &new_uid(), &ids).unwrap();
    assert!(!missing.available && missing.items.is_empty());
    let json = serde_json::to_value(inherited(&q1, "Q1")).unwrap();
    assert_eq!(json, serde_json::json!({ "kind": "inherited", "viaId": q1, "viaTitle": "Q1" }));
  }
}
