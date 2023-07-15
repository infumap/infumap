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
import { BoundingBox, Dimensions, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../util/geometry";
import { currentUnixTimeSeconds, panic } from "../util/lang";
import { EMPTY_UID, newUid, Uid } from "../util/uid";
import { ItemGeometry } from "../layout/item-geometry";
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from "./base/attachments-item";
import { Item, Measurable, ItemTypeMixin, ITEM_TYPE_LINK } from "./base/item";
import { calcGeometryOfItem_Attachment, calcGeometryOfItem_Cell, calcGeometryOfItem_Desktop, calcGeometryOfItem_ListItem, calcSizeForSpatialBl, cloneMeasurableFields } from "./base/item-polymorphism";
import { PositionalItem, asPositionalItem, isPositionalItem } from "./base/positional-item";
import { asXSizableItem, isXSizableItem, XSizableItem } from "./base/x-sizeable-item";
import { asYSizableItem, isYSizableItem, YSizableItem } from "./base/y-sizeable-item";
import { HitboxType, createHitbox } from "../layout/hitbox";


// Links have their own unique set of attachments (do not take those from the linked to item).
// If the linked-to item can not have attachments, then neither can the link item.
// The XSizableItem and YSizableItem may not apply, depending on the item linked to.

export interface LinkItem extends PositionalItem, XSizableItem, YSizableItem, AttachmentsItem {
  linkToId: Uid,
}


export function newLinkItem(ownerId: Uid, parentId: Uid, relationshipToParent: string, ordering: Uint8Array, linkToId: Uid): LinkItem {
  if (parentId == EMPTY_UID) { panic(); }
  return {
    itemType: ITEM_TYPE_LINK,
    ownerId,
    id: newUid(),
    parentId,
    relationshipToParent,
    creationDate: currentUnixTimeSeconds(),
    lastModifiedDate: currentUnixTimeSeconds(),
    ordering,
    spatialPositionGr: { x: 0.0, y: 0.0 },

    // possibly unused, depending on linked to type.
    spatialWidthGr: 4.0 * GRID_SIZE,
    spatialHeightGr: 4.0 * GRID_SIZE,

    linkToId,

    computed_attachments: [],
  };
}

export function linkFromObject(o: any): LinkItem {
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
    spatialPositionGr: o.spatialPositionGr,

    spatialWidthGr: o.spatialWidthGr,
    spatialHeightGr: o.spatialHeightGr,

    linkToId: o.linkToId,

    computed_attachments: [],
  });
}

export function linkToObject(l: LinkItem): object {
  return ({
    itemType: l.itemType,
    ownerId: l.ownerId,
    id: l.id,
    parentId: l.parentId,
    relationshipToParent: l.relationshipToParent,
    creationDate: l.creationDate,
    lastModifiedDate: l.lastModifiedDate,
    ordering: Array.from(l.ordering),
    spatialPositionGr: l.spatialPositionGr,

    spatialWidthGr: l.spatialWidthGr,
    spatialHeightGr: l.spatialHeightGr,

    linkToId: l.linkToId,
  });
}


function constructLinkToMeasurable(link: LinkItem, getItem: (id: Uid) => (Item | null)): Measurable | null {
  const linkedToItemMaybe = getItem(link.linkToId);
  if (linkedToItemMaybe == null) { return null; }
  const linkedToMeasurableFields = cloneMeasurableFields(linkedToItemMaybe!);
  if (isLink(linkedToMeasurableFields)) { panic(); }
  if (isPositionalItem(linkedToMeasurableFields)) {
    (asPositionalItem(linkedToMeasurableFields)).spatialPositionGr = link.spatialPositionGr;
  }
  if (isXSizableItem(linkedToMeasurableFields)) {
    (asXSizableItem(linkedToMeasurableFields)).spatialWidthGr = link.spatialWidthGr;
  }
  if (isYSizableItem(linkedToMeasurableFields)) {
    (asYSizableItem(linkedToMeasurableFields)).spatialHeightGr = link.spatialHeightGr;
  }
  return linkedToMeasurableFields
}

