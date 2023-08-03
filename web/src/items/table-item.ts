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
import { HitboxType, createHitbox, createHitboxMeta } from "../layout/hitbox";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft, Dimensions } from "../util/geometry";
import { currentUnixTimeSeconds, panic } from "../util/lang";
import { EMPTY_UID, newUid, Uid } from "../util/uid";
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from "./base/attachments-item";
import { ContainerItem } from "./base/container-item";
import { Item, ItemTypeMixin, ITEM_TYPE_TABLE } from "./base/item";
import { TitledItem } from "./base/titled-item";
import { XSizableItem, XSizableMixin } from "./base/x-sizeable-item";
import { YSizableItem, YSizableMixin } from "./base/y-sizeable-item";
import { ItemGeometry } from "../layout/item-geometry";
import { PositionalMixin } from "./base/positional-item";
import { FlagsMixin, ItemFlagsType } from "./base/flags-item";


export interface TableColumn {
  name: string,
  widthGr: number,
}

export interface TableItem extends TableMeasurable, XSizableItem, YSizableItem, ContainerItem, AttachmentsItem, TitledItem {
}

export interface TableMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, YSizableMixin, FlagsMixin {
  tableColumns: Array<TableColumn>;
}


export function newTableItem(ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): TableItem {
  if (parentId == EMPTY_UID) { panic(); }
  return {
    itemType: ITEM_TYPE_TABLE,
    ownerId,
    id: newUid(),
    parentId,
    relationshipToParent,
    creationDate: currentUnixTimeSeconds(),
    lastModifiedDate: currentUnixTimeSeconds(),
    ordering,
    title,
    spatialPositionGr: { x: 0.0, y: 0.0 },

    spatialWidthGr: 8.0 * GRID_SIZE,
    spatialHeightGr: 6.0 * GRID_SIZE,

    tableColumns: [{
      name: "Title",
      widthGr: 8 * GRID_SIZE,
    }],

    flags: ItemFlagsType.None,

    orderChildrenBy: "",

    computed_children: [],
    computed_attachments: [],

    childrenLoaded: false,
  };
}

export function tableFromObject(o: any): TableItem {
  // TODO (LOW): dynamic type check of o.
  // TODO (LOW): check flags field.
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
    spatialHeightGr: o.spatialHeightGr,

    tableColumns: o.tableColumns,
    flags: o.flags,

    orderChildrenBy: o.orderChildrenBy,

    computed_children: [],
    computed_attachments: [],

    childrenLoaded: false,
  });
}

export function tableToObject(t: TableItem): object {
  return ({
    itemType: t.itemType,
    ownerId: t.ownerId,
    id: t.id,
    parentId: t.parentId,
    relationshipToParent: t.relationshipToParent,
    creationDate: t.creationDate,
    lastModifiedDate: t.lastModifiedDate,
    ordering: Array.from(t.ordering),
    title: t.title,
    spatialPositionGr: t.spatialPositionGr,

    spatialWidthGr: t.spatialWidthGr,
    spatialHeightGr: t.spatialHeightGr,

    tableColumns: t.tableColumns,
    flags: t.flags,

    orderChildrenBy: t.orderChildrenBy,
  });
}


export function calcTableSizeForSpatialBl(table: TableMeasurable): Dimensions {
  return { w: table.spatialWidthGr / GRID_SIZE, h: table.spatialHeightGr / GRID_SIZE };
}

export function calcGeometryOfTableItem_Desktop(table: TableMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry {
  const tableSizeBl: Dimensions = calcTableSizeForSpatialBl(table);
  const boundsPx: BoundingBox = {
    x: (table.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (table.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: tableSizeBl.w / containerInnerSizeBl.w * containerBoundsPx.w + ITEM_BORDER_WIDTH_PX,
    h: tableSizeBl.h / containerInnerSizeBl.h * containerBoundsPx.h + ITEM_BORDER_WIDTH_PX,
  };
  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  const blockSizePx: Dimensions = {
    w: innerBoundsPx.w / tableSizeBl.w,
    h: innerBoundsPx.h / tableSizeBl.h
  };
  let accumBl = 0;
  let colResizeHitboxes = [];
  for (let i=0; i<table.tableColumns.length-1; ++i) {
    accumBl += table.tableColumns[i].widthGr / GRID_SIZE;
    if (accumBl >= table.spatialWidthGr / GRID_SIZE) { break; }
    colResizeHitboxes.push(
      createHitbox(
        HitboxType.ColResize,
        { x: accumBl * blockSizePx.w - RESIZE_BOX_SIZE_PX/2, y: blockSizePx.h, w: RESIZE_BOX_SIZE_PX, h: containerBoundsPx.h - blockSizePx.h },
        createHitboxMeta({ resizeColNumber: i })
      ));
  }
  return {
    boundsPx,
    hitboxes: !emitHitboxes ? [] : [
      createHitbox(HitboxType.Move, innerBoundsPx),
      createHitbox(HitboxType.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
      ...colResizeHitboxes,
      createHitbox(HitboxType.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
    ],
  };
}

export function calcGeometryOfTableItem_Attachment(table: TableMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry {
  return calcGeometryOfAttachmentItemImpl(table, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
}

export function calcGeometryOfTableItem_ListItem(_table: TableMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
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
    hitboxes: [ createHitbox(HitboxType.Move, innerBoundsPx) ]
  };
}

export function calcGeometryOfTableItem_Cell(_table: TableMeasurable, cellBoundsPx: BoundingBox): ItemGeometry {
  return {
    boundsPx: cloneBoundingBox(cellBoundsPx)!,
    hitboxes: [ createHitbox(HitboxType.Click, zeroBoundingBoxTopLeft(cellBoundsPx)) ]
  };
}

export function isTable(item: Item | ItemTypeMixin): boolean {
  if (item == null) { return false; }
  return item.itemType == ITEM_TYPE_TABLE;
}

export function asTableItem(item: ItemTypeMixin): TableItem {
  if (item.itemType == ITEM_TYPE_TABLE) { return item as TableItem; }
  panic();
}

export function asTableMeasurable(item: ItemTypeMixin): TableMeasurable {
  if (item.itemType == ITEM_TYPE_TABLE) { return item as TableMeasurable; }
  panic();
}

export function cloneTableMeasurableFields(table: TableMeasurable): TableMeasurable {
  return ({
    itemType: table.itemType,
    spatialPositionGr: table.spatialPositionGr,
    spatialWidthGr: table.spatialWidthGr,
    spatialHeightGr: table.spatialHeightGr,
    tableColumns: table.tableColumns,
    flags: table.flags,
  });
}

export function tableDebugSummary(tableItem: TableItem) {
  return "[table] " + tableItem.title;
}

export function getTableItemMightBeDirty(tableItem: TableItem): string {
  return tableItem.title;
}
