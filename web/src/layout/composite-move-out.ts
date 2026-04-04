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

import { BoundingBox } from "../util/geometry";


const COMPOSITE_MOVE_OUT_HANDLE_LINE_WIDTH_PX = 1;
const COMPOSITE_MOVE_OUT_HANDLE_LINE_GAP_PX = 2;
const COMPOSITE_MOVE_OUT_HANDLE_RIGHT_SHIFT_PX = 3;
const COMPOSITE_MOVE_OUT_HANDLE_HIT_PADDING_PX = 2;


export function compositeMoveOutHandleLineWidthPx(): number {
  return COMPOSITE_MOVE_OUT_HANDLE_LINE_WIDTH_PX;
}

export function compositeMoveOutHandleLineGapPx(): number {
  return COMPOSITE_MOVE_OUT_HANDLE_LINE_GAP_PX;
}

export function compositeMoveOutHandleTotalWidthPx(): number {
  return compositeMoveOutHandleLineWidthPx() * 2 + compositeMoveOutHandleLineGapPx();
}

export function compositeMoveOutHandleLineHeightPx(boundsPx: BoundingBox): number {
  return Math.max(8, boundsPx.h - 6);
}

export function compositeMoveOutHandleLineTopPx(boundsPx: BoundingBox): number {
  return Math.max(0, Math.round((boundsPx.h - compositeMoveOutHandleLineHeightPx(boundsPx)) / 2));
}

export function compositeMoveOutHandleLineLeftPx(boundsPx: BoundingBox): number {
  return Math.max(0, Math.min(
    boundsPx.w - compositeMoveOutHandleTotalWidthPx(),
    Math.round((boundsPx.w - compositeMoveOutHandleTotalWidthPx()) / 2) + COMPOSITE_MOVE_OUT_HANDLE_RIGHT_SHIFT_PX
  ));
}

export function compositeMoveOutHitboxBoundsPx(boundsPx: BoundingBox): BoundingBox {
  const leftPx = Math.max(0, compositeMoveOutHandleLineLeftPx(boundsPx) - COMPOSITE_MOVE_OUT_HANDLE_HIT_PADDING_PX);
  const rightPx = Math.min(boundsPx.w, compositeMoveOutHandleLineLeftPx(boundsPx) + compositeMoveOutHandleTotalWidthPx() + COMPOSITE_MOVE_OUT_HANDLE_HIT_PADDING_PX);
  return {
    x: boundsPx.x + leftPx,
    y: boundsPx.y,
    w: Math.max(0, rightPx - leftPx),
    h: boundsPx.h,
  };
}
