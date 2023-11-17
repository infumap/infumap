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

import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, RESIZE_BOX_SIZE_PX } from "../constants";
import { HitboxFlags, HitboxFns, HitboxMeta } from "../layout/hitbox";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft, Dimensions, Vector } from "../util/geometry";
import { currentUnixTimeSeconds, panic } from "../util/lang";
import { EMPTY_UID, newUid, Uid } from "../util/uid";
import { AttachmentsItem, asAttachmentsItem, calcGeometryOfAttachmentItemImpl, isAttachmentsItem } from "./base/attachments-item";
import { ContainerItem } from "./base/container-item";
import { Item, ItemTypeMixin, ItemType } from "./base/item";
import { TitledItem } from "./base/titled-item";
import { XSizableItem, XSizableMixin } from "./base/x-sizeable-item";
import { YSizableItem, YSizableMixin } from "./base/y-sizeable-item";
import { ItemGeometry } from "../layout/item-geometry";
import { PositionalMixin } from "./base/positional-item";
import { FlagsMixin, TableFlags } from "./base/flags-item";
import { VeFns, VisualElement } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe } from "./base/item-common-fns";
import { COL_HEADER_HEIGHT_BL, HEADER_HEIGHT_BL } from "../components/items/Table";
import { itemState } from "../store/ItemState";
import { PlaceholderFns } from "./placeholder-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { server } from "../server";
import { ItemFns } from "./base/item-polymorphism";
import { arrange } from "../layout/arrange";


export interface TableItem extends TableMeasurable, XSizableItem, YSizableItem, ContainerItem, AttachmentsItem, TitledItem { }

export interface TableMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, YSizableMixin, FlagsMixin {
  tableColumns: Array<TableColumn>;
}

export interface TableColumn {
  name: string,
  widthGr: number,
}


