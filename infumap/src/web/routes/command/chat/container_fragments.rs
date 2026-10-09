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

//! Pages, tables, composites, groups and notes as bounded text fragments for the chat tools, and the lines that
//! show lexical_search hits.
//!
//! Containers and notes change whenever the user edits them, so their fragments are built on demand from the
//! live database and never stored. A note's fragments are its text split at paragraph, line, sentence or word
//! boundaries. A container is first rendered under the database lock into units: blocks that are never split
//! across fragments unless one alone exceeds the budget, such as a table row, a composite, a group or a top-level
//! item. Stored fragment counts for files and images are read outside the lock, then the units are packed into
//! fragments in order. Child pages and nested tables are one-line references, so rendering never descends into
//! them. Spatial pages give each child's position and size, and calendar pages its day.
//!
//! A group is not an item but the id shared by two or more children of a page. It is listed as a unit of its page
//! and can be read on its own, as its members laid out the way its page lays them out.
//!
//! A search hit is shown as the record it belongs to: a table row with its cells, or an item with links to its
//! attachments. Its listing says which page or table lists it, in which fragment and group, so the result can
//! link everything from that container down.

use super::*;
use crate::ai::fragment::read_item_fragment_metadata;
use crate::web::routes::command::scope::{ResolvedScope, readable, resolve_content};
use futures_util::{StreamExt, stream};
use infusdk::item::{NoteFlags, NoteUrl};
use sha2::{Digest, Sha256};

/// Body text per fragment, excluding its header. The same budget get_fragment applies to documents.
const FRAGMENT_MAX_CHARS: usize = CHAT_FRAGMENT_TOOL_DEFAULT_MAX_CHARS;
/// Notes outside document pages are cut here; their full text is read as fragments of the note.
const NOTE_INLINE_MAX_CHARS: usize = 600;
const CELL_MAX_CHARS: usize = 200;
const LABEL_MAX_CHARS: usize = 80;
/// A note too long to be its own link label is linked by its start: in a container, where the body then repeats it,
/// and as an attachment in a search result.
const NOTE_LABEL_MAX_CHARS: usize = 40;
const BREADCRUMB_TITLE_MAX_CHARS: usize = 60;
const MAX_DEPTH: usize = 64;
const MAX_PLACEMENTS: usize = 50_000;
const VERSION_CHARS: usize = 8;
/// A table row shown as a search result is cut here.
const ROW_LISTING_MAX_CHARS: usize = 300;
/// A note shown as a search result is cut here; its full text is read as fragments of the note.
const HIT_NOTE_MAX_CHARS: usize = 160;
/// A search result shows this many of its item's attachments, each cut to a short label.
const HIT_ATTACHMENTS_MAX: usize = 4;

/// What the chat tools may read: the user's readable items, limited to the chat's scope if it has one.
pub(super) struct Access<'a> {
  pub user_id: &'a str,
  pub scope: Option<&'a ResolvedScope>,
}

impl Access<'_> {
  pub fn can_read(&self, db: &Db, item: &Item) -> bool {
    readable(item, self.user_id) && self.scope.is_none_or(|scope| scope.contains(db, item))
  }

  /// The item a placement displays. A link whose target is outside the scope has no content.
  pub fn content<'a>(&self, db: &'a Db, item: &'a Item) -> Option<&'a Item> {
    resolve_content(db, item, self.user_id).filter(|content| self.scope.is_none_or(|scope| scope.contains(db, content)))
  }
}

/// Ancestors are only checked for ownership, not scope. An excluded item's descendants are all excluded, so an
/// in-scope container never has an excluded ancestor; ancestors above an include root are shown for navigation.
fn ancestors<'a>(db: &'a Db, item: &'a Item, user_id: &str) -> InfuResult<Vec<&'a Item>> {
  let mut result = Vec::new();
  let mut seen = HashSet::from([&item.id]);
  let mut current = item;
  while let Some(parent_id) = current.parent_id.as_ref() {
    if is_empty_uid(parent_id) {
      break;
    }
    current = db.item.get(parent_id).map_err(|_| "Could not read page hierarchy.")?;
    if !readable(current, user_id) {
      return Err("Page was not found.".into());
    }
    if !seen.insert(&current.id) || result.len() >= MAX_DEPTH {
      return Err("Page hierarchy is cyclic or too deep.".into());
    }
    result.push(current);
  }
  result.reverse();
  Ok(result)
}

pub(super) struct ContainerFragment {
  pub text: String,
  /// The units in this fragment, in order. A unit split across fragments appears in each with its part of the text.
  pub units: Vec<FragmentUnit>,
}

pub(super) struct FragmentUnit {
  /// Placements rendered in the unit: a child with its attachments, or a composite or group with its members.
  pub item_ids: Vec<Uid>,
}

/// A table row on one line, with the placements rendered in it: the row item first, then its cells.
pub(super) struct Row {
  pub item_ids: Vec<Uid>,
  pub text: String,
}

pub(super) struct ContainerFragments {
  /// Changes when anything rendered changes, so a reader can tell that ordinals may have moved.
  pub version: String,
  pub fragments: Vec<ContainerFragment>,
  pub rows: Vec<Row>,
}

impl ContainerFragments {
  /// The first fragment that renders the placement.
  pub fn fragment_of(&self, item_id: &Uid) -> Option<usize> {
    self.fragments.iter().position(|fragment| fragment.units.iter().any(|unit| unit.item_ids.contains(item_id)))
  }

  /// The table row rendering the placement.
  pub fn row_of(&self, item_id: &Uid) -> Option<&Row> {
    self.rows.iter().find(|row| row.item_ids.contains(item_id))
  }
}

/// How lexical_search shows a hit: the page or table whose fragments list it, and the hit as text.
pub(super) struct HitListing {
  /// The listing container, when it is readable and in the scope.
  pub container_id: Option<Uid>,
  /// The container fragment listing the hit.
  pub container_fragment: usize,
  /// The group in the container that the hit belongs to, or that the item holding it does.
  pub group_id: Option<Uid>,
  /// The item `text` stands for: the hit, or for a table cell, its row, whose cells hold the cell's text.
  pub subject_id: Uid,
  /// The subject on one line: a table row with its cells, or else a linked label saying what the item is.
  pub text: String,
}

/// Listings for search hits, keyed by hit id, rendering each container once. A hit that is gone or that the chat
/// cannot read has no listing.
pub(super) async fn hit_listings(
  db: &Arc<tokio::sync::Mutex<Db>>,
  access: &Access<'_>,
  item_ids: &[Uid],
) -> HashMap<Uid, HitListing> {
  let (labels, mut placements, data_dir, data_item_ids) = {
    let db = db.lock().await;
    let mut renderer = Renderer::new(&db, access);
    let mut labels = Vec::new();
    let mut placements = HashMap::new();
    for item_id in item_ids {
      let Ok(item) = db.item.get(item_id) else {
        continue;
      };
      // An attachment is part of the item it is attached to, as a cell is of a row, so a hit on either shows the
      // item with its attachments.
      let parent = (item.relationship_to_parent == RelationshipToParent::Attachment)
        .then(|| db.item.get(item.parent_id.as_ref()?).ok())
        .flatten()
        .filter(|parent| access.can_read(&db, parent));
      let (subject_id, content) = match parent {
        Some(parent) => (parent.id.clone(), Some(parent)),
        None => (item_id.clone(), access.content(&db, item)),
      };
      let Some(label) = content.and_then(|content| renderer.record_label(content).ok()) else {
        continue;
      };
      if let Some((container, child)) = listing_placement(&db, item) {
        let group_id = child
          .group_id
          .as_ref()
          .filter(|group_id| group_members(&db, access, group_id).is_some_and(|(page, _)| page.id == container.id));
        // An item's day on a calendar page is where the page shows it, so its result carries it too.
        let date = (Layout::of(container) == Layout::Calendar).then(|| calendar_prefix(child));
        placements.insert(item_id.clone(), (container.id.clone(), group_id.cloned(), date));
      }
      labels.push((item_id.clone(), subject_id, label));
    }
    (labels, placements, db.item.data_dir().to_owned(), renderer.data_item_ids)
  };
  let counts = data_fragment_counts(&data_dir, access.user_id, &data_item_ids).await;
  let mut rendered = HashMap::new();
  for (container_id, ..) in placements.values() {
    if !rendered.contains_key(container_id) {
      rendered.insert(container_id.clone(), container_fragments(db, access, container_id).await.ok());
    }
  }
  labels
    .into_iter()
    .map(|(item_id, subject_id, label)| {
      let text = label.render(&counts);
      let mut listing = HitListing { container_id: None, container_fragment: 0, group_id: None, subject_id, text };
      let Some((container_id, group_id, date)) = placements.remove(&item_id) else {
        return (item_id, listing);
      };
      let Some(fragments) = rendered.get(&container_id).and_then(Option::as_ref) else {
        return (item_id, listing);
      };
      // Document pages do not render attachments, so an attachment is located by its item.
      if let Some(ordinal) = fragments.fragment_of(&item_id).or_else(|| fragments.fragment_of(&listing.subject_id)) {
        listing.container_id = Some(container_id);
        listing.container_fragment = ordinal;
        listing.group_id = group_id;
        // A row's cells are part of the record, so a row or cell hit is shown as the whole row.
        if let Some(row) = fragments.row_of(&item_id) {
          let (text, truncated) = excerpt(&row.text, ROW_LISTING_MAX_CHARS);
          listing.subject_id = row.item_ids[0].clone();
          listing.text = if truncated { format!("{text}…") } else { text };
        }
        if let Some(date) = date {
          listing.text.insert_str(0, &date);
        }
      }
      (item_id, listing)
    })
    .collect()
}

/// Composites are rendered inside the page or table that holds them, so they never list their own items.
fn is_listing_container(item: &Item) -> bool {
  matches!(item.item_type, ItemType::Page | ItemType::Table)
}

/// The page or table whose fragments list `item`, and its child that holds `item`: the item itself, or for an
/// attachment or composite member, the item or composite it is part of.
fn listing_placement<'a>(db: &'a Db, item: &'a Item) -> Option<(&'a Item, &'a Item)> {
  let mut current = item;
  for _ in 0..MAX_DEPTH {
    let parent = db.item.get(current.parent_id.as_ref()?).ok()?;
    if current.relationship_to_parent == RelationshipToParent::Child && is_listing_container(parent) {
      return Some((parent, current));
    }
    current = parent;
  }
  None
}

/// A container rendered under the database lock, waiting for the stored fragment counts of its data items.
pub(super) struct ContainerOutline {
  heading: String,
  /// A line after the heading in every fragment: a table's columns, or the legend for a spatial page's geometry.
  preamble: Option<String>,
  /// Said in the preamble only when the container needs more than one fragment.
  multi_fragment_note: Option<&'static str>,
  row_count: Option<usize>,
  separator: &'static str,
  units: Vec<Unit>,
  rows: Vec<(Vec<Uid>, Pieces)>,
  data_item_ids: HashSet<Uid>,
}

