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

// Move handles of document page rows are drawn in lanes in the right margin, outside the document column.
// Rows use the inner lane. A composite uses the outer lane, leaving the inner lane to its children, so their
// handles align with those of all other rows and are never drawn over content.
export const DOCUMENT_PAGE_MOVE_OUT_HANDLE_RIGHT_OFFSET_PX = 12;
const DOCUMENT_PAGE_COMPOSITE_MOVE_OUT_HANDLE_RIGHT_OFFSET_PX = 26;
// Where the inner lane hit area ends and the outer lane hit area begins, relative to the document column right edge.
const DOCUMENT_PAGE_MOVE_OUT_LANE_BOUNDARY_OFFSET_PX = 14;
// Where the outer lane hit area ends. Wider than the handle, so it is an easy target.
const DOCUMENT_PAGE_COMPOSITE_MOVE_OUT_HIT_RIGHT_OFFSET_PX = 32;

export enum DocumentMoveOutLane {
  Inner,
  Outer,
}


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

export function documentContentRightPx(
  blockSizePx: { w: number, h: number },
  documentContentWidthBl: number,
  documentLeftMarginBl: number,
): number {
  return (documentLeftMarginBl + documentContentWidthBl) * blockSizePx.w;
}

/**
 * The move handle box of a document page row (or of a child of a composite row), relative to the row.
 * childBoundsPx is the row's bounds in the document's child area.
 */
export function documentPageMoveOutBoxPx(
  childBoundsPx: BoundingBox,
  blockSizePx: { w: number, h: number },
  documentContentWidthBl: number,
  documentLeftMarginBl: number,
  lane: DocumentMoveOutLane = DocumentMoveOutLane.Inner,
): BoundingBox {
  const rightOffsetPx = lane == DocumentMoveOutLane.Outer
    ? DOCUMENT_PAGE_COMPOSITE_MOVE_OUT_HANDLE_RIGHT_OFFSET_PX
    : DOCUMENT_PAGE_MOVE_OUT_HANDLE_RIGHT_OFFSET_PX;
  return compositeMoveOutBoxForRightEdgePx(
    documentContentRightPx(blockSizePx, documentContentWidthBl, documentLeftMarginBl) - childBoundsPx.x + rightOffsetPx,
    childBoundsPx.h,
  );
}

/**
 * The move hitbox of a composite row in a document page, relative to the composite: the outer lane, from the
 * lane boundary to beyond the handle.
 */
export function documentPageCompositeMoveOutHitboxPx(
  compositeBoundsPx: BoundingBox,
  contentRightPx: number,
): BoundingBox {
  const handleBoxPx = compositeMoveOutBoxForRightEdgePx(0, compositeBoundsPx.h);
  return {
    x: contentRightPx - compositeBoundsPx.x + DOCUMENT_PAGE_MOVE_OUT_LANE_BOUNDARY_OFFSET_PX,
    y: handleBoxPx.y,
    w: DOCUMENT_PAGE_COMPOSITE_MOVE_OUT_HIT_RIGHT_OFFSET_PX - DOCUMENT_PAGE_MOVE_OUT_LANE_BOUNDARY_OFFSET_PX,
    h: handleBoxPx.h,
  };
}

/**
 * The move hitbox of a child of a composite row in a document page, relative to the child: the inner lane, extended
 * left to the composite's right edge and up/down to the given band, so the child stays under the mouse all the way
 * from its content to its handle. compositeWidthPx, contentRightPx and the band are relative to the composite.
 */
export function documentPageCompositeChildMoveOutHitboxPx(
  childBoundsPx: BoundingBox,
  compositeWidthPx: number,
  contentRightPx: number,
  bandTopPx: number,
  bandBottomPx: number,
): BoundingBox {
  const leftPx = compositeWidthPx - childBoundsPx.x;
  const rightPx = contentRightPx - childBoundsPx.x + DOCUMENT_PAGE_MOVE_OUT_LANE_BOUNDARY_OFFSET_PX;
  return {
    x: leftPx,
    y: bandTopPx - childBoundsPx.y,
    w: Math.max(0, rightPx - leftPx),
    h: bandBottomPx - bandTopPx,
  };
}
