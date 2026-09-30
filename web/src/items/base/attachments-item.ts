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
import { HitboxFlags, HitboxFns } from "../../layout/hitbox";
import { ItemGeometry } from "../../layout/item-geometry";
import { VisualElement } from "../../layout/visual-element";
import { Item, ItemTypeMixin, ItemType, Measurable } from "./item";
import { ItemFns } from "./item-polymorphism";
import { NATURAL_BLOCK_SIZE_PX, RESIZE_BOX_SIZE_PX } from "../../constants";


const ITEM_TYPES = [ItemType.Page, ItemType.Table, ItemType.Note, ItemType.File, ItemType.Text, ItemType.Image, ItemType.Password];

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
  panic("not attachments item.");
}

export function calcSpatialAttachmentStripWidthPx(parentWidthPx: number, blockWidthPx: number, attachmentCount: number): number {
  return Math.min(parentWidthPx, blockWidthPx * (attachmentCount + 1));
}

export function calcSpatialAttachmentHitboxBoundsPx(
  innerBoundsPx: BoundingBox,
  blockWidthPx: number,
  blockHeightPx: number,
  attachmentCount: number,
): BoundingBox {
  const stripWidthPx = calcSpatialAttachmentStripWidthPx(innerBoundsPx.w, blockWidthPx, attachmentCount);
  return {
    x: innerBoundsPx.w - stripWidthPx,
    y: -blockHeightPx / 2,
    w: stripWidthPx,
    h: blockHeightPx,
  };
}

/**
 * Sets the block size used for attachments of the item with the provided geometry, and updates any
 * attach (drop target) hitboxes to match. If ensureAttachHitbox is true, an attach hitbox is added
 * if there isn't one already.
 */
export function setGeometryAttachmentBlockSizePx(geometry: ItemGeometry, attachmentCount: number, blockSizePx: number, ensureAttachHitbox: boolean) {
  geometry.attachmentBlockSizePx = blockSizePx;
  const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);
  const attachBoundsPx = calcSpatialAttachmentHitboxBoundsPx(innerBoundsPx, blockSizePx, blockSizePx, attachmentCount);
  let hasAttachHitbox = false;
  for (let i = 0; i < geometry.hitboxes.length; ++i) {
    const hitbox = geometry.hitboxes[i];
    if (!(hitbox.type & HitboxFlags.Attach)) { continue; }
    geometry.hitboxes[i] = { ...hitbox, boundsPx: attachBoundsPx };
    hasAttachHitbox = true;
  }
  if (ensureAttachHitbox && !hasAttachHitbox) {
    geometry.hitboxes.push(HitboxFns.create(HitboxFlags.Attach, attachBoundsPx));
  }
}

/**
 * The block size (px) used for laying out attachments of the provided visual element, where the
 * visual element is rendered with width veWidthPx (which may differ from ve.boundsPx.w, e.g. if
 * measured in desktop coordinates).
 */
export function attachmentBlockSizePxForVe(ve: VisualElement, veWidthPx: number): number {
  if (ve.attachmentBlockSizePx != null) { return ve.attachmentBlockSizePx * veWidthPx / ve.boundsPx.w; }
  return veWidthPx / ItemFns.calcSpatialDimensionsBl(ve.displayItem).w;
}

export function calcSpatialAttachmentInsertIndex(
  veBoundsPx: BoundingBox,
  blockSizePx: number,
  desktopX: number,
  attachmentCount: number,
): number {
  const mouseXFromRight = veBoundsPx.x + veBoundsPx.w - desktopX;
  const slotIndex = Math.floor(mouseXFromRight / blockSizePx);
  return Math.max(0, Math.min(slotIndex, attachmentCount));
}


export function calcGeometryOfAttachmentItemImpl(
  item: Measurable,
  parentBoundsPx: BoundingBox,
  parentInnerSizeBl: Dimensions,
  index: number,
  isSelected: boolean,
  canPopup: boolean): ItemGeometry {

  if (isSelected) {
    return calcGeometryOfSelectedAttachmentItemImpl(item, parentBoundsPx, parentInnerSizeBl, index);
  }

  const SCALE_DOWN_PROP = 0.8;
  const blockSizePx = parentBoundsPx.w / parentInnerSizeBl.w;
  const scaleDownBlockSizePx = blockSizePx * SCALE_DOWN_PROP;
  const scaleDownMarginPx = (blockSizePx - scaleDownBlockSizePx) / 2.0;
  const itemSizeBl = ItemFns.calcSpatialDimensionsBl(item);
  let boundsPx: BoundingBox;
  if (itemSizeBl.w > itemSizeBl.h) {
    const wPx = scaleDownBlockSizePx;
    let hPx = scaleDownBlockSizePx * itemSizeBl.h / itemSizeBl.w;
    if (hPx < blockSizePx * 0.3) { hPx = blockSizePx * 0.3; }
    const marginH = (scaleDownBlockSizePx - hPx) / 2.0;
    const marginW = 0;
    boundsPx = {
      x: parentBoundsPx.w - (blockSizePx * (index + 1)) + marginW + scaleDownMarginPx,
      y: -blockSizePx / 2.0 + marginH + scaleDownMarginPx,
      w: wPx,
      h: hPx,
    }
  } else {
    let wPx = scaleDownBlockSizePx * itemSizeBl.w / itemSizeBl.h;
    if (wPx < blockSizePx * 0.3) { wPx = blockSizePx * 0.3; }
    const hPx = scaleDownBlockSizePx;
    const marginH = 0;
    const marginW = (scaleDownBlockSizePx - wPx) / 2.0;
    boundsPx = {
      x: parentBoundsPx.w - (blockSizePx * (index + 1)) + marginW + scaleDownMarginPx,
      y: -blockSizePx / 2.0 + marginH + scaleDownMarginPx,
      w: wPx,
      h: hPx,
    };
  }
  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  const hitboxes = [
    HitboxFns.create(HitboxFlags.Move, innerBoundsPx)
  ];
  if (canPopup) {
    hitboxes.push(HitboxFns.create(HitboxFlags.OpenAttachment, innerBoundsPx));
  } else {
    hitboxes.push(HitboxFns.create(HitboxFlags.Click, innerBoundsPx));
  }
  return ({
    boundsPx,
    viewportBoundsPx: boundsPx,
    blockSizePx: NATURAL_BLOCK_SIZE_PX,
    hitboxes
  });
}

export function calcGeometryOfSelectedAttachmentItemImpl(item: Measurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number): ItemGeometry {
  const blockSizePx = {
    w: parentBoundsPx.w / parentInnerSizeBl.w,
    h: parentBoundsPx.h / parentInnerSizeBl.h
  };
  const itemSizeBl = ItemFns.calcSpatialDimensionsBl(item);
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
    viewportBoundsPx: boundsPx,
    blockSizePx: NATURAL_BLOCK_SIZE_PX,
    hitboxes: [
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Resize, {
        x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX,
        y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX,
        w: RESIZE_BOX_SIZE_PX,
        h: RESIZE_BOX_SIZE_PX
      }),
    ],
  }
}
