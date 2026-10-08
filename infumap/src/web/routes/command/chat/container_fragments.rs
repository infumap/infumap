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

//! Pages, tables, composites and notes as bounded text fragments for the chat tools.
//!
//! Containers and notes change whenever the user edits them, so their fragments are built on demand from the
//! live database and never stored. A note's fragments are its text split at paragraph, line, sentence or word
//! boundaries. A container is first rendered under the database lock into units: blocks that are never split
//! across fragments unless one alone exceeds the budget, such as a table row, a composite, an explicit group or
//! a top-level item. Stored fragment counts for files and images are read outside the lock, then the units are
//! packed into fragments in order. Child pages and nested tables are one-line references, so rendering never
//! descends into them.

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
/// A note too long to be its own link label is linked by its start, which the body then repeats.
const NOTE_LABEL_MAX_CHARS: usize = 40;
const BREADCRUMB_TITLE_MAX_CHARS: usize = 60;
const MAX_DEPTH: usize = 64;
const MAX_PLACEMENTS: usize = 50_000;
const VERSION_CHARS: usize = 8;

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
pub(super) fn ancestors<'a>(db: &'a Db, item: &'a Item, user_id: &str) -> InfuResult<Vec<&'a Item>> {
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
  /// Placements rendered in this fragment: children, attachments and composite members. A unit split across
  /// fragments lists its placements in each.
  pub item_ids: Vec<Uid>,
}

pub(super) struct ContainerFragments {
  /// Changes when anything rendered changes, so a reader can tell that ordinals may have moved.
  pub version: String,
  pub fragments: Vec<ContainerFragment>,
}

/// A container rendered under the database lock, waiting for the stored fragment counts of its data items.
pub(super) struct ContainerOutline {
  heading: String,
  columns: Option<String>,
  row_count: Option<usize>,
  separator: &'static str,
  units: Vec<Unit>,
  data_item_ids: HashSet<Uid>,
  snapshot: Vec<u8>,
}

struct Unit {
  pieces: Pieces,
  item_ids: Vec<Uid>,
  row: Option<usize>,
}

enum Piece {
  Text(String),
  /// ", N fragments" when the data item has stored fragments, otherwise nothing.
  FragmentCount(Uid),
}

#[derive(Default)]
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
            result.push_str(&format!(", {count} fragment{}", if *count == 1 { "" } else { "s" }));
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

/// Stored fragment counts. Items without fragments, or whose manifest cannot be read, are left out.
async fn data_fragment_counts(data_dir: &str, user_id: &str, item_ids: &HashSet<Uid>) -> HashMap<Uid, usize> {
  stream::iter(item_ids.iter().map(|item_id| async move {
    let count = read_item_fragment_metadata(data_dir, user_id, item_id).await.ok().flatten()?.fragment_count;
    Some((item_id.clone(), count))
  }))
  .buffer_unordered(8)
  .filter_map(|entry| async move { entry })
  .collect()
  .await
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
  for item in ancestors.iter().copied().chain(std::iter::once(container)) {
    renderer.hasher.update(item.hash());
  }
  let tabular = is_tabular(container);
  let units = renderer.container_units(container)?;
  Ok(ContainerOutline {
    heading: heading(db, access, container, &ancestors),
    columns: tabular
      .then(|| column_names(container))
      .filter(|names| !names.is_empty())
      .map(|names| format!("Columns: {}", names.join(" | "))),
    row_count: tabular.then_some(units.len()),
    separator: if container.arrange_algorithm == Some(ArrangeAlgorithm::Document) { "\n\n" } else { "\n" },
    units,
    data_item_ids: renderer.data_item_ids,
    snapshot: renderer.hasher.finalize().to_vec(),
  })
}

