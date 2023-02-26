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

import { Accessor, createSignal, Setter } from "solid-js";
import { GRID_SIZE, RESIZE_BOX_SIZE_PX } from "../../../constants";
import { HitboxType } from "../hitbox";
import { BoundingBox, cloneBoundingBox, zeroTopLeft, cloneVector, Dimensions } from "../../../util/geometry";
import { currentUnixTimeSeconds, panic } from "../../../util/lang";
import { newUid, Uid } from "../../../util/uid";
import { AttachmentsItem } from "./base/attachments-item";
import { ContainerItem } from "./base/container-item";
import { Item, ItemTypeMixin, ITEM_TYPE_TABLE } from "./base/item";
import { TitledItem } from "./base/titled-item";
import { XSizableItem, XSizableMixin } from "./base/x-sizeable-item";
import { YSizableItem, YSizableMixin } from "./base/y-sizeable-item";
import { ItemGeometry } from "../item-geometry";
import { PositionalMixin } from "./base/positional-item";


export interface TableColumn {
  name: String,
  widthGr: number,
}

export interface TableItem extends TableMeasurable, XSizableItem, YSizableItem, ContainerItem, AttachmentsItem, TitledItem {
  tableColumns: Array<TableColumn>;

  scrollYPx: Accessor<number>;
  setScrollYPx: Setter<number>;
}

export interface TableMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, YSizableMixin { }


export function calcTableSizeForSpatialBl(table: TableMeasurable, _getItem: (id: Uid) => (Item | null)): Dimensions {
  return { w: table.spatialWidthGr / GRID_SIZE, h: table.spatialHeightGr / GRID_SIZE };
}

export function calcGeometryOfTableItem(table: TableMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, emitHitboxes: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: (table.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (table.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcTableSizeForSpatialBl(table, getItem).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcTableSizeForSpatialBl(table, getItem).h / containerInnerSizeBl.h * containerBoundsPx.h,
  };
  return {
    boundsPx,
    hitboxes: !emitHitboxes ? [] : [
      { type: HitboxType.Move, boundsPx: zeroTopLeft(boundsPx) },
      { type: HitboxType.Resize,
        boundsPx: { x: boundsPx.w - RESIZE_BOX_SIZE_PX, y: boundsPx.h - RESIZE_BOX_SIZE_PX,
                    w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX } }
    ],
  };
}

export function calcGeometryOfTableAttachmentItem(_table: TableMeasurable, containerBoundsPx: BoundingBox, index: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
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

export function calcGeometryOfTableItemInTable(_table: TableMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: blockSizePx.w * col,
    y: blockSizePx.h * row,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  return {
    boundsPx,
    hitboxes: [
      { type: HitboxType.Move, boundsPx: zeroTopLeft(boundsPx) }
    ],
  };
}

export function calcGeometryOfTableItemInCell(_table: TableMeasurable, cellBoundsPx: BoundingBox, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  return ({
    boundsPx: cloneBoundingBox(cellBoundsPx)!,
    hitboxes: [{ type: HitboxType.Click, boundsPx: zeroTopLeft(cellBoundsPx) }]
  });
}

export function setTableDefaultComputed(item: TableItem): void {
  item.computed_mouseIsOver = false;
  item.computed_movingItemIsOver = false;
  item.computed_children = [];
  item.computed_attachments = [];
  const [scrollYPx, setScrollYPx] = createSignal<number>(0, { equals: false });
  item.scrollYPx = scrollYPx;
  item.setScrollYPx = setScrollYPx;
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

export function newTableItem(ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): TableItem {
  const [scrollYPx, setScrollYPx] = createSignal<number>(0, { equals: false });
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

    computed_children: [],
    computed_attachments: [],

    computed_movingItemIsOver: false,
    computed_mouseIsOver: false,

    // these will be per render area.
    scrollYPx, setScrollYPx,
  };
}

export function cloneTableMeasurableFields(table: TableMeasurable): TableMeasurable {
  return ({
    itemType: table.itemType,
    spatialPositionGr: cloneVector(table.spatialPositionGr)!,
    spatialWidthGr: table.spatialWidthGr,
    spatialHeightGr: table.spatialHeightGr,
  });
}
