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

import {
  COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
  COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
} from "../constants";
import { BoundingBox } from "../util/geometry";


const COMPOSITE_MOVE_OUT_HANDLE_DOT_SIZE_PX = 2;
const COMPOSITE_MOVE_OUT_HANDLE_DOT_GAP_PX = 2;
const COMPOSITE_MOVE_OUT_HANDLE_DOT_COLS = 2;
const COMPOSITE_MOVE_OUT_HANDLE_MIN_DOT_ROWS = 2;
const COMPOSITE_MOVE_OUT_HANDLE_INSET_Y_PX = 3;

export const DOCUMENT_PAGE_MOVE_OUT_HANDLE_RIGHT_OFFSET_PX = 12;


export interface CompositeMoveOutHandleGeometry {
  gripBoundsPx: BoundingBox,
  backgroundBoundsPx: BoundingBox,
  dotSizePx: number,
  dotPositionsPx: Array<{ x: number, y: number }>,
}

function gripWidthPx(): number {
  return COMPOSITE_MOVE_OUT_HANDLE_DOT_COLS * COMPOSITE_MOVE_OUT_HANDLE_DOT_SIZE_PX +
    (COMPOSITE_MOVE_OUT_HANDLE_DOT_COLS - 1) * COMPOSITE_MOVE_OUT_HANDLE_DOT_GAP_PX;
}

function gripRowCount(boundsPx: BoundingBox): number {
  const availableH = boundsPx.h - COMPOSITE_MOVE_OUT_HANDLE_INSET_Y_PX * 2;
  const step = COMPOSITE_MOVE_OUT_HANDLE_DOT_SIZE_PX + COMPOSITE_MOVE_OUT_HANDLE_DOT_GAP_PX;
  return Math.max(
    COMPOSITE_MOVE_OUT_HANDLE_MIN_DOT_ROWS,
    Math.floor((availableH + COMPOSITE_MOVE_OUT_HANDLE_DOT_GAP_PX) / step));
}

function gripHeightPx(rows: number): number {
  return rows * COMPOSITE_MOVE_OUT_HANDLE_DOT_SIZE_PX +
    (rows - 1) * COMPOSITE_MOVE_OUT_HANDLE_DOT_GAP_PX;
}

/**
 * Left edge of the dot grip, relative to the move out box.
 */
export function compositeMoveOutHandleGripLeftPx(boundsPx: BoundingBox): number {
  return Math.max(0, Math.round((boundsPx.w - gripWidthPx()) / 2));
}

/**
 * Geometry of the move out handle (a two column dot grip spanning the height of the move out
 * box, so the extent of the item being dragged is clear, with a rounded background shown on
 * hover), relative to the move out box.
 */
export function compositeMoveOutHandleGeometry(boundsPx: BoundingBox): CompositeMoveOutHandleGeometry {
  const rows = gripRowCount(boundsPx);
  const gripW = gripWidthPx();
  const gripH = gripHeightPx(rows);
  const gripX = compositeMoveOutHandleGripLeftPx(boundsPx);
  const gripY = Math.max(0, Math.round((boundsPx.h - gripH) / 2));

  const step = COMPOSITE_MOVE_OUT_HANDLE_DOT_SIZE_PX + COMPOSITE_MOVE_OUT_HANDLE_DOT_GAP_PX;
  const dotPositionsPx = [];
  for (let row = 0; row < rows; ++row) {
    for (let col = 0; col < COMPOSITE_MOVE_OUT_HANDLE_DOT_COLS; ++col) {
      dotPositionsPx.push({ x: gripX + col * step, y: gripY + row * step });
    }
  }

  return {
    gripBoundsPx: { x: gripX, y: gripY, w: gripW, h: gripH },
    backgroundBoundsPx: { x: 0, y: 0, w: boundsPx.w, h: boundsPx.h },
    dotSizePx: COMPOSITE_MOVE_OUT_HANDLE_DOT_SIZE_PX,
    dotPositionsPx,
  };
}

export function compositeMoveOutHitboxBoundsPx(boundsPx: BoundingBox): BoundingBox {
  return {
    x: boundsPx.x,
    y: boundsPx.y,
    w: boundsPx.w,
    h: boundsPx.h,
  };
}

export function compositeMoveOutBoxForRightEdgePx(rightEdgePx: number, heightPx: number): BoundingBox {
  return {
    x: rightEdgePx - COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
    y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
    w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
    h: heightPx - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
  };
}

export function documentPageMoveOutBoxPx(
  childBoundsPx: BoundingBox,
  blockSizePx: { w: number, h: number },
  documentContentWidthBl: number,
  documentLeftMarginBl: number,
): BoundingBox {
  const documentContentRightPx =
    (documentLeftMarginBl + documentContentWidthBl) * blockSizePx.w;
  return compositeMoveOutBoxForRightEdgePx(
    documentContentRightPx - childBoundsPx.x + DOCUMENT_PAGE_MOVE_OUT_HANDLE_RIGHT_OFFSET_PX,
    childBoundsPx.h,
  );
}
