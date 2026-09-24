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

import { ATTACH_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LIST_PAGE_TOP_PADDING_PX, PADDING_PROP, RESIZE_BOX_SIZE_PX, TABLE_COL_HEADER_HEIGHT_BL, TABLE_TITLE_HEADER_HEIGHT_BL, LINE_HEIGHT_PX } from "../constants";
import { HitboxFlags, HitboxFns, HitboxMeta } from "../layout/hitbox";
import { compositeMoveOutHitboxBoundsPx } from "../layout/composite-move-out";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft, Dimensions, Vector, isInside } from "../util/geometry";
import { currentUnixTimeSeconds, panic } from "../util/lang";
import { EMPTY_UID, newUid, Uid } from "../util/uid";
import {
  AttachmentsItem,
  AttachmentsMixin,
  asAttachmentsItem,
  calcGeometryOfAttachmentItemImpl,
  calcSpatialAttachmentHitboxBoundsPx,
  calcSpatialAttachmentStripWidthPx,
  isAttachmentsItem
} from "./base/attachments-item";
import { itemCanEdit, normalizeItemCapabilities } from "./base/capabilities-item";
import { ContainerItem } from "./base/container-item";
import { itemCanAcceptManualChildren } from "./base/flags-item";
import { Item, ItemTypeMixin, ItemType } from "./base/item";
import { TitledItem } from "./base/titled-item";
import { XSizableItem, XSizableMixin } from "./base/x-sizeable-item";
import { YSizableItem, YSizableMixin } from "./base/y-sizeable-item";
import { ItemGeometry } from "../layout/item-geometry";
import { PositionalMixin } from "./base/positional-item";
import { FlagsMixin, TableFlags } from "./base/flags-item";
import { VeFns, VisualElement, VisualElementFlags, VisualElementPath, isTableView } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { calcBoundsInCell, calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe, isInsideDocumentPageClickContext, isInsidePopupHierarchy } from "./base/item-common-fns";
import { itemState } from "../store/ItemState";
import { PlaceholderFns } from "./placeholder-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { server } from "../server";
import { ItemFns } from "./base/item-polymorphism";
import { VesCache } from "../layout/ves-cache";
import { arrangeNow, requestArrange } from "../layout/arrange";
import { closestCaretPositionToClientPx, setCaretPosition } from "../util/caret";
import { CursorEventState } from "../input/state";
import { asCompositeItem, isComposite } from "./composite-item";
import { TabularItem, TabularMixin } from "./base/tabular-item";
import { newOrdering } from "../util/ordering";
import { markChildrenLoadAsInitiatedOrComplete } from "../layout/load";
import { TabularContainerItem, TabularInsertionTarget, TabularVisibleRowInfo, tabularColumnAtBl, tabularColumnHitboxes, tabularColumnWidthBl, tabularInsertionTarget, tabularVisibleRows } from "../layout/tabular";
import { asPageItem, isPage } from "./page-item";


export interface TableItem extends TableMeasurable, TabularItem, XSizableItem, YSizableItem, ContainerItem, AttachmentsItem, TitledItem { }

export interface TableMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, YSizableMixin, FlagsMixin, TabularMixin, AttachmentsMixin {
}

export type TableVisibleRowInfo = TabularVisibleRowInfo;
export type TableInsertionTarget = TabularInsertionTarget;

export function tableTitleHeaderHeightBl(table: FlagsMixin): number {
  return table.flags & TableFlags.HideTitle ? 0 : TABLE_TITLE_HEADER_HEIGHT_BL;
}

export function tableColHeaderHeightBl(table: FlagsMixin): number {
  return table.flags & TableFlags.ShowColHeader ? TABLE_COL_HEADER_HEIGHT_BL : 0;
}

export function tableHeaderHeightBl(table: FlagsMixin): number {
  return tableTitleHeaderHeightBl(table) + tableColHeaderHeightBl(table);
}


function tableVisibleRows(store: StoreContextModel, tableVe: VisualElement): Array<TableVisibleRowInfo> {
  return tabularVisibleRows(store, tabularViewItem(tableVe), VeFns.veToPath(tableVe));
}

