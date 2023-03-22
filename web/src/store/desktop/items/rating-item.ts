/*
  Copyright (C) 2023 The Infumap Authors
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

import { GRID_SIZE } from '../../../constants';
import { HitboxType } from '../hitbox';
import { BoundingBox, cloneBoundingBox, cloneVector, Dimensions, zeroTopLeft } from '../../../util/geometry';
import { panic } from '../../../util/lang';
import { Item, ItemTypeMixin, ITEM_TYPE_RATING } from './base/item';
import { ItemGeometry } from '../item-geometry';
import { Uid } from '../../../util/uid';
import { PositionalMixin } from './base/positional-item';
import { createBooleanSignal } from '../../../util/signals';


export interface RatingItem extends RatingMeasurable, Item {
  rating: number,
}

export interface RatingMeasurable extends ItemTypeMixin, PositionalMixin {}


export function calcRatingSizeForSpatialBl(_item: RatingMeasurable, _getItem: (id: Uid) => (Item | null)): Dimensions {
  return { w: 1.0, h: 1.0 };
}

export function calcGeometryOfRatingItem(rating: RatingMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _emitHitboxes: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: (rating.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (rating.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcRatingSizeForSpatialBl(rating, getItem).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcRatingSizeForSpatialBl(rating, getItem).h / containerInnerSizeBl.h * containerBoundsPx.h,
  };
  return {
    boundsPx,
    hitboxes: [],
  }
}

export function calcGeometryOfRatingAttachmentItem(_rating: RatingMeasurable, containerBoundsPx: BoundingBox, index: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: containerBoundsPx.w - (20 * index),
    y: -5,
    w: 15,
    h: 10,
  };
  return {
    boundsPx,
    hitboxes: [],
  }
}

export function calcGeometryOfRatingItemInTable(_rating: RatingMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: blockSizePx.w * col,
    y: blockSizePx.h * row,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  return {
    boundsPx,
    hitboxes: [
      { type: HitboxType.Move, boundsPx: zeroTopLeft(boundsPx) }
    ],
  };
}

export function calcGeometryOfRatingItemInCell(_rating: RatingMeasurable, cellBoundsPx: BoundingBox, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  return ({
    boundsPx: cloneBoundingBox(cellBoundsPx)!,
    hitboxes: [{ type: HitboxType.Click, boundsPx: zeroTopLeft(cellBoundsPx) }]
  });
}

export function setRatingDefaultComputed(item: RatingItem): void {
  item.computed_mouseIsOver = createBooleanSignal(false);
}

export function isRating(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ITEM_TYPE_RATING;
}

export function asRatingItem(item: ItemTypeMixin): RatingItem {
  if (item.itemType == ITEM_TYPE_RATING) { return item as RatingItem; }
  panic();
}

export function asRatingMeasurable(item: ItemTypeMixin): RatingMeasurable {
  if (item.itemType == ITEM_TYPE_RATING) { return item as RatingMeasurable; }
  panic();
}

export function cloneRatingMeasurableFields(rating: RatingMeasurable): RatingMeasurable {
  return ({
    itemType: rating.itemType,
    spatialPositionGr: cloneVector(rating.spatialPositionGr)!,
  });
}
