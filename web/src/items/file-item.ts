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

import { ATTACH_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LIST_PAGE_TOP_PADDING_PX, RESIZE_BOX_SIZE_PX } from '../constants';
import { HitboxFlags, HitboxFns } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../util/geometry';
import { panic } from '../util/lang';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ItemType, ItemTypeMixin } from './base/item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { DataItem } from "./base/data-item";
import { TitledItem, TitledMixin } from './base/titled-item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { StoreContextModel } from '../store/StoreProvider';
import { VisualElement } from '../layout/visual-element';
import { calcBoundsInCell, calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe } from './base/item-common-fns';
import { ItemFns } from './base/item-polymorphism';
import { measureLineCount } from '../layout/text';
import { NoteFlags } from './base/flags-item';


export interface FileItem extends FileMeasurable, XSizableItem, AttachmentsItem, DataItem, TitledItem { }

export interface FileMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, TitledMixin { }


export const FileFns = {
  fromObject: (o: any, origin: string | null): FileItem => {
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
      title: o.title,
      spatialPositionGr: o.spatialPositionGr,

      spatialWidthGr: o.spatialWidthGr,

      originalCreationDate: o.originalCreationDate,
      mimeType: o.mimeType,
      fileSizeBytes: o.fileSizeBytes,

      computed_attachments: [],
    });
  },

  toObject: (f: FileItem): object => {
    return ({
      itemType: f.itemType,
      ownerId: f.ownerId,
      id: f.id,
      parentId: f.parentId,
      relationshipToParent: f.relationshipToParent,
      creationDate: f.creationDate,
      lastModifiedDate: f.lastModifiedDate,
      ordering: Array.from(f.ordering),
      title: f.title,
      spatialPositionGr: f.spatialPositionGr,

      spatialWidthGr: f.spatialWidthGr,

      originalCreationDate: f.originalCreationDate,
      mimeType: f.mimeType,
      fileSizeBytes: f.fileSizeBytes,
    });
  },

  calcSpatialDimensionsBl: (file: FileMeasurable): Dimensions => {
    let lineCount = measureLineCount(file.title, file.spatialWidthGr / GRID_SIZE, NoteFlags.None);
    return { w: file.spatialWidthGr / GRID_SIZE, h: lineCount };
  },

  calcGeometry_Spatial: (file: FileMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
    const sizeBl = FileFns.calcSpatialDimensionsBl(file);
    const blockSizePx = {
      w: containerBoundsPx.w / containerInnerSizeBl.w,
      h: containerBoundsPx.h / containerInnerSizeBl.h
    };
    const boundsPx = {
      x: (file.spatialPositionGr.x / GRID_SIZE) * blockSizePx.w + containerBoundsPx.x,
      y: (file.spatialPositionGr.y / GRID_SIZE) * blockSizePx.h + containerBoundsPx.y,
      w: sizeBl.w * blockSizePx.w + ITEM_BORDER_WIDTH_PX,
      h: sizeBl.h * blockSizePx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: !emitHitboxes ? [] : [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
        HitboxFns.create(HitboxFlags.Resize, { x: boundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: boundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      ],
    }
  },

  calcGeometry_InComposite: (measurable: FileMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    let cloned = FileFns.asFileMeasurable(ItemFns.cloneMeasurableFields(measurable));
    cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    const sizeBl = FileFns.calcSpatialDimensionsBl(cloned);
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: sizeBl.h * blockSizePx.h
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    let moveWidthPx = 10;
    if (innerBoundsPx.w < 10) {
      // TODO (MEDIUM): something sensible.
      moveWidthPx = 1;
    }
    const moveBoundsPx = {
      x: innerBoundsPx.w - moveWidthPx,
      y: innerBoundsPx.y,
      w: moveWidthPx,
      h: innerBoundsPx.h
    };
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
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

  calcGeometry_Attachment: (file: FileMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(file, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_file: FileMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean): ItemGeometry => {
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
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx)
      ]
    };
  },

  calcGeometry_InCell: (file: FileMeasurable, cellBoundsPx: BoundingBox, maximize: boolean): ItemGeometry => {
    const sizeBl = FileFns.calcSpatialDimensionsBl(file);
    const boundsPx = maximize ? calcBoundsInCell(sizeBl, cellBoundsPx) : calcBoundsInCellFromSizeBl(sizeBl, cellBoundsPx);
    const blockSizePx = {
      w: boundsPx.w / sizeBl.w,
      h: boundsPx.h / sizeBl.h,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return ({
      boundsPx: cloneBoundingBox(boundsPx)!,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx)
      ]
    });
  },

  asFileMeasurable: (item: ItemTypeMixin): FileMeasurable => {
    if (item.itemType == ItemType.File) { return item as FileMeasurable; }
    panic("not file measurable.");
  },

  handleLinkClick: (visualElement: VisualElement): void => {
    const fileItem = asFileItem(visualElement.displayItem);
    window.open('/files/' + fileItem.id, '_blank');
  },

  handleClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
  },

  cloneMeasurableFields: (file: FileMeasurable): FileMeasurable => {
    return ({
      itemType: file.itemType,
      spatialPositionGr: file.spatialPositionGr,
      spatialWidthGr: file.spatialWidthGr,
      title: file.title,
    });
  },

  debugSummary: (fileItem: FileItem) => {
    return "[file] " + fileItem.title;
  },

  getFingerprint: (fileItem: FileItem): string => {
    return fileItem.title;
  }  
};


export function isFile(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.File;
}

export function asFileItem(item: ItemTypeMixin): FileItem {
  if (item.itemType == ItemType.File) { return item as FileItem; }
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not a file.`);
}