struct Unit {
  pieces: Pieces,
  item_ids: Vec<Uid>,
  /// The table rows in the unit, first and last, counted from zero.
  rows: Option<(usize, usize)>,
}

#[derive(Clone)]
enum Piece {
  Text(String),
  /// ", N fragments" when the data item has stored fragments, otherwise nothing.
  FragmentCount(Uid),
}

#[derive(Clone, Default)]
struct Pieces(Vec<Piece>);

impl Pieces {
  fn text(&mut self, text: &str) {
    if let Some(Piece::Text(last)) = self.0.last_mut() {
      last.push_str(text);
    } else if !text.is_empty() {
      self.0.push(Piece::Text(text.to_owned()));
    }
  }

  fn fragment_count(&mut self, item_id: &Uid) {
    self.0.push(Piece::FragmentCount(item_id.clone()));
  }

  fn append(&mut self, other: Pieces) {
    for piece in other.0 {
      match piece {
        Piece::Text(text) => self.text(&text),
        piece => self.0.push(piece),
      }
    }
  }

  fn is_empty(&self) -> bool {
    self.0.is_empty()
  }

  fn render(&self, counts: &HashMap<Uid, usize>) -> String {
    let mut result = String::new();
    for piece in &self.0 {
      match piece {
        Piece::Text(text) => result.push_str(text),
        Piece::FragmentCount(item_id) => {
          if let Some(count) = counts.get(item_id).filter(|count| **count > 0) {
            result.push_str(&format!(", {}", count_label(*count, "fragment")));
          }
        }
      }
    }
    result
  }
}

/// Renders a container under the database lock, then reads stored fragment counts without it.
pub(super) async fn container_fragments(
  db: &Arc<tokio::sync::Mutex<Db>>,
  access: &Access<'_>,
  container_id: &Uid,
) -> InfuResult<ContainerFragments> {
  let (outline, data_dir) = {
    let db = db.lock().await;
    (container_outline(&db, access, container_id)?, db.item.data_dir().to_owned())
  };
  let counts = data_fragment_counts(&data_dir, access.user_id, &outline.data_item_ids).await;
  Ok(outline.fragments(&counts))
}

/// A group's members as fragments, laid out as its page lays them out.
pub(super) async fn group_fragments(
  db: &Arc<tokio::sync::Mutex<Db>>,
  access: &Access<'_>,
  group_id: &Uid,
) -> InfuResult<ContainerFragments> {
  let (outline, data_dir) = {
    let db = db.lock().await;
    (group_outline(&db, access, group_id)?, db.item.data_dir().to_owned())
  };
  let counts = data_fragment_counts(&data_dir, access.user_id, &outline.data_item_ids).await;
  Ok(outline.fragments(&counts))
}

/// Stored fragment counts. Items without fragments, or whose manifest cannot be read, are left out.
async fn data_fragment_counts(data_dir: &str, user_id: &str, item_ids: &HashSet<Uid>) -> HashMap<Uid, usize> {
  let counts = stream::iter(item_ids.iter().cloned().map(|item_id| async move {
    let metadata = read_item_fragment_metadata(data_dir, user_id, &item_id).await.ok().flatten();
    metadata.map(|metadata| (item_id, metadata.fragment_count))
  }))
  .buffer_unordered(8)
  .collect::<Vec<_>>()
  .await;
  counts.into_iter().flatten().collect()
}

pub(super) fn container_outline(db: &Db, access: &Access, container_id: &Uid) -> InfuResult<ContainerOutline> {
  let container = db.item.get(container_id).map_err(|_| "Container was not found.")?;
  if !access.can_read(db, container) {
    return Err("Container was not found.".into());
  }
  if !is_container_item_type(container.item_type) {
    return Err("Item is not a page, table, or composite.".into());
  }
  let ancestors = ancestors(db, container, access.user_id)?;
  let mut renderer = Renderer::new(db, access);
  renderer.active.insert(container.id.clone());
  let entries = entries(renderer.children(container)?);
  let units = renderer.layout_units(Layout::of(container), entries)?;
  Ok(renderer.outline(heading(db, access, container, &ancestors), container, units))
}

/// The group's page, if the chat can read it, and the members it can read, if they are still a group.
pub(super) fn group_members<'a>(db: &'a Db, access: &Access, group_id: &Uid) -> Option<(&'a Item, Vec<&'a Item>)> {
  let page = db.item.get(&db.item.group_container_id(group_id)?).ok().filter(|page| access.can_read(db, page))?;
  let mut members = db.item.get_children(&page.id).ok()?;
  members.retain(|member| member.group_id.as_ref() == Some(group_id) && access.can_read(db, member));
  (members.len() >= 2).then_some((page, members))
}

/// A group read on its own: its members as units, in the order and layout of its page.
fn group_outline(db: &Db, access: &Access, group_id: &Uid) -> InfuResult<ContainerOutline> {
  let (page, _) = group_members(db, access, group_id).ok_or("Item was not found.")?;
  let mut path = ancestors(db, page, access.user_id)?;
  path.push(page);
  let mut renderer = Renderer::new(db, access);
  renderer.active.insert(page.id.clone());
  let mut members = renderer.children(page)?;
  members.retain(|member| member.group_id.as_ref() == Some(group_id));
  let heading = format!(
    "{} (group, {}) in {}",
    group_link(group_id),
    count_label(members.len(), "item"),
    breadcrumb(db, access, &path)
  );
  let units = renderer.layout_units(Layout::of(page), members.into_iter().map(Entry::Item).collect())?;
  Ok(renderer.outline(heading, page, units))
}

fn group_link(group_id: &Uid) -> String {
  format!("[group](infumap://{group_id})")
}

fn count_label(count: usize, noun: &str) -> String {
  format!("{count} {noun}{}", if count == 1 { "" } else { "s" })
}

impl ContainerOutline {
  pub fn fragments(&self, counts: &HashMap<Uid, usize>) -> ContainerFragments {
    struct Chunk {
      body: String,
      chars: usize,
      units: Vec<FragmentUnit>,
      rows: Option<(usize, usize)>,
    }
    let separator_chars = self.separator.chars().count();
    let mut chunks: Vec<Chunk> = Vec::new();
    for unit in &self.units {
      let text = unit.pieces.render(counts);
      for piece in split_text(&text, FRAGMENT_MAX_CHARS) {
        let piece_chars = piece.chars().count();
        let fits = chunks.last().is_some_and(|chunk| chunk.chars + separator_chars + piece_chars <= FRAGMENT_MAX_CHARS);
        if !fits {
          chunks.push(Chunk { body: String::new(), chars: 0, units: Vec::new(), rows: None });
        }
        let chunk = chunks.last_mut().expect("a chunk was just pushed");
        if !chunk.body.is_empty() {
          chunk.body.push_str(self.separator);
          chunk.chars += separator_chars;
        }
        chunk.body.push_str(&piece);
        chunk.chars += piece_chars;
        chunk.units.push(FragmentUnit { item_ids: unit.item_ids.clone() });
        if let Some((first_row, last_row)) = unit.rows {
          chunk.rows = Some(chunk.rows.map_or((first_row, last_row), |(first, _)| (first, last_row)));
        }
      }
    }
    if chunks.is_empty() {
      chunks.push(Chunk { body: "(empty)".to_owned(), chars: 0, units: Vec::new(), rows: None });
    }

    let last = chunks.len() - 1;
    let fragments: Vec<ContainerFragment> = chunks
      .into_iter()
      .enumerate()
      .map(|(ordinal, chunk)| {
        let mut text = format!("{} · fragment {ordinal} of 0–{last}", self.heading);
        if let (Some((first, end)), Some(row_count)) = (chunk.rows, self.row_count) {
          text.push_str(&format!(" · rows {}–{} of {row_count}", first + 1, end + 1));
        }
        if let Some(preamble) = &self.preamble {
          text.push('\n');
          text.push_str(preamble);
          if let Some(note) = self.multi_fragment_note.filter(|_| last > 0) {
            text.push(' ');
            text.push_str(note);
          }
        }
        text.push('\n');
        text.push_str(&chunk.body);
        ContainerFragment { text, units: chunk.units }
      })
      .collect();
    // Hashing rendered text, not items, is far cheaper and ignores edits a reader cannot see.
    let version = fragments_version(fragments.iter().map(|fragment| &fragment.text));
    let rows =
      self.rows.iter().map(|(item_ids, pieces)| Row { item_ids: item_ids.clone(), text: pieces.render(counts) });
    ContainerFragments { version, fragments, rows: rows.collect() }
  }
}

/// Changes when the fragment texts change.
pub(super) fn fragments_version<'a>(texts: impl IntoIterator<Item = &'a String>) -> String {
  let mut hasher = Sha256::new();
  for text in texts {
    hasher.update(text);
    hasher.update([0]);
  }
  format!("{:x}", hasher.finalize())[..VERSION_CHARS].to_owned()
}

/// A note's text, with its URLs as Markdown links, split into fragments. An empty note has none.
pub(super) fn note_fragments(note: &Item) -> Vec<String> {
  let text = note_markdown(note.title.as_deref().unwrap_or(""), note_urls(note));
  let text = text.trim();
  if text.is_empty() { Vec::new() } else { split_text(text, FRAGMENT_MAX_CHARS) }
}

/// The start of `text` where split_text would first cut it, and whether anything was left out. Only that cut is
/// worked out, from the text up to the first line break past the budget: links never span lines, so nothing after
/// it can move the cut.
fn excerpt(text: &str, max_chars: usize) -> (String, bool) {
  let head_end = text.char_indices().skip(max_chars).find(|(_, ch)| *ch == '\n').map_or(text.len(), |(index, _)| index);
  let chars = text[..head_end].chars().collect::<Vec<_>>();
  if head_end == text.len() && chars.len() <= max_chars {
    return (text.to_owned(), false);
  }
  let cut = cut_point(&chars, &markdown_link_ranges(&chars), 0, max_chars);
  (chars[..cut].iter().collect::<String>().trim_end().to_owned(), true)
}

/// Splits text into pieces of at most `max_chars`, cutting where cut_point says.
fn split_text(text: &str, max_chars: usize) -> Vec<String> {
  let chars = text.chars().collect::<Vec<_>>();
  let links = markdown_link_ranges(&chars);
  let mut pieces = Vec::new();
  let mut start = 0;
  while chars.len() - start > max_chars {
    let cut = cut_point(&chars, &links, start, max_chars);
    pieces.push(chars[start..cut].iter().collect::<String>().trim_end().to_owned());
    start = cut;
    while start < chars.len() && chars[start].is_whitespace() {
      start += 1;
    }
  }
  pieces.push(chars[start..].iter().collect());
  pieces
}

