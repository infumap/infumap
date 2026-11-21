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

/*
 * A \n in a note is a line break within its paragraph: the lines of an address, a verse or a code block, closer
 * together than paragraphs (separate notes) are. One note per line with a "no gap above" flag was the alternative, and
 * was rejected: an address is one thing to move, link to, attach to or copy, a flag like that is fragile under editing,
 * and a code block needs \n in one note anyway.
 *
 * Some places show only one line of a note: a list page line, a calendar entry, the cell of a table that doesn't wrap
 * the text of its rows. A line break can't be shown there, so one isn't added there (Shift+Enter is refused, pasted
 * line breaks become spaces), and one already in the note is drawn as a glyph rather than hiding the lines after it.
 */

import { NoteFlags } from "../items/base/flags-item";
import { ItemType } from "../items/base/item";
import { asNoteItem, isNote } from "../items/note-item";
import { TabularContainerItem, tabularWrapsRows } from "../layout/tabular";
import { VesCache } from "../layout/ves-cache";
import { VeFns, VisualElement, VisualElementFlags, isTableView } from "../layout/visual-element";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { normalizeLineBreaks } from "../util/editable_text";


/** Whether the note of noteVe is shown on one line, so a line break in it can't be. */
export function noteVeShowsOneLine(noteVe: VisualElement): boolean {
  // A row's attachments (its cells after the first) aren't flagged as line items, but are inside the table.
  if (!(noteVe.flags & VisualElementFlags.InsideTable)) { return !!(noteVe.flags & VisualElementFlags.LineItem); }
  // An attachment is below its row, which is below the table (or below the row of an expanded container).
  let path = VeFns.parentPath(VeFns.veToPath(noteVe));
  while (path != "") {
    const ve = VesCache.current.readNode(path);
    if (ve == null) { return true; }
    if (isTableView(ve)) { return !tabularWrapsRows(ve.displayItem as TabularContainerItem); }
    path = VeFns.parentPath(path);
  }
  return true;
}

/** Why a line break can't be added to the note of noteVe, or null if it can. */
export function noteLineBreakRefusal(noteVe: VisualElement): string | null {
  if (!noteVeShowsOneLine(noteVe)) { return null; }
  return (noteVe.flags & VisualElementFlags.InsideTable)
    ? "This table shows one line per row. Turn on \"Wrap row text\" to add line breaks."
    : "A line here shows one line of text.";
}

/**
 * Text pasted into the note being edited as it is to be inserted, with its line breaks normalized. The whitespace and
 * line breaks around it are dropped: they are almost always an artifact of the copy, such as a terminal line's newline.
 * Code keeps the indentation of its first line, which lines up with the others. Where the note shows one line, the line
 * breaks (and the whitespace around them) become spaces. Null if no note is being edited.
 */
export function noteTextForPaste(store: StoreContextModel, pastedText: string): string | null {
  const text = normalizeLineBreaks(pastedText);
  const info = store.overlay.textEditInfo();
  const noteVe = info?.itemType == ItemType.Note && info.colNum == null ? VesCache.current.readNode(info.itemPath) : null;
  const item = noteVe == null ? null : itemState.get(VeFns.veidFromPath(info!.itemPath).itemId);
  if (noteVe == null || item == null || !isNote(item)) { return null; }
  const code = !!(asNoteItem(item).flags & NoteFlags.Code);
  const trimmed = code ? text.replace(/^(?:[^\S\n]*\n)+/, "").trimEnd() : text.trim();
  return noteVeShowsOneLine(noteVe) ? trimmed.replace(/\s*\n\s*/g, " ") : trimmed;
}
