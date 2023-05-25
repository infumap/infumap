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

import { GRID_SIZE, RESIZE_BOX_SIZE_PX } from "../../../constants";
import { HitboxType } from "../hitbox";
import { BoundingBox, Dimensions, zeroBoundingBoxTopLeft } from "../../../util/geometry";
import { panic } from "../../../util/lang";
import { AttachmentsItem } from "./base/attachments-item";
import { DataItem } from "./base/data-item";
import { ItemTypeMixin, ITEM_TYPE_IMAGE } from "./base/item";
import { TitledItem } from "./base/titled-item";
import { XSizableItem, XSizableMixin } from "./base/x-sizeable-item";
import { ItemGeometry } from "../item-geometry";
import { PositionalMixin } from "./base/positional-item";


export interface ImageItem extends ImageMeasurable, XSizableItem, AttachmentsItem, DataItem, TitledItem {
  thumbnail: string,
}

export interface ImageMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin {
  imageSizePx: Dimensions,
}


export function imageFromObject(o: any): ImageItem {
  // TODO (LOW): dynamic type check of o.
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

    thumbnail: o.thumbnail,
    imageSizePx: o.imageSizePx,

    computed_attachments: [],
  });
}

export function imageToObject(i: ImageItem): object {
  return ({
    itemType: i.itemType,
    ownerId: i.ownerId,
    id: i.id,
    parentId: i.parentId,
    relationshipToParent: i.relationshipToParent,
    creationDate: i.creationDate,
    lastModifiedDate: i.lastModifiedDate,
    ordering: Array.from(i.ordering),
    title: i.title,
    spatialPositionGr: i.spatialPositionGr,

    spatialWidthGr: i.spatialWidthGr,

    originalCreationDate: i.originalCreationDate,
    mimeType: i.mimeType,
    fileSizeBytes: i.fileSizeBytes,

    thumbnail: i.thumbnail,
    imageSizePx: i.imageSizePx,
  });
}


export function isImage(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ITEM_TYPE_IMAGE;
}

export function asImageItem(item: ItemTypeMixin): ImageItem {
  if (item.itemType == ITEM_TYPE_IMAGE) { return item as ImageItem; }
  panic();
}

export function asImageMeasurable(item: ItemTypeMixin): ImageMeasurable {
  if (item.itemType == ITEM_TYPE_IMAGE) { return item as ImageMeasurable; }
  panic();
}

export function calcImageSizeForSpatialBl(image: ImageMeasurable): Dimensions {
  // half block quantization.
  let heightBl = Math.round(((image.spatialWidthGr / GRID_SIZE) * image.imageSizePx.h / image.imageSizePx.w) * 2.0) / 2.0;
  return { w: image.spatialWidthGr / GRID_SIZE, h: heightBl };
}

export function calcGeometryOfImageItem(image: ImageMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, emitHitboxes: boolean): ItemGeometry {
  const innerBoundsPx = {
    x: 0.0,
    y: 0.0,
    w: calcImageSizeForSpatialBl(image).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcImageSizeForSpatialBl(image).h / containerInnerSizeBl.h * containerBoundsPx.h,
  };
  const boundsPx = {
    x: (image.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (image.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcImageSizeForSpatialBl(image).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcImageSizeForSpatialBl(image).h / containerInnerSizeBl.h * containerBoundsPx.h,
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

export function calcGeometryOfImageAttachmentItem(_image: ImageMeasurable, containerBoundsPx: BoundingBox, index: number): ItemGeometry {
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

export function calcGeometryOfImageItemInTable(_image: ImageMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
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

export function calcGeometryOfImageItemInCell(image: ImageMeasurable, cellBoundsPx: BoundingBox): ItemGeometry {
  const imageAspect = image.imageSizePx.w / image.imageSizePx.h;
  let boundsPx = (() => {
    let result: BoundingBox;
    if (image.imageSizePx.w / cellBoundsPx.w > image.imageSizePx.h / cellBoundsPx.h) {
      // constraining dimension is width.
      result = {
        x: cellBoundsPx.x,
        w: cellBoundsPx.w,
        h: Math.round(cellBoundsPx.w / imageAspect),
        y: Math.round(cellBoundsPx.y + (cellBoundsPx.h - (cellBoundsPx.w / imageAspect)) / 2.0)
      };
    } else {
      // constraining dimension is height.
      result = {
        y: cellBoundsPx.y,
        h: cellBoundsPx.h,
        w: Math.round(cellBoundsPx.h * imageAspect),
        x: Math.round(cellBoundsPx.x + (cellBoundsPx.w - (cellBoundsPx.h * imageAspect)) / 2.0)
      };
    }
    return result;
  })();

  return ({
    boundsPx,
    hitboxes: [ { type: HitboxType.Click, boundsPx: zeroBoundingBoxTopLeft(boundsPx) } ]
  });
}

export function handleImageClick(imageItem: ImageItem): void {
  window.open('/files/' + imageItem.id, '_blank');
}

export function cloneImageMeasurableFields(image: ImageMeasurable): ImageMeasurable {
  return ({
    itemType: image.itemType,
    spatialPositionGr: image.spatialPositionGr,
    spatialWidthGr: image.spatialWidthGr,
    imageSizePx: image.imageSizePx
  });
}
