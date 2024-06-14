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

import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LIST_PAGE_TOP_PADDING_PX, RESIZE_BOX_SIZE_PX, TABLE_COL_HEADER_HEIGHT_BL, TABLE_TITLE_HEADER_HEIGHT_BL } from "../constants";
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
import { VeFns, VisualElement, VisualElementFlags } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { calcBoundsInCell, calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe } from "./base/item-common-fns";
import { itemState } from "../store/ItemState";
import { PlaceholderFns } from "./placeholder-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { server } from "../server";
import { ItemFns } from "./base/item-polymorphism";
import { VesCache } from "../layout/ves-cache";
import { fullArrange } from "../layout/arrange";
import { closestCaretPositionToClientPx, setCaretPosition } from "../util/caret";
import { CursorEventState } from "../input/state";


export interface TableItem extends TableMeasurable, XSizableItem, YSizableItem, ContainerItem, AttachmentsItem, TitledItem { }

export interface TableMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, YSizableMixin, FlagsMixin {
  tableColumns: Array<TableColumn>;
  numberOfVisibleColumns: number;
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
      numberOfVisibleColumns: 1,

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
      numberOfVisibleColumns: o.numberOfVisibleColumns,

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
      numberOfVisibleColumns: t.numberOfVisibleColumns,

      flags: t.flags,

