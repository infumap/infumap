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

import { MAIN_TOOLBAR_WIDTH_PX } from "../constants";


export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boundingBoxFromPosSize(pos: Vector, size: Dimensions): BoundingBox {
  return {
    x: pos.x,
    y: pos.y,
    w: size.w,
    h: size.h
  };
}

export function cloneBoundingBox(boundingBox: BoundingBox | null): BoundingBox | null {
  if (boundingBox == null) { return null; }
  return ({
    x: boundingBox.x,
    y: boundingBox.y,
    w: boundingBox.w,
    h: boundingBox.h
  });
}

export function quantizeBoundingBox(boundingBox: BoundingBox): BoundingBox {
  return ({
    x: Math.round(boundingBox.x),
    y: Math.round(boundingBox.y),
    w: Math.round(boundingBox.w),
    h: Math.round(boundingBox.h)
  });
}

export function getBoundingBoxSize(boundingBox: BoundingBox): Dimensions {
  return ({ w: boundingBox.w, h: boundingBox.h });
}

export function getBoundingBoxTopLeft(boundingBox: BoundingBox): Vector {
  return ({ x: boundingBox.x, y: boundingBox.y });
}

export function zeroBoundingBoxTopLeft(boundingBox: BoundingBox): BoundingBox {
  return ({ x: 0.0, y: 0.0, w: boundingBox.w, h: boundingBox.h });
}

export function boundingBoxCenter(boundingBox: BoundingBox): Vector {
  return ({ x: boundingBox.x + boundingBox.w / 2.0, y: boundingBox.y + boundingBox.h / 2.0 });
}

export function compareBoundingBox(a: BoundingBox, b: BoundingBox): number {
  if (a.x != b.x) { return 1; }
  if (a.y != b.y) { return 1; }
  if (a.w != b.w) { return 1; }
  if (a.h != b.h) { return 1; }
  return 0;
}

export function offsetBoundingBoxTopLeftBy(boundingBox: BoundingBox, offset: Vector): BoundingBox {
  return ({
    x: boundingBox.x + offset.x,
    y: boundingBox.y + offset.y,
    w: boundingBox.w,
    h: boundingBox.h
  });
}

export function isInside(point: Vector, boundingBox: BoundingBox): boolean {
  return point.x > boundingBox.x &&
         point.x < boundingBox.x + boundingBox.w &&
         point.y > boundingBox.y &&
         point.y < boundingBox.y + boundingBox.h;
}

export interface Vector {
  x: number;
  y: number;
}

export function cloneVector(vector: Vector | null): Vector | null {
  if (vector == null) { return null; }
  return {
    x: vector.x,
    y: vector.y
  };
}

export interface Dimensions {
  w: number;
  h: number;
}

export function cloneDimensions(dimensions: Dimensions | null): Dimensions | null {
  if (dimensions == null) { return null; }
  return {
    w: dimensions.w,
    h: dimensions.h
  };
}


function clientPxFromMouseEvent(ev: MouseEvent): Vector {
  return { x: ev.clientX, y: ev.clientY };
}

export function desktopPxFromMouseEvent(ev: MouseEvent): Vector {
  return vectorSubtract(clientPxFromMouseEvent(ev), { x: MAIN_TOOLBAR_WIDTH_PX, y: 0 });
}

export function vectorSubtract(a: Vector, b: Vector): Vector {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function vectorAdd(a: Vector, b: Vector): Vector {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function vectorDistance(a: Vector, b: Vector): number {
  return Math.sqrt((a.x-b.x) * (a.x-b.x) + (a.y-b.y)*(a.y-b.y));
}
