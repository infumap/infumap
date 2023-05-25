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

import { GRID_SIZE, RESIZE_BOX_SIZE_PX } from '../../../constants';
import { HitboxType } from '../hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../../../util/geometry';
import { panic } from '../../../util/lang';
import { AttachmentsItem } from './base/attachments-item';
import { ItemTypeMixin, ITEM_TYPE_FILE } from './base/item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { DataItem } from "./base/data-item";
import { TitledItem, TitledMixin } from './base/titled-item';
import { ItemGeometry } from '../item-geometry';
import { PositionalMixin } from './base/positional-item';
import { createUidArraySignal } from '../../../util/signals';
import { measureLineCount } from '../../../util/html';


export interface FileItem extends FileMeasurable, XSizableItem, AttachmentsItem, DataItem, TitledItem { }

export interface FileMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, TitledMixin { }


export function fileFromObject(o: any): FileItem {
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

    computed_attachments: createUidArraySignal([]),
  });
}

export function fileToObject(f: FileItem): object {
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
}

export function calcFileSizeForSpatialBl(file: FileMeasurable): Dimensions {
  let lineCount = measureLineCount(file.title, file.spatialWidthGr / GRID_SIZE);
  return { w: file.spatialWidthGr / GRID_SIZE, h: lineCount };
}

export function calcGeometryOfFileItem(file: FileMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, emitHitboxes: boolean): ItemGeometry {
  const innerBoundsPx = {
    x: 0.0,
    y: 0.0,
    w: calcFileSizeForSpatialBl(file).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcFileSizeForSpatialBl(file).h / containerInnerSizeBl.h * containerBoundsPx.h,
  };
  const boundsPx = {
    x: (file.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (file.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcFileSizeForSpatialBl(file).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcFileSizeForSpatialBl(file).h / containerInnerSizeBl.h * containerBoundsPx.h,
  };
  return {
    boundsPx,
    hitboxes: !emitHitboxes ? [] : [
      { type: HitboxType.Click, boundsPx: innerBoundsPx },
      { type: HitboxType.Move, boundsPx: innerBoundsPx },
      { type: HitboxType.Resize,
        boundsPx: { x: boundsPx.w - RESIZE_BOX_SIZE_PX, y: boundsPx.h - RESIZE_BOX_SIZE_PX,
                    w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX } }
    ],
  }
}

export function calcGeometryOfFileAttachmentItem(_file: FileMeasurable, containerBoundsPx: BoundingBox, index: number): ItemGeometry {
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

export function calcGeometryOfFileItemInTable(_file: FileMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
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
      { type: HitboxType.Click, boundsPx: innerBoundsPx },
      { type: HitboxType.Move, boundsPx: innerBoundsPx }
    ],
  };
}

export function calcGeometryOfFileItemInCell(_file: FileMeasurable, cellBoundsPx: BoundingBox): ItemGeometry {
  return ({
    boundsPx: cloneBoundingBox(cellBoundsPx)!,
    hitboxes: [{ type: HitboxType.Click, boundsPx: zeroBoundingBoxTopLeft(cellBoundsPx) }]
  });
}

export function isFile(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ITEM_TYPE_FILE;
}

export function asFileItem(item: ItemTypeMixin): FileItem {
  if (item.itemType == ITEM_TYPE_FILE) { return item as FileItem; }
  panic();
}

export function asFileMeasurable(item: ItemTypeMixin): FileMeasurable {
  if (item.itemType == ITEM_TYPE_FILE) { return item as FileMeasurable; }
  panic();
}

export function handleFileClick(fileItem: FileItem): void {
  window.open('/files/' + fileItem.id, '_blank');
}

export function cloneFileMeasurableFields(file: FileMeasurable): FileMeasurable {
  return ({
    itemType: file.itemType,
    spatialPositionGr: file.spatialPositionGr,
    spatialWidthGr: file.spatialWidthGr,
    title: file.title,
  });
}
