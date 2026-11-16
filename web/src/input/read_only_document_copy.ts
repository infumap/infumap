/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { noteIndentLevelFromFlags } from "../items/base/flags-item";
import { asNoteItem, isNote } from "../items/note-item";
import { asTableItem, isTable } from "../items/table-item";
import { noteHasBullet, noteHasNumbered } from "../layout/text";
import { VesCache } from "../layout/ves-cache";
import { VisualElementFlags } from "../layout/visual-element";


/**
 * Ends the text of each row of a read-only document. The rows are absolutely positioned, so to the browser their text
 * runs together: double-clicking "cell1" in a table selected "bcell1cell2cell3cell4Final". A zero-width space is a word
 * break that renders as nothing. Copied text leaves it out.
 */
export const READ_ONLY_DOCUMENT_ROW_END = "\u200B";

type CopyBlock =
  { kind: "paragraph", text: string, isListItem: boolean } |
  { kind: "row", tablePath: string, cells: Array<string | undefined> };

const TITLE_SUFFIX = ":title";

/**
 * Plain text for a copy of the selection in a read-only document page (e.g. a text file shown as a document), or null
 * if the selection isn't in one.
 *
 * The browser's own text runs table cells together and puts list markers inline with the text, because the rows are
 * absolutely positioned elements, not a table or a list. This writes paragraphs separated by a blank line, list items
 * on their own lines with markdown markers, and table rows on their own lines with tab separated cells (with the header
 * row when the selection starts before the table), which also pastes back into Infumap as the same structure.
 */
export function readOnlyDocumentCopyText(selection: Selection | null): string | null {
  if (selection == null || selection.rangeCount == 0 || selection.isCollapsed) { return null; }
  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const ancestorElement = ancestor instanceof Element ? ancestor : ancestor.parentElement;
  const container = ancestorElement?.closest("[data-infumap-read-only-document]");
  if (container == null) { return null; }

  const blocks: Array<CopyBlock> = [];
  const rowBlocks = new Map<string, CopyBlock & { kind: "row" }>();
  const titles = Array.from(container.querySelectorAll(`[id$="${TITLE_SUFFIX}"]`))
    .filter(title => range.intersectsNode(title));

  for (const title of titles) {
    const path = title.id.slice(0, -TITLE_SUFFIX.length);
    const ve = VesCache.current.readNode(path);
    if (ve == null || !isNote(ve.displayItem)) { continue; }
    const text = selectedTextWithin(range, title);

    if (ve.flags & VisualElementFlags.InsideTable) {
      const isCell = !!(ve.flags & VisualElementFlags.Attachment);
      const rowPath = isCell ? ve.parentPath : path;
      const rowVe = rowPath == null ? null : VesCache.current.readNode(rowPath);
      if (rowPath == null || rowVe == null || rowVe.parentPath == null) { continue; }
      const column = isCell
        ? (isAttachmentsItem(rowVe.displayItem)
          ? asAttachmentsItem(rowVe.displayItem).computed_attachments.indexOf(ve.displayItem.id) + 1
          : 0)
        : 0;
      if (column < 0) { continue; }
      let rowBlock = rowBlocks.get(rowPath);
      if (rowBlock == null) {
        const tablePath = rowVe.parentPath;
        const headerMaybe = headerRowIfSelectionStartsBeforeTable(range, title, tablePath, rowVe.displayItem.id);
        if (headerMaybe != null) { blocks.push(headerMaybe); }
        rowBlock = { kind: "row", tablePath, cells: [] };
        rowBlocks.set(rowPath, rowBlock);
        blocks.push(rowBlock);
      }
      rowBlock.cells[column] = text;
      continue;
    }

    const flags = asNoteItem(ve.displayItem).flags;
    const isListItem = noteHasBullet(flags) || noteHasNumbered(flags);
    const marker = !isListItem || !selectionIncludesStartOf(range, title)
      ? ""
      : "  ".repeat(noteIndentLevelFromFlags(flags)) + (noteHasBullet(flags) ? "- " : `${ve.listItemNumber ?? 1}. `);
    blocks.push({ kind: "paragraph", text: marker + text, isListItem });
  }

  // A selection that starts at the very end of a row, or ends at the very start of one, touches it without selecting
  // any of its text: leave it out rather than adding blank lines.
  while (blocks.length > 0 && blockText(blocks[0]) == "") { blocks.shift(); }
  while (blocks.length > 0 && blockText(blocks[blocks.length - 1]) == "") { blocks.pop(); }
  if (blocks.length == 0) { return null; }
  let result = "";
  for (let i = 0; i < blocks.length; ++i) {
    if (i > 0) { result += blockSeparator(blocks[i - 1], blocks[i]); }
    result += blockText(blocks[i]);
  }
  return result;
}

function blockSeparator(previous: CopyBlock, next: CopyBlock): string {
  if (previous.kind == "row" && next.kind == "row" && previous.tablePath == next.tablePath) { return "\n"; }
  if (previous.kind == "paragraph" && next.kind == "paragraph" && previous.isListItem && next.isListItem) { return "\n"; }
  return "\n\n";
}

function blockText(block: CopyBlock): string {
  if (block.kind == "paragraph") { return block.text; }
  // Only the columns the selection covers: a selection starting or ending inside a row has no leading or trailing tabs.
  const covered = block.cells.map((cell, i) => cell === undefined ? -1 : i).filter(i => i >= 0);
  if (covered.length == 0) { return ""; }
  const first = covered[0];
  const last = covered[covered.length - 1];
  const cells: Array<string> = [];
  for (let i = first; i <= last; ++i) { cells.push(block.cells[i] ?? ""); }
  return cells.join("\t");
}

function selectedTextWithin(range: Range, element: Element): string {
  const part = document.createRange();
  part.selectNodeContents(element);
  if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) { part.setStart(range.startContainer, range.startOffset); }
  if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) { part.setEnd(range.endContainer, range.endOffset); }
  return part.toString().replaceAll(READ_ONLY_DOCUMENT_ROW_END, "");
}

function selectionIncludesStartOf(range: Range, element: Element): boolean {
  const before = document.createRange();
  before.selectNodeContents(element);
  before.collapse(true);
  return range.compareBoundaryPoints(Range.START_TO_START, before) <= 0;
}

function headerRowIfSelectionStartsBeforeTable(
  range: Range,
  firstRowTitle: Element,
  tablePath: string,
  rowId: string,
): (CopyBlock & { kind: "row" }) | null {
  const tableVe = VesCache.current.readNode(tablePath);
  if (tableVe == null || !isTable(tableVe.displayItem)) { return null; }
  const table = asTableItem(tableVe.displayItem);
  if (table.computed_children[0] != rowId) { return null; }
  const rowStart = document.createRange();
  rowStart.selectNodeContents(firstRowTitle);
  rowStart.collapse(true);
  if (range.compareBoundaryPoints(Range.START_TO_START, rowStart) >= 0) { return null; }
  return { kind: "row", tablePath, cells: table.tableColumns.map(column => column.name) };
}