impl ContainerOutline {
  pub fn fragments(&self, counts: &HashMap<Uid, usize>) -> ContainerFragments {
    struct Chunk {
      body: String,
      chars: usize,
      item_ids: Vec<Uid>,
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
          chunks.push(Chunk { body: String::new(), chars: 0, item_ids: Vec::new(), rows: None });
        }
        let chunk = chunks.last_mut().expect("a chunk was just pushed");
        if !chunk.body.is_empty() {
          chunk.body.push_str(self.separator);
          chunk.chars += separator_chars;
        }
        chunk.body.push_str(&piece);
        chunk.chars += piece_chars;
        chunk.item_ids.extend(unit.item_ids.iter().cloned());
        if let Some(row) = unit.row {
          chunk.rows = Some(chunk.rows.map_or((row, row), |(first, _)| (first, row)));
        }
      }
    }
    if chunks.is_empty() {
      chunks.push(Chunk { body: "(empty)".to_owned(), chars: 0, item_ids: Vec::new(), rows: None });
    }

    let mut hasher = Sha256::new();
    hasher.update(&self.snapshot);
    let mut sorted_counts =
      counts.iter().filter(|(item_id, _)| self.data_item_ids.contains(*item_id)).collect::<Vec<_>>();
    sorted_counts.sort();
    for (item_id, count) in sorted_counts {
      hasher.update(item_id);
      hasher.update(count.to_le_bytes());
    }
    let version = format!("{:x}", hasher.finalize())[..VERSION_CHARS].to_owned();

    let last = chunks.len() - 1;
    let fragments = chunks
      .into_iter()
      .enumerate()
      .map(|(ordinal, chunk)| {
        let mut text = format!("{} · fragment {ordinal} of 0–{last}", self.heading);
        if let (Some((first, end)), Some(row_count)) = (chunk.rows, self.row_count) {
          text.push_str(&format!(" · rows {}–{} of {row_count}", first + 1, end + 1));
        }
        if let Some(columns) = &self.columns {
          text.push('\n');
          text.push_str(columns);
        }
        text.push('\n');
        text.push_str(&chunk.body);
        ContainerFragment { text, item_ids: chunk.item_ids }
      })
      .collect();
    ContainerFragments { version, fragments }
  }
}

/// A note's text, with its URLs as Markdown links, split into fragments. An empty note has none.
pub(super) fn note_fragments(note: &Item) -> Vec<String> {
  let text = note_markdown(note.title.as_deref().unwrap_or(""), note_urls(note));
  let text = text.trim();
  if text.is_empty() { Vec::new() } else { split_text(text, FRAGMENT_MAX_CHARS) }
}

/// The start of `text` where split_text would first cut it, and whether anything was left out.
fn excerpt(text: &str, max_chars: usize) -> (String, bool) {
  let mut pieces = split_text(text, max_chars).into_iter();
  (pieces.next().unwrap_or_default(), pieces.next().is_some())
}

/// Splits text into pieces of at most `max_chars`. Each cut is the last one in the second half of the budget
/// after a blank line, else a line break, else a sentence, else a word, and never inside a Markdown link. With
/// none of those, it cuts where a link spanning the budget starts, or failing that, at the budget mid-word.
fn split_text(text: &str, max_chars: usize) -> Vec<String> {
  let chars = text.chars().collect::<Vec<_>>();
  let links = markdown_link_ranges(&chars);
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

  let mut pieces = Vec::new();
  let mut start = 0;
  while chars.len() - start > max_chars {
    let end = start + max_chars;
    let earliest = start + max_chars / 2 + 1;
    let cut = boundaries
      .iter()
      .find_map(|boundary| (earliest..=end).rev().find(|index| boundary(*index) && !in_link(*index)))
      .unwrap_or_else(|| {
        link_around(end).map(|(link_start, _)| *link_start).filter(|link_start| *link_start > start).unwrap_or(end)
      });
    pieces.push(chars[start..cut].iter().collect::<String>().trim_end().to_owned());
    start = cut;
    while start < chars.len() && chars[start].is_whitespace() {
      start += 1;
    }
  }
  pieces.push(chars[start..].iter().collect());
  pieces
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
  if let Some((parent, above)) = ancestors.split_last() {
    let mut crumbs = above
      .iter()
      .map(|item| clamp_label(item.title.as_deref().unwrap_or(""), BREADCRUMB_TITLE_MAX_CHARS))
      .collect::<Vec<_>>();
    // Only the parent is linked, so the model can go up a level without a uid for every ancestor.
    crumbs.push(if access.can_read(db, parent) {
      item_link(parent)
    } else {
      clamp_label(parent.title.as_deref().unwrap_or(""), BREADCRUMB_TITLE_MAX_CHARS)
    });
    heading.push_str(" in ");
    heading.push_str(&crumbs.join(" › "));
  }
  if container.arrange_algorithm == Some(ArrangeAlgorithm::Calendar) {
    heading.push_str(" · times in UTC");
  }
  heading
}

