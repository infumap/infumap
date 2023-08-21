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
import { HitboxType, createHitbox } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../util/geometry';
import { panic } from '../util/lang';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ItemTypeMixin, ITEM_TYPE_FILE, calcBoundsInCellFromSizeBl } from './base/item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { DataItem } from "./base/data-item";
import { TitledItem, TitledMixin } from './base/titled-item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { measureLineCount } from '../util/html';
import { DesktopStoreContextModel } from '../store/DesktopStoreProvider';
import { VisualElement } from '../layout/visual-element';
import { handleListLineItemClickMaybe } from './base/item-common';


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

    computed_attachments: [],
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

export function calcGeometryOfFileItem_Desktop(file: FileMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry {
  const boundsPx = {
    x: (file.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (file.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcFileSizeForSpatialBl(file).w / containerInnerSizeBl.w * containerBoundsPx.w + ITEM_BORDER_WIDTH_PX,
    h: calcFileSizeForSpatialBl(file).h / containerInnerSizeBl.h * containerBoundsPx.h + ITEM_BORDER_WIDTH_PX,
  };
  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  return {
    boundsPx,
    hitboxes: !emitHitboxes ? [] : [
      createHitbox(HitboxType.Click, innerBoundsPx),
      createHitbox(HitboxType.Move, innerBoundsPx),
      createHitbox(HitboxType.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
      createHitbox(HitboxType.Resize, { x: boundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: boundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
    ],
  }
}

export function calcGeometryOfFileItem_Attachment(file: FileMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry {
  return calcGeometryOfAttachmentItemImpl(file, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
}

export function calcGeometryOfFileItem_ListItem(_file: FileMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
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
      createHitbox(HitboxType.Click, innerBoundsPx),
      createHitbox(HitboxType.Move, innerBoundsPx)
    ]
  };
}

export function calcGeometryOfFileItem_Cell(file: FileMeasurable, cellBoundsPx: BoundingBox): ItemGeometry {
  const boundsPx = calcBoundsInCellFromSizeBl(calcFileSizeForSpatialBl(file), cellBoundsPx);
  return ({
    boundsPx: cloneBoundingBox(boundsPx)!,
    hitboxes: [
      createHitbox(HitboxType.Click, zeroBoundingBoxTopLeft(boundsPx))
    ]
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

export function handleFileClick(visualElement: VisualElement, desktopStore: DesktopStoreContextModel): void {
  if (handleListLineItemClickMaybe(visualElement, desktopStore)) { return; }
  const fileItem = asFileItem(visualElement.displayItem);
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

export function fileDebugSummary(fileItem: FileItem) {
  return "[file] " + fileItem.title;
}

export function getFileItemMightBeDirty(fileItem: FileItem): string {
  return fileItem.title;
}
