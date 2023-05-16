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

import { GRID_SIZE, RESIZE_BOX_SIZE_PX } from "../../../constants";
import { HitboxType } from "../hitbox";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft, Dimensions } from "../../../util/geometry";
import { currentUnixTimeSeconds, notImplemented, panic } from "../../../util/lang";
import { newUid, Uid } from "../../../util/uid";
import { AttachmentsItem } from "./base/attachments-item";
import { ContainerItem } from "./base/container-item";
import { Item, ItemTypeMixin, ITEM_TYPE_TABLE } from "./base/item";
import { TitledItem } from "./base/titled-item";
import { XSizableItem, XSizableMixin } from "./base/x-sizeable-item";
import { YSizableItem, YSizableMixin } from "./base/y-sizeable-item";
import { ItemGeometry } from "../item-geometry";
import { PositionalMixin } from "./base/positional-item";
import { createBooleanSignal, createNumberSignal, createUidArraySignal, createVectorSignal, NumberSignal } from "../../../util/signals";


export interface TableColumn {
  name: String,
  widthGr: number,
}

export interface TableItem extends TableMeasurable, XSizableItem, YSizableItem, ContainerItem, AttachmentsItem, TitledItem {
  tableColumns: Array<TableColumn>;

  scrollYPx: NumberSignal;
}

export interface TableMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, YSizableMixin { }


export function newTableItem(ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): TableItem {
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
    spatialPositionGr: createVectorSignal({ x: 0.0, y: 0.0 }),

    spatialWidthGr: createNumberSignal(8.0 * GRID_SIZE),
    spatialHeightGr: createNumberSignal(6.0 * GRID_SIZE),

    tableColumns: [{
      name: "Title",
      widthGr: 8 * GRID_SIZE,
    }],

    computed_children: createUidArraySignal([]),
    computed_attachments: createUidArraySignal([]),

    computed_movingItemIsOver: createBooleanSignal(false),
    computed_mouseIsOver: createBooleanSignal(false),

    childrenLoaded: createBooleanSignal(false),

    scrollYPx: createNumberSignal(0)
  };
}

export function tableFromObject(o: any): TableItem {
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
    title: o.title,
    spatialPositionGr: createVectorSignal(o.spatialPositionGr),

    spatialWidthGr: createNumberSignal(o.spatialWidthGr),
    spatialHeightGr: createNumberSignal(o.spatialHeightGr),

    tableColumns: o.tableColumns,

    computed_children: createUidArraySignal([]),
    computed_attachments: createUidArraySignal([]),

    computed_movingItemIsOver: createBooleanSignal(false),
    computed_mouseIsOver: createBooleanSignal(false),

    childrenLoaded: createBooleanSignal(false),

    scrollYPx: createNumberSignal(0),
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
    spatialPositionGr: t.spatialPositionGr.get(),

    spatialWidthGr: t.spatialWidthGr.get(),
    spatialHeightGr: t.spatialHeightGr.get(),

    tableColumns: t.tableColumns,
  });
}


export function calcTableSizeForSpatialBl(table: TableMeasurable): Dimensions {
  return { w: table.spatialWidthGr.get() / GRID_SIZE, h: table.spatialHeightGr.get() / GRID_SIZE };
}

export function calcGeometryOfTableItem(table: TableMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, emitHitboxes: boolean): ItemGeometry {
  const innerBoundsPx = {
    x: 0.0,
    y: 0.0,
    w: calcTableSizeForSpatialBl(table).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcTableSizeForSpatialBl(table).h / containerInnerSizeBl.h * containerBoundsPx.h,
  };
  const boundsPx = {
    x: (table.spatialPositionGr.get().x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (table.spatialPositionGr.get().y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcTableSizeForSpatialBl(table).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcTableSizeForSpatialBl(table).h / containerInnerSizeBl.h * containerBoundsPx.h,
  };
  return {
    boundsPx,
    hitboxes: !emitHitboxes ? [] : [
      { type: HitboxType.Move, boundsPx: innerBoundsPx },
      { type: HitboxType.Resize,
        boundsPx: { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX,
                    w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX } }
    ],
  };
}

export function calcGeometryOfTableAttachmentItem(_table: TableMeasurable, containerBoundsPx: BoundingBox, index: number): ItemGeometry {
  const boundsPx = {
    x: containerBoundsPx.w - (20 * index),
    y: -5,
    w: 15,
    h: 10,
  };
  return {
    boundsPx,
    hitboxes: [],
  }
}

export function calcGeometryOfTableItemInTable(_table: TableMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
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
    hitboxes: [
      { type: HitboxType.Move, boundsPx: innerBoundsPx }
    ],
  };
}

export function calcGeometryOfTableItemInCell(_table: TableMeasurable, cellBoundsPx: BoundingBox): ItemGeometry {
  return {
    boundsPx: cloneBoundingBox(cellBoundsPx)!,
    hitboxes: [{ type: HitboxType.Click, boundsPx: zeroBoundingBoxTopLeft(cellBoundsPx) }]
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
  });
}
