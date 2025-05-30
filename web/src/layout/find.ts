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

import { isImage } from "../items/image-item";
import { isPage } from "../items/page-item";
import { boundingBoxCenter, vectorDistance } from "../util/geometry";
import { panic } from "../util/lang";
import { VesCache } from "./ves-cache";
import { VeFns, VisualElement, VisualElementFlags, VisualElementPath } from "./visual-element";


export enum FindDirection {
  Left,
  Right,
  Up,
  Down
}

export function findDirectionFromLetterPrefix(prefix: string): FindDirection {
  prefix = prefix.toUpperCase();
  if (prefix == "L") { return FindDirection.Left; }
  if (prefix == "R") { return FindDirection.Right; }
  if (prefix == "U") { return FindDirection.Up; }
  if (prefix == "D") { return FindDirection.Down; }
  throw new Error(`Unexpected direction letter: ${prefix}.`);
}

export function findDirectionFromKeyCode(code: string): FindDirection {
  if (code ==  "ArrowLeft") { return FindDirection.Left; }
  if (code == "ArrowRight") { return FindDirection.Right; }
  if (code == "ArrowUp") { return FindDirection.Up; }
  if (code == "ArrowDown") { return FindDirection.Down; }
  panic(`Unexpected direction keycode: ${code}`);
}

export function findClosest(path: VisualElementPath, direction: FindDirection, allItemTypes: boolean, virtual: boolean): VisualElementPath | null {
  const currentVe = virtual
    ? VesCache.getVirtual(path)!.get()
    : VesCache.get(path)!.get();
  const currentBoundsPx = currentVe.boundsPx;

  const isInsideComposite = !!(currentVe.flags & VisualElementFlags.InsideCompositeOrDoc);

  let siblings;
  if (isInsideComposite) {
    const parentPath = currentVe.parentPath!;
    const parentVe = virtual
      ? VesCache.getVirtual(parentPath)!.get()
      : VesCache.get(parentPath)!.get();

    siblings = parentVe.childrenVes
      ? parentVe.childrenVes.map(ves => ves.get())
      : [];
  } else {
    siblings = (virtual ? VesCache.getSiblingsVirtual(path) : VesCache.getSiblings(path))
      .map(ves => ves.get());
  }

  siblings = siblings
    .filter(ve => !(ve.flags & VisualElementFlags.Popup))
    .filter(ve => allItemTypes ? true : isPage(ve.displayItem) || isImage(ve.displayItem));

  const SLACK_PX = 2;

  const candidates: Array<VisualElement> = [];
  if (direction == FindDirection.Left) {
    for (let sibling of siblings) {
      const siblingBoundsPx = sibling.boundsPx;
      if (siblingBoundsPx.x + siblingBoundsPx.w - SLACK_PX > currentBoundsPx.x ||
          siblingBoundsPx.y + SLACK_PX > currentBoundsPx.y + currentBoundsPx.h ||
          siblingBoundsPx.y + siblingBoundsPx.h - SLACK_PX < currentBoundsPx.y) {
        continue;
      }
      candidates.push(sibling);
    }
  }
  else if (direction == FindDirection.Right) {
    for (let sibling of siblings) {
      const siblingBoundsPx = sibling.boundsPx;
      if (siblingBoundsPx.x < currentBoundsPx.x + currentBoundsPx.w - SLACK_PX ||
          siblingBoundsPx.y + SLACK_PX > currentBoundsPx.y + currentBoundsPx.h ||
          siblingBoundsPx.y + siblingBoundsPx.h - SLACK_PX < currentBoundsPx.y) {
        continue;
      }
      candidates.push(sibling);
    }
  }
  else if (direction == FindDirection.Up) {
    for (let sibling of siblings) {
      const siblingBoundsPx = sibling.boundsPx;
      if (siblingBoundsPx.y + siblingBoundsPx.h - SLACK_PX > currentBoundsPx.y ||
          siblingBoundsPx.x + SLACK_PX > currentBoundsPx.x + currentBoundsPx.w ||
          siblingBoundsPx.x + siblingBoundsPx.w - SLACK_PX < currentBoundsPx.x) {
        continue;
      }
      candidates.push(sibling);
    }
  }
  else if (direction == FindDirection.Down) {
    for (let sibling of siblings) {
      const siblingBoundsPx = sibling.boundsPx;
      if (siblingBoundsPx.y < currentBoundsPx.y + currentBoundsPx.h - SLACK_PX ||
          siblingBoundsPx.x + SLACK_PX > currentBoundsPx.x + currentBoundsPx.w ||
          siblingBoundsPx.x + siblingBoundsPx.w - SLACK_PX < currentBoundsPx.x) {
        continue;
      }
      candidates.push(sibling);
    }
  }
  else {
    panic(`Unknown direction: ${direction}`);
  }

  if (candidates.length == 0) {
    return null;
  }

  const currentCenterPx = boundingBoxCenter(currentBoundsPx);
  let best = candidates[0];
  let bestDist = vectorDistance(currentCenterPx, boundingBoxCenter(candidates[0].boundsPx));
  for (let i=1; i<candidates.length; ++i) {
    let dist = vectorDistance(currentCenterPx, boundingBoxCenter(candidates[i].boundsPx));
    if (dist < bestDist) {
      best = candidates[i];
      bestDist = dist;
    }
  }

  return VeFns.veToPath(best);
}