/// Where the piece of at most `max_chars` starting at `start` ends: the last cut in the second half of the budget
/// after a blank line, else a line break, else a sentence, else a word, and never inside a Markdown link. With none
/// of those, it cuts where a link spanning the budget starts, or failing that, at the budget mid-word. `links` are
/// the ranges markdown_link_ranges finds in `chars`, which hold at least the budget.
fn cut_point(chars: &[char], links: &[(usize, usize)], start: usize, max_chars: usize) -> usize {
  // A cut at `index` ends a piece just before chars[index]. Links are sorted and never overlap.
  let link_around = |index: usize| {
    let before = links.partition_point(|(start, _)| *start < index);
    links[..before].last().filter(|(_, end)| index < *end)
  };
  let in_link = |index: usize| link_around(index).is_some();
  let after_blank_line = |index: usize| index >= 2 && chars[index - 1] == '\n' && chars[index - 2] == '\n';
  let after_line = |index: usize| chars[index - 1] == '\n';
  let after_sentence = |index: usize| {
    (chars[index - 1].is_whitespace() && index >= 2 && matches!(chars[index - 2], '.' | '!' | '?'))
      || matches!(chars[index - 1], '。' | '！' | '？')
  };
  let after_word = |index: usize| chars[index - 1].is_whitespace();
  let boundaries: [&dyn Fn(usize) -> bool; 4] = [&after_blank_line, &after_line, &after_sentence, &after_word];
  let end = start + max_chars;
  let earliest = start + max_chars / 2 + 1;
  boundaries
    .iter()
    .find_map(|boundary| (earliest..=end).rev().find(|index| boundary(*index) && !in_link(*index)))
    .unwrap_or_else(|| {
      link_around(end).map(|(link_start, _)| *link_start).filter(|link_start| *link_start > start).unwrap_or(end)
    })
}

/// Character ranges of `[label](target)` links and `<target>` autolinks, end exclusive.
fn markdown_link_ranges(chars: &[char]) -> Vec<(usize, usize)> {
  let find =
    |from: usize, close: char| (from..chars.len()).find(|index| chars[*index] == close || chars[*index] == '\n');
  let mut ranges = Vec::new();
  let mut index = 0;
  while index < chars.len() {
    match chars[index] {
      '\\' => index += 1,
      '[' => {
        let mut label_end = index + 1;
        while label_end < chars.len() && chars[label_end] != ']' && chars[label_end] != '\n' {
          label_end += if chars[label_end] == '\\' { 2 } else { 1 };
        }
        if chars.get(label_end) == Some(&']')
          && chars.get(label_end + 1) == Some(&'(')
          && let Some(target_end) = find(label_end + 2, ')').filter(|end| chars[*end] == ')')
        {
          ranges.push((index, target_end + 1));
          index = target_end;
        }
      }
      '<' => {
        let target_end = (index + 1..chars.len()).find(|end| chars[*end] == '>' || chars[*end].is_whitespace());
        if let Some(target_end) = target_end.filter(|end| chars[*end] == '>' && *end > index + 1) {
          ranges.push((index, target_end + 1));
          index = target_end;
        }
      }
      _ => {}
    }
    index += 1;
  }
  ranges
}

fn is_tabular(container: &Item) -> bool {
  container.item_type == ItemType::Table
    || (container.item_type == ItemType::Page && container.arrange_algorithm == Some(ArrangeAlgorithm::Table))
}

fn column_names(container: &Item) -> Vec<String> {
  container.table_columns.iter().flatten().map(|column| single_line(&column.name)).collect()
}

fn layout_name(arrange_algorithm: Option<ArrangeAlgorithm>) -> &'static str {
  match arrange_algorithm {
    Some(ArrangeAlgorithm::SpatialStretch) => "spatial",
    Some(ArrangeAlgorithm::SingleCell) => "single cell",
    Some(arrange_algorithm) => arrange_algorithm.as_str(),
    None => "unknown",
  }
}

fn heading(db: &Db, access: &Access, container: &Item, ancestors: &[&Item]) -> String {
  let kind = match container.item_type {
    ItemType::Page => format!("page, {} layout", layout_name(container.arrange_algorithm)),
    item_type => item_type.as_str().to_owned(),
  };
  let mut heading = format!("{} ({kind})", item_link(container));
  if !ancestors.is_empty() {
    heading.push_str(" in ");
    heading.push_str(&breadcrumb(db, access, ancestors));
  }
  heading
}

/// Titles of `path`, outermost first. Only the last is linked, so the model can go up a level without a uid for
/// every ancestor.
fn breadcrumb(db: &Db, access: &Access, path: &[&Item]) -> String {
  let Some((parent, above)) = path.split_last() else {
    return String::new();
  };
  let mut crumbs = above
    .iter()
    .map(|item| clamp_label(item.title.as_deref().unwrap_or(""), BREADCRUMB_TITLE_MAX_CHARS))
    .collect::<Vec<_>>();
  crumbs.push(if access.can_read(db, parent) {
    item_link(parent)
  } else {
    clamp_label(parent.title.as_deref().unwrap_or(""), BREADCRUMB_TITLE_MAX_CHARS)
  });
  crumbs.join(" › ")
}

fn link_url(item: &Item) -> String {
  format!("infumap://{}", item.id)
}

/// An item's title on one line, cut to label length, or what it is when untitled. Composites have no titles.
pub(super) fn item_label(item: &Item) -> String {
  let title = single_line(item.title.as_deref().unwrap_or(""));
  match item.item_type {
    ItemType::Composite => "composite".to_owned(),
    _ if title.is_empty() => format!("untitled {}", item.item_type.as_str()),
    _ => clamp_label(&title, LABEL_MAX_CHARS),
  }
}

fn item_link(item: &Item) -> String {
  format!("[{}]({})", escape_label(&item_label(item)), link_url(item))
}

fn single_line(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One line of at most `max_chars`, ending in "…" when cut.
fn clamp_label(text: &str, max_chars: usize) -> String {
  let (clamped, truncated) = clamp_text_chars(&single_line(text), max_chars);
  if truncated { format!("{}…", clamped.trim_end()) } else { clamped }
}

fn escape_label(text: &str) -> String {
  text.replace('[', "\\[").replace(']', "\\]")
}

fn escape_cell(text: &str) -> String {
  text.replace('|', "\\|")
}

/// Note text with its URL annotations as Markdown links. Annotation offsets are JavaScript UTF-16 indices.
fn note_markdown(text: &str, urls: &[NoteUrl]) -> String {
  let mut spans = urls.iter().filter(|url| url.end > url.start && !url.url.trim().is_empty()).collect::<Vec<_>>();
  spans.sort_by_key(|url| (url.start, url.end));
  let mut result = String::with_capacity(text.len());
  let mut position = 0i64;
  let mut next = 0;
  let mut open: Option<&NoteUrl> = None;
  let close = |result: &mut String, url: &NoteUrl| result.push_str(&format!("]({})", url.url.trim()));
  for ch in text.chars() {
    if let Some(url) = open.filter(|url| position >= url.end) {
      close(&mut result, url);
      open = None;
    }
    if open.is_none() {
      // Spans overlapping one already written are dropped.
      while next < spans.len() && spans[next].end <= position {
        next += 1;
      }
      if next < spans.len() && spans[next].start <= position {
        open = Some(spans[next]);
        next += 1;
        result.push('[');
      }
    }
    result.push(ch);
    position += ch.len_utf16() as i64;
  }
  if let Some(url) = open {
    close(&mut result, url);
  }
  result
}

fn note_urls(note: &Item) -> &[NoteUrl] {
  note.urls.as_deref().unwrap_or(&[])
}

/// How a spatial page's geometry is given, and the size of its visible area.
fn spatial_legend(page: &Item) -> String {
  let width = page.inner_spatial_width_gr.unwrap_or(0) as f64 / GRID_SIZE as f64;
  let height = page.natural_aspect.filter(|aspect| *aspect > 0.0).map_or(0.0, |aspect| (width / aspect).floor());
  format!(
    "Page area {}×{} blocks. Items start with @x,y w×h in blocks from the top left; h is ? where text sets it.",
    number(width),
    number(height)
  )
}

/// "@x,y w×h " for a child of a spatial page, in blocks. Heights the server can work out are given as the UI
/// computes them; a height set by text wrapping, as for notes, files and composites, is "?".
fn spatial_prefix(placement: &Item, content: Option<&Item>) -> String {
  let blocks = |gr: i64| gr as f64 / GRID_SIZE as f64;
  // The UI rounds derived heights to half blocks, with half a block the least.
  let half_blocks = |bl: f64| ((bl * 2.0).round() / 2.0).max(0.5);
  let position = placement.spatial_position_gr.as_ref().map_or((0, 0), |position| (position.x, position.y));
  let mut width = blocks(placement.spatial_width_gr.unwrap_or(0));
  let height = match content {
    None => Some(1.0),
    Some(content) => match content.item_type {
      ItemType::Page => content.natural_aspect.filter(|aspect| *aspect > 0.0).map(|aspect| half_blocks(width / aspect)),
      ItemType::Image => content
        .image_size_px
        .as_ref()
        .filter(|size| size.w > 0)
        .map(|size| half_blocks(width * size.h as f64 / size.w as f64)),
      ItemType::Table => placement.spatial_height_gr.map(blocks),
      // A link to such a note has a height of its own, as the link's size stands in for the note's.
      ItemType::Note
        if NoteFlags::from_bits_truncate(content.flags.unwrap_or(0)).contains(NoteFlags::ExplicitHeight) =>
      {
        placement.spatial_height_gr.filter(|height| *height > 0).map(blocks)
      }
      ItemType::Rating => {
        width = 1.0;
        Some(1.0)
      }
      ItemType::Password | ItemType::Search => Some(1.0),
      _ => None,
    },
  };
  let height = height.map_or("?".to_owned(), number);
  format!("@{},{} {}×{height} ", number(blocks(position.0)), number(blocks(position.1)), number(width))
}

/// A number of blocks to one decimal place, without a trailing ".0".
fn number(value: f64) -> String {
  let text = format!("{:.1}", value);
  text.strip_suffix(".0").map(str::to_owned).unwrap_or(text)
}

/// "2026-01-03 Sat: " for an item on a calendar page, or its first and last days. The calendar places items by day,
/// so the time of day is left out: it is whatever the item was created with. Dates are taken as stored, without
/// converting between time zones.
fn calendar_prefix(item: &Item) -> String {
  let format = |seconds: i64| {
    time::OffsetDateTime::from_unix_timestamp(seconds).ok().map(|date| {
      let weekday = date.weekday().to_string();
      format!("{:04}-{:02}-{:02} {}", date.year(), u8::from(date.month()), date.day(), &weekday[..3])
    })
  };
  match (format(item.datetime), item.end_datetime.and_then(format)) {
    (Some(start), Some(end)) => format!("{start} – {end}: "),
    (Some(start), None) => format!("{start}: "),
    (None, _) => String::new(),
  }
}

/// How a container lays out its children.
#[derive(Clone, Copy, PartialEq)]
enum Layout {
  /// One row per line with its cells.
  Table,
  /// Notes as Markdown.
  Document,
  /// Bullet lines with a date prefix.
  Calendar,
  /// Bullet lines with a position and size prefix.
  Spatial,
  /// Bullet lines.
  Lines,
}

impl Layout {
  fn of(container: &Item) -> Layout {
    if is_tabular(container) {
      return Layout::Table;
    }
    match container.arrange_algorithm.filter(|_| container.item_type == ItemType::Page) {
      Some(ArrangeAlgorithm::Document) => Layout::Document,
      Some(ArrangeAlgorithm::Calendar) => Layout::Calendar,
      Some(ArrangeAlgorithm::SpatialStretch) => Layout::Spatial,
      _ => Layout::Lines,
    }
  }
}

/// A child of a container, or a group of its children.
enum Entry<'a> {
  Item(&'a Item),
  Group(Uid, Vec<&'a Item>),
}

/// Children in display order, with each group in place of its first member. A group id held by only one child is
/// not a group: the other members were moved or deleted.
fn entries<'a>(children: Vec<&'a Item>) -> Vec<Entry<'a>> {
  let mut group_sizes = HashMap::<&Uid, usize>::new();
  for group_id in children.iter().filter_map(|child| child.group_id.as_ref()) {
    *group_sizes.entry(group_id).or_default() += 1;
  }
  let mut written_groups = HashSet::new();
  let mut entries = Vec::new();
  for child in &children {
    match child.group_id.as_ref().filter(|group_id| group_sizes[group_id] >= 2) {
      Some(group_id) => {
        if written_groups.insert(group_id) {
          let members = children.iter().filter(|item| item.group_id.as_ref() == Some(group_id)).copied().collect();
          entries.push(Entry::Group(group_id.clone(), members));
        }
      }
      None => entries.push(Entry::Item(child)),
    }
  }
  entries
}

