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

import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LINE_HEIGHT_PX, LINK_TRIANGLE_SIZE_PX, LIST_PAGE_TOP_PADDING_PX, RESIZE_BOX_SIZE_PX } from "../constants";
import { BoundingBox, Dimensions, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../util/geometry";
import { assert, currentUnixTimeSeconds, panic } from "../util/lang";
import { EMPTY_UID, isUid, newUid, Uid } from "../util/uid";
import { ItemGeometry } from "../layout/item-geometry";
import { AttachmentsMixin, calcGeometryOfAttachmentItemImpl } from "./base/attachments-item";
import { Measurable, ItemTypeMixin, Item, ItemType } from "./base/item";
import { ItemFns } from "./base/item-polymorphism";
import { PositionalMixin, asPositionalItem, isPositionalItem } from "./base/positional-item";
import { asXSizableItem, isXSizableItem, XSizableMixin } from "./base/x-sizeable-item";
import { asYSizableItem, isYSizableItem, YSizableMixin } from "./base/y-sizeable-item";
import { HitboxFlags, HitboxFns } from "../layout/hitbox";
import { itemState } from "../store/ItemState";
import { calcBoundsInCellFromSizeBl } from "./base/item-common-fns";


// If the linked-to item can not have attachments, then neither can the link item.
// The XSizableItem and YSizableItem may not apply, depending on the item linked to.

export interface LinkItem extends LinkMeasurable, Item, AttachmentsMixin {
  overrideArrangeAlgorithm?: string | null,
  filterDate?: { year: number; month: number; day: number } | null,
  overrideTitle?: string | null,
  linkRequiresRemoteLogin?: string | null,
}

export interface LinkMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, YSizableMixin {
  linkTo: string,
  linkToResolvedId: Uid | null,
}


export const LinkFns = {
  createFromItem: (item: Item, parentId: Uid, relationshipToParent: string, ordering: Uint8Array): LinkItem => {
    const parent = itemState.get(parentId);
    const ownerId = parent ? parent.ownerId : item.ownerId;
    const result = LinkFns.create(ownerId, parentId, relationshipToParent, item.id, ordering);
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

  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, linkToMaybe: Uid | "", ordering: Uint8Array): LinkItem => {
    if (parentId == EMPTY_UID) { panic("LinkFns.create: parent is empty."); }
    if (linkToMaybe != "" && !isUid(linkToMaybe)) { panic(`invalid linkTo '${linkToMaybe}'.`); }
    return {
      origin: null,
      itemType: ItemType.Link,
      ownerId,
      id: newUid(),
      parentId,
      relationshipToParent,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      dateTime: currentUnixTimeSeconds(),
      ordering,
      spatialPositionGr: { x: 0.0, y: 0.0 },

      // possibly unused, depending on linked to type.
      spatialWidthGr: 4.0 * GRID_SIZE,
      spatialHeightGr: 4.0 * GRID_SIZE,

      linkTo: linkToMaybe,
      linkToResolvedId: linkToMaybe == "" ? null : linkToMaybe,

      computed_attachments: [],
      overrideArrangeAlgorithm: null,
      filterDate: null,
      overrideTitle: null,
      linkRequiresRemoteLogin: null,
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
      dateTime: o.dateTime,
      ordering: new Uint8Array(o.ordering),
      spatialPositionGr: o.spatialPositionGr,

      spatialWidthGr: o.spatialWidthGr,
      spatialHeightGr: o.spatialHeightGr,

      linkTo: o.linkTo,
      linkToResolvedId: null,

      computed_attachments: [],
      overrideArrangeAlgorithm: null,
      filterDate: null,
      overrideTitle: null,
      linkRequiresRemoteLogin: null,
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
      dateTime: l.dateTime,
      ordering: Array.from(l.ordering),
      spatialPositionGr: l.spatialPositionGr,

      spatialWidthGr: l.spatialWidthGr,
      spatialHeightGr: l.spatialHeightGr,

      linkTo: l.linkTo,
    });
  },

  calcSpatialDimensionsBl: (link: LinkItem, adjustBl?: Dimensions): Dimensions => {
    function noLinkTo() {
      assert(!adjustBl, "size adjustment on empty link item unexpected.");
      return { w: link.spatialWidthGr / GRID_SIZE, h: 1.0 };
    }
    if (LinkFns.getLinkToId(link) == EMPTY_UID) { return noLinkTo(); }
    const measurableMaybe = constructLinkToMeasurable(link);
    if (measurableMaybe == null) { return noLinkTo(); }
    return ItemFns.calcSpatialDimensionsBl(measurableMaybe!, adjustBl);
  },

  calcGeometry_Spatial: (link: LinkItem, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, parentIsPopup: boolean, emitHitboxes: boolean, isPopup: boolean, hasPendingChanges: boolean, editing: boolean, smallScreenMode: boolean): ItemGeometry => {
    function noLinkTo(): ItemGeometry {
      const sizeBl = LinkFns.calcSpatialDimensionsBl(link);
      const blockSizePx = {
        w: containerBoundsPx.w / containerInnerSizeBl.w,
        h: containerBoundsPx.h / containerInnerSizeBl.h
      };
      const boundsPx = {
        x: (link.spatialPositionGr.x / GRID_SIZE) * blockSizePx.w + containerBoundsPx.x,
        y: (link.spatialPositionGr.y / GRID_SIZE) * blockSizePx.h + containerBoundsPx.y,
        w: sizeBl.w * blockSizePx.w + ITEM_BORDER_WIDTH_PX,
        h: sizeBl.h * blockSizePx.h + ITEM_BORDER_WIDTH_PX,
      };
      const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
      return {
        boundsPx,
        blockSizePx,
        viewportBoundsPx: null,
        hitboxes: !emitHitboxes ? [] : [
          HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
          HitboxFns.create(HitboxFlags.TriangleLinkSettings, { x: 0, y: 0, w: LINK_TRIANGLE_SIZE_PX + 2, h: LINK_TRIANGLE_SIZE_PX + 2 }),
          HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
        ],
      }
    }

    if (LinkFns.getLinkToId(link) == EMPTY_UID) { return noLinkTo(); }
    const measurableMaybe = constructLinkToMeasurable(link);
    if (measurableMaybe == null) { return noLinkTo(); }

    const result = ItemFns.calcGeometry_Spatial(measurableMaybe, containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes, isPopup, hasPendingChanges, editing, smallScreenMode);

    let insertPos = result.hitboxes.length;
    if (result.hitboxes.length > 0 && result.hitboxes[result.hitboxes.length-1].type == HitboxFlags.Resize) {
      insertPos = result.hitboxes.length - 1;
    }
    result.hitboxes.splice(insertPos, 0, HitboxFns.create(HitboxFlags.TriangleLinkSettings, { x: 0, y: 0, w: LINK_TRIANGLE_SIZE_PX + 2, h: LINK_TRIANGLE_SIZE_PX + 2 }))

    return result;
  },

  calcGeometry_InComposite: (link: LinkItem, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number, smallScreenMode: boolean): ItemGeometry => {
    function noLinkTo(): ItemGeometry {
      const boundsPx = {
        x: leftMarginBl * blockSizePx.w,
        y: topPx,
        w: compositeWidthBl * blockSizePx.w,
        h: blockSizePx.h
      };
      const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
      const moveBoundsPx = {
        x: innerBoundsPx.w
            - COMPOSITE_MOVE_OUT_AREA_SIZE_PX
            - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
            - CONTAINER_IN_COMPOSITE_PADDING_PX
            - COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX,
        y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
        w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
        h: innerBoundsPx.h - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
      };
      return {
        boundsPx,
        blockSizePx,
        viewportBoundsPx: null,
        hitboxes: [
          HitboxFns.create(HitboxFlags.TriangleLinkSettings, { x: 0, y: 0, w: LINK_TRIANGLE_SIZE_PX + 2, h: LINK_TRIANGLE_SIZE_PX + 2 }),
          HitboxFns.create(HitboxFlags.Move, moveBoundsPx),
          HitboxFns.create(HitboxFlags.AttachComposite, {
            x: innerBoundsPx.w / 4,
            y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
            w: innerBoundsPx.w / 2,
            h: ATTACH_AREA_SIZE_PX,
          }),
        ]
      };
    }

    if (LinkFns.getLinkToId(link) == EMPTY_UID) { return noLinkTo(); }
    const measurableMaybe = constructLinkToMeasurable(link);
    if (measurableMaybe == null) { return noLinkTo(); }

    const result = ItemFns.calcGeometry_InComposite(measurableMaybe!, blockSizePx, compositeWidthBl, leftMarginBl, topPx, smallScreenMode);
    let insertPos = result.hitboxes.length;
    result.hitboxes.splice(insertPos, 0, HitboxFns.create(HitboxFlags.TriangleLinkSettings, { x: 0, y: 0, w: LINK_TRIANGLE_SIZE_PX + 2, h: LINK_TRIANGLE_SIZE_PX + 2 }))
    return result;
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

  calcGeometry_ListItem: (link: LinkItem, blockSizePx: Dimensions, row: number, col: number, widthBl: number, parentIsPopup: boolean, padTop: boolean, expandable: boolean, inTable: boolean): ItemGeometry => {
    function noLinkTo(): ItemGeometry {
      const scale = blockSizePx.h / LINE_HEIGHT_PX;
      const boundsPx = {
        x: blockSizePx.w * col,
        y: blockSizePx.h * row + (padTop ? LIST_PAGE_TOP_PADDING_PX * scale : 0),
        w: blockSizePx.w * widthBl,
        h: blockSizePx.h
      };
      const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
      return {
        boundsPx,
        blockSizePx,
        viewportBoundsPx: null,
        hitboxes: [
          HitboxFns.create(HitboxFlags.TriangleLinkSettings, { x: 0, y: 0, w: LINK_TRIANGLE_SIZE_PX + 2, h: LINK_TRIANGLE_SIZE_PX + 2 }),
          HitboxFns.create(HitboxFlags.Move, zeroBoundingBoxTopLeft(boundsPx)),
        ]
      };
    }
  
    if (LinkFns.getLinkToId(link) == EMPTY_UID) { return noLinkTo(); }
    const measurableMaybe = constructLinkToMeasurable(link);
    if (measurableMaybe == null) { return noLinkTo(); }

    const result = ItemFns.calcGeometry_ListItem(measurableMaybe!, blockSizePx, row, col, widthBl, parentIsPopup, padTop, expandable, inTable);

    let insertPos = result.hitboxes.length;
    result.hitboxes.splice(insertPos, 0, HitboxFns.create(HitboxFlags.TriangleLinkSettings, { x: 0, y: 0, w: LINK_TRIANGLE_SIZE_PX + 2, h: LINK_TRIANGLE_SIZE_PX + 2 }))

    return result;
  },

  calcGeometry_InCell: (link: LinkItem, cellBoundsPx: BoundingBox, expandable: boolean, parentIsPopup: boolean, parentIsDock: boolean, isPopup: boolean, hasPendingChanges: boolean, maximize: boolean, ignoreCellHeight: boolean, smallScreenMode: boolean): ItemGeometry => {
    const sizeBl = LinkFns.calcSpatialDimensionsBl(link);
    const boundsPx = cloneBoundingBox(cellBoundsPx)!;
    const blockSizePx = {
      w: boundsPx.w / sizeBl.w,
      h: boundsPx.h / sizeBl.h,
    };
    function noLinkTo(): ItemGeometry {
      const calculatedBoundsPx = calcBoundsInCellFromSizeBl(sizeBl, cellBoundsPx);
      const calculatedBlockSizePx = {
        w: calculatedBoundsPx.w / sizeBl.w,
        h: calculatedBoundsPx.h / sizeBl.h,
      };
      const innerBoundsPx = zeroBoundingBoxTopLeft(calculatedBoundsPx);
      return ({
        boundsPx: cloneBoundingBox(calculatedBoundsPx)!,
        blockSizePx: calculatedBlockSizePx,
        viewportBoundsPx: null,
        hitboxes: [
          HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
          HitboxFns.create(HitboxFlags.Click, innerBoundsPx)
        ]
      });
    }

    if (LinkFns.getLinkToId(link) == EMPTY_UID) { return noLinkTo(); }
    const measurableMaybe = constructLinkToMeasurable(link);
    if (measurableMaybe == null) { return noLinkTo(); }
    return ItemFns.calcGeometry_InCell(measurableMaybe!, cellBoundsPx, expandable, parentIsPopup, parentIsDock, isPopup, hasPendingChanges, maximize, ignoreCellHeight, smallScreenMode);
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
      linkTo: link.linkTo,
      linkToResolvedId: link.linkToResolvedId,
    });
  },

  debugSummary: (linkItem: LinkItem) => {
    return "[link] " + linkItem.linkTo;
  },

  getLinkToId: (linkItem: LinkMeasurable): Uid => {
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
    if (linkedToItemMaybe == null) { return "_" + linkToId + "_"; }
    return linkToId + "_" + ItemFns.getFingerprint(linkedToItemMaybe!);
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
