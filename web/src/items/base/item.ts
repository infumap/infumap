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

import { LINE_HEIGHT_PX } from '../../constants';
import { HitboxType, createHitbox } from '../../layout/hitbox';
import { ItemGeometry } from '../../layout/item-geometry';
import { Child } from '../../layout/relationship-to-parent';
import { BoundingBox, Dimensions } from '../../util/geometry';
import { EMPTY_UID, Uid } from '../../util/uid';

export const ITEM_TYPE_NONE = "none";
export const ITEM_TYPE_PAGE = "page";
export const ITEM_TYPE_TABLE = "table";
export const ITEM_TYPE_COMPOSITE = "composite";
export const ITEM_TYPE_NOTE = "note";
export const ITEM_TYPE_FILE = "file";
export const ITEM_TYPE_PASSWORD = "password";
export const ITEM_TYPE_IMAGE = "image";
export const ITEM_TYPE_RATING = "rating";
export const ITEM_TYPE_LINK = "link";
export const ITEM_TYPE_PLACEHOLDER = "placeholder";

export interface ItemTypeMixin {
  itemType: string,
}

export interface Measurable extends ItemTypeMixin { }

export interface Item extends ItemTypeMixin {
  ownerId: Uid,
  id: Uid,
  parentId: Uid,
  relationshipToParent: string,
  creationDate: number,
  lastModifiedDate: number,
  ordering: Uint8Array,
}

export const EMPTY_ITEM = () => ({
  itemType: ITEM_TYPE_NONE,
  ownerId: EMPTY_UID,
  id: EMPTY_UID,
  parentId: EMPTY_UID,
  relationshipToParent: Child,
  creationDate: 0,
  lastModifiedDate: 0,
  ordering: Uint8Array.from([]),
});

export function calcGeometryOfEmptyItem_ListItem(_empty: Measurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
  const innerBoundsPx = {
    x: 0.0,
    y: 0.0,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  const boundsPx = {
    x: blockSizePx.w * col,
    y: blockSizePx.h * row,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  return {
    boundsPx,
    hitboxes: [
      createHitbox(HitboxType.Click, innerBoundsPx),
      createHitbox(HitboxType.Move, innerBoundsPx)
    ]
  };
}

/**
 * Units of size are arbitrary. Used only for aspect calculations.
 */
export function calcBoundsInCell(size: Dimensions, cellBoundsPx: BoundingBox): BoundingBox {
  const imageAspect = size.w / size.h;
  let result: BoundingBox;
  if (size.w / cellBoundsPx.w > size.h / cellBoundsPx.h) {
    // constraining dimension is width.
    result = {
      x: cellBoundsPx.x,
      w: cellBoundsPx.w,
      h: Math.round(cellBoundsPx.w / imageAspect),
      y: Math.round(cellBoundsPx.y + (cellBoundsPx.h - (cellBoundsPx.w / imageAspect)) / 2.0)
    };
  } else {
    // constraining dimension is height.
    result = {
      y: cellBoundsPx.y,
      h: cellBoundsPx.h,
      w: Math.round(cellBoundsPx.h * imageAspect),
      x: Math.round(cellBoundsPx.x + (cellBoundsPx.w - (cellBoundsPx.h * imageAspect)) / 2.0)
    };
  }
  return result;
}

export function calcBoundsInCellFromSizeBl(sizeBl: Dimensions, cellBoundsPx: BoundingBox): BoundingBox {
  const boundsPx = calcBoundsInCell(sizeBl, cellBoundsPx);
  const blockSizePx: Dimensions = {
    w: boundsPx.w / sizeBl.w,
    h: boundsPx.h / sizeBl.h
  };
  let xScale = 1.0;
  if (blockSizePx.w > LINE_HEIGHT_PX) {
    xScale = blockSizePx.w / LINE_HEIGHT_PX;
  }
  let yScale = 1.0;
  if (blockSizePx.h > LINE_HEIGHT_PX) {
    yScale = blockSizePx.h / LINE_HEIGHT_PX;
  }
  let scale = Math.max(xScale, yScale);
  let xSizeDeltaPx = boundsPx.w - boundsPx.w / scale;
  let ySizeDeltaPx = boundsPx.h - boundsPx.h / scale;
  return ({
    x: boundsPx.x + xSizeDeltaPx / 2.0,
    y: boundsPx.y + ySizeDeltaPx / 2.0,
    w: boundsPx.w - xSizeDeltaPx,
    h: boundsPx.h - ySizeDeltaPx,
  });
}
