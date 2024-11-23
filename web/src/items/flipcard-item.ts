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

import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, FLIPCARD_TITLE_HEADER_HEIGHT_BL, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX, RESIZE_BOX_SIZE_PX } from "../constants";
import { HitboxFlags, HitboxFns } from "../layout/hitbox";
import { ItemGeometry } from "../layout/item-geometry";
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from "../util/geometry";
import { currentUnixTimeSeconds, panic } from "../util/lang";
import { EMPTY_UID, newUid, Uid } from "../util/uid";
import { AspectMixin } from "./base/aspect-item";
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from "./base/attachments-item";
import { ColorableItem } from "./base/colorable-item";
import { ContainerItem } from "./base/container-item";
import { ItemType, ItemTypeMixin } from "./base/item";
import { calcBoundsInCell, calcBoundsInCellFromSizeBl } from "./base/item-common-fns";
import { ItemFns } from "./base/item-polymorphism";
import { PositionalMixin } from "./base/positional-item";
import { XSizableItem, XSizableMixin } from "./base/x-sizeable-item";


export interface FlipCardItem extends FlipCardMeasurable, XSizableItem, ContainerItem, AttachmentsItem, ColorableItem {
  scale: number;
}

export interface FlipCardMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, AspectMixin {
  id: Uid;
  childrenLoaded: boolean;
  computed_children: Array<Uid>;
}


