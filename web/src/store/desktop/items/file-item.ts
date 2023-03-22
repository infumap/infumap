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

import { GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, RESIZE_BOX_SIZE_PX } from '../../../constants';
import { HitboxType } from '../hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroTopLeft } from '../../../util/geometry';
import { panic } from '../../../util/lang';
import { AttachmentsItem } from './base/attachments-item';
import { Item, ItemTypeMixin, ITEM_TYPE_FILE } from './base/item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { DataItem } from "./base/data-item";
import { TitledItem, TitledMixin } from './base/titled-item';
import { ItemGeometry } from '../item-geometry';
import { Uid } from '../../../util/uid';
import { PositionalMixin } from './base/positional-item';
import { createBooleanSignal, createUidArraySignal, createVectorSignal } from '../../../util/signals';


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
    spatialPositionGr: createVectorSignal(o.spatialPositionGr),

    spatialWidthGr: o.spatialWidthGr,

    originalCreationDate: o.originalCreationDate,
    mimeType: o.mimeType,
    fileSizeBytes: o.fileSizeBytes,

    computed_attachments: createUidArraySignal([]),
    computed_mouseIsOver: createBooleanSignal(false),
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
    spatialPositionGr: f.spatialPositionGr.get(),

    spatialWidthGr: f.spatialWidthGr,

    originalCreationDate: f.originalCreationDate,
    mimeType: f.mimeType,
    fileSizeBytes: f.fileSizeBytes,
  });
}


function measureLineCount(s: string, widthBl: number): number {
  const div = document.createElement("div");
  div.setAttribute("style", `line-height: ${LINE_HEIGHT_PX}px; width: ${widthBl*LINE_HEIGHT_PX}px; overflow-wrap: break-word; padding: ${NOTE_PADDING_PX}px;`);
  const txt = document.createTextNode(s);
  div.appendChild(txt);
  document.body.appendChild(div);
  let lineCount = div.offsetHeight / LINE_HEIGHT_PX;
  document.body.removeChild(div);
  return Math.floor(lineCount);
}

export function calcFileSizeForSpatialBl(file: FileMeasurable, _getItem: (id: Uid) => (Item | null)): Dimensions {
  let lineCount = measureLineCount(file.title, file.spatialWidthGr / GRID_SIZE);
  return { w: file.spatialWidthGr / GRID_SIZE, h: lineCount };
}

export function calcGeometryOfFileItem(file: FileMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, emitHitboxes: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: (file.spatialPositionGr.get().x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (file.spatialPositionGr.get().y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcFileSizeForSpatialBl(file, getItem).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcFileSizeForSpatialBl(file, getItem).h / containerInnerSizeBl.h * containerBoundsPx.h,
  };
  return {
    boundsPx,
    hitboxes: !emitHitboxes ? [] : [
      { type: HitboxType.Click, boundsPx: zeroTopLeft(boundsPx) },
      { type: HitboxType.Move, boundsPx: zeroTopLeft(boundsPx) },
      { type: HitboxType.Resize,
        boundsPx: { x: boundsPx.w - RESIZE_BOX_SIZE_PX, y: boundsPx.h - RESIZE_BOX_SIZE_PX,
                    w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX } }
    ],
  }
}

export function calcGeometryOfFileAttachmentItem(_file: FileMeasurable, containerBoundsPx: BoundingBox, index: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
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

export function calcGeometryOfFileItemInTable(_file: FileMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: blockSizePx.w * col,
    y: blockSizePx.h * row,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  return {
    boundsPx,
    hitboxes: [
      { type: HitboxType.Click, boundsPx: zeroTopLeft(boundsPx) },
      { type: HitboxType.Move, boundsPx: zeroTopLeft(boundsPx) }
    ],
  };
}

export function calcGeometryOfFileItemInCell(_file: FileMeasurable, cellBoundsPx: BoundingBox, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  return ({
    boundsPx: cloneBoundingBox(cellBoundsPx)!,
    hitboxes: [{ type: HitboxType.Click, boundsPx: zeroTopLeft(cellBoundsPx) }]
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
