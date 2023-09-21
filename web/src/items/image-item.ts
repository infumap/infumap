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

import { ATTACH_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, RESIZE_BOX_SIZE_PX } from "../constants";
import { HitboxType, HitboxFns } from "../layout/hitbox";
import { BoundingBox, Dimensions, zeroBoundingBoxTopLeft } from "../util/geometry";
import { panic } from "../util/lang";
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from "./base/attachments-item";
import { DataItem } from "./base/data-item";
import { ItemTypeMixin, ITEM_TYPE_IMAGE, calcBoundsInCell } from "./base/item";
import { TitledItem } from "./base/titled-item";
import { XSizableItem, XSizableMixin } from "./base/x-sizeable-item";
import { ItemGeometry } from "../layout/item-geometry";
import { PositionalMixin } from "./base/positional-item";
import { VisualElement, VisualElementFlags, VeFns } from "../layout/visual-element";
import { DesktopStoreContextModel, PopupType } from "../store/DesktopStoreProvider";
import { arrange } from "../layout/arrange";
import { VesCache } from "../layout/ves-cache";
import { handleListPageLineItemClickMaybe } from "./base/item-common";


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

export function calcGeometryOfImageItem_Desktop(image: ImageMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry {
  const boundsPx = {
    x: (image.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (image.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcImageSizeForSpatialBl(image).w / containerInnerSizeBl.w * containerBoundsPx.w + ITEM_BORDER_WIDTH_PX,
    h: calcImageSizeForSpatialBl(image).h / containerInnerSizeBl.h * containerBoundsPx.h + ITEM_BORDER_WIDTH_PX,
  };
  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  return {
    boundsPx,
    hitboxes: !emitHitboxes ? [] : [
      HitboxFns.create(HitboxType.Click, innerBoundsPx),
      HitboxFns.create(HitboxType.Move, innerBoundsPx),
      HitboxFns.create(HitboxType.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
      HitboxFns.create(HitboxType.Resize, { x: boundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: boundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
    ],
  }
}

export function calcGeometryOfImageItem_InComposite(measurable: ImageMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, topPx: number): ItemGeometry {
  panic();
}

export function calcGeometryOfImageItem_Attachment(image: ImageMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry {
  return calcGeometryOfAttachmentItemImpl(image, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
}

export function calcGeometryOfImageItem_ListItem(_image: ImageMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
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
}

export function calcGeometryOfImageItem_Cell(image: ImageMeasurable, cellBoundsPx: BoundingBox): ItemGeometry {
  const boundsPx = calcBoundsInCell(image.imageSizePx, cellBoundsPx);
  return ({
    boundsPx,
    hitboxes: [
      HitboxFns.create(HitboxType.Click, zeroBoundingBoxTopLeft(boundsPx))
    ]
  });
}

export function handleImageClick(visualElement: VisualElement, desktopStore: DesktopStoreContextModel): void {
  if (handleListPageLineItemClickMaybe(visualElement, desktopStore)) { return; }
  if (visualElement.flags & VisualElementFlags.Popup) {
    window.open('/files/' + visualElement.displayItem.id, '_blank');
  } else if (VesCache.get(visualElement.parentPath!)!.get().flags & VisualElementFlags.Popup) {
    desktopStore.pushPopup({ type: PopupType.Image, vePath: VeFns.veToPath(visualElement) });
    arrange(desktopStore);
  } else {
    desktopStore.replacePopup({ type: PopupType.Image, vePath: VeFns.veToPath(visualElement) });
    arrange(desktopStore);
  }
}

export function cloneImageMeasurableFields(image: ImageMeasurable): ImageMeasurable {
  return ({
    itemType: image.itemType,
    spatialPositionGr: image.spatialPositionGr,
    spatialWidthGr: image.spatialWidthGr,
    imageSizePx: image.imageSizePx
  });
}

export function imageDebugSummary(imageItem: ImageItem) {
  return "[image] " + imageItem.title;
}

export function getImageItemFingerprint(imageItem: ImageItem): string {
  return imageItem.title;
}