fn link_url(item: &Item) -> String {
  format!("infumap://{}", item.id)
}

fn item_link(item: &Item) -> String {
  let title = item.title.as_deref().unwrap_or("");
  let label =
    if single_line(title).is_empty() { format!("untitled {}", item.item_type.as_str()) } else { title.to_owned() };
  format!("[{}]({})", escape_label(&clamp_label(&label, LABEL_MAX_CHARS)), link_url(item))
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

fn calendar_prefix(item: &Item) -> String {
  let format = |seconds: i64| {
    time::OffsetDateTime::from_unix_timestamp(seconds).ok().map(|date| {
      format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        date.year(),
        u8::from(date.month()),
        date.day(),
        date.hour(),
        date.minute()
      )
    })
  };
  match (format(item.datetime), item.end_datetime.and_then(format)) {
    (Some(start), Some(end)) => format!("{start} – {end}: "),
    (Some(start), None) => format!("{start}: "),
    (None, _) => String::new(),
  }
}

struct Renderer<'a, 'b> {
  db: &'a Db,
  access: &'b Access<'b>,
  /// Containers being expanded, so a link cannot expand a composite inside itself.
  active: HashSet<Uid>,
  data_item_ids: HashSet<Uid>,
  hasher: Sha256,
  placements: usize,
  unit_item_ids: Vec<Uid>,
}

impl<'a, 'b> Renderer<'a, 'b> {
  fn new(db: &'a Db, access: &'b Access<'b>) -> Self {
    Renderer {
      db,
      access,
      active: HashSet::new(),
      data_item_ids: HashSet::new(),
      hasher: Sha256::new(),
      placements: 0,
      unit_item_ids: Vec::new(),
    }
  }

  fn visit(&mut self, placement: &Item, content: Option<&Item>) -> InfuResult<()> {
    self.placements += 1;
    if self.placements > MAX_PLACEMENTS {
      return Err(format!("Container has more than {MAX_PLACEMENTS} placements; read a smaller container.").into());
    }
    self.hasher.update(placement.hash());
    if let Some(content) = content.filter(|content| content.id != placement.id) {
      self.hasher.update(content.hash());
    }
    self.unit_item_ids.push(placement.id.clone());
    Ok(())
  }

