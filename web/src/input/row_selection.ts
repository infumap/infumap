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

import { VeFns, Veid } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { Uid } from "../util/uid";


/** A row of a list page or table, as shift + up/down selects it. parentId is the parent of the row's tree item. */
export interface SelectableRow {
  veid: Veid,
  parentId: Uid,
}

/**
 * Move the cursor end of the range of rows selected with shift + up/down (store.overlay.selectedVeids) one row in
 * direction. rows are the rows shown, in order, and cursorVeid is the row the keyboard is on (the focused table row,
 * or the selected list page row).
 *
 * The range is anchored at the row the cursor was on when shift + up/down started. That isn't stored: while the
 * selection is a run of rows with the cursor at one end, the other end is the anchor, and anything else starts a new
 * range at the cursor. The range only spans siblings of the anchor, skipping the rows of expanded containers, because a
 * group move takes its items from a single parent.
 *
 * The selection is kept in row order, which a drag of it keeps (see stackedGroupMoveStartPositionsGr). A range of one
 * row is no selection: the cursor alone shows it.
 *
 * Returns the row the cursor moved to, or null when it is at the end of the rows it can move over.
 */
export function extendRowRangeSelection(
  store: StoreContextModel,
  rows: Array<SelectableRow>,
  cursorVeid: Veid,
  direction: -1 | 1,
): SelectableRow | null {
  const cursor = rows.find(row => VeFns.compareVeids(row.veid, cursorVeid) == 0);
  if (cursor == null) { return null; }

  const siblings = rows.filter(row => row.parentId == cursor.parentId);
  const indexOf = (veid: Veid) => siblings.findIndex(row => VeFns.compareVeids(row.veid, veid) == 0);
  const cursorIdx = indexOf(cursorVeid);
  const selectedIndices = store.overlay.selectedVeids.get().map(indexOf).sort((a, b) => a - b);
  const first = selectedIndices[0];
  const last = selectedIndices[selectedIndices.length - 1];
  const selectionIsRunEndingAtCursor =
    selectedIndices.length >= 2 &&
    first >= 0 &&
    selectedIndices.every((idx, i) => idx == first + i) &&
    (cursorIdx == first || cursorIdx == last);
  const anchorIdx = !selectionIsRunEndingAtCursor
    ? cursorIdx
    : cursorIdx == first ? last : first;

  const nextIdx = cursorIdx + direction;
  if (nextIdx < 0 || nextIdx >= siblings.length) { return null; }

  store.overlay.selectedVeids.set(nextIdx == anchorIdx
    ? []
    : siblings.slice(Math.min(anchorIdx, nextIdx), Math.max(anchorIdx, nextIdx) + 1).map(row => row.veid));
  return siblings[nextIdx];
}

/** Clear a selection made with shift + up/down, when up/down moves on without shift. */
export function clearRowRangeSelectionMaybe(store: StoreContextModel): void {
  if (store.overlay.selectedVeids.get().length > 0) {
    store.overlay.selectedVeids.set([]);
  }
}
