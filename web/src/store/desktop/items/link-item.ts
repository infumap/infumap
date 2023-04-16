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

import { GRID_SIZE } from "../../../constants";
import { BoundingBox, Dimensions } from "../../../util/geometry";
import { currentUnixTimeSeconds, panic } from "../../../util/lang";
import { createBooleanSignal, createNumberSignal, createUidArraySignal, createVectorSignal } from "../../../util/signals";
import { newUid, Uid } from "../../../util/uid";
import { ItemGeometry } from "../item-geometry";
import { AttachmentsItem } from "./base/attachments-item";
import { Item, Measurable, ItemTypeMixin, ITEM_TYPE_LINK } from "./base/item";
import { calcGeometryOfAttachmentItem, calcGeometryOfItemInCell, calcGeometryOfItemInPage, calcGeometryOfItemInTable, calcSizeForSpatialBl, cloneMeasurableFields } from "./base/item-polymorphism";
import { asPositionalItem, isPositionalItem } from "./base/positional-item";
import { asXSizableItem, isXSizableItem, XSizableItem } from "./base/x-sizeable-item";
import { asYSizableItem, isYSizableItem, YSizableItem } from "./base/y-sizeable-item";


// Links have their own unique set of attachments (do not take those from the linked to item).
// If the linked-to item can not have attachments, then neither can the link item.
// The XSizableItem and YSizableItem may not apply, depending on the item linked to.

export interface LinkItem extends XSizableItem, YSizableItem, AttachmentsItem {
  linkToId: Uid,
}


export function newLinkItem(ownerId: Uid, parentId: Uid, relationshipToParent: string, ordering: Uint8Array, linkToId: Uid): LinkItem {
  return {
    itemType: ITEM_TYPE_LINK,
    ownerId,
    id: newUid(),
    parentId,
    relationshipToParent,
    creationDate: currentUnixTimeSeconds(),
    lastModifiedDate: currentUnixTimeSeconds(),
    ordering,
    spatialPositionGr: createVectorSignal({ x: 0.0, y: 0.0 }),

    // possibly unused, depending on linked to type.
    spatialWidthGr: createNumberSignal(4.0 * GRID_SIZE),
    spatialHeightGr: createNumberSignal(4.0 * GRID_SIZE),

    linkToId,

    computed_attachments: createUidArraySignal([]),
    computed_mouseIsOver: createBooleanSignal(false),
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
    spatialPositionGr: createVectorSignal(o.spatialPositionGr),

    spatialWidthGr: createNumberSignal(o.spatialWidthGr),
    spatialHeightGr: createNumberSignal(o.spatialHeightGr),

    linkToId: o.linkToId,

    computed_attachments: createUidArraySignal([]),
    computed_mouseIsOver: createBooleanSignal(false),
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
    spatialPositionGr: l.spatialPositionGr.get(),

    spatialWidthGr: l.spatialWidthGr.get(),
    spatialHeightGr: l.spatialHeightGr.get(),

    linkToId: l.linkToId,
  });
}


function constructLinkToMeasurable(link: LinkItem, getItem: (id: Uid) => (Item | null)): Measurable {
  const linkedToMeasurableFields = cloneMeasurableFields(getItem(link.linkToId)!);
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
  return calcSizeForSpatialBl(constructLinkToMeasurable(link, getItem), getItem);
}

export function calcGeometryOfLinkItem(link: LinkItem, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, emitHitboxes: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  return calcGeometryOfItemInPage(constructLinkToMeasurable(link, getItem), containerBoundsPx, containerInnerSizeBl, emitHitboxes, getItem)
}

export function calcGeometryOfLinkAttachmentItem(link: LinkItem, containerBoundsPx: BoundingBox, index: number, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  return calcGeometryOfAttachmentItem(constructLinkToMeasurable(link, getItem), containerBoundsPx, index, getItem);
}

export function calcGeometryOfLinkItemInTable(link: LinkItem, blockSizePx: Dimensions, row: number, col: number, widthBl: number, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  return calcGeometryOfItemInTable(constructLinkToMeasurable(link, getItem), blockSizePx, row, col, widthBl, getItem);
}

export function calcGeometryOfLinkItemInCell(link: LinkItem, cellBoundsPx: BoundingBox, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  return calcGeometryOfItemInCell(constructLinkToMeasurable(link, getItem), cellBoundsPx, getItem);
}

export function isLink(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ITEM_TYPE_LINK;
}

export function asLinkItem(item: ItemTypeMixin): LinkItem {
  if (item.itemType == ITEM_TYPE_LINK) { return item as LinkItem; }
  panic();
}
