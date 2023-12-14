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

import { GRID_SIZE, ITEM_BORDER_WIDTH_PX, RESIZE_BOX_SIZE_PX } from "../constants";
import { BoundingBox, Dimensions, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../util/geometry";
import { currentUnixTimeSeconds, panic } from "../util/lang";
import { EMPTY_UID, newUid, Uid } from "../util/uid";
import { ItemGeometry } from "../layout/item-geometry";
import { AttachmentsMixin, calcGeometryOfAttachmentItemImpl } from "./base/attachments-item";
import { Measurable, ItemTypeMixin, Item, ItemType } from "./base/item";
import { ItemFns } from "./base/item-polymorphism";
import { PositionalMixin, asPositionalItem, isPositionalItem } from "./base/positional-item";
import { asXSizableItem, isXSizableItem, XSizableMixin } from "./base/x-sizeable-item";
import { asYSizableItem, isYSizableItem, YSizableMixin } from "./base/y-sizeable-item";
import { HitboxFlags, HitboxFns } from "../layout/hitbox";
import { itemState } from "../store/ItemState";


// Links have their own unique set of attachments (do not take those from the linked to item).
// If the linked-to item can not have attachments, then neither can the link item.
// The XSizableItem and YSizableItem may not apply, depending on the item linked to.

export interface LinkItem extends LinkMeasurable, Item, AttachmentsMixin {
  linkTo: Uid,
  linkToResolvedId: Uid | null,
  linkToBaseUrl: string,
}

export interface LinkMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, YSizableMixin { }


export const LinkFns = {
  createFromItem: (item: Item, relationshipToParent: string, ordering: Uint8Array): LinkItem => {
    const result = LinkFns.create(item.ownerId, item.parentId, relationshipToParent, ordering, item.id);
    if (isPositionalItem(item)) {
      result.spatialPositionGr = asPositionalItem(item).spatialPositionGr;
    }
    if (isXSizableItem(item)) {
      result.spatialWidthGr = asXSizableItem(item).spatialWidthGr;
    }
    if (isYSizableItem(item)) {
      result.spatialHeightGr = asYSizableItem(item).spatialHeightGr;
    }
    return result;
  },

  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, ordering: Uint8Array, linkTo: Uid): LinkItem => {
    if (parentId == EMPTY_UID) { panic("LinkFns.create: parent is empty."); }
    return {
      origin: null,
      itemType: ItemType.Link,
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

      linkTo,
      linkToResolvedId: linkTo,
      linkToBaseUrl: "",

      computed_attachments: [],
    };
  },

  fromObject: (o: any, origin: string | null): LinkItem => {
    // TODO: dynamic type check of o.
    return ({
      origin,
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

      linkTo: o.linkTo,
      linkToResolvedId: null,
      linkToBaseUrl: o.linkToBaseUrl,

      computed_attachments: [],
    });
  },

  toObject: (l: LinkItem): object => {
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

      linkTo: l.linkTo,
      linkToBaseUrl: l.linkToBaseUrl,
    });
  },

  calcSpatialDimensionsBl: (link: LinkItem): Dimensions => {
    function noLinkTo() {
      return { w: link.spatialWidthGr / GRID_SIZE, h: 1.0 };
    }
    if (LinkFns.getLinkToId(link) == EMPTY_UID) { return noLinkTo(); }
    const measurableMaybe = constructLinkToMeasurable(link);
    if (measurableMaybe == null) { return noLinkTo(); }
    return ItemFns.calcSpatialDimensionsBl(measurableMaybe!);
  },

  calcGeometry_Spatial: (link: LinkItem, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, parentIsPopup: boolean, emitHitboxes: boolean, isPopup: boolean, hasPendingChanges: boolean): ItemGeometry => {
    function noLinkTo() {
      const boundsPx = {
        x: (link.spatialPositionGr.x / (parentInnerSizeBl.w * GRID_SIZE)) * parentBoundsPx.w + parentBoundsPx.x,
        y: (link.spatialPositionGr.y / (parentInnerSizeBl.h * GRID_SIZE)) * parentBoundsPx.h + parentBoundsPx.y,
        w: LinkFns.calcSpatialDimensionsBl(link).w / parentInnerSizeBl.w * parentBoundsPx.w + ITEM_BORDER_WIDTH_PX,
        h: LinkFns.calcSpatialDimensionsBl(link).h / parentInnerSizeBl.h * parentBoundsPx.h + ITEM_BORDER_WIDTH_PX,
      };
      const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
      return {
        boundsPx,
        hitboxes: !emitHitboxes ? [] : [
          HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
          HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
        ],
      }
    }

    if (LinkFns.getLinkToId(link) == EMPTY_UID) { return noLinkTo(); }
    const measurableMaybe = constructLinkToMeasurable(link);
    if (measurableMaybe == null) { return noLinkTo(); }
    return ItemFns.calcGeometry_Spatial(measurableMaybe, parentBoundsPx, parentInnerSizeBl, parentIsPopup, emitHitboxes, isPopup, hasPendingChanges);
  },

  calcGeometry_InComposite: (link: LinkItem, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    function noLinkTo() {
      const boundsPx = {
        x: leftMarginBl * blockSizePx.w,
        y: topPx,
        w: compositeWidthBl * blockSizePx.w,
        h: blockSizePx.h
      };
      const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
      let moveWidthPx = 10;
      if (innerBoundsPx.w < 10) {
        // TODO (MEDIUM): something sensible.
        moveWidthPx = 1;
      }
      const moveBoundsPx = {
        x: innerBoundsPx.w - moveWidthPx,
        y: innerBoundsPx.y,
        w: moveWidthPx,
        h: innerBoundsPx.h
      };
      return {
        boundsPx,
        hitboxes: [
          HitboxFns.create(HitboxFlags.Move, moveBoundsPx),
        ]
      };
    }

    if (LinkFns.getLinkToId(link) == EMPTY_UID) { return noLinkTo(); }
    const measurableMaybe = constructLinkToMeasurable(link);
    if (measurableMaybe == null) { return noLinkTo(); }
    return ItemFns.calcGeometry_InComposite(measurableMaybe!, blockSizePx, compositeWidthBl, leftMarginBl, topPx);
  },

  calcGeometry_Attachment: (link: LinkItem, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    if (LinkFns.getLinkToId(link) == EMPTY_UID) {
      return calcGeometryOfAttachmentItemImpl(link, parentBoundsPx, parentInnerSizeBl, index, isSelected, false);
    }
    const measurableMaybe = constructLinkToMeasurable(link);
    if (measurableMaybe == null) {
      return calcGeometryOfAttachmentItemImpl(link, parentBoundsPx, parentInnerSizeBl, index, isSelected, false);
    }
    return ItemFns.calcGeometry_Attachment(measurableMaybe!, parentBoundsPx, parentInnerSizeBl, index, isSelected);
  },

  calcGeometry_ListItem: (link: LinkItem, blockSizePx: Dimensions, row: number, col: number, widthBl: number, parentIsPopup: boolean): ItemGeometry => {
    function noLinkTo() {
      const boundsPx = {
        x: blockSizePx.w * col,
        y: blockSizePx.h * row,
        w: blockSizePx.w * widthBl,
        h: blockSizePx.h
      };
      return {
        boundsPx,
        hitboxes: [
          HitboxFns.create(HitboxFlags.Move, zeroBoundingBoxTopLeft(boundsPx))
        ]
      };
    }
  
    if (LinkFns.getLinkToId(link) == EMPTY_UID) { return noLinkTo(); }
    const measurableMaybe = constructLinkToMeasurable(link);
    if (measurableMaybe == null) { return noLinkTo(); }
    return ItemFns.calcGeometry_ListItem(measurableMaybe!, blockSizePx, row, col, widthBl, parentIsPopup);
  },

  calcGeometry_InCell: (link: LinkItem, cellBoundsPx: BoundingBox, expandable: boolean, parentIsPopup: boolean, isPopup: boolean, hasPendingChanges: boolean, maximize: boolean): ItemGeometry => {
    function noLinkTo() {
      return ({
        boundsPx: cloneBoundingBox(cellBoundsPx)!,
        hitboxes: [
          HitboxFns.create(HitboxFlags.Click, zeroBoundingBoxTopLeft(cellBoundsPx))
        ]
      });
    }
  
    if (LinkFns.getLinkToId(link) == EMPTY_UID) { return noLinkTo(); }
    const measurableMaybe = constructLinkToMeasurable(link);
    if (measurableMaybe == null) { return noLinkTo(); }
    return ItemFns.calcGeometry_InCell(measurableMaybe!, cellBoundsPx, expandable, parentIsPopup, isPopup, hasPendingChanges, maximize);
  },

  asLinkMeasurable: (item: ItemTypeMixin): LinkMeasurable => {
    if (item.itemType == ItemType.Link) { return item as LinkMeasurable; }
    panic("not link measurable.");
  },

  cloneMeasurableFields: (link: LinkMeasurable): LinkMeasurable => {
    return ({
      itemType: link.itemType,
      spatialPositionGr: link.spatialPositionGr,
      spatialWidthGr: link.spatialWidthGr,
      spatialHeightGr: link.spatialHeightGr,
    });
  },

  debugSummary: (linkItem: LinkItem) => {
    return "[link] " + linkItem.linkTo + (linkItem.linkToBaseUrl == "" ? "" : "[" + linkItem.linkToBaseUrl + "]");
  },

  getLinkToId: (linkItem: LinkItem): Uid => {
    return linkItem.linkToResolvedId == null
      ? linkItem.linkTo
      : linkItem.linkToResolvedId;
  },

  getFingerprint: (linkItem: LinkItem): string => {
    const linkToId = LinkFns.getLinkToId(linkItem);
    if (linkToId == EMPTY_UID) {
      return "";
    }
    const linkedToItemMaybe = itemState.get(linkToId);
    if (linkedToItemMaybe == null) { return ""; }
    return ItemFns.getFingerprint(linkedToItemMaybe!);
  }  
};


function constructLinkToMeasurable(link: LinkItem): Measurable | null {
  const linkedToItemMaybe = itemState.get(LinkFns.getLinkToId(link));
  if (linkedToItemMaybe == null) { return null; }
  if (isLink(linkedToItemMaybe)) { return null; }

  const linkedToMeasurableFields = ItemFns.cloneMeasurableFields(linkedToItemMaybe!);

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


export function isLink(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Link;
}

export function asLinkItem(item: ItemTypeMixin): LinkItem {
  if (item.itemType == ItemType.Link) { return item as LinkItem; }
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not a link.`);
}