export const FlipCardFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, ordering: Uint8Array): FlipCardItem => {
    if (parentId == EMPTY_UID) { panic("FlipCardFns.create: parentId is empty."); }
    return {
      origin: null,
      itemType: ItemType.FlipCard,
      ownerId,
      id: newUid(),
      parentId,
      relationshipToParent,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      ordering,
      spatialPositionGr: { x: 0.0, y: 0.0 },

      spatialWidthGr: 10.0 * GRID_SIZE,

      naturalAspect: 2.0,
      backgroundColorIndex: 0,

      orderChildrenBy: "",

      scale: 1.0,
      computed_children: [],
      computed_attachments: [],
      childrenLoaded: false,
    };
  },

  fromObject: (o: any, origin: string | null): FlipCardItem => {
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

      spatialWidthGr: o.spatialWidthGr,

      naturalAspect: o.naturalAspect,
      backgroundColorIndex: o.backgroundColorIndex,

      orderChildrenBy: o.orderChildrenBy,

      scale: o.scale,

      computed_children: [],
      computed_attachments: [],
      childrenLoaded: false,
    });
  },

  toObject: (fc: FlipCardItem): object => {
    return ({
      itemType: fc.itemType,
      ownerId: fc.ownerId,
      id: fc.id,
      parentId: fc.parentId,
      relationshipToParent: fc.relationshipToParent,
      creationDate: fc.creationDate,
      lastModifiedDate: fc.lastModifiedDate,
      ordering: Array.from(fc.ordering),
      spatialPositionGr: fc.spatialPositionGr,

      spatialWidthGr: fc.spatialWidthGr,

      orderChildrenBy: fc.orderChildrenBy,

      naturalAspect: fc.naturalAspect,
      backgroundColorIndex: fc.backgroundColorIndex,

      scale: fc.scale,
    });
  },

  calcGeometry_Spatial: (
      page: FlipCardMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions,
      _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {

    const sizeBl = FlipCardFns.calcSpatialDimensionsBl(page);
    const blockSizePx = {
      w: containerBoundsPx.w / containerInnerSizeBl.w,
      h: containerBoundsPx.h / containerInnerSizeBl.h
    };
    const boundsPx = {
      x: (page.spatialPositionGr.x / GRID_SIZE) * blockSizePx.w + containerBoundsPx.x,
      y: (page.spatialPositionGr.y / GRID_SIZE) * blockSizePx.h + containerBoundsPx.y,
      w: sizeBl.w * blockSizePx.w + ITEM_BORDER_WIDTH_PX,
      h: sizeBl.h * blockSizePx.h + ITEM_BORDER_WIDTH_PX,
    };

    let headerHeightBl = FLIPCARD_TITLE_HEADER_HEIGHT_BL;
    let viewportBoundsPx = cloneBoundingBox(boundsPx)!;
    boundsPx.h = boundsPx.h + headerHeightBl * blockSizePx.h;
    viewportBoundsPx.y = viewportBoundsPx.y + headerHeightBl * blockSizePx.h;

    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);

    return ({
      boundsPx,
      blockSizePx,
      viewportBoundsPx,
      hitboxes: !emitHitboxes ? [] : [
        HitboxFns.create(HitboxFlags.Move, { x: 0, y: 0, h: blockSizePx.h * headerHeightBl, w: innerBoundsPx.w }),
        HitboxFns.create(HitboxFlags.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
        HitboxFns.create(HitboxFlags.Flip, { x: innerBoundsPx.w - blockSizePx.w, y: 0.0, h: blockSizePx.h, w: blockSizePx.w }),
        HitboxFns.create(HitboxFlags.TimedFlip, { x: innerBoundsPx.w - blockSizePx.w * 2, y: 0.0, h: blockSizePx.h, w: blockSizePx.w })
      ],
    });
  },

  calcGeometry_Attachment: (page: FlipCardMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(page, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_flipcard: FlipCardMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean, _expandable: boolean): ItemGeometry => {
    const scale = blockSizePx.h / LINE_HEIGHT_PX;
    const innerBoundsPx = {
      x: 0.0,
      y: 0.0,
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const boundsPx = {
      x: blockSizePx.w * col,
      y: blockSizePx.h * row + (padTop ? LIST_PAGE_TOP_PADDING_PX * scale : 0),
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
      ]
    };
  },

  calcGeometry_InCell: (password: FlipCardMeasurable, cellBoundsPx: BoundingBox, maximize: boolean): ItemGeometry => {
    const sizeBl = FlipCardFns.calcSpatialDimensionsBl(password);
    const boundsPx = maximize ? calcBoundsInCell(sizeBl, cellBoundsPx) : calcBoundsInCellFromSizeBl(sizeBl, cellBoundsPx);
    const blockSizePx = {
      w: boundsPx.w / sizeBl.w,
      h: boundsPx.h / sizeBl.h,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return ({
      boundsPx: cloneBoundingBox(boundsPx)!,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        // HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        // HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      ]
    });
  },

  calcGeometry_InComposite: (measurable: FlipCardMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    let cloned = FlipCardFns.asFlipCardMeasurable(ItemFns.cloneMeasurableFields(measurable));
    cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    const sizeBl = FlipCardFns.calcSpatialDimensionsBl(cloned);
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: sizeBl.h * blockSizePx.h
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveBoundsPx = {
      x: innerBoundsPx.w
          - COMPOSITE_MOVE_OUT_AREA_SIZE_PX
          - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
          - CONTAINER_IN_COMPOSITE_PADDING_PX
          - COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
    };
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        // HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        // HitboxFns.create(HitboxFlags.Move, moveBoundsPx),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: innerBoundsPx.w / 4,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w / 2,
          h: ATTACH_AREA_SIZE_PX,
        }),
      ]
    };
  },

  cloneMeasurableFields: (flipcard: FlipCardMeasurable): FlipCardMeasurable => {
    return ({
      itemType: flipcard.itemType,
      id: flipcard.id,
      spatialPositionGr: flipcard.spatialPositionGr,
      spatialWidthGr: flipcard.spatialWidthGr,
      naturalAspect: flipcard.naturalAspect,
      childrenLoaded: flipcard.childrenLoaded,
      computed_children: flipcard.computed_children,
    });
  },

  debugSummary: (_flipcardItem: FlipCardItem) => {
    return "[flipcard] ";
  },

  getFingerprint: (pageItem: FlipCardItem): string => {
    return pageItem.backgroundColorIndex + "~~~!@#~~~";
  },

  calcSpatialDimensionsBl: (flipcard: FlipCardMeasurable): Dimensions => {
    let bh = Math.round(flipcard.spatialWidthGr / GRID_SIZE / flipcard.naturalAspect * 2.0) / 2.0;
    const result = { w: flipcard.spatialWidthGr / GRID_SIZE, h: bh < 0.5 ? 0.5 : bh };
    return result;
  },

  calcInnerSpatialDimensionsBl: (flipCard: FlipCardMeasurable): Dimensions => {
    return ({
      w: flipCard.spatialWidthGr / GRID_SIZE,
      h: Math.floor(flipCard.spatialWidthGr / GRID_SIZE / flipCard.naturalAspect)
    });
  },

  asFlipCardMeasurable: (item: ItemTypeMixin): FlipCardMeasurable => {
    if (item.itemType == ItemType.FlipCard) { return item as FlipCardMeasurable; }
    panic("not flip card measurable.");
  },

}


export function isFlipCard(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.FlipCard;
}

export function asFlipCardItem(item: ItemTypeMixin): FlipCardItem {
  if (item.itemType == ItemType.FlipCard) { return item as FlipCardItem; }
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not a flip card.`);
}
