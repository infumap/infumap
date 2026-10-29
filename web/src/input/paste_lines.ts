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

import { ContainerItem, asContainerItem } from "../items/base/container-item";
import { NoteFns, NoteItem } from "../items/note-item";
import { TableFns } from "../items/table-item";
import { arrangeNow } from "../layout/arrange";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VeFns, VisualElement, VisualElementFlags, isTableView } from "../layout/visual-element";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { TransientMessageType } from "../store/StoreProvider_Overlay";
import { normalizeClipboardLineEndings } from "../util/editable_text";
import { Uid } from "../util/uid";
import { parentChainAllowsNewChild, scrollTableToIncludeNewItemRow } from "./create";
import { clearRowRangeSelectionMaybe } from "./row_selection";
import { locallyEditable } from "./structural_text_edit";


const BULLET_MARKER = /^[-*•]\s+(?=\S)/;
const NUMBERED_MARKER = /^\d+[.)]\s+(?=\S)/;

/** Pasting more lines than this asks first. */
const CONFIRM_LINE_COUNT = 50;
/**
 * Pasting more lines than this is refused. Each note is its own add-item request, undo deletes them one at a time,
 * and the undo entry holds a snapshot of every note (undo history is capped at 8 MB).
 */
const MAX_LINE_COUNT = 1000;

/**
 * Split pasted plain text into the titles of the notes to create, one per line.
 *
 * Lines are trimmed and blank lines dropped. Tabs become a single space: a row's other columns are its attachments,
 * not cells of the line, so tab separated text is kept as one title rather than split into columns.
 *
 * List markers ("- ", "* ", "• ", or "1. ", "1) ") are removed only when there are at least two lines and every one of
 * them has the same kind of marker. A lone "1. Introduction", or a list of urls with one line that happens to start
 * with "- ", is text, and stripping it would lose what the user pasted.
 */
export function parsePastedLines(text: string): Array<string> {
  const lines = normalizeClipboardLineEndings(text)
    .split(/[\n\u2028\u2029]/)
    .map(line => line.replace(/\s*\t\s*/g, " ").trim())
    .filter(line => line.length > 0);
  if (lines.length < 2) { return lines; }
  for (const marker of [BULLET_MARKER, NUMBERED_MARKER]) {
    if (lines.every(line => marker.test(line))) {
      return lines.map(line => line.replace(marker, ""));
    }
  }
  return lines;
}

/** Where pasted lines go. */
export interface PasteLinesTarget {
  /** The table view the lines are pasted into. */
  tableVe: VisualElement,
  /** Gets the new notes as children. */
  parentContainer: ContainerItem,
  /** The child of parentContainer (a row's item, or its link) the new notes follow, or null to add them at the end. */
  afterItemId: Uid | null,
}

/**
 * Where to paste lines, from the keyboard focus. A focused table view (a table, or a page arranged as one) gets them at
 * the end. A focused row, or a cell of one, gets them after the row, in the container the row is a child of: that is
 * not the table when the row is in an expanded container.
 *
 * Null when there is nowhere to paste: no table or row is focused, text is being edited, a popup or another overlay is
 * open, undo or redo is running, or the container can't get new items. That includes a container the user doesn't own,
 * which is all of them while signed out (a public page): the server refuses to add children to it. And it includes
 * remote containers: the new notes would be saved to this server, and undo refuses structural changes to them.
 */
export function pasteLinesTargetMaybe(store: StoreContextModel): PasteLinesTarget | null {
  if (store.overlay.anOverlayIsVisible() || store.history.currentPopupSpec() != null || store.editorHistory.busy()) {
    return null;
  }
  const focusPath = store.history.getFocusPathMaybe();
  const focusVe = focusPath == null ? null : VesCache.current.readNode(focusPath);
  if (focusVe == null) { return null; }

  let target: PasteLinesTarget | null = null;
  if (isTableView(focusVe)) {
    target = { tableVe: focusVe, parentContainer: asContainerItem(focusVe.displayItem), afterItemId: null };
  } else if (focusVe.flags & VisualElementFlags.InsideTable) {
    const rowPath = focusVe.flags & VisualElementFlags.Attachment ? focusVe.parentPath : focusPath;
    const rowVe = rowPath == null ? null : VesCache.current.readNode(rowPath);
    const tableVe = rowVe?.parentPath == null ? null : VesCache.current.readNode(rowVe.parentPath);
    if (tableVe == null || !isTableView(tableVe)) { return null; }
    const row = TableFns.tableVisibleRows(store, tableVe).find(row => row.path == rowPath);
    if (row == null) { return null; }
    target = { tableVe, parentContainer: row.parentContainer, afterItemId: row.item.id };
  }
  if (target == null) { return null; }

  const parent = target.parentContainer;
  if (!locallyEditable(store, parent) || !parentChainAllowsNewChild(parent.id)) { return null; }
  return target;
}

/**
 * Add a note for each line to target, in order, as one undo step, and focus the last of them. Above CONFIRM_LINE_COUNT
 * lines this asks first, and above MAX_LINE_COUNT it refuses. Returns whether the notes were added.
 *
 * In a container sorted by title, the notes are added at the end of its orderings and the sort places them. Inserting
 * them after a row there would mean finding a gap between orderings that are not in the order of its children.
 */
export function pasteLinesIntoContainer(store: StoreContextModel, target: PasteLinesTarget, lines: Array<string>): boolean {
  if (lines.length == 0) { return false; }
  if (lines.length > MAX_LINE_COUNT) {
    showMessage(store, `Can't paste ${lines.length} lines: the limit is ${MAX_LINE_COUNT}.`);
    return false;
  }
  if (lines.length > CONFIRM_LINE_COUNT && !window.confirm(`Add ${lines.length} rows?`)) { return false; }

  const parentId = target.parentContainer.id;
  const tablePath = VeFns.veToPath(target.tableVe);
  const inOrderingOrder = itemState.childrenAreInOrderingOrder(parentId);
  const ownerId = store.user.getUser().userId;

  store.textEdit.flushActive();
  const token = store.editorHistory.begin([parentId], lines.length == 1 ? "Paste line" : `Paste ${lines.length} lines`);
  let afterId = inOrderingOrder ? target.afterItemId : null;
  let lastNote: NoteItem | null = null;
  for (const line of lines) {
    const ordering = afterId == null
      ? itemState.newOrderingAtEndOfChildren(parentId)
      : itemState.newOrderingDirectlyAfterChild(parentId, afterId);
    const note = NoteFns.create(ownerId, parentId, RelationshipToParent.Child, line, ordering);
    NoteFns.ensureTitleUrl(note);
    store.editorHistory.include(token, note.id);
    itemState.add(note);
    store.editorHistory.track(server.addItem(note, null));
    if (inOrderingOrder) { afterId = note.id; }
    lastNote = note;
  }

  clearRowRangeSelectionMaybe(store);
  scrollTableToIncludeNewItemRow(store, target.tableVe, lastNote!, 0);
  store.history.setFocus(VeFns.addVeidToPath({ itemId: lastNote!.id, linkIdMaybe: null }, tablePath));
  arrangeNow(store, "paste-lines-create-notes");
  store.editorHistory.commit(token);
  return true;
}

function showMessage(store: StoreContextModel, text: string): void {
  const message = { text, type: TransientMessageType.Info };
  store.overlay.toolbarTransientMessage.set(message);
  setTimeout(() => {
    if (store.overlay.toolbarTransientMessage.get() === message) { store.overlay.toolbarTransientMessage.set(null); }
  }, 4500);
}