  fn finish_unit(&mut self, pieces: Pieces, row: Option<usize>) -> Unit {
    Unit { pieces, item_ids: std::mem::take(&mut self.unit_item_ids), row }
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

  fn container_units(&mut self, container: &'a Item) -> InfuResult<Vec<Unit>> {
    self.active.insert(container.id.clone());
    if is_tabular(container) {
      return self.table_units(container);
    }
    let children = self.children(container)?;
    let mut units = Vec::new();
    match container.arrange_algorithm.filter(|_| container.item_type == ItemType::Page) {
      Some(ArrangeAlgorithm::Document) => {
        for child in children {
          let mut pieces = Pieces::default();
          self.document_block(child, 0, &mut pieces)?;
          units.push(self.finish_unit(pieces, None));
        }
      }
      Some(ArrangeAlgorithm::SpatialStretch) => {
        let mut group_sizes = HashMap::<&str, usize>::new();
        for child in &children {
          if let Some(group_id) = child.group_id.as_deref() {
            *group_sizes.entry(group_id).or_default() += 1;
          }
        }
        // A groupId held by only one child is not a group (the other members were moved or deleted).
        let group_of = |item: &Item| item.group_id.clone().filter(|group_id| group_sizes[group_id.as_str()] >= 2);
        let mut written_groups = HashSet::new();
        for child in &children {
          let mut pieces = Pieces::default();
          match group_of(child) {
            Some(group_id) => {
              if !written_groups.insert(group_id.clone()) {
                continue;
              }
              pieces.text("- Group:");
              for member in children.iter().filter(|item| item.group_id.as_ref() == Some(&group_id)) {
                pieces.text("\n");
                self.item_lines(member, 1, "", &mut pieces)?;
              }
            }
            None => self.item_lines(child, 0, "", &mut pieces)?,
          }
          units.push(self.finish_unit(pieces, None));
        }
      }
      Some(ArrangeAlgorithm::Calendar) => {
        for child in children {
          let mut pieces = Pieces::default();
          self.item_lines(child, 0, &calendar_prefix(child), &mut pieces)?;
          units.push(self.finish_unit(pieces, None));
        }
      }
      _ => {
        for child in children {
          let mut pieces = Pieces::default();
          self.item_lines(child, 0, "", &mut pieces)?;
          units.push(self.finish_unit(pieces, None));
        }
      }
    }
    Ok(units)
  }

  fn table_units(&mut self, table: &'a Item) -> InfuResult<Vec<Unit>> {
    let mut units = Vec::new();
    for (index, row) in self.children(table)?.into_iter().enumerate() {
      let mut pieces = Pieces::default();
      let content = self.access.content(self.db, row);
      self.visit(row, content)?;
      match content {
        None => pieces.text("(unavailable link)"),
        Some(content) => {
          if content.item_type == ItemType::Note {
            let text = clamp_label(content.title.as_deref().unwrap_or(""), CELL_MAX_CHARS);
            pieces.text(&format!("[{}]({})", escape_cell(&escape_label(&text)), link_url(content)));
            for url in note_urls(content).iter().filter(|url| !url.url.trim().is_empty()) {
              pieces.text(&format!(" <{}>", url.url.trim()));
            }
          } else {
            self.label(content, &mut pieces)?;
          }
          let mut cells = Vec::new();
          for attachment in self.attachments(content)? {
            cells.push(self.cell(attachment)?);
          }
          while cells.last().is_some_and(Pieces::is_empty) {
            cells.pop();
          }
          for cell in cells {
            pieces.text(" | ");
            pieces.append(cell);
          }
        }
      }
      units.push(self.finish_unit(pieces, Some(index)));
    }
    Ok(units)
  }

  /// A table cell or attachment on one line. Empty for placeholders and attachments the chat cannot read.
  fn cell(&mut self, attachment: &'a Item) -> InfuResult<Pieces> {
    let mut pieces = Pieces::default();
    if !self.access.can_read(self.db, attachment) || attachment.item_type == ItemType::Placeholder {
      return Ok(pieces);
    }
    let content = self.access.content(self.db, attachment);
    self.visit(attachment, content)?;
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
    self.visit(placement, content)?;
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
    self.visit(placement, content)?;
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

    /// Composites and files have no constructor here, so they start as notes with the note-only fields cleared.
    async fn non_note(&mut self, parent_id: &Uid, title: &str, edit: impl FnOnce(&mut Item)) -> Uid {
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

    async fn note_with(&mut self, parent_id: &Uid, title: &str, edit: impl FnOnce(&mut Item)) -> Uid {
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
    let group_text = t.texts(&spatial).into_iter().find(|text| text.contains("group a")).unwrap();
    assert!(group_text.contains("- Group:\n  - [group a]"));
    let composite_text = t.texts(&list).into_iter().find(|text| text.contains("first member")).unwrap();
    assert!(composite_text.contains("(composite)\n  - [first member]"));
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
    assert_eq!(titles(&t.texts(&spatial)[0]), ["first", "second", "third"]);
    assert_eq!(titles(&t.texts(&sorted)[0]), ["c", "b", "a", "- (unavailable link)"]);
    let calendar_text = &t.texts(&calendar)[0];
    assert!(calendar_text.lines().next().unwrap().contains(" · times in UTC · fragment 0 of 0–0"));
    assert_eq!(body(calendar_text).lines().next().unwrap().split(": ").next().unwrap(), "- 2026-01-01 00:00");
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
    assert_eq!(without.fragments[0].item_ids, vec![file]);
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
