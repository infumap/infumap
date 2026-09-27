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

import { isNote } from "../items/note-item";
import { VesCache } from "../layout/ves-cache";
import { VeFns } from "../layout/visual-element";
import { closestCaretPositionToClientPx, getEditPathInfoForNode, getTextOffsetWithinElement, resolveTextRangePosition } from "../util/caret";


let readOnlyDocumentTextSelectionActive = false;
let stopMarginSelectionDrag: (() => void) | null = null;

function startMarginSelectionDrag(element: HTMLElement): void {
  stopMarginSelectionDrag?.();
  const selection = window.getSelection();
  const pathInfo = getEditPathInfoForNode(element);
  if (pathInfo == null || selection?.anchorNode == null || !element.contains(selection.anchorNode)) { return; }
  const parentPath = VeFns.parentPath(pathInfo.path);
  if (parentPath == null) { return; }
  const anchorOffset = getTextOffsetWithinElement(element, selection.anchorNode, selection.anchorOffset);
  let hasMoved = false;

  const stop = () => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", finish, true);
    window.removeEventListener("blur", stop);
    stopMarginSelectionDrag = null;
  };
  const extend = (ev: MouseEvent) => {
    if (!element.isConnected) { stop(); return; }
    // Gaps have no text nodes. Resolve them to the nearest paragraph, including
    // positions above/below the first/last paragraph in this container.
    let target = element;
    let nearestDistance = Infinity;
    for (const child of VesCache.current.readStructuralChildren(parentPath)) {
      if (!isNote(child.displayItem)) { continue; }
      const title = document.getElementById(VeFns.veToPath(child) + ":title");
      if (title == null || title.getClientRects().length == 0) { continue; }
      const rect = title.getBoundingClientRect();
      const dx = Math.max(rect.left - ev.clientX, ev.clientX - rect.right, 0);
      const dy = Math.max(rect.top - ev.clientY, ev.clientY - rect.bottom, 0);
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        target = title;
      }
    }
    const anchor = resolveTextRangePosition(element, anchorOffset);
    const focus = resolveTextRangePosition(target, closestCaretPositionToClientPx(target, { x: ev.clientX, y: ev.clientY }));
    window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  };
  const move = (ev: MouseEvent) => {
    if (!(ev.buttons & 1)) { stop(); return; }
    hasMoved = true;
    extend(ev);
    ev.preventDefault();
    ev.stopPropagation();
  };
  const finish = (ev: MouseEvent) => {
    if (ev.button != 0) { return; }
    if (hasMoved) { extend(ev); }
    stop();
  };
  stopMarginSelectionDrag = stop;
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", finish, true);
  window.addEventListener("blur", stop);
}

export const NativeTextSelectionState = {
  // A prevented mousedown cannot start the browser's native selection drag.
  // Continue from the caret explicitly when the press landed on a gap/guard.
  startMarginSelectionDrag,

  startReadOnlyDocumentTextSelection: (): void => {
    readOnlyDocumentTextSelectionActive = true;
  },

  clear: (): void => {
    readOnlyDocumentTextSelectionActive = false;
    stopMarginSelectionDrag?.();
  },

  isReadOnlyDocumentTextSelectionActive: (): boolean => readOnlyDocumentTextSelectionActive,
};
