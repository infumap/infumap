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

import { ATTACH_AREA_SIZE_PX, COMPOSITE_ITEM_GAP_BL, GRID_SIZE, ITEM_BORDER_WIDTH_PX, RESIZE_BOX_SIZE_PX } from '../constants';
import { HitboxType, HitboxFns } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { EMPTY_UID, newUid, Uid } from '../util/uid';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ContainerItem } from './base/container-item';
import { Item, ItemType, ItemTypeMixin } from './base/item';
import { XSizableItem, XSizableMixin, asXSizableItem, isXSizableItem } from './base/x-sizeable-item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { itemState } from '../store/ItemState';
import { ItemFns } from './base/item-polymorphism';
import { calcBoundsInCell } from './base/item-common-fns';
import { CompositeFlags, FlagsMixin } from './base/flags-item';


export interface CompositeItem extends CompositeMeasurable, XSizableItem, ContainerItem, AttachmentsItem, Item { }

export interface CompositeMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, FlagsMixin {
  id: Uid;
  childrenLoaded: boolean;
  computed_children: Array<Uid>;
}


export const CompositeFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, ordering: Uint8Array): CompositeItem => {
    return ({
      itemType: ItemType.Composite,
      ownerId,
      id: newUid(),
      parentId,
      relationshipToParent,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      ordering,
      spatialPositionGr: { x: 0.0, y: 0.0 },
  
      spatialWidthGr: 4.0 * GRID_SIZE,
  
      flags: CompositeFlags.None,

      orderChildrenBy: "",
  
      computed_children: [],
      computed_attachments: [],
      childrenLoaded: false,
    });
  },

  fromObject: (o: any): CompositeItem => {
    // TODO: dynamic type check of o.
    return ({
      itemType: o.itemType,
      ownerId: o.ownerId,
      id: o.id,
      parentId: o.parentId ? o.parentId : null,
      relationshipToParent: o.relationshipToParent,
      creationDate: o.creationDate,
      lastModifiedDate: o.lastModifiedDate,
      ordering: new Uint8Array(o.ordering),
      spatialPositionGr: o.spatialPositionGr,
  
      spatialWidthGr: o.spatialWidthGr,
  
      flags: o.flags,

      orderChildrenBy: o.orderChildrenBy,
  
      computed_children: [],
      computed_attachments: [],
  
      childrenLoaded: false,
    });
  },

  toObject: (p: CompositeItem): object => {
    return ({
      itemType: p.itemType,
      ownerId: p.ownerId,
      id: p.id,
      parentId: p.parentId == EMPTY_UID ? null : p.parentId,
      relationshipToParent: p.relationshipToParent,
      creationDate: p.creationDate,
      lastModifiedDate: p.lastModifiedDate,
      ordering: Array.from(p.ordering),
      spatialPositionGr: p.spatialPositionGr,
  
      spatialWidthGr: p.spatialWidthGr,
  
      flags: p.flags,

      orderChildrenBy: p.orderChildrenBy,
    });
  },

  calcSpatialDimensionsBl: (composite: CompositeMeasurable): Dimensions => {
    let bh = 0.0;
    for (let childId of composite.computed_children) {
      let item = itemState.get(childId)!;
      if (!item) { continue; }
      let cloned = ItemFns.cloneMeasurableFields(item);
      // TODO (HIGH): different items will be sized differently in composite items.
      // Tables: allow to be sized arbitrarily, but will be scaled.
      // Notes: will be sized to width of composite.
      // For now, just consider x sizable items, and only in a basic way. assume note or file.
      if (isXSizableItem(cloned)) {
        asXSizableItem(cloned).spatialWidthGr = composite.spatialWidthGr;
      }
      const sizeBl = ItemFns.calcSpatialDimensionsBl(cloned);
      bh += sizeBl.h + COMPOSITE_ITEM_GAP_BL;
    }
    bh -= COMPOSITE_ITEM_GAP_BL;
    bh = Math.ceil(bh*2)/2;
    return { w: composite.spatialWidthGr / GRID_SIZE, h: bh < 0.5 ? 0.5 : bh };
  },

  calcGeometry_Spatial: (composite: CompositeMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
    const boundsPx = {
      x: (composite.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
      y: (composite.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
      w: CompositeFns.calcSpatialDimensionsBl(composite).w / containerInnerSizeBl.w * containerBoundsPx.w + ITEM_BORDER_WIDTH_PX,
      h: CompositeFns.calcSpatialDimensionsBl(composite).h / containerInnerSizeBl.h * containerBoundsPx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return ({
      boundsPx,
      hitboxes: !emitHitboxes ? [] : [
        HitboxFns.create(HitboxType.Move, innerBoundsPx),
        HitboxFns.create(HitboxType.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
        HitboxFns.create(HitboxType.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
      ],
    });
  },

  calcGeometry_Attachment: (composite: CompositeMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(composite, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_composite: CompositeMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry => {
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
    const clickAreaBoundsPx = {
      x: blockSizePx.w,
      y: 0.0,
      w: blockSizePx.w * (widthBl - 1),
      h: blockSizePx.h
    };
    return ({
      boundsPx,
      hitboxes: [
        HitboxFns.create(HitboxType.Click, clickAreaBoundsPx),
        HitboxFns.create(HitboxType.Move, innerBoundsPx)
      ]
    });
  },

  calcGeometry_Cell: (composite: CompositeMeasurable, cellBoundsPx: BoundingBox): ItemGeometry => {
    const sizeBl = CompositeFns.calcSpatialDimensionsBl(composite);
    const boundsPx = calcBoundsInCell(sizeBl, cellBoundsPx);
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return ({
      boundsPx: cloneBoundingBox(boundsPx)!,
      hitboxes: [
        HitboxFns.create(HitboxType.Click, innerBoundsPx),
      ]
    });
  },

  asCompositeMeasurable: (item: ItemTypeMixin): CompositeMeasurable => {
    if (item.itemType == ItemType.Composite) { return item as CompositeMeasurable; }
    panic();
  },

  cloneMeasurableFields: (composite: CompositeMeasurable): CompositeMeasurable => {
    return ({
      itemType: composite.itemType,
      id: composite.id,
      spatialPositionGr: composite.spatialPositionGr,
      spatialWidthGr: composite.spatialWidthGr,
      childrenLoaded: composite.childrenLoaded,
      computed_children: composite.computed_children,
      flags: composite.flags,
    });
  },

  debugSummary: (_compositeItem: CompositeItem) => {
    return "[composite] ...";
  },

  getFingerprint: (compositeItem: CompositeItem): string => {
    return "~~~!@#~~~" + compositeItem.flags + "@#$" + compositeItem.computed_children.length;
  }  
};


export function isComposite(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Composite;
}

export function asCompositeItem(item: ItemTypeMixin): CompositeItem {
  if (item.itemType == ItemType.Composite) { return item as CompositeItem; }
  panic();
}
