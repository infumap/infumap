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

import { isPage } from "../items/page-item";
import { boundingBoxCenter, vectorDistance } from "../util/geometry";
import { panic } from "../util/lang";
import { VesCache } from "./arrange";
import { VisualElement, VisualElementFlags, VisualElementPath, visualElementToPath } from "./visual-element";


export enum FindDirection {
  Left,
  Right,
  Up,
  Down
}

export function findDirectionFromKeyCode(code: string): FindDirection {
  if (code ==  "ArrowLeft") {
    return FindDirection.Left;
  }
  if (code == "ArrowRight") {
    return FindDirection.Right;
  }
  if (code == "ArrowUp") {
    return FindDirection.Up;
  }
  if (code == "ArrowDown") {
    return FindDirection.Down;
  }
  panic();
}

export function findClosest(path: VisualElementPath, direction: FindDirection): VisualElementPath | null {
  const currentBoundsPx = VesCache.get(path)!.get().boundsPx;

  const siblings = VesCache.getSiblings(path)
    .map(ves => ves.get())
    .filter(ve => (ve.flags & VisualElementFlags.PagePopup) != VisualElementFlags.PagePopup)
    .filter(ve => isPage(ve.displayItem));

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
    panic();
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

  return visualElementToPath(best);
}
