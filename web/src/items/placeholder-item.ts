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
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { BoundingBox, Dimensions } from "../util/geometry";
import { currentUnixTimeSeconds, panic } from "../util/lang";
import { EMPTY_UID, Uid, newUid } from "../util/uid";
import { calcGeometryOfAttachmentItemImpl } from "./base/attachments-item";
import { Item, ItemTypeMixin, ItemType } from "./base/item";

export interface PlaceholderItem extends PlaceholderMeasurable, Item { }
export interface PlaceholderMeasurable extends ItemTypeMixin { }


export const PlaceholderFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, ordering: Uint8Array): PlaceholderItem => {
    if (relationshipToParent != RelationshipToParent.Attachment) { panic("PlaceholderFns.create: relationshipToParent is not Attachment."); }
    if (parentId == EMPTY_UID) { panic("PlaceholderFns.create: parent is empty."); }
    return {
      origin: null,
      itemType: ItemType.Placeholder,
      ownerId,
      id: newUid(),
      parentId,
      relationshipToParent,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      ordering
    };
  },

  fromObject: (o: any, origin: string | null): PlaceholderItem => {
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
    });
  },

  toObject: (h: PlaceholderItem): object => {
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
  },

  calcSpatialDimensionsBl: (_item: PlaceholderMeasurable): Dimensions => {
    // used when measuring attachment size.
    return { w: 1.0, h: 1.0 };
  },

  calcGeometry_Spatial: (_placeholder: PlaceholderMeasurable, _containerBoundsPx: BoundingBox, _containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, _emitHitboxes: boolean): ItemGeometry => {
    panic("PlaceholderFns.calcGeometry_Spatial: not implemented.");
  },

  calcGeometry_InComposite: (_measurable: PlaceholderMeasurable, _blockSizePx: Dimensions, _compositeWidthBl: number, _topPx: number): ItemGeometry => {
    panic("PlaceholderFns.calcGeometry_InComposite: not implemented.");
  },

  calcGeometry_Attachment: (placeholder: PlaceholderMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(placeholder, parentBoundsPx, parentInnerSizeBl, index, isSelected, false);
  },

  calcGeometry_ListItem: (_placeholder: PlaceholderMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry => {
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
  },

  calcGeometry_InCell: (_placeholder: PlaceholderMeasurable, _cellBoundsPx: BoundingBox): ItemGeometry => {
    panic("PlaceholderFns.calcGeometry_Cell: not implemented.");
  },

  asPlaceholderMeasurable: (item: ItemTypeMixin): PlaceholderMeasurable => {
    if (item.itemType == ItemType.Placeholder) { return item as PlaceholderMeasurable; }
    panic("PlaceholderFns.asPlaceholderMeasurable: not implemented.");
  },

  cloneMeasurableFields: (placeholder: PlaceholderMeasurable): PlaceholderMeasurable => {
    return ({
      itemType: placeholder.itemType,
    });
  },

  debugSummary: (_placeholderItem: PlaceholderItem) => {
    return "[placeholder]";
  },

  getFingerprint: (_placeholderItem: PlaceholderItem): string => {
    return "";
  }
};


export function isPlaceholder(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Placeholder;
}

export function asPlaceholderItem(item: ItemTypeMixin): PlaceholderItem {
  if (item.itemType == ItemType.Placeholder) { return item as PlaceholderItem; }
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not a placeholder.`);
}
