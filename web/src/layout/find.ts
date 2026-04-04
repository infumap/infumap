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
import { isPlaceholder } from "../items/placeholder-item";
import { BoundingBox, boundingBoxCenter, vectorDistance } from "../util/geometry";
import { panic } from "../util/lang";
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
  if (code == "ArrowLeft") { return FindDirection.Left; }
  if (code == "ArrowRight") { return FindDirection.Right; }
  if (code == "ArrowUp") { return FindDirection.Up; }
  if (code == "ArrowDown") { return FindDirection.Down; }
  panic(`Unexpected direction keycode: ${code}`);
}

type FindSceneReader = {
  readNode: (path: VisualElementPath) => VisualElement | undefined,
  readStructuralChildren: (parentPath: VisualElementPath) => Array<VisualElement>,
  readSiblings: (path: VisualElementPath) => Array<VisualElement>,
};

function overlappingSpanPx(aStartPx: number, aEndPx: number, bStartPx: number, bEndPx: number): number {
  return Math.max(0, Math.min(aEndPx, bEndPx) - Math.max(aStartPx, bStartPx));
}

function perpendicularOverlapPx(currentBoundsPx: BoundingBox, candidateBoundsPx: BoundingBox, direction: FindDirection): number {
  if (direction == FindDirection.Left || direction == FindDirection.Right) {
    return overlappingSpanPx(
      currentBoundsPx.y,
      currentBoundsPx.y + currentBoundsPx.h,
      candidateBoundsPx.y,
      candidateBoundsPx.y + candidateBoundsPx.h
    );
  }

  return overlappingSpanPx(
    currentBoundsPx.x,
    currentBoundsPx.x + currentBoundsPx.w,
    candidateBoundsPx.x,
    candidateBoundsPx.x + candidateBoundsPx.w
  );
}

function directionalGapPx(currentBoundsPx: BoundingBox, candidateBoundsPx: BoundingBox, direction: FindDirection): number {
  if (direction == FindDirection.Left) {
    return currentBoundsPx.x - (candidateBoundsPx.x + candidateBoundsPx.w);
  }
  if (direction == FindDirection.Right) {
    return candidateBoundsPx.x - (currentBoundsPx.x + currentBoundsPx.w);
  }
  if (direction == FindDirection.Up) {
    return currentBoundsPx.y - (candidateBoundsPx.y + candidateBoundsPx.h);
  }
  if (direction == FindDirection.Down) {
    return candidateBoundsPx.y - (currentBoundsPx.y + currentBoundsPx.h);
  }
  panic(`Unknown direction: ${direction}`);
}

export function findClosest(scene: FindSceneReader, path: VisualElementPath, direction: FindDirection, allItemTypes: boolean): VisualElementPath | null {
  const currentVe = scene.readNode(path)!;
  const currentBoundsPx = currentVe.boundsPx;

  const isInsideComposite = !!(currentVe.flags & VisualElementFlags.InsideCompositeOrDoc);

  let siblings: Array<VisualElement>;
  if (isInsideComposite) {
    const parentPath = currentVe.parentPath!;
    siblings = scene.readStructuralChildren(parentPath);
  } else {
    siblings = scene.readSiblings(path);
  }

  siblings = siblings
    .filter(ve => !(ve.flags & VisualElementFlags.Popup))
    .filter(ve => !(ve.flags & VisualElementFlags.IsDock))
    .filter(ve => !isPlaceholder(ve.displayItem))
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
  const EPSILON_PX = 0.001;
  let best = candidates[0];
  let bestOverlapPx = perpendicularOverlapPx(currentBoundsPx, candidates[0].boundsPx, direction);
  let bestGapPx = directionalGapPx(currentBoundsPx, candidates[0].boundsPx, direction);
  let bestDist = vectorDistance(currentCenterPx, boundingBoxCenter(candidates[0].boundsPx));
  for (let i = 1; i < candidates.length; ++i) {
    const overlapPx = perpendicularOverlapPx(currentBoundsPx, candidates[i].boundsPx, direction);
    const gapPx = directionalGapPx(currentBoundsPx, candidates[i].boundsPx, direction);
    let dist = vectorDistance(currentCenterPx, boundingBoxCenter(candidates[i].boundsPx));
    if (gapPx < bestGapPx - EPSILON_PX ||
      (Math.abs(gapPx - bestGapPx) <= EPSILON_PX && (
        overlapPx > bestOverlapPx + EPSILON_PX ||
        (Math.abs(overlapPx - bestOverlapPx) <= EPSILON_PX && dist < bestDist)
      ))) {
      best = candidates[i];
      bestOverlapPx = overlapPx;
      bestGapPx = gapPx;
      bestDist = dist;
    }
  }

  return VeFns.veToPath(best);
}
