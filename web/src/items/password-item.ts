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

import { ATTACH_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, RESIZE_BOX_SIZE_PX } from '../constants';
import { HitboxType, HitboxFns } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { EMPTY_UID, newUid, Uid } from '../util/uid';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ItemTypeMixin, ITEM_TYPE_PASSWORD } from './base/item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { VisualElement } from '../layout/visual-element';
import { DesktopStoreContextModel } from '../store/DesktopStoreProvider';
import { handleListPageLineItemClickMaybe } from './base/item-common-fns';


export interface PasswordItem extends PasswordMeasurable, XSizableItem, AttachmentsItem { }

export interface PasswordMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin {
  text: string,
}


export const PasswordFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, text: string, ordering: Uint8Array): PasswordItem => {
    if (parentId == EMPTY_UID) { panic(); }
    return {
      itemType: ITEM_TYPE_PASSWORD,
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

  fromObject: (o: any): PasswordItem => {
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

  calcGeometry_Desktop: (password: PasswordMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
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
        HitboxFns.create(HitboxType.Click, innerBoundsPx),
        HitboxFns.create(HitboxType.Move, innerBoundsPx),
        HitboxFns.create(HitboxType.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
        HitboxFns.create(HitboxType.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      ],
    }
  },

  calcGeometry_InComposite: (_measurable: PasswordMeasurable, _blockSizePx: Dimensions, _compositeWidthBl: number, _topPx: number): ItemGeometry => {
    panic();
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
        HitboxFns.create(HitboxType.Click, innerBoundsPx),
        HitboxFns.create(HitboxType.Move, innerBoundsPx)
      ]
    };
  },

  calcGeometry_Cell: (_password: PasswordMeasurable, cellBoundsPx: BoundingBox): ItemGeometry => {
    return ({
      boundsPx: cloneBoundingBox(cellBoundsPx)!,
      hitboxes: [
        HitboxFns.create(HitboxType.Click, zeroBoundingBoxTopLeft(cellBoundsPx))
      ]
    });
  },

  asPasswordMeasurable: (item: ItemTypeMixin): PasswordMeasurable => {
    if (item.itemType == ITEM_TYPE_PASSWORD) { return item as PasswordMeasurable; }
    panic();
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
  return item.itemType == ITEM_TYPE_PASSWORD;
}

export function asPasswordItem(item: ItemTypeMixin): PasswordItem {
  if (item.itemType == ITEM_TYPE_PASSWORD) { return item as PasswordItem; }
  panic();
}
