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

import { itemCanEdit } from "../items/base/capabilities-item";
import { ContainerItem, asContainerItem } from "../items/base/container-item";
import { TableFns } from "../items/table-item";
import { VesCache } from "../layout/ves-cache";
import { VisualElement, VisualElementFlags, isTableView } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { normalizeClipboardLineEndings } from "../util/editable_text";
import { Uid } from "../util/uid";
import { parentChainAllowsNewChild } from "./create";


const BULLET_MARKER = /^[-*•]\s+(?=\S)/;
const NUMBERED_MARKER = /^\d+[.)]\s+(?=\S)/;

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
 * open, undo or redo is running, or the container can't get new items. That includes remote containers: the new notes
 * would be saved to this server, and undo refuses structural changes to them.
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
  if (parent.clientOnly === true || parent.origin != null || !itemCanEdit(parent) ||
      !parentChainAllowsNewChild(parent.id)) {
    return null;
  }
  return target;
}
