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

import { BoundingBox, Dimensions, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { panic } from "../../util/lang";
import { Uid } from "../../util/uid";
import { HitboxType, createHitbox } from "../../layout/hitbox";
import { ItemGeometry } from "../../layout/item-geometry";
import { Item, ItemTypeMixin, ITEM_TYPE_FILE, ITEM_TYPE_IMAGE, ITEM_TYPE_NOTE, ITEM_TYPE_PAGE, ITEM_TYPE_TABLE, Measurable } from "./item";
import { calcSizeForSpatialBl } from "./item-polymorphism";
import { RESIZE_BOX_SIZE_PX } from "../../constants";


const ITEM_TYPES = [ITEM_TYPE_PAGE, ITEM_TYPE_TABLE, ITEM_TYPE_NOTE, ITEM_TYPE_FILE, ITEM_TYPE_IMAGE];

export interface AttachmentsMixin {
  computed_attachments: Array<Uid>;
}

export interface AttachmentsItem extends AttachmentsMixin, Item { }


export function isAttachmentsItem(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return ITEM_TYPES.find(t => t == item.itemType) != null;
}


export function asAttachmentsItem(item: ItemTypeMixin): AttachmentsItem {
  if (isAttachmentsItem(item)) { return item as AttachmentsItem; }
  panic();
}


export function calcGeometryOfAttachmentItemImpl(item: Measurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry {
  if (isSelected) {
    return calcGeometryOfSelectedAttachmentItemImpl(item, parentBoundsPx, parentInnerSizeBl, index);
  }
  const SCALE_DOWN_PROP = 0.8;
  const blockSizePx = parentBoundsPx.w / parentInnerSizeBl.w;
  const scaleDownBlockSizePx = blockSizePx * SCALE_DOWN_PROP;
  const scaleDownMarginPx = (blockSizePx - scaleDownBlockSizePx) / 2.0;
  const itemSizeBl = calcSizeForSpatialBl(item);
  let boundsPx: BoundingBox;
  if (itemSizeBl.w > itemSizeBl.h) {
    const wPx = scaleDownBlockSizePx;
    let hPx = scaleDownBlockSizePx * itemSizeBl.h / itemSizeBl.w;
    if (hPx < scaleDownBlockSizePx / 5.0) { hPx = scaleDownBlockSizePx / 5.0; }
    const marginH = (scaleDownBlockSizePx - hPx) / 2.0;
    const marginW = 0;
    boundsPx = {
      x: parentBoundsPx.w - (blockSizePx * (index+1)) + marginW + scaleDownMarginPx,
      y: -blockSizePx/2.0 + marginH + scaleDownMarginPx,
      w: wPx,
      h: hPx,
    }
  } else {
    let wPx = scaleDownBlockSizePx * itemSizeBl.w / itemSizeBl.h;
    if (wPx < scaleDownBlockSizePx / 5.0) { wPx = scaleDownBlockSizePx / 5.0; }
    const hPx = scaleDownBlockSizePx;
    const marginH = 0;
    const marginW = (scaleDownBlockSizePx - wPx) / 2.0;
    boundsPx = {
      x: parentBoundsPx.w - (blockSizePx * (index+1)) + marginW + scaleDownMarginPx,
      y: -blockSizePx/2.0 + marginH + scaleDownMarginPx,
      w: wPx,
      h: hPx,
    };
  }
  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  return {
    boundsPx,
    hitboxes: [
      createHitbox(HitboxType.Move, innerBoundsPx),
      createHitbox(HitboxType.OpenAttachment, innerBoundsPx),
    ],
  }
}

export function calcGeometryOfSelectedAttachmentItemImpl(item: Measurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number): ItemGeometry {
  const blockSizePx = {
    w: parentBoundsPx.w / parentInnerSizeBl.w,
    h: parentBoundsPx.h / parentInnerSizeBl.h
  };
  const itemSizeBl = calcSizeForSpatialBl(item);
  const itemSizePx = {
    w: itemSizeBl.w * blockSizePx.w,
    h: itemSizeBl.h * blockSizePx.h
  };
  const boundsPx = {
    x: parentBoundsPx.w - itemSizePx.w / 2.0 - (index + 0.5) * blockSizePx.w,
    y: -itemSizePx.h / 2.0,
    w: itemSizePx.w,
    h: itemSizePx.h,
  }
  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  return {
    boundsPx,
    hitboxes: [
      createHitbox(HitboxType.Move, innerBoundsPx),
      createHitbox(HitboxType.Click, innerBoundsPx),
      createHitbox(HitboxType.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
    ],
  }
}
