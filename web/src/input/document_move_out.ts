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

import { itemCanCopy, itemCanMove } from "../items/base/capabilities-item";
import { isInsideDocumentPageClickContext } from "../items/base/item-common-fns";
import { HitboxFlags } from "../layout/hitbox";
import { VeFns, VisualElement, type VisualElementPath } from "../layout/visual-element";


/**
 * Whether a drag from visualElement's handle copies it: a row of a document page (or a child of a composite row) that
 * can be copied but not moved, such as a table in a markdown file shown as a document. The hit test keeps the Move of
 * such a handle (filteredHitboxType), though not of the row's other move hitboxes. It used to be found from where the
 * handle was drawn instead, so a press counted only where the drawn handle and the hitbox overlapped, which was 3px when
 * a table's handle was drawn in the wrong place.
 */
export function readOnlyDocumentHandleCopies(visualElement: VisualElement): boolean {
  const treeItem = VeFns.treeItem(visualElement);
  return itemCanCopy(treeItem) && !itemCanMove(treeItem) && isInsideDocumentPageClickContext(visualElement);
}

/**
 * The read-only document row whose drag handle a hit (on hitVe, with hitboxType) is on, if it is. With Shift, a drag
 * copies anything copyable from any of its move hitboxes, so isn't a handle drag.
 */
export function readOnlyDocumentHandleVeMaybe(
  hitVe: VisualElement,
  hitboxType: HitboxFlags,
  shiftDown: boolean,
): VisualElement | null {
  if (shiftDown || !(hitboxType & HitboxFlags.Move)) { return null; }
  return readOnlyDocumentHandleCopies(hitVe) ? hitVe : null;
}


let readOnlyDocumentHandlePressPath: VisualElementPath | null = null;

/**
 * The row whose drag handle in a read-only document the current mouse action started on, if it did. It is recorded here
 * for the drag (a copy, see dragModifiers in mouse_move_move.ts) and the release (a click places the caret, see
 * mouse_up.ts).
 */
export const ReadOnlyDocumentHandlePress = {
  set: (path: VisualElementPath | null): void => { readOnlyDocumentHandlePressPath = path; },
  get: (): VisualElementPath | null => readOnlyDocumentHandlePressPath,
};
