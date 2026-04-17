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

import { LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../constants";
import { isFile } from "../items/file-item";
import { isNote } from "../items/note-item";
import { isPassword } from "../items/password-item";
import { StoreContextModel } from "../store/StoreProvider";
import { BoundingBox, Vector } from "../util/geometry";
import { VeFns, VisualElement } from "./visual-element";


function stackedChildVisibleVerticalBoundsPx(childVe: VisualElement, boundsPx: BoundingBox): { top: number, bottom: number } {
  if (isNote(childVe.displayItem) || isFile(childVe.displayItem) || isPassword(childVe.displayItem)) {
    const scale = childVe.blockSizePx ? childVe.blockSizePx.h / LINE_HEIGHT_PX : 1;
    return {
      top: boundsPx.y + (NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * scale,
      bottom: boundsPx.y + boundsPx.h - 3 * scale,
    };
  }

  return {
    top: boundsPx.y,
    bottom: boundsPx.y + boundsPx.h,
  };
}

export function stackedInsertionLineBoundsPx(
  childVes: Array<VisualElement>,
  containerWidthPx: number,
  moveOverIndex: number,
): BoundingBox | null {
  if (moveOverIndex < 0) {
    return null;
  }

  const widthPx = Math.max(0, containerWidthPx);
  if (childVes.length === 0) {
    return { x: 0, y: 0, w: widthPx, h: 1 };
  }

  if (moveOverIndex <= 0) {
    return {
      x: 0,
      y: Math.round(stackedChildVisibleVerticalBoundsPx(childVes[0], childVes[0].boundsPx).top),
      w: widthPx,
      h: 1,
    };
  }

  if (moveOverIndex >= childVes.length) {
    const lastVe = childVes[childVes.length - 1];
    return {
      x: 0,
      y: Math.round(stackedChildVisibleVerticalBoundsPx(lastVe, lastVe.boundsPx).bottom),
      w: widthPx,
      h: 1,
    };
  }

  const prevVe = childVes[moveOverIndex - 1];
  const nextVe = childVes[moveOverIndex];
  const prevVisibleBoundsPx = stackedChildVisibleVerticalBoundsPx(prevVe, prevVe.boundsPx);
  const nextVisibleBoundsPx = stackedChildVisibleVerticalBoundsPx(nextVe, nextVe.boundsPx);
  return {
    x: 0,
    y: Math.round((prevVisibleBoundsPx.bottom + nextVisibleBoundsPx.top) / 2),
    w: widthPx,
    h: 1,
  };
}

export function stackedInsertionIndexFromDesktopPx(
  store: StoreContextModel,
  childVes: Array<VisualElement>,
  desktopPx: Vector,
): number {
  let insertIndex = childVes.length;

  for (let i = 0; i < childVes.length; ++i) {
    const childVe = childVes[i];
    const childBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, childVe);
    const childVisibleBoundsPx = stackedChildVisibleVerticalBoundsPx(childVe, childBoundsPx);
    if (desktopPx.y < (childVisibleBoundsPx.top + childVisibleBoundsPx.bottom) / 2) {
      insertIndex = i;
      break;
    }
  }

  return insertIndex;
}
