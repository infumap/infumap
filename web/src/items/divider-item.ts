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

import { COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX, RESIZE_BOX_SIZE_PX } from "../constants";
import { HitboxFlags, HitboxFns } from "../layout/hitbox";
import { ItemGeometry } from "../layout/item-geometry";
import { VisualElement, VeFns } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from "../util/geometry";
import { currentUnixTimeSeconds, panic } from "../util/lang";
import { EMPTY_UID, Uid, newUid } from "../util/uid";
import { calcGeometryOfAttachmentItemImpl } from "./base/attachments-item";
import { normalizeItemCapabilities } from "./base/capabilities-item";
import { calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe } from "./base/item-common-fns";
import { Item, ItemType, ItemTypeMixin } from "./base/item";
import { PositionalMixin } from "./base/positional-item";
import { XSizableMixin } from "./base/x-sizeable-item";
import { YSizableMixin } from "./base/y-sizeable-item";


export type DividerDirection = "horizontal" | "vertical";

const DEFAULT_WIDTH_GR = GRID_SIZE * 4;
const DEFAULT_HEIGHT_GR = GRID_SIZE;

export interface DividerItem extends DividerMeasurable, Item { }
export interface DividerMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, YSizableMixin {
  dividerDirection: DividerDirection,
}

export const DividerFns = {
  create: (
    ownerId: Uid,
    parentId: Uid,
    relationshipToParent: string,
    ordering: Uint8Array,
    dividerDirection: DividerDirection = "horizontal",
  ): DividerItem => {
    if (parentId == EMPTY_UID) { panic("DividerFns.create: parent is empty."); }
    return {
      origin: null,
      itemType: ItemType.Divider,
      ownerId,
      id: newUid(),
      parentId,
      relationshipToParent,
      groupId: null,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      dateTime: currentUnixTimeSeconds(),
      endDateTime: null,
      ordering,
      spatialPositionGr: { x: 0.0, y: 0.0 },
      spatialWidthGr: DEFAULT_WIDTH_GR,
      spatialHeightGr: DEFAULT_HEIGHT_GR,
      dividerDirection,
    };
  },

  fromObject: (o: any, origin: string | null): DividerItem => {
    const dividerDirection = o.dividerDirection == "vertical" ? "vertical" : "horizontal";
    return ({
      origin,
      capabilities: normalizeItemCapabilities(o.capabilities),
      itemType: o.itemType,
      ownerId: o.ownerId,
      id: o.id,
      parentId: o.parentId,
      relationshipToParent: o.relationshipToParent,
      groupId: o.groupId ?? null,
      creationDate: o.creationDate,
      lastModifiedDate: o.lastModifiedDate,
      dateTime: o.dateTime,
      endDateTime: o.endDateTime ?? null,
      ordering: new Uint8Array(o.ordering),
      spatialPositionGr: o.spatialPositionGr ?? { x: 0.0, y: 0.0 },
      spatialWidthGr: typeof o.spatialWidthGr == "number" ? o.spatialWidthGr : DEFAULT_WIDTH_GR,
      spatialHeightGr: typeof o.spatialHeightGr == "number" ? o.spatialHeightGr : DEFAULT_HEIGHT_GR,
      dividerDirection,
    });
  },

  toObject: (divider: DividerItem): object => {
    return ({
      itemType: divider.itemType,
      ownerId: divider.ownerId,
      id: divider.id,
      parentId: divider.parentId,
      relationshipToParent: divider.relationshipToParent,
      groupId: divider.groupId,
      creationDate: divider.creationDate,
      lastModifiedDate: divider.lastModifiedDate,
      dateTime: divider.dateTime,
      endDateTime: divider.endDateTime,
      ordering: Array.from(divider.ordering),
      spatialPositionGr: divider.spatialPositionGr,
      spatialWidthGr: divider.spatialWidthGr,
      spatialHeightGr: divider.spatialHeightGr,
      dividerDirection: divider.dividerDirection,
    });
  },

  calcSpatialDimensionsBl: (divider: DividerMeasurable): Dimensions => {
    return {
      w: Math.max(1, divider.spatialWidthGr / GRID_SIZE),
      h: Math.max(1, divider.spatialHeightGr / GRID_SIZE),
    };
  },

  calcGeometry_Spatial: (
    divider: DividerMeasurable,
    containerBoundsPx: BoundingBox,
    containerInnerSizeBl: Dimensions,
    _parentIsPopup: boolean,
    emitHitboxes: boolean,
  ): ItemGeometry => {
    const sizeBl = DividerFns.calcSpatialDimensionsBl(divider);
    const blockSizePx = {
      w: containerBoundsPx.w / containerInnerSizeBl.w,
      h: containerBoundsPx.h / containerInnerSizeBl.h,
    };
    const boundsPx = {
      x: (divider.spatialPositionGr.x / GRID_SIZE) * blockSizePx.w + containerBoundsPx.x,
      y: (divider.spatialPositionGr.y / GRID_SIZE) * blockSizePx.h + containerBoundsPx.y,
      w: sizeBl.w * blockSizePx.w + ITEM_BORDER_WIDTH_PX,
      h: sizeBl.h * blockSizePx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const hitboxes = emitHitboxes
      ? [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Resize, {
          x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX,
          y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX,
          w: RESIZE_BOX_SIZE_PX,
          h: RESIZE_BOX_SIZE_PX,
        }),
      ]
      : [];
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes,
    };
  },

  calcGeometry_InComposite: (
    measurable: DividerMeasurable,
    blockSizePx: Dimensions,
    compositeWidthBl: number,
    leftMarginBl: number,
    topPx: number,
  ): ItemGeometry => {
    const heightBl = Math.max(1, measurable.spatialHeightGr / GRID_SIZE);
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: heightBl * blockSizePx.h,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveAreaBoundsPx = {
      x: innerBoundsPx.w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    };
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move | HitboxFlags.ShowPointer, moveAreaBoundsPx, { compositeMoveOut: true }),
        HitboxFns.create(HitboxFlags.Resize, {
          x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX,
          y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX,
          w: RESIZE_BOX_SIZE_PX,
          h: RESIZE_BOX_SIZE_PX,
        }),
      ],
    };
  },

  calcGeometry_Attachment: (
    divider: DividerMeasurable,
    parentBoundsPx: BoundingBox,
    parentInnerSizeBl: Dimensions,
    index: number,
    isSelected: boolean,
  ): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(divider, parentBoundsPx, parentInnerSizeBl, index, isSelected, false);
  },

  calcGeometry_ListItem: (
    _divider: DividerMeasurable,
    blockSizePx: Dimensions,
    row: number,
    col: number,
    widthBl: number,
    padTop: boolean,
    _expandable: boolean,
  ): ItemGeometry => {
    const innerBoundsPx = {
      x: 0.0,
      y: 0.0,
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h,
    };
    const boundsPx = {
      x: blockSizePx.w * col,
      y: blockSizePx.h * row + (padTop ? LIST_PAGE_TOP_PADDING_PX : 0),
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h,
    };
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
      ],
    };
  },

  calcGeometry_InCell: (divider: DividerMeasurable, cellBoundsPx: BoundingBox, parentIsDock: boolean): ItemGeometry => {
    const sizeBl = DividerFns.calcSpatialDimensionsBl(divider);
    const boundsPx = calcBoundsInCellFromSizeBl(sizeBl, cellBoundsPx);
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const hitboxes = [
      HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
    ];
    if (parentIsDock) {
      hitboxes.push(HitboxFns.create(HitboxFlags.Resize, {
        x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX,
        y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX,
        w: RESIZE_BOX_SIZE_PX,
        h: RESIZE_BOX_SIZE_PX,
      }));
    }
    return {
      boundsPx: cloneBoundingBox(boundsPx)!,
      viewportBoundsPx: null,
      blockSizePx: {
        w: boundsPx.w / sizeBl.w,
        h: boundsPx.h / sizeBl.h,
      },
      hitboxes,
    };
  },

  handleClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    store.history.setFocus(VeFns.veToPath(visualElement));
  },

  cloneMeasurableFields: (divider: DividerMeasurable): DividerMeasurable => {
    return {
      itemType: divider.itemType,
      spatialPositionGr: { ...divider.spatialPositionGr },
      spatialWidthGr: divider.spatialWidthGr,
      spatialHeightGr: divider.spatialHeightGr,
      dividerDirection: divider.dividerDirection,
    };
  },

  getFingerprint: (divider: DividerItem): string => {
    return divider.dividerDirection;
  },

  asDividerMeasurable: (item: ItemTypeMixin): DividerMeasurable => {
    if (item.itemType == ItemType.Divider) { return item as DividerMeasurable; }
    panic(`item is a '${item.itemType}', not a divider.`);
  },

  debugSummary: (divider: DividerItem): string => {
    return `[divider] ${divider.dividerDirection}`;
  },
};

export function isDivider(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Divider;
}

export function asDividerItem(item: ItemTypeMixin): DividerItem {
  if (item.itemType == ItemType.Divider) { return item as DividerItem; }
  panic(`item is a '${item.itemType}', not a divider.`);
}
