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
import { BoundingBox, cloneVector, Dimensions, zeroTopLeft } from "../../../util/geometry";
import { panic } from "../../../util/lang";
import { AttachmentsItem } from "./base/attachments-item";
import { DataItem } from "./base/data-item";
import { Item, ItemTypeMixin, ITEM_TYPE_IMAGE } from "./base/item";
import { TitledItem } from "./base/titled-item";
import { XSizableItem, XSizableMixin } from "./base/x-sizeable-item";
import { ItemGeometry } from "../item-geometry";
import { Uid } from "../../../util/uid";
import { PositionalMixin } from "./base/positional-item";


export interface ImageItem extends ImageMeasurable, XSizableItem, AttachmentsItem, DataItem, TitledItem {
  thumbnail: string,
}

export interface ImageMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin {
  imageSizePx: Dimensions,
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

export function calcImageSizeForSpatialBl(image: ImageMeasurable, _getItem: (id: Uid) => (Item | null)): Dimensions {
  // half block quantization.
  let heightBl = Math.round(((image.spatialWidthGr / GRID_SIZE) * image.imageSizePx.h / image.imageSizePx.w) * 2.0) / 2.0;
  return { w: image.spatialWidthGr / GRID_SIZE, h: heightBl };
}

export function calcGeometryOfImageItem(image: ImageMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, emitHitboxes: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: (image.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (image.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcImageSizeForSpatialBl(image, getItem).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcImageSizeForSpatialBl(image, getItem).h / containerInnerSizeBl.h * containerBoundsPx.h,
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

export function calcGeometryOfImageAttachmentItem(_image: ImageMeasurable, containerBoundsPx: BoundingBox, index: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
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

export function calcGeometryOfImageItemInTable(_image: ImageMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
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

export function calcGeometryOfImageItemInCell(image: ImageMeasurable, cellBoundsPx: BoundingBox, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const imageAspect = image.imageSizePx.w / image.imageSizePx.h;
  let boundsPx: BoundingBox;
  if (image.imageSizePx.w / cellBoundsPx.w > image.imageSizePx.h / cellBoundsPx.h) {
    // constraining dimension is width.
    boundsPx = {
      x: cellBoundsPx.x,
      w: cellBoundsPx.w,
      h: Math.round(cellBoundsPx.w / imageAspect),
      y: Math.round(cellBoundsPx.y + (cellBoundsPx.h - (cellBoundsPx.w / imageAspect)) / 2.0)
    };
  } else {
    // constraining dimension is height.
    boundsPx = {
      y: cellBoundsPx.y,
      h: cellBoundsPx.h,
      w: Math.round(cellBoundsPx.h * imageAspect),
      x: Math.round(cellBoundsPx.x + (cellBoundsPx.w - (cellBoundsPx.h * imageAspect)) / 2.0)
    };
  }

  return (
    { boundsPx, hitboxes: [ { type: HitboxType.Click, boundsPx: zeroTopLeft(boundsPx) } ] }
  );
}

export function setImageDefaultComputed(item: ImageItem): void {
  item.computed_attachments = [];
  item.computed_mouseIsOver = false;
}

export function handleImageClick(imageItem: ImageItem): void {
  window.open('/files/' + imageItem.id, '_blank');
}

export function cloneImageMeasurableFields(image: ImageMeasurable): ImageMeasurable {
  return ({
    itemType: image.itemType,
    spatialPositionGr: cloneVector(image.spatialPositionGr)!,
    spatialWidthGr: image.spatialWidthGr,
    imageSizePx: image.imageSizePx
  });
}
