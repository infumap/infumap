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

import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LIST_PAGE_TOP_PADDING_PX } from '../constants';
import { HitboxFlags, HitboxFns } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { Item, ItemType, ItemTypeMixin } from './base/item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { EMPTY_UID, newUid, Uid } from '../util/uid';
import { StoreContextModel } from '../store/StoreProvider';
import { serverOrRemote } from '../server';
import { VisualElementSignal } from '../util/signals';
import { calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { calcBoundsInCell, calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe } from './base/item-common-fns';
import { rearrangeWithDisplayId } from '../layout/arrange';


export interface RatingItem extends RatingMeasurable, Item {
  rating: number,
}

export interface RatingMeasurable extends ItemTypeMixin, PositionalMixin { }


export const RatingFns = {
  create: (ownerId: Uid, parentId: Uid, rating: number, relationshipToParent: string, ordering: Uint8Array): RatingItem => {
    if (parentId == EMPTY_UID) { panic("RatingFns.create: parent is empty."); }
    return {
      origin: null,
      itemType: ItemType.Rating,
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
  },

  fromObject: (o: any, origin: string | null): RatingItem => {
    // TODO: dynamic type check of o.
    return ({
      origin,
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
  },

  toObject: (r: RatingItem): object => {
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
  },

  calcSpatialDimensionsBl: (_item: RatingMeasurable): Dimensions => {
    return { w: 1.0, h: 1.0 };
  },

  calcGeometry_Spatial: (rating: RatingMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, _emitHitboxes: boolean): ItemGeometry => {
    const sizeBl = RatingFns.calcSpatialDimensionsBl(rating);
    const blockSizePx = {
      w: containerBoundsPx.w / containerInnerSizeBl.w,
      h: containerBoundsPx.h / containerInnerSizeBl.h
    };
    const boundsPx = {
      x: (rating.spatialPositionGr.x / GRID_SIZE) * blockSizePx.w + containerBoundsPx.x,
      y: (rating.spatialPositionGr.y / GRID_SIZE) * blockSizePx.h + containerBoundsPx.y,
      w: sizeBl.w * blockSizePx.w + ITEM_BORDER_WIDTH_PX,
      h: sizeBl.h * blockSizePx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
      ],
    }
  },

  calcGeometry_InComposite: (_measurable: RatingMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w + CONTAINER_IN_COMPOSITE_PADDING_PX,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w - (CONTAINER_IN_COMPOSITE_PADDING_PX * 2) - 2,
      h: blockSizePx.h
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveBoundsPx = {
      x: innerBoundsPx.w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
    };
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, moveBoundsPx),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: innerBoundsPx.w / 4,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w / 2,
          h: ATTACH_AREA_SIZE_PX,
        }),
      ]
    };
  },

  calcGeometry_Attachment: (rating: RatingMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(rating, parentBoundsPx, parentInnerSizeBl, index, isSelected, false);
  },

  calcGeometry_ListItem: (_rating: RatingMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean, _expandable: boolean): ItemGeometry => {
    const innerBoundsPx = {
      x: 0.0,
      y: 0.0,
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const boundsPx = {
      x: blockSizePx.w * col,
      y: blockSizePx.h * row + (padTop ? LIST_PAGE_TOP_PADDING_PX : 0),
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx)
      ]
    };
  },

  calcGeometry_InCell: (rating: RatingMeasurable, cellBoundsPx: BoundingBox, _maximize: boolean): ItemGeometry => {
    const sizeBl = RatingFns.calcSpatialDimensionsBl(rating);
    const boundsPx = calcBoundsInCell(sizeBl, cellBoundsPx);
    const blockSizePx = {
      w: boundsPx.w / sizeBl.w,
      h: boundsPx.h / sizeBl.h,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return ({
      boundsPx: cloneBoundingBox(cellBoundsPx)!,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx)
      ]
    });
  },

  handleClick: (store: StoreContextModel, visualElementSignal: VisualElementSignal): void => {
    const visualElement = visualElementSignal.get();
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    const item = asRatingItem(visualElementSignal.get().displayItem);
    item.rating += 1;
    if (item.rating == 6) { item.rating = 0; }
    rearrangeWithDisplayId(store, item.id);
  
    function clickTimerHandler() {
      serverOrRemote.updateItem(item);
      clickTimer = null;
    }
    if (clickTimer != null) { clearTimeout(clickTimer); }
    clickTimer = setTimeout(clickTimerHandler, PERSIST_AFTER_MS);
  },

  asRatingMeasurable: (item: ItemTypeMixin): RatingMeasurable => {
    if (item.itemType == ItemType.Rating) { return item as RatingMeasurable; }
    panic("not rating measurable.");
  },

  cloneMeasurableFields: (rating: RatingMeasurable): RatingMeasurable => {
    return ({
      itemType: rating.itemType,
      spatialPositionGr: rating.spatialPositionGr,
    });
  },

  debugSummary: (ratingItem: RatingItem) => {
    return "[rating] " + ratingItem.rating;
  },

  getFingerprint: (ratingItem: RatingItem): string => {
    return "" + ratingItem.rating;
  } 
};

// for click handler
const PERSIST_AFTER_MS = 1000;
let clickTimer: number | null = null;


export function isRating(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Rating;
}

export function asRatingItem(item: ItemTypeMixin): RatingItem {
  if (item.itemType == ItemType.Rating) { return item as RatingItem; }
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not a rating.`);
}