export function calcLinkSizeForSpatialBl(link: LinkItem, getItem: (id: Uid) => (Item | null)): Dimensions {
  function noLinkTo() {
    return { w: link.spatialWidthGr / GRID_SIZE, h: 1.0 };
  }
  if (link.linkToId == EMPTY_UID) {
    return noLinkTo();
  }
  const measurableMaybe = constructLinkToMeasurable(link, getItem);
  if (measurableMaybe == null) {
    return noLinkTo();
  }
  return calcSizeForSpatialBl(measurableMaybe!, getItem);
}

export function calcGeometryOfLinkItem_Desktop(link: LinkItem, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, parentIsPopup: boolean, emitHitboxes: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  function noLinkTo() {
    const boundsPx = {
      x: (link.spatialPositionGr.x / (parentInnerSizeBl.w * GRID_SIZE)) * parentBoundsPx.w + parentBoundsPx.x,
      y: (link.spatialPositionGr.y / (parentInnerSizeBl.h * GRID_SIZE)) * parentBoundsPx.h + parentBoundsPx.y,
      w: calcLinkSizeForSpatialBl(link, getItem).w / parentInnerSizeBl.w * parentBoundsPx.w + ITEM_BORDER_WIDTH_PX,
      h: calcLinkSizeForSpatialBl(link, getItem).h / parentInnerSizeBl.h * parentBoundsPx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return {
      boundsPx,
      hitboxes: !emitHitboxes ? [] : [
        createHitbox(HitboxType.Click, innerBoundsPx),
        createHitbox(HitboxType.Move, innerBoundsPx),
        createHitbox(HitboxType.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
        createHitbox(HitboxType.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      ],
    }
  }
  if (link.linkToId == EMPTY_UID) {
    return noLinkTo();
  }
  const measurableMaybe = constructLinkToMeasurable(link, getItem);
  if (measurableMaybe == null) {
    return noLinkTo();
  }
  return calcGeometryOfItem_Desktop(measurableMaybe!, parentBoundsPx, parentInnerSizeBl, parentIsPopup, emitHitboxes, getItem)
}

export function calcGeometryOfLinkItem_Attachment(link: LinkItem, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (link.linkToId == EMPTY_UID) {
    return calcGeometryOfAttachmentItemImpl(link, parentBoundsPx, parentInnerSizeBl, index, isSelected, getItem);
  }
  const measurableMaybe = constructLinkToMeasurable(link, getItem);
  if (measurableMaybe == null) {
    return calcGeometryOfAttachmentItemImpl(link, parentBoundsPx, parentInnerSizeBl, index, isSelected, getItem);
  }
  return calcGeometryOfItem_Attachment(measurableMaybe!, parentBoundsPx, parentInnerSizeBl, index, isSelected, getItem);
}

export function calcGeometryOfLinkItem_ListItem(link: LinkItem, blockSizePx: Dimensions, row: number, col: number, widthBl: number, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  function noLinkTo() {
    const boundsPx = {
      x: blockSizePx.w * col,
      y: blockSizePx.h * row,
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    return {
      boundsPx,
      hitboxes: []
    };
  }
  if (link.linkToId == EMPTY_UID) {
    return noLinkTo();
  }
  const measurableMaybe = constructLinkToMeasurable(link, getItem);
  if (measurableMaybe == null) {
    return noLinkTo();
  }
  return calcGeometryOfItem_ListItem(measurableMaybe!, blockSizePx, row, col, widthBl, getItem);
}

export function calcGeometryOfLinkItem_Cell(link: LinkItem, cellBoundsPx: BoundingBox, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  function noLinkTo() {
    return ({
      boundsPx: cloneBoundingBox(cellBoundsPx)!,
      hitboxes: [
        createHitbox(HitboxType.Click, zeroBoundingBoxTopLeft(cellBoundsPx))
      ]
    });
  }
  if (link.linkToId == EMPTY_UID) {
    return noLinkTo();
  }
  const measurableMaybe = constructLinkToMeasurable(link, getItem);
  if (measurableMaybe == null) {
    return noLinkTo();
  }
  return calcGeometryOfItem_Cell(measurableMaybe!, cellBoundsPx, getItem);
}

export function isLink(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ITEM_TYPE_LINK;
}

export function asLinkItem(item: ItemTypeMixin): LinkItem {
  if (item.itemType == ITEM_TYPE_LINK) { return item as LinkItem; }
  panic();
}
