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

import { GRID_SIZE, ITEM_BORDER_WIDTH_PX } from '../constants';
import { createHitbox, HitboxType } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { Item, ItemTypeMixin, ITEM_TYPE_RATING } from './base/item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { EMPTY_UID, newUid, Uid } from '../util/uid';
import { DesktopStoreContextModel } from '../store/DesktopStoreProvider';
import { server } from '../server';
import { arrange } from '../layout/arrange';
import { VisualElementSignal } from '../util/signals';
import { calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { handleListPageLineItemClickMaybe } from './base/item-common';


export interface RatingItem extends RatingMeasurable, Item {
  rating: number,
}

export interface RatingMeasurable extends ItemTypeMixin, PositionalMixin {}


export function newRatingItem(ownerId: Uid, parentId: Uid, rating: number, relationshipToParent: string, ordering: Uint8Array): RatingItem {
  if (parentId == EMPTY_UID) { panic(); }
  return {
    itemType: ITEM_TYPE_RATING,
    ownerId,
    id: newUid(),
    parentId,
    relationshipToParent,
    creationDate: currentUnixTimeSeconds(),
    lastModifiedDate: currentUnixTimeSeconds(),
    ordering,
    spatialPositionGr: { x: 0.0, y: 0.0 },

    rating,
  };
}


export function ratingFromObject(o: any): RatingItem {
  // TODO: dynamic type check of o.
  return ({
    itemType: o.itemType,
    ownerId: o.ownerId,
    id: o.id,
    parentId: o.parentId,
    relationshipToParent: o.relationshipToParent,
    creationDate: o.creationDate,
    lastModifiedDate: o.lastModifiedDate,
    ordering: new Uint8Array(o.ordering),
    spatialPositionGr: o.spatialPositionGr,

    rating: o.rating,
  });
}

export function ratingToObject(r: RatingItem): object {
  return ({
    itemType: r.itemType,
    ownerId: r.ownerId,
    id: r.id,
    parentId: r.parentId,
    relationshipToParent: r.relationshipToParent,
    creationDate: r.creationDate,
    lastModifiedDate: r.lastModifiedDate,
    ordering: Array.from(r.ordering),
    spatialPositionGr: r.spatialPositionGr,

    rating: r.rating,
  });
}


export function calcRatingSizeForSpatialBl(_item: RatingMeasurable): Dimensions {
  return { w: 1.0, h: 1.0 };
}

export function calcGeometryOfRatingItem_Desktop(rating: RatingMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, _emitHitboxes: boolean): ItemGeometry {
  const boundsPx = {
    x: (rating.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (rating.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcRatingSizeForSpatialBl(rating).w / containerInnerSizeBl.w * containerBoundsPx.w + ITEM_BORDER_WIDTH_PX,
    h: calcRatingSizeForSpatialBl(rating).h / containerInnerSizeBl.h * containerBoundsPx.h + ITEM_BORDER_WIDTH_PX,
  };
  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  return {
    boundsPx,
    hitboxes: [
      createHitbox(HitboxType.Move, innerBoundsPx),
      createHitbox(HitboxType.Click, innerBoundsPx),
    ],
  }
}

export function calcGeometryOfRatingItem_InComposite(measurable: RatingMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, topPx: number): ItemGeometry {
  panic();
}

export function calcGeometryOfRatingItem_Attachment(rating: RatingMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry {
  return calcGeometryOfAttachmentItemImpl(rating, parentBoundsPx, parentInnerSizeBl, index, isSelected, false);
}

export function calcGeometryOfRatingItem_ListItem(_rating: RatingMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
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
      createHitbox(HitboxType.Move, innerBoundsPx),
      createHitbox(HitboxType.Click, innerBoundsPx)
    ]
  };
}

export function calcGeometryOfRatingItem_Cell(_rating: RatingMeasurable, cellBoundsPx: BoundingBox): ItemGeometry {
  return ({
    boundsPx: cloneBoundingBox(cellBoundsPx)!,
    hitboxes: [
      createHitbox(HitboxType.Click, zeroBoundingBoxTopLeft(cellBoundsPx))
    ]
  });
}

const PERSIST_AFTER_MS = 1000;
let clickTimer: number | null = null;

export function handleRatingClick(desktopStore: DesktopStoreContextModel, visualElementSignal: VisualElementSignal): void {
  const visualElement = visualElementSignal.get();
  if (handleListPageLineItemClickMaybe(visualElement, desktopStore)) { return; }
  const item = asRatingItem(visualElementSignal.get().displayItem);
  item.rating += 1;
  if (item.rating == 6) { item.rating = 0; }
  arrange(desktopStore); // TODO (LOW): only need to rearrange the element.

  function clickTimerHandler() {
    server.updateItem(item);
    clickTimer = null;
  }
  if (clickTimer != null) { clearTimeout(clickTimer); }
  clickTimer = setTimeout(clickTimerHandler, PERSIST_AFTER_MS);
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
    spatialPositionGr: rating.spatialPositionGr,
  });
}

export function ratingDebugSummary(ratingItem: RatingItem) {
  return "[rating] " + ratingItem.rating;
}

export function getRatingItemUniqueHash(ratingItem: RatingItem): string {
  return "" + ratingItem.rating;
}
