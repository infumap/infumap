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

import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, RESIZE_BOX_SIZE_PX } from '../constants';
import { HitboxFlags, HitboxFns } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { EMPTY_UID, newUid, Uid } from '../util/uid';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ItemType, ItemTypeMixin } from './base/item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { VisualElement } from '../layout/visual-element';
import { DesktopStoreContextModel } from '../store/DesktopStoreProvider';
import { calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe } from './base/item-common-fns';
import { ItemFns } from './base/item-polymorphism';


export interface PasswordItem extends PasswordMeasurable, XSizableItem, AttachmentsItem { }

export interface PasswordMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin {
  text: string,
}


export const PasswordFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, text: string, ordering: Uint8Array): PasswordItem => {
    if (parentId == EMPTY_UID) { panic("PasswordFns.create: parentId is empty."); }
    return {
      origin: null,
      itemType: ItemType.Password,
      ownerId,
      id: newUid(),
      parentId,
      relationshipToParent,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      ordering,
      spatialPositionGr: { x: 0.0, y: 0.0 },
  
      spatialWidthGr: 10.0 * GRID_SIZE,
  
      text,
  
      computed_attachments: [],
    };
  },

  fromObject: (o: any, origin: string | null): PasswordItem => {
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
  
      text: o.text,
  
      computed_attachments: [],
    });
  },

  toObject: (p: PasswordItem): object => {
    return ({
      itemType: p.itemType,
      ownerId: p.ownerId,
      id: p.id,
      parentId: p.parentId,
      relationshipToParent: p.relationshipToParent,
      creationDate: p.creationDate,
      lastModifiedDate: p.lastModifiedDate,
      ordering: Array.from(p.ordering),
      spatialPositionGr: p.spatialPositionGr,
  
      spatialWidthGr: p.spatialWidthGr,
  
      text: p.text,
    });
  },

  calcSpatialDimensionsBl: (password: PasswordMeasurable): Dimensions => {
    return ({ w: password.spatialWidthGr / GRID_SIZE, h: 1 });
  },

  calcGeometry_Spatial: (password: PasswordMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
    const boundsPx = {
      x: (password.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
      y: (password.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
      w: PasswordFns.calcSpatialDimensionsBl(password).w / containerInnerSizeBl.w * containerBoundsPx.w + ITEM_BORDER_WIDTH_PX,
      h: PasswordFns.calcSpatialDimensionsBl(password).h / containerInnerSizeBl.h * containerBoundsPx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return {
      boundsPx,
      hitboxes: !emitHitboxes ? [] : [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      ],
    }
  },

  calcGeometry_InComposite: (measurable: PasswordMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, topPx: number): ItemGeometry => {
    let cloned = PasswordFns.asPasswordMeasurable(ItemFns.cloneMeasurableFields(measurable));
    cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    const sizeBl = PasswordFns.calcSpatialDimensionsBl(cloned);
    const boundsPx = {
      x: 0,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: sizeBl.h * blockSizePx.h
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

  calcGeometry_Attachment: (password: PasswordMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(password, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_password: PasswordMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry => {
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
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
      ]
    };
  },

  calcGeometry_Cell: (password: PasswordMeasurable, cellBoundsPx: BoundingBox): ItemGeometry => {
    const boundsPx = calcBoundsInCellFromSizeBl(PasswordFns.calcSpatialDimensionsBl(password), cellBoundsPx);
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return ({
      boundsPx: cloneBoundingBox(cellBoundsPx)!,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
      ]
    });
  },

  asPasswordMeasurable: (item: ItemTypeMixin): PasswordMeasurable => {
    if (item.itemType == ItemType.Password) { return item as PasswordMeasurable; }
    panic("not password measurable.");
  },

  cloneMeasurableFields: (password: PasswordMeasurable): PasswordMeasurable => {
    return ({
      itemType: password.itemType,
      spatialPositionGr: password.spatialPositionGr,
      spatialWidthGr: password.spatialWidthGr,
      text: password.text,
    });
  },

  debugSummary: (passwordItem: PasswordItem) => {
    return "[password] ******";
  },

  getFingerprint: (passwordItem: PasswordItem): string => {
    return passwordItem.text;
  },

  handleClick: (visualElement: VisualElement, desktopStore: DesktopStoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, desktopStore)) { return; }
  }
};


export function isPassword(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Password;
}

export function asPasswordItem(item: ItemTypeMixin): PasswordItem {
  if (item.itemType == ItemType.Password) { return item as PasswordItem; }
  panic("not password item.");
}