function tabularViewItem(ve: VisualElement): TabularContainerItem {
  if (isTable(ve.displayItem)) { return asTableItem(ve.displayItem); }
  if (isTableView(ve) && isPage(ve.displayItem)) { return asPageItem(ve.displayItem); }
  panic("expected a table item or Table-arranged page");
}


export const TableFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): TableItem => {
    if (parentId == EMPTY_UID) { panic("TableFns.create: parent is empty."); }
    let id = newUid();
    markChildrenLoadAsInitiatedOrComplete(id);
    return {
      origin: null,
      itemType: ItemType.Table,
      ownerId,
      id,
      parentId,
      relationshipToParent,
      groupId: null,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      dateTime: currentUnixTimeSeconds(),
      endDateTime: null,
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
      capabilities: normalizeItemCapabilities(o.capabilities),
      itemType: o.itemType,
      ownerId: o.ownerId,
      id: o.id,
      parentId: o.parentId == EMPTY_UID ? null : o.parentId,
      relationshipToParent: o.relationshipToParent,
      groupId: o.groupId ?? null,
      creationDate: o.creationDate,
      lastModifiedDate: o.lastModifiedDate,
      dateTime: o.dateTime,
      endDateTime: o.endDateTime ?? null,
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
      parentId: t.parentId == EMPTY_UID ? null : t.parentId,
      relationshipToParent: t.relationshipToParent,
      groupId: t.groupId,
      creationDate: t.creationDate,
      lastModifiedDate: t.lastModifiedDate,
      dateTime: t.dateTime,
      endDateTime: t.endDateTime,
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
    return calcTableGeometryImpl(table, boundsPx, blockSizePx, emitHitboxes, true);
  },

  calcGeometry_InComposite: (table: TableMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    let cloned = TableFns.asTableMeasurable(ItemFns.cloneMeasurableFields(table));
    cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    const sizeBl = TableFns.calcSpatialDimensionsBl(cloned);
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w + CONTAINER_IN_COMPOSITE_PADDING_PX,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w - (CONTAINER_IN_COMPOSITE_PADDING_PX * 2) - 2,
      h: sizeBl.h * blockSizePx.h
    };
    const result = calcTableGeometryImpl(table, boundsPx, blockSizePx, true, false);
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveAreaBoundsPx = {
      x: innerBoundsPx.w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2)
    };
    const resizeHb = result.hitboxes.pop()!;
    result.hitboxes.push(HitboxFns.create(HitboxFlags.Move | HitboxFlags.ShowPointer, compositeMoveOutHitboxBoundsPx(moveAreaBoundsPx, leftMarginBl == 0 ? 2 : 0), { compositeMoveOut: true }));
    result.hitboxes.push(
      HitboxFns.create(HitboxFlags.AttachComposite, {
        x: 0,
        y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
        w: innerBoundsPx.w,
        h: ATTACH_AREA_SIZE_PX,
      }));
    result.hitboxes.push(resizeHb); // expected to be last.
    return result;
  },

  calcGeometry_Attachment: (table: TableMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(table, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_table: TableMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean, expandable: boolean): ItemGeometry => {
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
    return calcTableGeometryImpl(table, boundsPx, blockSizePx, true, true);
  },

  asTableMeasurable: (item: ItemTypeMixin): TableMeasurable => {
    if (item.itemType == ItemType.Table) { return item as TableMeasurable; }
    panic("not table measurable.");
  },

  handleClick: (visualElement: VisualElement, hitboxMeta: HitboxMeta | null, store: StoreContextModel, forceEdit: boolean = false): void => {
    const handledByList = handleListPageLineItemClickMaybe(visualElement, store);
    if (!forceEdit && handledByList) { return; }
    const itemPath = VeFns.veToPath(visualElement);
    const editTitle = hitboxMeta == null;
    if (editTitle && tableTitleHeaderHeightBl(asTableItem(visualElement.displayItem)) == 0) {
      store.history.setFocus(itemPath);
      arrangeNow(store, "table-hidden-title-focus-only");
      return;
    }
    if (!itemCanEdit(visualElement.displayItem)) {
      if (!handledByList) {
        store.history.setFocus(itemPath);
        arrangeNow(store, "table-focus-only");
      }
      return;
    }
    store.overlay.setTextEditInfo(store.history, {
      itemPath,
      itemType: ItemType.Table,
      colNum: hitboxMeta == null ? null : hitboxMeta.colNum!,
      startBl: hitboxMeta == null ? null : hitboxMeta.startBl!,
      endBl: hitboxMeta == null ? null : hitboxMeta.endBl!,
    });
    const editingPath = editTitle ? itemPath + ":title" : itemPath + ":col" + hitboxMeta.colNum!;
    const el = document.getElementById(editingPath);
    if (el == null) {
      store.overlay.setTextEditInfo(store.history, null);
      store.history.setFocus(itemPath);
      arrangeNow(store, "table-edit-target-missing");
      return;
    }
    el.focus();
    const closestIdx = closestCaretPositionToClientPx(el, CursorEventState.getLatestClientPx());
    arrangeNow(store, "table-enter-edit-mode");
    const freshEl = document.getElementById(editingPath)!;
    setCaretPosition(freshEl, closestIdx);
  },


  handlePopupClick: (visualElement: VisualElement, store: StoreContextModel, _isFromAttachment?: boolean): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    if (isInsidePopupHierarchy(visualElement)) {
      store.history.pushPopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
    } else {
      store.history.replacePopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
    }
    requestArrange(store, "item-popup-open");
  },

  cloneMeasurableFields: (table: TableMeasurable): TableMeasurable => {
    return ({
      itemType: table.itemType,
      spatialPositionGr: table.spatialPositionGr,
      spatialWidthGr: table.spatialWidthGr,
      spatialHeightGr: table.spatialHeightGr,
      tableColumns: table.tableColumns,
      numberOfVisibleColumns: table.numberOfVisibleColumns,
      computed_attachments: table.computed_attachments,
      flags: table.flags,
    });
  },

  debugSummary: (tableItem: TableItem) => {
    return "[table] " + tableItem.title;
  },

  getFingerprint: (tableItem: TableItem): string => {
    let tableColText = "";
    for (let i = 0; i < tableItem.tableColumns.length; ++i) { tableColText += tableItem.tableColumns[i].name + "!$!!@"; }
    return tableItem.title + "~~~!@#~~~" + tableItem.flags + "~~~%@#~~~" + tableColText + "~~~%^&~~~" + tableItem.numberOfVisibleColumns;
  },

  /**
   * Determine the block width of the column specified by index.
   * This may be wider than the tableColumn specification, if it's the last one.
   */
  columnWidthBl: (tableItem: TableItem, index: number): number => {
    return tabularColumnWidthBl(tableItem, tableItem.spatialWidthGr / GRID_SIZE, index);
  },

  /**
   * Determine if the desktopPx position is inside the table visual element's viewport.
   */
  desktopViewportBoundsPx(store: StoreContextModel, tableVe: VisualElement): BoundingBox {
    if (tableVe.tableBodyViewportBoundsPx != null) {
      const pageViewport = VeFns.veViewportBoundsRelativeToDesktopPx(store, tableVe);
      const headerHeightPx = tableVe.tableBodyViewportBoundsPx.y - tableVe.viewportBoundsPx!.y;
      return { ...pageViewport, y: pageViewport.y + headerHeightPx, h: tableVe.tableBodyViewportBoundsPx.h };
    }
    const tableDesktopBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, tableVe);
    const viewportDesktopPx = cloneBoundingBox(tableVe.viewportBoundsPx)!;
    const headerHeightPx = tableVe.boundsPx.h - tableVe.viewportBoundsPx!.h;
    viewportDesktopPx.x = tableDesktopBoundsPx.x;
    viewportDesktopPx.y = tableDesktopBoundsPx.y + headerHeightPx;
    return viewportDesktopPx;
  },

  isInsideViewport(store: StoreContextModel, tableVe: VisualElement, desktopPx: Vector): boolean {
    return isInside(desktopPx, TableFns.desktopViewportBoundsPx(store, tableVe));
  },

  /**
   * Determine whether a header hover should use the table's top-right attachment insertion UI.
   */
  isNearHeaderAttachmentInsertionPoint(store: StoreContextModel, tableVe: VisualElement, desktopPx: Vector): boolean {
    const tableDesktopBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, tableVe);
    if (!isInside(desktopPx, tableDesktopBoundsPx)) { return false; }
    const viewportDesktopPx = TableFns.desktopViewportBoundsPx(store, tableVe);
    if (desktopPx.y >= viewportDesktopPx.y) { return false; }

    const tableItem = asTableItem(tableVe.displayItem);
    const tableDimensionsBl = tableVisualDimensionsBl(tableVe);
    const attachmentBlockSizePx = tableVe.blockSizePx?.w ?? tableDesktopBoundsPx.w / tableDimensionsBl.w;
    const attachmentStripWidthPx = calcSpatialAttachmentStripWidthPx(
      tableDesktopBoundsPx.w,
      attachmentBlockSizePx,
      tableItem.computed_attachments.length,
    );
    const attachmentStripLeftPx = tableDesktopBoundsPx.x + tableDesktopBoundsPx.w - attachmentStripWidthPx;
    if (desktopPx.x < attachmentStripLeftPx) { return false; }

    return desktopPx.y <= tableDesktopBoundsPx.y + ATTACH_AREA_SIZE_PX;
  },

  /**
   * When the pointer is over a table header, reuse the first-row insertion logic unless we're
   * intentionally targeting the table's own top-right attachment insertion point.
   */
  normalizeMoveOverDesktopPx(store: StoreContextModel, tableVe: VisualElement, desktopPx: Vector): Vector {
    if (tableVe.tableBodyViewportBoundsPx != null && tableVe.tableRowBlockSizePx != null) {
      const pageViewport = VeFns.veViewportBoundsRelativeToDesktopPx(store, tableVe);
      const bodyViewport = TableFns.desktopViewportBoundsPx(store, tableVe);
      if (!isInside(desktopPx, pageViewport) || desktopPx.y >= bodyViewport.y) { return desktopPx; }
      return {
        x: desktopPx.x,
        y: bodyViewport.y + Math.min(Math.max(1, Math.round(tableVe.tableRowBlockSizePx.h * 0.25)), Math.max(0, Math.floor(bodyViewport.h - 1))),
      };
    }
    const tableDesktopBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, tableVe);
    if (!isInside(desktopPx, tableDesktopBoundsPx)) { return desktopPx; }

    const viewportDesktopPx = TableFns.desktopViewportBoundsPx(store, tableVe);
    if (desktopPx.y >= viewportDesktopPx.y) { return desktopPx; }
    if (TableFns.isNearHeaderAttachmentInsertionPoint(store, tableVe, desktopPx)) { return desktopPx; }

    const normalizedYOffsetPx = Math.min(Math.max(1, Math.round(tableVe.blockSizePx!.h * 0.25)), Math.max(0, Math.floor(viewportDesktopPx.h - 1)));
    return {
      x: desktopPx.x,
      y: viewportDesktopPx.y + normalizedYOffsetPx,
    };
  },

  /**
   * Given a desktop position desktopPx and table visual element, determine the table cell under desktopPx.
   * This may or not have an existing associated item.
   */
  tableModifiableColRow(store: StoreContextModel, tableVe: VisualElement, desktopPx: Vector): { insertRow: number, attachmentPos: number } {
    if (tableVe.tableBodyViewportBoundsPx != null && tableVe.tableRowBlockSizePx != null) {
      const body = TableFns.desktopViewportBoundsPx(store, tableVe);
      const block = tableVe.tableRowBlockSizePx;
      const widthBl = body.w / block.w;
      const colNumber = tabularColumnAtBl(tabularViewItem(tableVe), widthBl, (desktopPx.x - body.x) / block.w);
      const attachmentPos = colNumber - 1;
      const scrollYPos = store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVe));
      const row = (desktopPx.y - body.y) / block.h + scrollYPos;
      const insertRow = Math.max(0, Math.min(
        attachmentPos == -1 ? Math.round(row) : Math.floor(row),
        TableFns.tableVisibleRowCount(store, tableVe),
      ));
      return { insertRow, attachmentPos };
    }
    desktopPx = TableFns.normalizeMoveOverDesktopPx(store, tableVe, desktopPx);
    const tableItem = asTableItem(tableVe.displayItem);
    const tableDimensionsBl = tableVisualDimensionsBl(tableVe);

    const tableBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, tableVe);

    // col
    const mousePropX = (desktopPx.x - tableBoundsPx.x) / tableBoundsPx.w;
    const tableXBl = Math.floor(mousePropX * tableDimensionsBl.w * 2.0) / 2.0;
    const colNumber = tabularColumnAtBl(tableItem, tableDimensionsBl.w, tableXBl);
    const attachmentPos = colNumber - 1;

    // row
    const mousePropY = (desktopPx.y - tableBoundsPx.y) / tableBoundsPx.h;
    const rawTableRowNumber = attachmentPos == -1 ? Math.round(mousePropY * tableDimensionsBl.h) : Math.floor(mousePropY * tableDimensionsBl.h);
    const yScrollPos = store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVe));
    let insertRow = rawTableRowNumber + yScrollPos - tableHeaderHeightBl(tableItem);
    if (insertRow < yScrollPos) { insertRow = yScrollPos; }
    insertRow = Math.floor(insertRow);
    const visibleRowCount = TableFns.tableVisibleRowCount(store, tableVe);
    if (insertRow < 0) { insertRow = 0; }
    if (insertRow > visibleRowCount) { insertRow = visibleRowCount; }

    return { insertRow, attachmentPos };
  },

  tableVisibleRows: (store: StoreContextModel, tableVe: VisualElement): Array<TableVisibleRowInfo> => {
    return tableVisibleRows(store, tableVe);
  },

  tableVisibleRowCount: (store: StoreContextModel, tableVe: VisualElement): number => {
    return tableVisibleRows(store, tableVe).length;
  },

  tableVisibleRowAt: (store: StoreContextModel, tableVe: VisualElement, rowNumber: number): TableVisibleRowInfo | null => {
    const idx = Math.floor(rowNumber);
    if (idx < 0) { return null; }
    return tableVisibleRows(store, tableVe)[idx] ?? null;
  },

  tableInsertionTarget: (store: StoreContextModel, tableVe: VisualElement, insertRow: number): TableInsertionTarget => {
    const tableItem = tabularViewItem(tableVe);
    const rows = tableVisibleRows(store, tableVe);
    return tabularInsertionTarget(tableItem, rows, insertRow);
  },

  tableAttachmentTargetAtRow: (store: StoreContextModel, tableVe: VisualElement, rowNumber: number): AttachmentsItem | null => {
    const row = TableFns.tableVisibleRowAt(store, tableVe, rowNumber);
    if (row == null || !isAttachmentsItem(row.displayItem)) {
      return null;
    }
    return asAttachmentsItem(row.displayItem);
  },

  insertEmptyColAt(tableId: Uid, colPos: number, store: StoreContextModel) {
    const tableItem = itemState.get(tableId)! as TabularContainerItem;
    let ancestor: Item | null = tableItem;
    while (ancestor != null) {
      if (ancestor.itemType == ItemType.Page) {
        if (ancestor.clientOnly === true || !itemCanEdit(ancestor) || !itemCanAcceptManualChildren(ancestor)) {
          return;
        }
        break;
      }
      ancestor = ancestor.parentId != null ? itemState.get(ancestor.parentId) : null;
    }

    for (let i = 0; i < tableItem.computed_children.length; ++i) {
      const child = itemState.get(tableItem.computed_children[i])!;
      if (!isAttachmentsItem(child)) { continue; }
      const attachments = asAttachmentsItem(child).computed_attachments;
      if (colPos >= attachments.length) { continue; }
      if (colPos == -1) {
        const ordering = newOrdering();
        const placeholderItem = PlaceholderFns.create(child.ownerId, child.id, RelationshipToParent.Attachment, ordering);
        itemState.add(placeholderItem);
        server.addItem(placeholderItem, null, store.general.networkStatus);
        continue;
      }
      const ordering = itemState.newOrderingAtAttachmentsPosition(child.id, colPos);
      const placeholderItem = PlaceholderFns.create(child.ownerId, child.id, RelationshipToParent.Attachment, ordering);
      itemState.add(placeholderItem);
      server.addItem(placeholderItem, null, store.general.networkStatus);
    }
  },

  removeColItemsAt(tableId: Uid, colPos: number, store: StoreContextModel) {
    const tableItem = itemState.get(tableId)! as TabularContainerItem;
    for (let i = 0; i < tableItem.computed_children.length; ++i) {
      const child = itemState.get(tableItem.computed_children[i])!;
      if (!isAttachmentsItem(child)) { continue; }
      const attachments = asAttachmentsItem(child).computed_attachments;
      if (colPos >= attachments.length) { continue; }
      const attachmentId = attachments[colPos];
      itemState.delete(attachmentId);
      server.deleteItem(attachmentId, store.general.networkStatus);
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


function tableVisualDimensionsBl(tableVe: VisualElement): Dimensions {
  if (tableVe.blockSizePx != null && tableVe.blockSizePx.w > 0 && tableVe.blockSizePx.h > 0) {
    return {
      w: tableVe.boundsPx.w / tableVe.blockSizePx.w,
      h: tableVe.boundsPx.h / tableVe.blockSizePx.h,
    };
  }

  const tableItem = asTableItem(tableVe.displayItem);
  const dimensionsBl: Dimensions = {
    w: (tableVe.linkItemMaybe ? tableVe.linkItemMaybe.spatialWidthGr : tableItem.spatialWidthGr) / GRID_SIZE,
    h: (tableVe.linkItemMaybe ? tableVe.linkItemMaybe.spatialHeightGr : tableItem.spatialHeightGr) / GRID_SIZE,
  };
  const tableParentVe = tableVe.parentPath == null ? null : VesCache.current.readNode(tableVe.parentPath);
  if (tableParentVe != null && isComposite(tableParentVe.displayItem)) {
    dimensionsBl.w = asCompositeItem(tableParentVe.displayItem).spatialWidthGr / GRID_SIZE;
  }
  return dimensionsBl;
}


function calcTableGeometryImpl(
  table: TableMeasurable,
  boundsPx: BoundingBox,
  blockSizePx: Dimensions,
  emitHitboxes: boolean,
  emitMove: boolean): ItemGeometry {
  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  const titleHeaderHeightPxOrZero = tableTitleHeaderHeightBl(table) * blockSizePx.h;
  const titleBoundsPx = {
    x: 0, y: 0,
    w: innerBoundsPx.w,
    h: titleHeaderHeightPxOrZero,
  };
  const colHeaderHeightPxOrZero = tableColHeaderHeightBl(table) * blockSizePx.h;
  const columnHitboxes = tabularColumnHitboxes(
    table, innerBoundsPx.w, boundsPx.h, blockSizePx,
    titleHeaderHeightPxOrZero, colHeaderHeightPxOrZero,
    !!(table.flags & TableFlags.ShowColHeader),
  );
  const viewportBoundsPx = cloneBoundingBox(boundsPx)!;
  viewportBoundsPx.h -= titleHeaderHeightPxOrZero + colHeaderHeightPxOrZero;
  viewportBoundsPx.y += titleHeaderHeightPxOrZero + colHeaderHeightPxOrZero;
  const moveHbMaybe = [];
  if (emitMove) {
    moveHbMaybe.push(HitboxFns.create(HitboxFlags.Move, innerBoundsPx));
  }
  const titleHbMaybe = tableTitleHeaderHeightBl(table) == 0
    ? []
    : [HitboxFns.create(HitboxFlags.Move | HitboxFlags.Click | HitboxFlags.ContentEditable, titleBoundsPx)];
  return {
    boundsPx,
    blockSizePx,
    viewportBoundsPx,
    hitboxes: !emitHitboxes ? [] : [
      ...moveHbMaybe,
      HitboxFns.create(
        HitboxFlags.Attach,
        calcSpatialAttachmentHitboxBoundsPx(innerBoundsPx, blockSizePx.w, blockSizePx.h, table.computed_attachments.length),
      ),
      ...columnHitboxes.resize,
      ...columnHitboxes.header,
      ...titleHbMaybe,
      HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
    ],
  };
}