struct Renderer<'a, 'b> {
  db: &'a Db,
  access: &'b Access<'b>,
  /// Containers being expanded, so a link cannot expand a composite inside itself.
  active: HashSet<Uid>,
  data_item_ids: HashSet<Uid>,
  placements: usize,
  unit_item_ids: Vec<Uid>,
  rows: Vec<(Vec<Uid>, Pieces)>,
}

impl<'a, 'b> Renderer<'a, 'b> {
  fn new(db: &'a Db, access: &'b Access<'b>) -> Self {
    Renderer {
      db,
      access,
      active: HashSet::new(),
      data_item_ids: HashSet::new(),
      placements: 0,
      unit_item_ids: Vec::new(),
      rows: Vec::new(),
    }
  }

  fn visit(&mut self, placement: &Item) -> InfuResult<()> {
    self.placements += 1;
    if self.placements > MAX_PLACEMENTS {
      return Err(format!("Container has more than {MAX_PLACEMENTS} placements; read a smaller container.").into());
    }
    self.unit_item_ids.push(placement.id.clone());
    Ok(())
  }

  /// Readable children in the order the container displays them.
  fn children(&self, container: &Item) -> InfuResult<Vec<&'a Item>> {
    let mut items = self.db.item.get_children(&container.id)?;
    items.retain(|item| self.access.can_read(self.db, item));
    let by_ordering = |a: &&Item, b: &&Item| a.ordering.cmp(&b.ordering).then_with(|| a.id.cmp(&b.id));
    match container.arrange_algorithm.filter(|_| container.item_type == ItemType::Page) {
      Some(ArrangeAlgorithm::Document) => items.sort_by(by_ordering),
      Some(ArrangeAlgorithm::SpatialStretch) => items.sort_by_key(|item| {
        let position = item.spatial_position_gr.as_ref().map_or((0, 0), |position| (position.y, position.x));
        (position, item.id.clone())
      }),
      Some(ArrangeAlgorithm::Calendar) => {
        items.sort_by(|a, b| a.datetime.cmp(&b.datetime).then_with(|| by_ordering(a, b)))
      }
      _ => match container.order_children_by.as_deref() {
        Some(order @ ("title[ASC]" | "title[DESC]")) => {
          let descending = order == "title[DESC]";
          items.sort_by_cached_key(|item| {
            let content = self.access.content(self.db, item);
            let title = content.and_then(|content| content.title.as_deref()).unwrap_or("").to_lowercase();
            (content.is_none(), title, item.id.clone())
          });
          if descending {
            // Unresolved links stay last, as they do on screen.
            let resolved = items.iter().take_while(|item| self.access.content(self.db, item).is_some()).count();
            items[..resolved].reverse();
          }
        }
        _ => items.sort_by(by_ordering),
      },
    }
    Ok(items)
  }

  /// Attachments in slot order. Unreadable ones are kept so table cells stay under their columns.
  fn attachments(&self, item: &Item) -> InfuResult<Vec<&'a Item>> {
    let mut items = self.db.item.get_attachments(&item.id)?;
    items.sort_by(|a, b| a.ordering.cmp(&b.ordering).then_with(|| a.id.cmp(&b.id)));
    Ok(items)
  }

  fn readable_child_count(&self, container: &Item) -> InfuResult<usize> {
    Ok(self.db.item.get_children(&container.id)?.into_iter().filter(|item| self.access.can_read(self.db, item)).count())
  }

  /// The outline of `container`'s units, with its columns when it is tabular, or its size when it is spatial.
  fn outline(self, heading: String, container: &Item, units: Vec<Unit>) -> ContainerOutline {
    let tabular = is_tabular(container);
    let preamble = match Layout::of(container) {
      Layout::Table => Some(column_names(container))
        .filter(|names| !names.is_empty())
        .map(|names| format!("Columns: {}", names.join(" | "))),
      Layout::Spatial => Some(spatial_legend(container)),
      _ => None,
    };
    ContainerOutline {
      heading,
      preamble,
      // A neighbour above or below an item can be listed far from it, past a fragment boundary.
      multi_fragment_note: (Layout::of(container) == Layout::Spatial)
        .then_some("Listed top to bottom, then left to right; nearby items may be in different fragments."),
      row_count: tabular.then_some(self.rows.len()),
      separator: if Layout::of(container) == Layout::Document { "\n\n" } else { "\n" },
      units,
      rows: self.rows,
      data_item_ids: self.data_item_ids,
    }
  }

  /// One unit per entry. A group is a line linking it, then its members beneath it.
  fn layout_units(&mut self, layout: Layout, entries: Vec<Entry<'a>>) -> InfuResult<Vec<Unit>> {
    let mut units = Vec::new();
    for entry in entries {
      let mut pieces = Pieces::default();
      let first_row = self.rows.len();
      match entry {
        Entry::Item(child) => self.entry_item(layout, child, 0, &mut pieces)?,
        Entry::Group(group_id, members) => {
          let bullet = if matches!(layout, Layout::Lines | Layout::Calendar | Layout::Spatial) { "- " } else { "" };
          pieces.text(&format!("{bullet}{} (group, {})", group_link(&group_id), count_label(members.len(), "item")));
          for member in members {
            pieces.text(if layout == Layout::Document { "\n\n" } else { "\n" });
            self.entry_item(layout, member, 1, &mut pieces)?;
          }
        }
      }
      let rows = (self.rows.len() > first_row).then(|| (first_row, self.rows.len() - 1));
      units.push(Unit { pieces, item_ids: std::mem::take(&mut self.unit_item_ids), rows });
    }
    Ok(units)
  }

  fn entry_item(&mut self, layout: Layout, child: &'a Item, depth: usize, pieces: &mut Pieces) -> InfuResult<()> {
    match layout {
      Layout::Table => {
        pieces.text(&"  ".repeat(depth));
        self.table_row(child, pieces)
      }
      // Document pages have no indentation to show grouping with; members follow the group line.
      Layout::Document => self.document_block(child, 0, pieces),
      Layout::Calendar => self.item_lines(child, depth, &calendar_prefix(child), pieces),
      Layout::Spatial => {
        let prefix = spatial_prefix(child, self.access.content(self.db, child));
        self.item_lines(child, depth, &prefix, pieces)
      }
      Layout::Lines => self.item_lines(child, depth, "", pieces),
    }
  }

  /// A row and its cells on one line, also kept whole for search results.
  fn table_row(&mut self, row: &'a Item, pieces: &mut Pieces) -> InfuResult<()> {
    let first_item = self.unit_item_ids.len();
    let mut row_pieces = Pieces::default();
    let content = self.access.content(self.db, row);
    self.visit(row)?;
    match content {
      None => row_pieces.text("(unavailable link)"),
      Some(content) => {
        if content.item_type == ItemType::Note {
          let text = clamp_label(content.title.as_deref().unwrap_or(""), CELL_MAX_CHARS);
          row_pieces.text(&format!("[{}]({})", escape_cell(&escape_label(&text)), link_url(content)));
          for url in note_urls(content).iter().filter(|url| !url.url.trim().is_empty()) {
            row_pieces.text(&format!(" <{}>", url.url.trim()));
          }
        } else {
          self.label(content, &mut row_pieces)?;
        }
        let mut cells = Vec::new();
        for attachment in self.attachments(content)? {
          cells.push(self.cell(attachment)?);
        }
        while cells.last().is_some_and(Pieces::is_empty) {
          cells.pop();
        }
        for cell in cells {
          row_pieces.text(" | ");
          row_pieces.append(cell);
        }
      }
    }
    self.rows.push((self.unit_item_ids[first_item..].to_vec(), row_pieces.clone()));
    pieces.append(row_pieces);
    Ok(())
  }

  /// A table cell or attachment on one line. Empty for placeholders and attachments the chat cannot read.
  fn cell(&mut self, attachment: &'a Item) -> InfuResult<Pieces> {
    let mut pieces = Pieces::default();
    if !self.access.can_read(self.db, attachment) || attachment.item_type == ItemType::Placeholder {
      return Ok(pieces);
    }
    let content = self.access.content(self.db, attachment);
    self.visit(attachment)?;
    match content {
      None => pieces.text("(unavailable link)"),
      Some(content) if content.item_type == ItemType::Note => {
        let text = note_markdown(content.title.as_deref().unwrap_or(""), note_urls(content));
        let (text, truncated) = excerpt(&single_line(&text), CELL_MAX_CHARS);
        pieces.text(&escape_cell(&text));
        if truncated {
          pieces.text(&format!("… [more]({})", link_url(content)));
        }
      }
      Some(content) => self.label(content, &mut pieces)?,
    }
    Ok(pieces)
  }

  /// A bullet line for an item, followed by its attachments and, for a composite, its members.
  fn item_lines(&mut self, placement: &'a Item, depth: usize, prefix: &str, pieces: &mut Pieces) -> InfuResult<()> {
    if depth > MAX_DEPTH {
      return Err("Container is too deeply nested.".into());
    }
    let indent = "  ".repeat(depth);
    let content = self.access.content(self.db, placement);
    self.visit(placement)?;
    pieces.text(&format!("{indent}- {prefix}"));
    let Some(content) = content else {
      pieces.text("(unavailable link)");
      return Ok(());
    };
    match content.item_type {
      ItemType::Note => {
        let text = content.title.as_deref().unwrap_or("");
        let urls = note_urls(content);
        let line = single_line(text);
        if line.is_empty() {
          pieces.text(&item_link(content));
        } else if line.chars().count() <= LABEL_MAX_CHARS {
          pieces.text(&format!("[{}]({})", escape_label(&line), link_url(content)));
          for url in urls.iter().filter(|url| !url.url.trim().is_empty()) {
            pieces.text(&format!(" <{}>", url.url.trim()));
          }
        } else {
          let (body, truncated) = excerpt(&note_markdown(text, urls), NOTE_INLINE_MAX_CHARS);
          let label = escape_label(&clamp_label(text, NOTE_LABEL_MAX_CHARS));
          pieces.text(&format!("[{label}]({}): {body}", link_url(content)));
          if truncated {
            let count = note_fragments(content).len();
            pieces.text(&format!("… (truncated; full text in {count} fragment{})", if count == 1 { "" } else { "s" }));
          }
        }
      }
      _ => self.label(content, pieces)?,
    }
    let mut attached = Vec::new();
    for attachment in self.attachments(content)? {
      let cell = self.cell(attachment)?;
      if !cell.is_empty() {
        attached.push(cell);
      }
    }
    if !attached.is_empty() {
      pieces.text(&format!("\n{indent}  attached: "));
      for (index, cell) in attached.into_iter().enumerate() {
        if index > 0 {
          pieces.text("; ");
        }
        pieces.append(cell);
      }
    }
    if content.item_type == ItemType::Composite && self.active.insert(content.id.clone()) {
      for member in self.children(content)? {
        pieces.text("\n");
        self.item_lines(member, depth + 1, "", pieces)?;
      }
      self.active.remove(&content.id);
    }
    Ok(())
  }

  /// A note in a document page as Markdown, or any other item as a linked line.
  fn document_block(&mut self, placement: &'a Item, depth: usize, pieces: &mut Pieces) -> InfuResult<()> {
    if depth > MAX_DEPTH {
      return Err("Container is too deeply nested.".into());
    }
    let content = self.access.content(self.db, placement);
    self.visit(placement)?;
    let Some(content) = content else {
      pieces.text("(unavailable link)");
      return Ok(());
    };
    match content.item_type {
      ItemType::Note => {
        let text = content.title.as_deref().unwrap_or("");
        let flags = NoteFlags::from_bits_truncate(content.flags.unwrap_or(0));
        if flags.contains(NoteFlags::Code) {
          pieces.text(&format!("```\n{text}\n```"));
        } else {
          let indent = if flags.contains(NoteFlags::Indent2) {
            "    "
          } else if flags.contains(NoteFlags::Indent1) {
            "  "
          } else {
            ""
          };
          let marker = if flags.contains(NoteFlags::Heading1) {
            "# "
          } else if flags.contains(NoteFlags::Heading2) {
            "## "
          } else if flags.contains(NoteFlags::Heading3) {
            "### "
          } else if flags.contains(NoteFlags::Heading4) {
            "#### "
          } else if flags.contains(NoteFlags::Bullet1) {
            "- "
          } else if flags.contains(NoteFlags::Numbered) {
            "1. "
          } else {
            ""
          };
          let indent = if marker.starts_with('#') { "" } else { indent };
          pieces.text(&format!("{indent}{marker}{}", note_markdown(text, note_urls(content))));
        }
      }
      ItemType::Divider => pieces.text("---"),
      ItemType::Composite if self.active.insert(content.id.clone()) => {
        for (index, member) in self.children(content)?.into_iter().enumerate() {
          if index > 0 {
            pieces.text("\n\n");
          }
          self.document_block(member, depth + 1, pieces)?;
        }
        self.active.remove(&content.id);
      }
      _ => self.label(content, pieces)?,
    }
    Ok(())
  }

  /// A search hit's linked label, then links to its attachments: at most a few, each with a short label.
  fn record_label(&mut self, content: &'a Item) -> InfuResult<Pieces> {
    let mut pieces = self.hit_label(content, HIT_NOTE_MAX_CHARS)?;
    let mut attachments = self.attachments(content)?;
    attachments.retain(|item| item.item_type != ItemType::Placeholder && self.access.can_read(self.db, item));
    for (index, attachment) in attachments.iter().take(HIT_ATTACHMENTS_MAX).enumerate() {
      pieces.text(if index == 0 { " · attached: " } else { "; " });
      match self.access.content(self.db, attachment) {
        None => pieces.text("(unavailable link)"),
        Some(content) => pieces.append(self.hit_label(content, NOTE_LABEL_MAX_CHARS)?),
      }
    }
    if attachments.len() > HIT_ATTACHMENTS_MAX {
      pieces.text(&format!("; +{} more", attachments.len() - HIT_ATTACHMENTS_MAX));
    }
    Ok(pieces)
  }

  /// A linked label. A note is its text, cut short with the number of fragments holding all of it.
  fn hit_label(&mut self, content: &'a Item, note_max_chars: usize) -> InfuResult<Pieces> {
    let mut pieces = Pieces::default();
    if content.item_type != ItemType::Note {
      self.label(content, &mut pieces)?;
      return Ok(pieces);
    }
    // Only the start of a long note is collapsed to one line: a label never needs more. Collapsing whitespace only
    // shortens text, so a label from the start can be shorter than the budget, but never wrongly uncut.
    let title = content.title.as_deref().unwrap_or("");
    let head_end = title.char_indices().nth(note_max_chars * 4).map_or(title.len(), |(index, _)| index);
    let line = single_line(&title[..head_end]);
    if line.is_empty() {
      pieces.text(&item_link(content));
    } else {
      let (label, cut) = excerpt(&line, note_max_chars);
      let truncated = cut || head_end < title.len();
      let label = if truncated { format!("{}…", label.trim_end()) } else { label };
      pieces.text(&format!("[{}]({})", escape_label(&label), link_url(content)));
      if truncated {
        let count = note_fragments(content).len();
        pieces.text(&format!(" (note, {})", count_label(count, "fragment")));
      }
    }
    Ok(pieces)
  }

  /// A linked title and what kind of item it is. Notes are rendered by their callers.
  fn label(&mut self, content: &'a Item, pieces: &mut Pieces) -> InfuResult<()> {
    match content.item_type {
      ItemType::Page => {
        let count = self.readable_child_count(content)?;
        pieces.text(&format!("{} (page, {count} item{})", item_link(content), if count == 1 { "" } else { "s" }));
      }
      ItemType::Table => {
        let count = self.readable_child_count(content)?;
        pieces.text(&format!("{} (table, {count} row{}", item_link(content), if count == 1 { "" } else { "s" }));
        let columns = column_names(content);
        if !columns.is_empty() {
          pieces.text(&format!("; columns: {}", columns.join(" | ")));
        }
        pieces.text(")");
      }
      ItemType::Composite => {
        let repeated = if self.active.contains(&content.id) { ", shown above" } else { "" };
        pieces.text(&format!("[composite]({}) (composite{repeated})", link_url(content)));
      }
      ItemType::File | ItemType::Text | ItemType::Image => {
        self.data_item_ids.insert(content.id.clone());
        pieces.text(&format!("{} ({}", item_link(content), content.item_type.as_str()));
        if content.item_type == ItemType::File
          && let Some(mime_type) = content.mime_type.as_deref().filter(|mime_type| !mime_type.is_empty())
        {
          pieces.text(&format!(", {mime_type}"));
        }
        pieces.fragment_count(&content.id);
        pieces.text(")");
      }
      ItemType::Rating => pieces.text(&format!("rating {}", content.rating.unwrap_or(0))),
      ItemType::Divider => pieces.text("---"),
      ItemType::Placeholder => pieces.text("(empty)"),
      ItemType::Note => pieces.text(&item_link(content)),
      ItemType::Search | ItemType::Link | ItemType::Password => {
        pieces.text(&format!("{} ({})", item_link(content), content.item_type.as_str()))
      }
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::web::routes::command::scope::resolve_scope;
  use crate::web::routes::command::scope::test_db::TestDb;

  impl TestDb {
    async fn arranged_page(&mut self, parent_id: &Uid, title: &str, arrange: ArrangeAlgorithm, order: &str) -> Uid {
      let item = Item::new_page(
        Some(parent_id),
        vec![],
        Vector { x: 0, y: 0 },
        GRID_SIZE,
        RelationshipToParent::Child,
        title,
        order,
        0,
        0,
        0,
        2.0,
        60 * GRID_SIZE,
        arrange,
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

    async fn table(&mut self, parent_id: &Uid, title: &str, columns: &[&str]) -> Uid {
      let columns = columns
        .iter()
        .map(|name| TableColumn { width_gr: 4 * GRID_SIZE, name: (*name).to_owned() })
        .collect::<Vec<_>>();
      let count = columns.len() as i64;
      let item = Item::new_table(
        parent_id,
        vec![],
        Vector { x: 0, y: 0 },
        8 * GRID_SIZE,
        8 * GRID_SIZE,
        RelationshipToParent::Child,
        title,
        TableFlags::None,
        columns,
        count,
        "",
      );
      self.add(item).await
    }

    async fn composite(&mut self, parent_id: &Uid) -> Uid {
      self
        .non_note(parent_id, "", |item| {
          item.item_type = ItemType::Composite;
          item.title = None;
        })
        .await
    }

    async fn placeholder(&mut self, parent_id: &Uid) -> Uid {
      self.add(Item::new_placeholder(parent_id, vec![])).await
    }

    fn outline(&self, container_id: &Uid) -> ContainerOutline {
      container_outline(&self.db, &Access { user_id: &self.user_id, scope: None }, container_id).unwrap()
    }

    fn texts(&self, container_id: &Uid) -> Vec<String> {
      self
        .outline(container_id)
        .fragments(&HashMap::new())
        .fragments
        .into_iter()
        .map(|fragment| fragment.text)
        .collect()
    }
  }

  fn body(text: &str) -> &str {
    text.split_once('\n').map_or("", |(_, body)| body)
  }

  #[tokio::test]
  async fn table_rows_are_packed_with_the_header_in_every_fragment() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let table = t.table(&home, "Tasks", &["Name", "Status", "Notes", "Due"]).await;
    let mut rows = Vec::new();
    for index in 0..120 {
      let row =
        t.note(&table, &format!("Row {index:03} with a reasonably long name"), RelationshipToParent::Child).await;
      t.note(&row, "Active", RelationshipToParent::Attachment).await;
      t.placeholder(&row).await;
      t.note(&row, &format!("2026-01-{:02}", index % 28 + 1), RelationshipToParent::Attachment).await;
      t.placeholder(&row).await;
      rows.push(row);
    }

    let fragments = t.outline(&table).fragments(&HashMap::new()).fragments;
    assert!(fragments.len() > 2, "120 rows do not fit one fragment");
    let last = fragments.len() - 1;
    let mut seen_rows = Vec::new();
    for (ordinal, fragment) in fragments.iter().enumerate() {
      let mut lines = fragment.text.lines();
      let heading = lines.next().unwrap();
      assert!(heading.starts_with(&format!("[Tasks](infumap://{table}) (table) in [test](infumap://{home})")));
      assert!(heading.contains(&format!("fragment {ordinal} of 0–{last}")));
      assert!(heading.contains("of 120"));
      assert_eq!(lines.next(), Some("Columns: Name | Status | Notes | Due"));
      let body = lines.collect::<Vec<_>>();
      assert!(body.join("\n").chars().count() <= FRAGMENT_MAX_CHARS);
      for line in body {
        assert!(line.contains(" | Active |  | 2026-01-") && !line.ends_with(' '), "{line}");
        let row_id = line.split("(infumap://").nth(1).unwrap().split(')').next().unwrap();
        seen_rows.push(row_id.to_owned());
      }
    }
    assert_eq!(seen_rows, rows, "every row once, in order, with trailing empty cells dropped");
    assert!(fragments[0].text.lines().next().unwrap().contains("rows 1–"));
  }

  #[tokio::test]
  async fn composites_and_groups_are_never_split() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let list = t.arranged_page(&home, "List", ArrangeAlgorithm::List, "").await;
    let spatial = t.arranged_page(&home, "Spatial", ArrangeAlgorithm::SpatialStretch, "").await;
    let filler = "word ".repeat(30);
    let group_id = new_uid();
    for index in 0..60 {
      t.note(&list, &format!("{index} {filler}"), RelationshipToParent::Child).await;
      t.note_with(&spatial, &format!("{index} {filler}"), |item| {
        item.spatial_position_gr = Some(Vector { x: 0, y: index * 10 })
      })
      .await;
      if index == 30 {
        let composite = t.composite(&list).await;
        for member in ["first member", "second member", "third member"] {
          t.note(&composite, member, RelationshipToParent::Child).await;
        }
        for (member, y) in [("group a", 301), ("group b", 302), ("group c", 303)] {
          let group_id = group_id.clone();
          t.note_with(&spatial, member, |item| {
            item.spatial_position_gr = Some(Vector { x: 0, y });
            item.group_id = Some(group_id);
          })
          .await;
        }
      }
    }

    for (page, members) in
      [(&list, ["first member", "second member", "third member"]), (&spatial, ["group a", "group b", "group c"])]
    {
      let texts = t.texts(page);
      assert!(texts.len() > 1);
      let holding = texts.iter().filter(|text| members.iter().any(|member| text.contains(member))).collect::<Vec<_>>();
      assert_eq!(holding.len(), 1, "one fragment holds the whole unit");
      assert!(members.iter().all(|member| holding[0].contains(member)));
    }
    let note = "; nearby items may be in different fragments.";
    assert!(
      t.texts(&spatial).iter().all(|text| text.lines().nth(1).unwrap().ends_with(note)),
      "said in every fragment"
    );
    assert!(t.texts(&list).iter().all(|text| !text.contains(note)), "only on spatial pages");
    let group_text = t.texts(&spatial).into_iter().find(|text| text.contains("group a")).unwrap();
    assert!(group_text.contains(&format!("- [group](infumap://{group_id}) (group, 3 items)\n  - @0,5 1×? [group a]")));
    let composite_text = t.texts(&list).into_iter().find(|text| text.contains("first member")).unwrap();
    assert!(composite_text.contains("(composite)\n  - [first member]"));
  }

  #[tokio::test]
  async fn groups_are_shown_in_every_layout_and_read_on_their_own() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let mut pages = Vec::new();
    for (title, arrange) in [
      ("List", ArrangeAlgorithm::List),
      ("Grid", ArrangeAlgorithm::Grid),
      ("Doc", ArrangeAlgorithm::Document),
      ("Tabular", ArrangeAlgorithm::Table),
    ] {
      let page = t.arranged_page(&home, title, arrange, "").await;
      let group_id = new_uid();
      t.note(&page, "solo", RelationshipToParent::Child).await;
      let mut members = Vec::new();
      for member in ["g one", "g two"] {
        let group_id = group_id.clone();
        members.push(t.note_with(&page, member, |item| item.group_id = Some(group_id)).await);
      }
      let stale = new_uid();
      let lone = t.note_with(&page, "lone", |item| item.group_id = Some(stale.clone())).await;
      pages.push((page, group_id, members, stale, lone));
    }
    let texts = pages.iter().map(|(page, ..)| t.texts(page)[0].clone()).collect::<Vec<_>>();
    let group_line = |index: usize| format!("[group](infumap://{}) (group, 2 items)", pages[index].1);
    let member_link =
      |index: usize, member: usize, title: &str| format!("[{title}](infumap://{})", pages[index].2[member]);
    for index in [0, 1] {
      let expected = format!(
        "\n- {}\n  - {}\n  - {}\n",
        group_line(index),
        member_link(index, 0, "g one"),
        member_link(index, 1, "g two")
      );
      assert!(texts[index].contains(&expected), "{}", texts[index]);
    }
    assert!(texts[2].contains(&format!("\n\n{}\n\ng one\n\ng two\n\n", group_line(2))), "{}", texts[2]);
    assert!(texts[3].contains(&format!(
      "\n{}\n  {}\n  {}\n",
      group_line(3),
      member_link(3, 0, "g one"),
      member_link(3, 1, "g two")
    )));
    assert!(texts[3].contains("rows 1–4 of 4"), "group members are still counted as rows: {}", texts[3]);
    for ((_, _, _, stale, _), text) in pages.iter().zip(&texts) {
      assert!(!text.contains(stale.as_str()) && text.contains("lone"), "a lone member is no group: {text}");
    }

    let (list, group_id, members, stale, lone) = &pages[0];
    let user_id = t.user_id.clone();
    let db = Arc::new(tokio::sync::Mutex::new(t.db));
    let access = Access { user_id: &user_id, scope: None };
    let group = group_fragments(&db, &access, group_id).await.unwrap();
    let text = &group.fragments[0].text;
    assert!(text.starts_with(&format!("[group](infumap://{group_id}) (group, 2 items) in ")), "{text}");
    assert!(text.contains(&format!(" › [List](infumap://{list}) · fragment 0 of 0–0\n")), "{text}");
    assert!(
      text.ends_with(&format!("\n- [g one](infumap://{})\n- [g two](infumap://{})", members[0], members[1])),
      "{text}"
    );
    let tabular = group_fragments(&db, &access, &pages[3].1).await.unwrap();
    assert!(tabular.fragments[0].text.contains("· rows 1–2 of 2\nColumns: Title\n"), "{}", tabular.fragments[0].text);
    assert_eq!(
      group_fragments(&db, &access, stale).await.err().map(|e| e.to_string()),
      Some("Item was not found.".to_owned())
    );

    let listings = hit_listings(&db, &access, &[members[0].clone(), lone.clone()]).await;
    assert_eq!(listings[&members[0]].group_id.as_ref(), Some(group_id));
    assert_eq!(listings[lone].group_id, None);
  }

  #[tokio::test]
  async fn an_oversized_document_note_is_split_across_fragments() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let document = t.arranged_page(&home, "Doc", ArrangeAlgorithm::Document, "").await;
    let paragraph = (0..700).map(|index| format!("w{index}")).collect::<Vec<_>>().join(" ");
    t.note(&document, "Intro", RelationshipToParent::Child).await;
    t.note(&document, &paragraph, RelationshipToParent::Child).await;

    let texts = t.texts(&document);
    assert!(texts.len() >= 2);
    let rejoined = texts.iter().map(|text| body(text)).collect::<Vec<_>>().join(" ");
    assert_eq!(single_line(&rejoined), single_line(&format!("Intro {paragraph}")));
  }

  #[tokio::test]
  async fn document_notes_are_markdown_without_per_note_links() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let document = t.arranged_page(&home, "Doc", ArrangeAlgorithm::Document, "").await;
    t.note_with(&document, "Title", |item| item.flags = Some(NoteFlags::Heading1.bits())).await;
    t.note_with(&document, "see the docs here", |item| {
      item.urls = Some(vec![NoteUrl { start: 8, end: 12, url: "https://example.com".to_owned() }]);
    })
    .await;
    t.note_with(&document, "point", |item| item.flags = Some((NoteFlags::Bullet1 | NoteFlags::Indent1).bits())).await;
    t.note_with(&document, "let x = 1;", |item| item.flags = Some(NoteFlags::Code.bits())).await;

    let texts = t.texts(&document);
    assert_eq!(texts.len(), 1);
    assert_eq!(
      body(&texts[0]),
      "# Title\n\nsee the [docs](https://example.com) here\n\n  - point\n\n```\nlet x = 1;\n```"
    );
  }

  #[tokio::test]
  async fn spatial_children_start_with_their_position_and_size() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let spatial = t.arranged_page(&home, "Spatial", ArrangeAlgorithm::SpatialStretch, "").await;
    let at = |x: f64, y: f64| Some(Vector { x: (x * GRID_SIZE as f64) as i64, y: (y * GRID_SIZE as f64) as i64 });
    let page = t.page(&spatial, "Review").await;
    let mut item = t.db.item.get(&page).unwrap().clone();
    (item.spatial_position_gr, item.spatial_width_gr) = (at(2.0, 1.0), Some(10 * GRID_SIZE));
    t.db.item.update(&item).await.unwrap();
    t.non_note(&spatial, "photo.jpg", |item| {
      item.item_type = ItemType::Image;
      (item.spatial_position_gr, item.spatial_width_gr) = (at(14.0, 1.0), Some(6 * GRID_SIZE));
      item.image_size_px = Some(Dimensions { w: 400, h: 300 });
    })
    .await;
    t.note_with(&spatial, "plain", |item| item.spatial_position_gr = at(0.0, 8.5)).await;
    t.note_with(&spatial, "boxed", |item| {
      item.spatial_position_gr = at(4.0, 8.5);
      item.flags = Some(NoteFlags::ExplicitHeight.bits());
      item.spatial_height_gr = Some(3 * GRID_SIZE);
    })
    .await;
    let link = t.link(&spatial, &page).await;
    let mut item = t.db.item.get(&link).unwrap().clone();
    (item.spatial_position_gr, item.spatial_width_gr) = (at(21.0, 1.0), Some(4 * GRID_SIZE));
    t.db.item.update(&item).await.unwrap();

    let text = &t.texts(&spatial)[0];
    let mut lines = text.lines().skip(1);
    assert_eq!(
      lines.next().unwrap(),
      "Page area 60×30 blocks. Items start with @x,y w×h in blocks from the top left; h is ? where text sets it."
    );
    let prefixes = lines.map(|line| line.split(" [").next().unwrap()).collect::<Vec<_>>();
    assert_eq!(prefixes, ["- @2,1 10×5", "- @14,1 6×4.5", "- @21,1 4×2", "- @0,8.5 1×?", "- @4,8.5 1×3"], "{text}");
  }

  #[tokio::test]
  async fn hits_show_their_item_with_short_links_to_its_attachments() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let doc = t.arranged_page(&home, "Doc", ArrangeAlgorithm::Document, "").await;
    let mut ids = Vec::new();
    for page in [&home, &doc] {
      let item = t.note(page, "Vendor review", RelationshipToParent::Child).await;
      let tag = t.note(&item, "fat cat", RelationshipToParent::Attachment).await;
      let long_text = "Notes from the call with the vendor about pricing and the renewal terms";
      let long = t.note(&item, long_text, RelationshipToParent::Attachment).await;
      let notes = t.page(&item, "Notes").await;
      let mut attached_page = t.db.item.get(&notes).unwrap().clone();
      attached_page.relationship_to_parent = RelationshipToParent::Attachment;
      attached_page.ordering = [t.db.item.get(&long).unwrap().ordering.clone(), vec![128]].concat();
      t.db.item.update(&attached_page).await.unwrap();
      let mut fourth = None;
      for extra in ["four", "five", "six"] {
        let id = t.note(&item, extra, RelationshipToParent::Attachment).await;
        fourth.get_or_insert(id);
      }
      ids.push((item, tag, long, notes, fourth.unwrap()));
    }
    let user_id = t.user_id.clone();
    let db = Arc::new(tokio::sync::Mutex::new(t.db));
    let access = Access { user_id: &user_id, scope: None };
    let hits = ids.iter().flat_map(|(item, tag, ..)| [item.clone(), tag.clone()]).collect::<Vec<_>>();
    let listings = hit_listings(&db, &access, &hits).await;

    for (page, (item, tag, long, notes, fourth)) in [&home, &doc].into_iter().zip(&ids) {
      let expected = format!(
        "[Vendor review](infumap://{item}) · attached: [fat cat](infumap://{tag}); [Notes from the call with the vendor…](\
         infumap://{long}) (note, 1 fragment); [Notes](infumap://{notes}) (page, 0 items); [four](infumap://{fourth}); \
         +2 more"
      );
      for hit in [item, tag] {
        let listing = &listings[hit];
        assert_eq!((&listing.subject_id, &listing.text), (item, &expected), "{hit}");
        assert_eq!(listing.container_id.as_ref(), Some(page), "a document page's attachment is located by its item");
      }
    }
  }

  #[tokio::test]
  async fn hits_on_table_pages_are_shown_as_rows() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let page = t.arranged_page(&home, "Contacts", ArrangeAlgorithm::Table, "").await;
    let row = t.note(&page, "Alice", RelationshipToParent::Child).await;
    let cell = t.note(&row, "alice@example.com", RelationshipToParent::Attachment).await;
    let user_id = t.user_id.clone();
    let db = Arc::new(tokio::sync::Mutex::new(t.db));
    let access = Access { user_id: &user_id, scope: None };

    let listings = hit_listings(&db, &access, &[row.clone(), cell.clone()]).await;
    let row_text = format!("[Alice](infumap://{row}) | alice@example.com");
    for hit in [&row, &cell] {
      assert_eq!((&listings[hit].subject_id, &listings[hit].text), (&row, &row_text));
    }
  }

  #[tokio::test]
  async fn hits_on_calendar_pages_carry_their_day() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let calendar = t.arranged_page(&home, "Calendar", ArrangeAlgorithm::Calendar, "").await;
    // 2026-01-01 at 23:30, a Thursday: the time is left out, and the day is taken as stored.
    let dentist = t.note_with(&calendar, "dentist", |item| item.datetime = 1_767_310_200).await;
    let trip = t
      .note_with(&calendar, "trip", |item| {
        item.datetime = 1_767_225_600;
        item.end_datetime = Some(1_767_398_400);
      })
      .await;
    let composite = t.composite(&calendar).await;
    let mut item = t.db.item.get(&composite).unwrap().clone();
    item.datetime = 1_767_398_400;
    t.db.item.update(&item).await.unwrap();
    let member = t.note(&composite, "packing", RelationshipToParent::Child).await;
    let elsewhere = t.note_with(&home, "not on a calendar", |item| item.datetime = 1_767_225_600).await;
    let user_id = t.user_id.clone();
    let db = Arc::new(tokio::sync::Mutex::new(t.db));
    let access = Access { user_id: &user_id, scope: None };

    let listings =
      hit_listings(&db, &access, &[dentist.clone(), trip.clone(), member.clone(), elsewhere.clone()]).await;
    assert_eq!(listings[&dentist].text, format!("2026-01-01 Thu: [dentist](infumap://{dentist})"));
    assert_eq!(listings[&trip].text, format!("2026-01-01 Thu – 2026-01-03 Sat: [trip](infumap://{trip})"));
    assert_eq!(listings[&member].text, format!("2026-01-03 Sat: [packing](infumap://{member})"), "the composite's day");
    assert_eq!(listings[&elsewhere].text, format!("[not on a calendar](infumap://{elsewhere})"));
  }

  #[tokio::test]
  async fn children_follow_spatial_title_and_calendar_order() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let spatial = t.arranged_page(&home, "Spatial", ArrangeAlgorithm::SpatialStretch, "").await;
    for (title, x, y) in [("third", 0, 20), ("second", 50, 0), ("first", 10, 0)] {
      t.note_with(&spatial, title, |item| item.spatial_position_gr = Some(Vector { x, y })).await;
    }
    let sorted = t.arranged_page(&home, "Sorted", ArrangeAlgorithm::List, "title[DESC]").await;
    t.link(&sorted, &new_uid()).await;
    for title in ["b", "c", "a"] {
      t.note(&sorted, title, RelationshipToParent::Child).await;
    }
    let calendar = t.arranged_page(&home, "Calendar", ArrangeAlgorithm::Calendar, "").await;
    for (title, datetime) in [("later", 1_767_398_400), ("earlier", 1_767_225_600)] {
      t.note_with(&calendar, title, |item| item.datetime = datetime).await;
    }

    let titles = |text: &str| {
      body(text)
        .lines()
        .map(|line| line.split('[').nth(1).map_or(line, |rest| rest.split(']').next().unwrap()).to_owned())
        .collect::<Vec<_>>()
    };
    let spatial_text = &t.texts(&spatial)[0];
    assert_eq!(titles(spatial_text)[1..], ["first", "second", "third"], "after the geometry legend");
    assert_eq!(titles(&t.texts(&sorted)[0]), ["c", "b", "a", "- (unavailable link)"]);
    let calendar_text = &t.texts(&calendar)[0];
    assert!(calendar_text.lines().next().unwrap().contains("(page, calendar layout) in "));
    assert!(!calendar_text.contains("UTC"), "{calendar_text}");
    assert_eq!(body(calendar_text).lines().next().unwrap().split(": ").next().unwrap(), "- 2026-01-01 Thu");
    assert_eq!(titles(calendar_text), ["earlier", "later"]);
  }

  #[tokio::test]
  async fn nested_pages_and_tables_are_references_and_long_notes_are_cut() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let page = t.page(&home, "Project").await;
    let child = t.page(&page, "Archive").await;
    t.note(&child, "old", RelationshipToParent::Child).await;
    t.note(&child, "older", RelationshipToParent::Child).await;
    let table = t.table(&page, "Tasks", &["Name", "Status"]).await;
    for index in 0..3 {
      t.note(&table, &format!("hidden row {index}"), RelationshipToParent::Child).await;
    }
    let long = "x".repeat(2_000);
    let note = t.note(&page, &long, RelationshipToParent::Child).await;
    let tagged = t.note(&page, "tagged", RelationshipToParent::Child).await;
    t.note(&tagged, "urgent", RelationshipToParent::Attachment).await;
    let long_cell = t.note(&tagged, &"word ".repeat(60), RelationshipToParent::Attachment).await;

    let text = t.texts(&page).join("\n");
    assert!(text.contains(&format!("- [Archive](infumap://{child}) (page, 2 items)")));
    assert!(text.contains(&format!("- [Tasks](infumap://{table}) (table, 3 rows; columns: Name | Status)")));
    assert!(!text.contains("hidden row"));
    assert!(text.contains(&format!(
      "](infumap://{note}): {}… (truncated; full text in 1 fragment)",
      "x".repeat(NOTE_INLINE_MAX_CHARS)
    )));
    assert!(text.contains(&format!("- [tagged](infumap://{tagged})\n  attached: urgent; word word")));
    assert!(text.contains(&format!("word… [more](infumap://{long_cell})")));
  }

  #[tokio::test]
  async fn scope_hides_excluded_children_and_link_targets() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let work = t.page(&home, "Work").await;
    let visible = t.note(&work, "visible", RelationshipToParent::Child).await;
    let secret = t.page(&work, "Secret").await;
    let elsewhere = t.page(&home, "Elsewhere").await;
    t.link(&work, &elsewhere).await;
    let scope_id = t.page(&t.scopes_id(), "Work only").await;
    t.link(&scope_id, &work).await;
    let exclude = t.page(&scope_id, "Exclude").await;
    t.link(&exclude, &secret).await;
    let scope = resolve_scope(&t.db, &t.user_id, &scope_id).unwrap();
    let access = Access { user_id: &t.user_id, scope: Some(&scope) };

    let outline = container_outline(&t.db, &access, &work).unwrap();
    let text = outline.fragments(&HashMap::new()).fragments.remove(0).text;
    assert!(text.contains(&format!("[visible](infumap://{visible})")));
    assert!(!text.contains("Secret"));
    assert!(!text.contains("Elsewhere"));
    assert!(text.contains("- (unavailable link)"));
    assert!(
      text.lines().next().unwrap().contains(" in test · fragment"),
      "the out-of-scope parent is not linked: {text}"
    );
    assert!(container_outline(&t.db, &access, &secret).is_err());
    assert!(container_outline(&t.db, &access, &home).is_err());
  }

  #[tokio::test]
  async fn a_composite_linked_inside_itself_is_not_expanded_again() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let page = t.page(&home, "Page").await;
    let composite = t.composite(&page).await;
    t.note(&composite, "member", RelationshipToParent::Child).await;
    t.link(&composite, &composite).await;

    let text = t.texts(&page).join("\n");
    assert_eq!(text.matches("member").count(), 1);
    assert!(text.contains(&format!("\n  - [composite](infumap://{composite}) (composite, shown above)")), "{text}");
  }

  #[tokio::test]
  async fn data_items_show_stored_fragment_counts_and_version_tracks_changes() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let page = t.page(&home, "Files").await;
    let file = t
      .non_note(&page, "report.pdf", |item| {
        item.item_type = ItemType::File;
        item.mime_type = Some("application/pdf".to_owned());
        item.file_size_bytes = Some(1);
        item.original_creation_date = Some(0);
      })
      .await;

    let outline = t.outline(&page);
    assert!(outline.data_item_ids.contains(&file));
    let without = outline.fragments(&HashMap::new());
    let with = outline.fragments(&HashMap::from([(file.clone(), 12)]));
    assert!(without.fragments[0].text.contains(&format!("[report.pdf](infumap://{file}) (file, application/pdf)")));
    assert!(with.fragments[0].text.contains("(file, application/pdf, 12 fragments)"));
    assert_ne!(without.version, with.version, "a document finishing processing changes the text");
    assert_eq!(without.version.len(), VERSION_CHARS);
    assert_eq!(without.version, t.outline(&page).fragments(&HashMap::new()).version);
    t.note(&page, "new", RelationshipToParent::Child).await;
    assert_ne!(without.version, t.outline(&page).fragments(&HashMap::new()).version);
    assert_eq!(without.fragments[0].units.iter().map(|unit| unit.item_ids.clone()).collect::<Vec<_>>(), [[file]]);
  }

  #[tokio::test]
  async fn hit_listings_point_at_the_fragment_listing_each_hit() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let page = t.page(&home, "Project").await;
    let table = t.table(&page, "Tasks", &["Name", "Status"]).await;
    let (mut rows, mut cells) = (Vec::new(), Vec::new());
    for index in 0..120 {
      let row =
        t.note(&table, &format!("Row {index:03} with a reasonably long name"), RelationshipToParent::Child).await;
      cells.push(t.note(&row, &format!("status {index}"), RelationshipToParent::Attachment).await);
      rows.push(row);
    }
    let composite = t.composite(&page).await;
    let member = t.note(&composite, "member one", RelationshipToParent::Child).await;
    t.note(&composite, "member two", RelationshipToParent::Child).await;
    let long_text = "Words in a sentence. ".repeat(140).trim_end().to_owned();
    let long = t.note(&page, &long_text, RelationshipToParent::Child).await;
    let child = t.page(&page, "Child").await;
    let attached = t.note(&child, "attached to child page", RelationshipToParent::Attachment).await;
    let user_id = t.user_id.clone();
    let db = Arc::new(tokio::sync::Mutex::new(t.db));
    let access = Access { user_id: &user_id, scope: None };

    let hits = [&cells[100], &rows[100], &table, &member, &long, &attached, &child, &composite, &new_uid()];
    let listings = hit_listings(&db, &access, &hits.map(Uid::clone)).await;
    assert_eq!(listings.len(), 8, "a missing item has no listing");

    let table_fragments = container_fragments(&db, &access, &table).await.unwrap();
    let cell = &listings[&cells[100]];
    assert_eq!(cell.container_id.as_ref(), Some(&table));
    assert!(cell.container_fragment > 0);
    assert!(table_fragments.fragments[cell.container_fragment].text.contains(&rows[100]));
    let row_text = format!("[Row 100 with a reasonably long name](infumap://{}) | status 100", rows[100]);
    assert_eq!((&cell.subject_id, cell.text.as_str()), (&rows[100], row_text.as_str()), "a cell hit is its row");
    let row = &listings[&rows[100]];
    assert_eq!((row.container_fragment, &row.subject_id, &row.text), (cell.container_fragment, &rows[100], &cell.text));

    let in_page = |item_id: &Uid| {
      let listing = &listings[item_id];
      assert_eq!((listing.container_id.as_ref(), listing.subject_id == *item_id), (Some(&page), true));
      listing.text.as_str()
    };
    assert_eq!(in_page(&table), format!("[Tasks](infumap://{table}) (table, 120 rows; columns: Name | Status)"));
    let child_text =
      format!("[Child](infumap://{child}) (page, 0 items) · attached: [attached to child page](infumap://{attached})");
    assert_eq!(in_page(&child), child_text, "a page is listed by its parent");
    assert_eq!(in_page(&member), format!("[member one](infumap://{member})"), "a member is only itself");
    assert_eq!(in_page(&composite), format!("[composite](infumap://{composite}) (composite)"));
    let long_listing = in_page(&long);
    assert!(long_listing.starts_with("[Words in a sentence."), "{long_listing}");
    assert!(long_listing.ends_with(&format!(" sentence.…](infumap://{long}) (note, 2 fragments)")), "{long_listing}");
    assert!(long_listing.chars().count() < HIT_NOTE_MAX_CHARS + 80, "{long_listing}");
    let attachment = &listings[&attached];
    assert_eq!(
      (&attachment.subject_id, &attachment.text),
      (&child, &child_text),
      "an attachment is shown with its item"
    );
  }

  #[tokio::test]
  async fn hit_listings_skip_containers_outside_the_scope() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let page = t.page(&home, "Page").await;
    let note = t.note(&page, "included on its own", RelationshipToParent::Child).await;
    let scope_id = t.page(&t.scopes_id(), "Just the note").await;
    t.link(&scope_id, &note).await;
    let scope = resolve_scope(&t.db, &t.user_id, &scope_id).unwrap();
    let user_id = t.user_id.clone();
    let db = Arc::new(tokio::sync::Mutex::new(t.db));

    let scoped =
      hit_listings(&db, &Access { user_id: &user_id, scope: Some(&scope) }, std::slice::from_ref(&note)).await;
    assert_eq!(scoped[&note].container_id, None);
    assert_eq!(scoped[&note].text, format!("[included on its own](infumap://{note})"));
    let unscoped = hit_listings(&db, &Access { user_id: &user_id, scope: None }, std::slice::from_ref(&note)).await;
    assert_eq!(unscoped[&note].container_id.as_ref(), Some(&page));
  }

  #[test]
  fn split_text_prefers_paragraphs_then_lines_sentences_and_words() {
    let text = format!("{}\n{}", "a".repeat(8), "b".repeat(8));
    assert_eq!(split_text(&text, 12), ["aaaaaaaa", "bbbbbbbb"]);
    assert_eq!(split_text("aaaaaa\n\nbbb\ncccccc", 14), ["aaaaaa", "bbb\ncccccc"]);
    assert_eq!(split_text("One two. Three four five", 16), ["One two.", "Three four five"]);
    assert_eq!(split_text("aaaa bbbb cccc", 10), ["aaaa bbbb", "cccc"]);
    assert_eq!(split_text(&"z".repeat(25), 10), ["z".repeat(10), "z".repeat(10), "z".repeat(5)]);
    assert_eq!(split_text("short", 10), ["short"]);
  }

  #[test]
  fn excerpt_is_the_first_piece_split_text_cuts() {
    let long_link = format!("see [docs](https://example.com/{}) now", "a".repeat(60));
    let texts = [
      "short".to_owned(),
      "One two. Three four five".to_owned(),
      format!("{}\n{}", "a".repeat(8), "b".repeat(8)),
      format!("{}\n\nnext paragraph\nmore", "word ".repeat(9)),
      long_link.clone(),
      format!("{long_link}\n{}", "tail ".repeat(50)),
      "z".repeat(25),
      format!("{}\n", "x".repeat(10)),
    ];
    for text in &texts {
      for max_chars in [5, 10, 12, 16, 30, 40] {
        let pieces = split_text(text, max_chars);
        let expected = (pieces[0].clone(), pieces.len() > 1);
        assert_eq!(excerpt(text, max_chars), expected, "{text:?} at {max_chars}");
      }
    }
  }

  #[test]
  fn split_text_never_cuts_inside_a_link() {
    // A word break inside the link text is skipped for an earlier one.
    assert_eq!(
      split_text("see more of the [docs here](https://e.com) now", 30),
      ["see more of the", "[docs here](https://e.com) now"]
    );
    // With no usable break, the cut moves back to where the link starts.
    assert_eq!(
      split_text("see more of [the docs](https://e.com) now", 30),
      ["see more of", "[the docs](https://e.com) now"]
    );
    assert_eq!(split_text("abcdefgh<https://example.com/a/b> x", 30), ["abcdefgh", "<https://example.com/a/b> x"]);
    // A link longer than the budget has to be cut.
    assert_eq!(split_text("[docs](https://example.com/a)", 20), ["[docs](https://examp", "le.com/a)"]);
    assert_eq!(
      markdown_link_ranges(&r"a \[b] [c\]d](u) <e> [f] (g) <h i>".chars().collect::<Vec<_>>()),
      [(7, 16), (17, 20)]
    );
  }

  #[tokio::test]
  async fn notes_split_into_fragments_on_demand() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let paragraph = "A sentence. ".repeat(75).trim_end().to_owned();
    let long = [paragraph.as_str(); 5].join("\n\n");
    let note = t.note(&home, &long, RelationshipToParent::Child).await;
    let fragments = note_fragments(t.db.item.get(&note).unwrap());
    assert_eq!(fragments.len(), 3, "two 900-char paragraphs fit each fragment");
    assert!(fragments.iter().all(|fragment| fragment.chars().count() <= FRAGMENT_MAX_CHARS));
    assert_eq!(fragments.join("\n\n"), long);

    let linked = format!("{} link here", "word ".repeat(497));
    let start = linked.encode_utf16().count() as i64 - 9;
    let url = NoteUrl { start, end: start + 4, url: "https://example.com".to_owned() };
    let linked_note = t.note_with(&home, &linked, |item| item.urls = Some(vec![url])).await;
    let fragments = note_fragments(t.db.item.get(&linked_note).unwrap());
    assert_eq!(fragments.len(), 2);
    assert!(fragments[1].ends_with("[link](https://example.com) here"));

    let empty = t.note(&home, "  ", RelationshipToParent::Child).await;
    assert!(note_fragments(t.db.item.get(&empty).unwrap()).is_empty());
  }
}