export const TableFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): TableItem => {
    if (parentId == EMPTY_UID) { panic("TableFns.create: parent is empty."); }
    return {
      origin: null,
      itemType: ItemType.Table,
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

      flags: TableFlags.None,

      orderChildrenBy: "",

      computed_children: [],
      computed_attachments: [],

      childrenLoaded: false,
    };
  },

  fromObject: (o: any, origin: string | null): TableItem => {
    // TODO (LOW): dynamic type check of o.
    // TODO (LOW): check flags field.
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
  },

  toObject: (t: TableItem): object => {
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
  },

  calcSpatialDimensionsBl: (table: TableMeasurable): Dimensions => {
    return { w: table.spatialWidthGr / GRID_SIZE, h: table.spatialHeightGr / GRID_SIZE };
  },

  calcGeometry_Spatial: (table: TableMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
    const tableSizeBl: Dimensions = TableFns.calcSpatialDimensionsBl(table);
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
    const titleBoundsPx = {
      x: 0, y: 0,
      w: innerBoundsPx.w,
      h: blockSizePx.h,
    };
    let accumBl = 0;
    let colResizeHitboxes = [];
    let colClickHitboxes = [];
    for (let i=0; i<table.tableColumns.length; ++i) {
      const startBl = accumBl;
      const startXPx = accumBl * blockSizePx.w - RESIZE_BOX_SIZE_PX / 2;
      accumBl += table.tableColumns[i].widthGr / GRID_SIZE;
      let endXPx = accumBl * blockSizePx.w - RESIZE_BOX_SIZE_PX / 2;
      let endBl = accumBl;
      if (endXPx > innerBoundsPx.w) {
        endXPx = innerBoundsPx.w;
        endBl = table.spatialWidthGr / GRID_SIZE;
      }
      if (i == table.tableColumns.length-1) {
        endXPx = innerBoundsPx.w;
        endBl = endBl = table.spatialWidthGr / GRID_SIZE;
      }
      if (accumBl < table.spatialWidthGr / GRID_SIZE && i < table.tableColumns.length-1) {
        colResizeHitboxes.push(HitboxFns.create(
          HitboxFlags.ColResize,
          { x: endXPx, y: blockSizePx.h, w: RESIZE_BOX_SIZE_PX, h: containerBoundsPx.h - blockSizePx.h },
          HitboxFns.createMeta({ colNum: i })
        ));
      }
      if (table.flags & TableFlags.ShowColHeader) {
        colClickHitboxes.push(HitboxFns.create(
          HitboxFlags.Click,
          { x: startXPx, y: blockSizePx.h, w: endXPx - startXPx, h: blockSizePx.h },
          HitboxFns.createMeta({ colNum: i, startBl, endBl })
        ));
      }
      if (accumBl >= table.spatialWidthGr / GRID_SIZE) { break; }
    }
    return {
      boundsPx,
      hitboxes: !emitHitboxes ? [] : [
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
        ...colResizeHitboxes,
        ...colClickHitboxes,
        HitboxFns.create(HitboxFlags.Click, titleBoundsPx),
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      ],
    };
  },

  calcGeometry_InComposite: (measurable: TableMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, topPx: number): ItemGeometry => {
    let cloned = TableFns.asTableMeasurable(ItemFns.cloneMeasurableFields(measurable));
    cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    const sizeBl = TableFns.calcSpatialDimensionsBl(cloned);
    const boundsPx = {
      x: 0,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: sizeBl.h * blockSizePx.h
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveBoundsPx = {
      x: innerBoundsPx.w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
    };
    return {
      boundsPx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, moveBoundsPx),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: innerBoundsPx.w / 4,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w / 2,
          h: ATTACH_AREA_SIZE_PX,
        }),
      ]
    };
  },

  calcGeometry_Attachment: (table: TableMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(table, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_table: TableMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry => {
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
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx)
      ]
    };
  },

  calcGeometry_Cell: (table: TableMeasurable, cellBoundsPx: BoundingBox): ItemGeometry => {
    const boundsPx = calcBoundsInCellFromSizeBl(TableFns.calcSpatialDimensionsBl(table), cellBoundsPx);
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return {
      boundsPx: cloneBoundingBox(boundsPx)!,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      ]
    };
  },

  asTableMeasurable: (item: ItemTypeMixin): TableMeasurable => {
    if (item.itemType == ItemType.Table) { return item as TableMeasurable; }
    panic("not table measurable.");
  },

  handleClick: (visualElement: VisualElement, hitboxMeta: HitboxMeta | null, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    store.overlay.tableEditOverlayInfo.set({
      itemPath: VeFns.veToPath(visualElement),
      colNum: hitboxMeta == null ? null : hitboxMeta.colNum!,
      startBl: hitboxMeta == null ? null : hitboxMeta.startBl!,
      endBl: hitboxMeta == null ? null : hitboxMeta.endBl!,
    });
    arrange(store); // input focus changed.
  },

  cloneMeasurableFields: (table: TableMeasurable): TableMeasurable => {
    return ({
      itemType: table.itemType,
      spatialPositionGr: table.spatialPositionGr,
      spatialWidthGr: table.spatialWidthGr,
      spatialHeightGr: table.spatialHeightGr,
      tableColumns: table.tableColumns,
      flags: table.flags,
    });
  },

  debugSummary: (tableItem: TableItem) => {
    return "[table] " + tableItem.title;
  },

  getFingerprint: (tableItem: TableItem): string => {
    return tableItem.title + "~~~!@#~~~" + tableItem.flags;
  },

  columnWidthBl: (tableItem: TableItem, index: number): number => {
    if (index == tableItem.tableColumns.length - 1) {
      let accumBl = 0;
      for (let i=0; i<tableItem.tableColumns.length - 1; ++i) {
        accumBl += tableItem.tableColumns[i].widthGr / GRID_SIZE;
      }
      let result = tableItem.spatialWidthGr / GRID_SIZE - accumBl;
      if (result < 1) { result = 1; } // naive sanitize.
      return result;
    }
    return tableItem.tableColumns[index].widthGr / GRID_SIZE;
  },

  tableModifiableColRow(store: StoreContextModel, tableVe: VisualElement, desktopPx: Vector): { insertRow: number, attachmentPos: number} {
    const tableItem = asTableItem(tableVe.displayItem);
    const tableDimensionsBl: Dimensions = {
      w: (tableVe.linkItemMaybe ? tableVe.linkItemMaybe.spatialWidthGr : tableItem.spatialWidthGr) / GRID_SIZE,
      h: (tableVe.linkItemMaybe ? tableVe.linkItemMaybe.spatialHeightGr : tableItem.spatialHeightGr) / GRID_SIZE
    };
    const tableBoundsPx = VeFns.veBoundsRelativeToDestkopPx(store, tableVe);

    // col
    const mousePropX = (desktopPx.x - tableBoundsPx.x) / tableBoundsPx.w;
    const tableXBl = Math.floor(mousePropX * tableDimensionsBl.w * 2.0) / 2.0;
    let accumBl = 0;
    let colNumber = tableItem.tableColumns.length - 1;
    for (let i=0; i<tableItem.tableColumns.length; ++i) {
      accumBl += tableItem.tableColumns[i].widthGr / GRID_SIZE;
      if (accumBl >= tableDimensionsBl.w) {
        colNumber = i;
        break;
      }
      if (tableXBl < accumBl) {
        colNumber = i;
        break;
      }
    }
    const attachmentPos = colNumber - 1;

    // row
    const mousePropY = (desktopPx.y - tableBoundsPx.y) / tableBoundsPx.h;
    const rawTableRowNumber = attachmentPos == -1 ? Math.round(mousePropY * tableDimensionsBl.h) : Math.floor(mousePropY * tableDimensionsBl.h);
    const yScrollPos = store.getTableScrollYPos(VeFns.veidFromVe(tableVe));
    let insertRow = rawTableRowNumber + yScrollPos - HEADER_HEIGHT_BL - ((tableItem.flags & TableFlags.ShowColHeader) ? COL_HEADER_HEIGHT_BL : 0);
    if (insertRow < yScrollPos) { insertRow = yScrollPos; }
    insertRow -= insertRow > tableItem.computed_children.length
      ? insertRow - tableItem.computed_children.length
      : 0;

    return { insertRow, attachmentPos };
  },

  insertEmptyColAt(tableId: Uid, colPos: number) {
    const tableItem = asTableItem(itemState.get(tableId)!);
    for (let i=0; i<tableItem.computed_children.length; ++i) {
      const child = itemState.get(tableItem.computed_children[i])!;
      if (!isAttachmentsItem(child)) { continue; }
      const attachments = asAttachmentsItem(child).computed_attachments;
      if (colPos >= attachments.length) { continue; }
      const ordering = itemState.newOrderingAtAttachmentsPosition(child.id, colPos);
      const placeholderItem = PlaceholderFns.create(child.ownerId, child.id, RelationshipToParent.Attachment, ordering);
      itemState.add(placeholderItem);
      server.addItem(placeholderItem, null);
    }
  },

  removeColItemsAt(tableId: Uid, colPos: number) {
    const tableItem = asTableItem(itemState.get(tableId)!);
    for (let i=0; i<tableItem.computed_children.length; ++i) {
      const child = itemState.get(tableItem.computed_children[i])!;
      if (!isAttachmentsItem(child)) { continue; }
      const attachments = asAttachmentsItem(child).computed_attachments;
      if (colPos >= attachments.length) { continue; }
      const attachmentId = attachments[colPos];
      itemState.delete(attachmentId);
      server.deleteItem(attachmentId);
    }
  },

};


export function isTable(item: Item | ItemTypeMixin): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Table;
}

export function asTableItem(item: ItemTypeMixin): TableItem {
  if (item.itemType == ItemType.Table) { return item as TableItem; }
  panic("not table item.");
}
