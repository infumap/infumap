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

import { ItemGeometry } from "../layout/item-geometry";
import { Attachment } from "../layout/relationship-to-parent";
import { BoundingBox, Dimensions } from "../util/geometry";
import { currentUnixTimeSeconds, panic } from "../util/lang";
import { EMPTY_UID, Uid, newUid } from "../util/uid";
import { calcGeometryOfAttachmentItemImpl } from "./base/attachments-item";
import { ITEM_TYPE_PLACEHOLDER, Item, ItemTypeMixin } from "./base/item";

export interface PlaceholderItem extends PlaceholderMeasurable, Item {}
export interface PlaceholderMeasurable extends ItemTypeMixin {}


export function newPlaceholderItem(ownerId: Uid, parentId: Uid, relationshipToParent: string, ordering: Uint8Array): PlaceholderItem {
  if (relationshipToParent != Attachment) { panic(); }
  if (parentId == EMPTY_UID) { panic(); }
  return {
    itemType: ITEM_TYPE_PLACEHOLDER,
    ownerId,
    id: newUid(),
    parentId,
    relationshipToParent,
    creationDate: currentUnixTimeSeconds(),
    lastModifiedDate: currentUnixTimeSeconds(),
    ordering
  };
}

export function placeholderFromObject(o: any): PlaceholderItem {
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
  });
}

export function placeholderToObject(h: PlaceholderItem): object {
  return ({
    itemType: h.itemType,
    ownerId: h.ownerId,
    id: h.id,
    parentId: h.parentId,
    relationshipToParent: h.relationshipToParent,
    creationDate: h.creationDate,
    lastModifiedDate: h.lastModifiedDate,
    ordering: Array.from(h.ordering),
  });
}

export function calcPlaceholderSizeForSpatialBl(_item: PlaceholderMeasurable): Dimensions {
  // used when measuring attachment size.
  return { w: 1.0, h: 1.0 };
}

export function calcGeometryOfPlaceholderItem_Desktop(_placeholder: PlaceholderMeasurable, _containerBoundsPx: BoundingBox, _containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, _emitHitboxes: boolean): ItemGeometry {
  panic();
}

export function calcGeometryOfPlaceholderItem_InComposite(measurable: PlaceholderMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, topPx: number): ItemGeometry {
  panic();
}

export function calcGeometryOfPlaceholderItem_Attachment(placeholder: PlaceholderMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry {
  return calcGeometryOfAttachmentItemImpl(placeholder, parentBoundsPx, parentInnerSizeBl, index, isSelected, false);
}

export function calcGeometryOfPlaceholderItem_ListItem(_placeholder: PlaceholderMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
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

export function calcGeometryOfPlaceholderItem_Cell(_placeholder: PlaceholderMeasurable, _cellBoundsPx: BoundingBox): ItemGeometry {
  panic();
}

export function isPlaceholder(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ITEM_TYPE_PLACEHOLDER;
}

export function asPlaceholderItem(item: ItemTypeMixin): PlaceholderItem {
  if (item.itemType == ITEM_TYPE_PLACEHOLDER) { return item as PlaceholderItem; }
  panic();
}

export function asPlaceholderMeasurable(item: ItemTypeMixin): PlaceholderMeasurable {
  if (item.itemType == ITEM_TYPE_PLACEHOLDER) { return item as PlaceholderMeasurable; }
  panic();
}

export function clonePlaceholderMeasurableFields(placeholder: PlaceholderMeasurable): PlaceholderMeasurable {
  return ({
    itemType: placeholder.itemType,
  });
}

export function placeholderDebugSummary(_placeholderItem: PlaceholderItem) {
  return "[placeholder]";
}

export function getPlaceholderItemMightBeDirty(placeholderItem: PlaceholderItem): string {
  return "";
}
