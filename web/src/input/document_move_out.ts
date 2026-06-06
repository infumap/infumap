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
import { compositeMoveOutHandleLineLeftPx } from "../layout/composite-move-out";
import { VesCache } from "../layout/ves-cache";
import { VeFns, VisualElement, type VisualElementPath } from "../layout/visual-element";
import { boundingBoxFromDOMRect, type BoundingBox, type Vector } from "../util/geometry";


export const COMPOSITE_MOVE_OUT_HANDLE_PATH_ATTRIBUTE = "data-infumap-composite-move-out-path";


function isInsideInclusive(point: Vector, boundingBox: BoundingBox): boolean {
  return point.x >= boundingBox.x &&
    point.x <= boundingBox.x + boundingBox.w &&
    point.y >= boundingBox.y &&
    point.y <= boundingBox.y + boundingBox.h;
}

function readOnlyDocumentMoveOutVeFromPath(path: VisualElementPath | null): VisualElement | null {
  if (path == null) { return null; }

  const visualElement = VesCache.current.readNode(path);
  if (visualElement == null || !isInsideDocumentPageClickContext(visualElement)) {
    return null;
  }

  const treeItem = VeFns.treeItem(visualElement);
  return itemCanCopy(treeItem) && !itemCanMove(treeItem)
    ? visualElement
    : null;
}

export function readOnlyDocumentMoveOutVeAtClientPx(clientPosPx: Vector): VisualElement | null {
  const handles = Array.from(document.querySelectorAll<HTMLElement>(`[${COMPOSITE_MOVE_OUT_HANDLE_PATH_ATTRIBUTE}]`));
  for (let i = handles.length - 1; i >= 0; --i) {
    const bounds = boundingBoxFromDOMRect(handles[i].getBoundingClientRect());
    if (bounds == null) { continue; }
    const hitBounds = {
      ...bounds,
      x: bounds.x + compositeMoveOutHandleLineLeftPx(bounds),
    };
    if (!isInsideInclusive(clientPosPx, hitBounds)) { continue; }

    const visualElement = readOnlyDocumentMoveOutVeFromPath(
      handles[i].getAttribute(COMPOSITE_MOVE_OUT_HANDLE_PATH_ATTRIBUTE)
    );
    if (visualElement != null) { return visualElement; }
  }

  return null;
}
