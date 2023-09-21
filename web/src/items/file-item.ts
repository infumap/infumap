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
import { panic } from '../util/lang';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ItemType, ItemTypeMixin } from './base/item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { DataItem } from "./base/data-item";
import { TitledItem, TitledMixin } from './base/titled-item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { measureLineCount } from '../util/html';
import { DesktopStoreContextModel } from '../store/DesktopStoreProvider';
import { VisualElement } from '../layout/visual-element';
import { calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe } from './base/item-common-fns';
import { ItemFns } from './base/item-polymorphism';


export interface FileItem extends FileMeasurable, XSizableItem, AttachmentsItem, DataItem, TitledItem { }

export interface FileMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, TitledMixin { }


export const FileFns = {
  fromObject: (o: any): FileItem => {
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
    let lineCount = measureLineCount(file.title, file.spatialWidthGr / GRID_SIZE);
    return { w: file.spatialWidthGr / GRID_SIZE, h: lineCount };
  },

  calcGeometry_Spatial: (file: FileMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
    const boundsPx = {
      x: (file.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
      y: (file.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
      w: FileFns.calcSpatialDimensionsBl(file).w / containerInnerSizeBl.w * containerBoundsPx.w + ITEM_BORDER_WIDTH_PX,
      h: FileFns.calcSpatialDimensionsBl(file).h / containerInnerSizeBl.h * containerBoundsPx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return {
      boundsPx,
      hitboxes: !emitHitboxes ? [] : [
        HitboxFns.create(HitboxType.Click, innerBoundsPx),
        HitboxFns.create(HitboxType.Move, innerBoundsPx),
        HitboxFns.create(HitboxType.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
        HitboxFns.create(HitboxType.Resize, { x: boundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: boundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      ],
    }
  },

  calcGeometry_InComposite: (measurable: FileMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, topPx: number): ItemGeometry => {
    let cloned = FileFns.asFileMeasurable(ItemFns.cloneMeasurableFields(measurable));
    cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    const sizePx = FileFns.calcSpatialDimensionsBl(cloned);
    const boundsPx = {
      x: 0,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: sizePx.h * blockSizePx.h
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
      hitboxes: [
        HitboxFns.create(HitboxType.Click, innerBoundsPx),
        HitboxFns.create(HitboxType.Move, moveBoundsPx),
        HitboxFns.create(HitboxType.AttachComposite, {
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

  calcGeometry_ListItem: (_file: FileMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry => {
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

  calcGeometry_Cell: (file: FileMeasurable, cellBoundsPx: BoundingBox): ItemGeometry => {
    const boundsPx = calcBoundsInCellFromSizeBl(FileFns.calcSpatialDimensionsBl(file), cellBoundsPx);
    return ({
      boundsPx: cloneBoundingBox(boundsPx)!,
      hitboxes: [
        HitboxFns.create(HitboxType.Click, zeroBoundingBoxTopLeft(boundsPx))
      ]
    });
  },

  asFileMeasurable: (item: ItemTypeMixin): FileMeasurable => {
    if (item.itemType == ItemType.File) { return item as FileMeasurable; }
    panic();
  },

  handleClick: (visualElement: VisualElement, desktopStore: DesktopStoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, desktopStore)) { return; }
    const fileItem = asFileItem(visualElement.displayItem);
    window.open('/files/' + fileItem.id, '_blank');
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
  panic();
}
