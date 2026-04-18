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

import { ATTACH_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX, RESIZE_BOX_SIZE_PX } from "../constants";
import { arrangeNow } from "../layout/arrange";
import { HitboxFlags, HitboxFns } from "../layout/hitbox";
import { ItemGeometry } from "../layout/item-geometry";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VisualElement, VeFns } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from "../util/geometry";
import { currentUnixTimeSeconds, panic } from "../util/lang";
import { EMPTY_UID, Uid, newUid } from "../util/uid";
import { calcGeometryOfAttachmentItemImpl } from "./base/attachments-item";
import { calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe } from "./base/item-common-fns";
import { Item, ItemType, ItemTypeMixin } from "./base/item";
import { PositionalMixin } from "./base/positional-item";
import { XSizableMixin } from "./base/x-sizeable-item";


const DEFAULT_WIDTH_GR = GRID_SIZE * 4;

export interface SearchItem extends SearchMeasurable, Item { }
export interface SearchMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin { }


export const SearchFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, ordering: Uint8Array): SearchItem => {
    if (parentId == EMPTY_UID) { panic("SearchFns.create: parent is empty."); }
    return {
      origin: null,
      itemType: ItemType.Search,
      ownerId,
      id: newUid(),
      parentId,
      relationshipToParent,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      dateTime: currentUnixTimeSeconds(),
      ordering,
      spatialPositionGr: { x: 0.0, y: 0.0 },
      spatialWidthGr: DEFAULT_WIDTH_GR,
    };
  },

  fromObject: (o: any, origin: string | null): SearchItem => {
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
      spatialPositionGr: o.spatialPositionGr ?? { x: 0.0, y: 0.0 },
      spatialWidthGr: o.spatialWidthGr ?? DEFAULT_WIDTH_GR,
    });
  },

  toObject: (search: SearchItem): object => {
    return ({
      itemType: search.itemType,
      ownerId: search.ownerId,
      id: search.id,
      parentId: search.parentId,
      relationshipToParent: search.relationshipToParent,
      creationDate: search.creationDate,
      lastModifiedDate: search.lastModifiedDate,
      dateTime: search.dateTime,
      ordering: Array.from(search.ordering),
      spatialPositionGr: search.spatialPositionGr,
      spatialWidthGr: search.spatialWidthGr,
    });
  },

  calcSpatialDimensionsBl: (search: SearchMeasurable): Dimensions => {
    return { w: search.spatialWidthGr / GRID_SIZE, h: 1.0 };
  },

  calcGeometry_Spatial: (search: SearchMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
    const sizeBl = SearchFns.calcSpatialDimensionsBl(search);
    const blockSizePx = {
      w: containerBoundsPx.w / containerInnerSizeBl.w,
      h: containerBoundsPx.h / containerInnerSizeBl.h
    };
    const boundsPx = {
      x: (search.spatialPositionGr.x / GRID_SIZE) * blockSizePx.w + containerBoundsPx.x,
      y: (search.spatialPositionGr.y / GRID_SIZE) * blockSizePx.h + containerBoundsPx.y,
      w: sizeBl.w * blockSizePx.w + ITEM_BORDER_WIDTH_PX,
      h: sizeBl.h * blockSizePx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: emitHitboxes ? [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Resize, {
          x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX,
          y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX,
          w: RESIZE_BOX_SIZE_PX,
          h: RESIZE_BOX_SIZE_PX,
        }),
      ] : [],
    };
  },

  calcGeometry_InComposite: (_search: SearchMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: blockSizePx.h,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: 0,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w,
          h: ATTACH_AREA_SIZE_PX,
        }),
      ],
    };
  },

  calcGeometry_Attachment: (search: SearchMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(search, parentBoundsPx, parentInnerSizeBl, index, isSelected, false);
  },

  calcGeometry_ListItem: (_search: SearchMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean, _expandable: boolean): ItemGeometry => {
    const scale = blockSizePx.h / LINE_HEIGHT_PX;
    const innerBoundsPx = {
      x: 0.0,
      y: 0.0,
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const boundsPx = {
      x: blockSizePx.w * col,
      y: blockSizePx.h * row + (padTop ? LIST_PAGE_TOP_PADDING_PX * scale : 0),
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
      ],
    };
  },

  calcGeometry_InCell: (search: SearchMeasurable, cellBoundsPx: BoundingBox, maximize: boolean): ItemGeometry => {
    const sizeBl = SearchFns.calcSpatialDimensionsBl(search);
    const boundsPx = maximize ? cloneBoundingBox(cellBoundsPx)! : calcBoundsInCellFromSizeBl(sizeBl, cellBoundsPx);
    const blockSizePx = {
      w: boundsPx.w / sizeBl.w,
      h: boundsPx.h / sizeBl.h,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return ({
      boundsPx: cloneBoundingBox(boundsPx)!,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Resize, {
          x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX,
          y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX,
          w: RESIZE_BOX_SIZE_PX,
          h: RESIZE_BOX_SIZE_PX,
        }),
      ],
    });
  },

  asSearchMeasurable: (item: ItemTypeMixin): SearchMeasurable => {
    if (item.itemType == ItemType.Search) { return item as SearchMeasurable; }
    panic("not search measurable.");
  },

  handleClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    store.history.setFocus(VeFns.veToPath(visualElement));
    arrangeNow(store, "search-click");
  },

  handleLinkClick: (_visualElement: VisualElement): void => {
    // Search is a placeholder item type for now.
  },

  cloneMeasurableFields: (search: SearchMeasurable): SearchMeasurable => {
    return ({
      itemType: search.itemType,
      spatialPositionGr: search.spatialPositionGr,
      spatialWidthGr: search.spatialWidthGr,
    });
  },

  debugSummary: (_searchItem: SearchItem) => {
    return "[search]";
  },

  getFingerprint: (_searchItem: SearchItem): string => {
    return "";
  }
};


export function isSearch(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Search;
}

export function asSearchItem(item: ItemTypeMixin): SearchItem {
  if (item.itemType == ItemType.Search) { return item as SearchItem; }
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not a search.`);
}