      orderChildrenBy: t.orderChildrenBy,
    });
  },

  calcSpatialDimensionsBl: (table: TableMeasurable): Dimensions => {
    return { w: table.spatialWidthGr / GRID_SIZE, h: table.spatialHeightGr / GRID_SIZE };
  },

  calcGeometry_Spatial: (table: TableMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
    const blockSizePx = {
      w: containerBoundsPx.w / containerInnerSizeBl.w,
      h: containerBoundsPx.h / containerInnerSizeBl.h
    };
    const tableSizeBl: Dimensions = TableFns.calcSpatialDimensionsBl(table);
    const boundsPx: BoundingBox = {
      x: (table.spatialPositionGr.x / GRID_SIZE) * blockSizePx.w + containerBoundsPx.x,
      y: (table.spatialPositionGr.y / GRID_SIZE) * blockSizePx.h + containerBoundsPx.y,
      w: tableSizeBl.w * blockSizePx.w + ITEM_BORDER_WIDTH_PX,
      h: tableSizeBl.h * blockSizePx.h + ITEM_BORDER_WIDTH_PX,
    };
    return calcTableGeometryImpl(table, boundsPx, blockSizePx, emitHitboxes);
  },

  calcGeometry_InComposite: (table: TableMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    let cloned = TableFns.asTableMeasurable(ItemFns.cloneMeasurableFields(table));
    cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    const sizeBl = TableFns.calcSpatialDimensionsBl(cloned);
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: sizeBl.h * blockSizePx.h
    };
    const result = calcTableGeometryImpl(table, boundsPx, blockSizePx, true);
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveBoundsPx = {
      x: innerBoundsPx.w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
    };
    const resizeHb = result.hitboxes.pop()!;
    result.hitboxes.push(HitboxFns.create(HitboxFlags.Move, moveBoundsPx));
    result.hitboxes.push(
      HitboxFns.create(HitboxFlags.AttachComposite, {
        x: innerBoundsPx.w / 4,
        y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
        w: innerBoundsPx.w / 2,
        h: ATTACH_AREA_SIZE_PX,
      }));
    result.hitboxes.push(resizeHb); // expected to be last.
    return result;
  },

  calcGeometry_Attachment: (table: TableMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(table, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_table: TableMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean, expandable: boolean): ItemGeometry => {
    const innerBoundsPx = {
      x: 0.0,
      y: 0.0,
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const boundsPx = {
      x: blockSizePx.w * col,
      y: blockSizePx.h * row + (padTop ? LIST_PAGE_TOP_PADDING_PX : 0),
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const clickAreaBoundsPx = {
      x: blockSizePx.w,
      y: 0.0,
      w: blockSizePx.w * (widthBl - 1),
      h: blockSizePx.h
    };
    const popupClickAreaBoundsPx = { x: 0.0, y: 0.0, w: blockSizePx.w, h: blockSizePx.h };
    const expandAreaBoundsPx = {
      x: boundsPx.w - blockSizePx.w,
      y: 0.0,
      w: blockSizePx.w,
      h: blockSizePx.h
    };
    const hitboxes = [
      HitboxFns.create(HitboxFlags.Click, clickAreaBoundsPx),
      HitboxFns.create(HitboxFlags.OpenPopup, popupClickAreaBoundsPx),
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
    ];
    if (expandable) {
      hitboxes.push(HitboxFns.create(HitboxFlags.Expand, expandAreaBoundsPx));
    }
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes
    };
  },

  calcGeometry_InCell: (table: TableMeasurable, cellBoundsPx: BoundingBox, maximize: boolean): ItemGeometry => {
    const sizeBl = TableFns.calcSpatialDimensionsBl(table);
    const boundsPx = maximize ? calcBoundsInCell(sizeBl, cellBoundsPx) : calcBoundsInCellFromSizeBl(sizeBl, cellBoundsPx);
    const blockSizePx = {
      w: boundsPx.w / sizeBl.w,
      h: boundsPx.h / sizeBl.h,
    };
    return calcTableGeometryImpl(table, boundsPx, blockSizePx, true);
  },

  asTableMeasurable: (item: ItemTypeMixin): TableMeasurable => {
    if (item.itemType == ItemType.Table) { return item as TableMeasurable; }
    panic("not table measurable.");
  },

  handleClick: (visualElement: VisualElement, hitboxMeta: HitboxMeta | null, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    const itemPath = VeFns.veToPath(visualElement);
    store.overlay.setTextEditInfo(store.history, {
      itemPath,
      itemType: ItemType.Table,
      colNum: hitboxMeta == null ? null : hitboxMeta.colNum!,
      startBl: hitboxMeta == null ? null : hitboxMeta.startBl!,
      endBl: hitboxMeta == null ? null : hitboxMeta.endBl!,
    });
    const editingPath = hitboxMeta == null ? itemPath + ":title" : itemPath + ":col" + hitboxMeta.colNum!;
    const el = document.getElementById(editingPath)!;
    el.focus();
    const closestIdx = closestCaretPositionToClientPx(el, CursorEventState.getLatestClientPx());
    setCaretPosition(el, closestIdx);
  },


  handlePopupClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    if (VesCache.get(visualElement.parentPath!)!.get().flags & VisualElementFlags.Popup) {
      store.history.pushPopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
      fullArrange(store);
    } else {
      store.history.replacePopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
      fullArrange(store);
    }
  },

  cloneMeasurableFields: (table: TableMeasurable): TableMeasurable => {
    return ({
      itemType: table.itemType,
      spatialPositionGr: table.spatialPositionGr,
      spatialWidthGr: table.spatialWidthGr,
      spatialHeightGr: table.spatialHeightGr,
      tableColumns: table.tableColumns,
      numberOfVisibleColumns: table.numberOfVisibleColumns,
      flags: table.flags,
    });
  },

  debugSummary: (tableItem: TableItem) => {
    return "[table] " + tableItem.title;
  },

  getFingerprint: (tableItem: TableItem): string => {
    let tableColText = "";
    for (let i=0; i<tableItem.tableColumns.length; ++i) { tableColText += tableItem.tableColumns[i].name + "!$!!@"; }
    return tableItem.title + "~~~!@#~~~" + tableItem.flags + "~~~%@#~~~" + tableColText + "~~~%^&~~~" + tableItem.numberOfVisibleColumns;
  },

  /**
   * Determine the block width of the column specified by index.
   * This may be wider than the tableColumn specification, if it's the last one.
   */
  columnWidthBl: (tableItem: TableItem, index: number): number => {
    let colLen = tableItem.tableColumns.length;
    if (colLen > tableItem.numberOfVisibleColumns) { colLen = tableItem.numberOfVisibleColumns; }
    if (index >= colLen - 1) {
      let accumBl = 0;
      for (let i=0; i<colLen - 1; ++i) {
        accumBl += tableItem.tableColumns[i].widthGr / GRID_SIZE;
      }
      let result = tableItem.spatialWidthGr / GRID_SIZE - accumBl;
      if (result < 1) { result = 1; } // naive sanitize.
      return result;
    }
    return tableItem.tableColumns[index].widthGr / GRID_SIZE;
  },

  /**
   * Given a desktop position desktopPx and table visual element, determine the table cell under desktopPx.
   * This may or not have an existing associated item.
   */
  tableModifiableColRow(store: StoreContextModel, tableVe: VisualElement, desktopPx: Vector): { insertRow: number, attachmentPos: number} {
    const tableItem = asTableItem(tableVe.displayItem);
    const tableDimensionsBl: Dimensions = {
      w: (tableVe.linkItemMaybe ? tableVe.linkItemMaybe.spatialWidthGr : tableItem.spatialWidthGr) / GRID_SIZE,
      h: (tableVe.linkItemMaybe ? tableVe.linkItemMaybe.spatialHeightGr : tableItem.spatialHeightGr) / GRID_SIZE
    };
    const tableBoundsPx = VeFns.veBoundsRelativeToDestkopPx(store, tableVe);

    // col
    let colLen = tableItem.tableColumns.length;
    if (colLen > tableItem.numberOfVisibleColumns) { colLen = tableItem.numberOfVisibleColumns; }
    const mousePropX = (desktopPx.x - tableBoundsPx.x) / tableBoundsPx.w;
    const tableXBl = Math.floor(mousePropX * tableDimensionsBl.w * 2.0) / 2.0;
    let accumBl = 0;
    let colNumber = colLen - 1;
    for (let i=0; i<colLen; ++i) {
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
    const yScrollPos = store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVe));
    let insertRow = rawTableRowNumber + yScrollPos - TABLE_TITLE_HEADER_HEIGHT_BL - ((tableItem.flags & TableFlags.ShowColHeader) ? TABLE_COL_HEADER_HEIGHT_BL : 0);
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
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not a table.`);
}


function calcTableGeometryImpl(table: TableMeasurable, boundsPx: BoundingBox, blockSizePx: Dimensions, emitHitboxes: boolean): ItemGeometry {
  let colLen = table.tableColumns.length;
  if (colLen > table.numberOfVisibleColumns) { colLen = table.numberOfVisibleColumns; }

  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  const titleBoundsPx = {
    x: 0, y: 0,
    w: innerBoundsPx.w,
    h: TABLE_TITLE_HEADER_HEIGHT_BL * blockSizePx.h,
  };
  const colHeaderHeightPxOrZero = table.flags & TableFlags.ShowColHeader ? TABLE_COL_HEADER_HEIGHT_BL * blockSizePx.h : 0;
  let accumBl = 0;
  let colResizeHitboxes = [];
  let colClickHitboxes = [];
  for (let i=0; i<colLen; ++i) {
    const startBl = accumBl;
    const startXPx = accumBl * blockSizePx.w - RESIZE_BOX_SIZE_PX / 2;
    accumBl += table.tableColumns[i].widthGr / GRID_SIZE;
    let endXPx = accumBl * blockSizePx.w - RESIZE_BOX_SIZE_PX / 2;
    let endBl = accumBl;
    if (endXPx > innerBoundsPx.w) {
      endXPx = innerBoundsPx.w;
      endBl = table.spatialWidthGr / GRID_SIZE;
    }
    if (i == colLen-1) {
      endXPx = innerBoundsPx.w;
      endBl = endBl = table.spatialWidthGr / GRID_SIZE;
    }
    if (accumBl < table.spatialWidthGr / GRID_SIZE && i < colLen-1) {
      colResizeHitboxes.push(HitboxFns.create(
        HitboxFlags.HorizontalResize,
        { x: endXPx, y: TABLE_TITLE_HEADER_HEIGHT_BL * blockSizePx.h, w: RESIZE_BOX_SIZE_PX, h: boundsPx.h - TABLE_TITLE_HEADER_HEIGHT_BL * blockSizePx.h },
        HitboxFns.createMeta({ colNum: i })
      ));
    }
    if (table.flags & TableFlags.ShowColHeader) {
      colClickHitboxes.push(HitboxFns.create(
        HitboxFlags.Click | HitboxFlags.ContentEditable,
        { x: startXPx, y: TABLE_TITLE_HEADER_HEIGHT_BL * blockSizePx.h, w: endXPx - startXPx, h: colHeaderHeightPxOrZero },
        HitboxFns.createMeta({ colNum: i, startBl, endBl })
      ));
    }
    if (accumBl >= table.spatialWidthGr / GRID_SIZE) { break; }
  }
  const viewportBoundsPx = cloneBoundingBox(boundsPx)!;
  viewportBoundsPx.h -= TABLE_TITLE_HEADER_HEIGHT_BL * blockSizePx.h + colHeaderHeightPxOrZero;
  viewportBoundsPx.y += TABLE_TITLE_HEADER_HEIGHT_BL * blockSizePx.h + colHeaderHeightPxOrZero;
  return {
    boundsPx,
    blockSizePx,
    viewportBoundsPx,
    hitboxes: !emitHitboxes ? [] : [
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
      ...colResizeHitboxes,
      ...colClickHitboxes,
      HitboxFns.create(HitboxFlags.Click | HitboxFlags.ContentEditable, titleBoundsPx),
      HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
    ],
  };
}
