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

import { recoverWithFullArrange } from ".";
import { GRID_SIZE } from "../../constants";
import { asAttachmentsItem, isAttachmentsItem } from "../../items/base/attachments-item";
import { ContainerItem, asContainerItem, isContainer } from "../../items/base/container-item";
import { TableFlags } from "../../items/base/flags-item";
import { Item, uniqueEmptyItem } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { isComposite } from "../../items/composite-item";
import { LinkItem } from "../../items/link-item";
import { TableItem, asTableItem } from "../../items/table-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { Dimensions, EMPTY_BOUNDING_BOX, cloneBoundingBox, getBoundingBoxSize, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { panic } from "../../util/lang";
import { VisualElementSignal } from "../../util/signals";
import { ItemGeometry } from "../item-geometry";
import { initiateLoadChildItemsMaybe } from "../load";
import { RelationshipToParent } from "../relationship-to-parent";

import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElement, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";

import { arrangeItemAttachments } from "./attachments";
import { ArrangeItemFlags, getCommonVisualElementFlags } from "./item";
import { getVePropertiesForItem } from "./util";


export const arrangeTable = (
  store: StoreContextModel,
  parentPath: VisualElementPath,
  displayItem_Table: TableItem,
  linkItemMaybe_Table: LinkItem | null,
  actualLinkItemMaybe_Table: LinkItem | null,
  tableGeometry: ItemGeometry,
  flags: ArrangeItemFlags,
  widthBlOverride?: number): VisualElementSignal => {

  let sizeBl = linkItemMaybe_Table
    ? { w: linkItemMaybe_Table!.spatialWidthGr / GRID_SIZE, h: linkItemMaybe_Table!.spatialHeightGr / GRID_SIZE }
    : { w: displayItem_Table.spatialWidthGr / GRID_SIZE, h: displayItem_Table.spatialHeightGr / GRID_SIZE };

  const blockSizePx = widthBlOverride
    ? { w: tableGeometry.boundsPx.w / widthBlOverride, h: tableGeometry.blockSizePx.h }
    : tableGeometry.blockSizePx;

  if (widthBlOverride) {
    sizeBl.w = widthBlOverride;
  }

  const tableVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_Table, linkItemMaybe_Table), parentPath);

  const highlightedPath = store.find.highlightedPath.get();
  const isTableHighlighted = highlightedPath !== null && highlightedPath === tableVePath;

  const isSelectionHighlighted = (() => {
    const sel = store.overlay.selectedVeids.get();
    if (!sel || sel.length === 0) { return false; }
    const veid = VeFns.veidFromItems(displayItem_Table, actualLinkItemMaybe_Table);
    for (let i = 0; i < sel.length; ++i) {
      if (sel[i].itemId === veid.itemId && sel[i].linkIdMaybe === veid.linkIdMaybe) { return true; }
    }
    return false;
  })();

  const tableSpec: VisualElementSpec = {
    displayItem: displayItem_Table,
    linkItemMaybe: linkItemMaybe_Table,
    actualLinkItemMaybe: actualLinkItemMaybe_Table,
    flags: VisualElementFlags.Detailed |
      VisualElementFlags.ShowChildren |
      getCommonVisualElementFlags(flags) |
      (isTableHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None) |
      (isSelectionHighlighted ? VisualElementFlags.SelectionHighlighted : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: tableGeometry.boundsPx,
    viewportBoundsPx: tableGeometry.viewportBoundsPx!,
    hitboxes: tableGeometry.hitboxes,
    blockSizePx,
    row: tableGeometry.row,
    col: tableGeometry.col,
    parentPath,
  };

  const [windowState, numRows] = arrangeTableChildren(
    store, displayItem_Table, linkItemMaybe_Table, tableGeometry, tableVePath, flags, sizeBl, blockSizePx);

  const childAreaBoundsPx = zeroBoundingBoxTopLeft(cloneBoundingBox(tableGeometry.viewportBoundsPx)!);
  childAreaBoundsPx.h = numRows * blockSizePx.h;
  tableSpec.childAreaBoundsPx = childAreaBoundsPx;

  const parentItemSizeBl = ItemFns.calcSpatialDimensionsBl(linkItemMaybe_Table == null ? displayItem_Table : linkItemMaybe_Table);
  const attachments = arrangeItemAttachments(store, displayItem_Table.computed_attachments, parentItemSizeBl, tableGeometry.boundsPx, tableVePath);

  const tableRelationships: VisualElementRelationships = {
    childrenVes: windowState.childrenVes,
    attachmentsPaths: attachments,
  };

  const tableVisualElementSignal = VesCache.full_writeVisualElementSignal(tableSpec, tableRelationships, tableVePath);
  persistTableRenderWindowRows(tableVePath, windowState);

  return tableVisualElementSignal;
}


export function arrangeTableChildren(
  store: StoreContextModel,
  displayItem_table: TableItem,
  linkItemMaybe_table: LinkItem | null,
  tableGeometry: ItemGeometry,
  tableVePath: VisualElementPath,
  flags: ArrangeItemFlags,
  sizeBl: Dimensions,
  blockSizePx: Dimensions): [TableRenderWindowState, number] {

  const scrollYPos = store.perItem.getTableScrollYPos(VeFns.veidFromItems(displayItem_table, linkItemMaybe_table));
  const firstItemIdx = Math.floor(scrollYPos);
  const numVisibleRows = sizeBl.h - 1 - (displayItem_table.flags & TableFlags.ShowColHeader ? 1 : 0);
  let lastItemIdx = firstItemIdx + numVisibleRows;
  const outCount = lastItemIdx - firstItemIdx + 1;

  // outIdx:          there are a fixed number of visual elements (outCount) created, generally less than the number of
  //                  rows in the table child area, arranged in a circular buffer. outIdx is the index into this buffer.
  // rowIdx:          there is a fixed total number of rows logically present in the table child area (in turn
  //                  determining the inner div height). this is the index into that.

  const windowPlans = buildTableWindowPlans(
    store,
    displayItem_table,
    tableVePath,
    firstItemIdx,
    lastItemIdx,
    outCount,
    true,
    flags,
    sizeBl,
    blockSizePx,
    getBoundingBoxSize(tableGeometry.boundsPx),
  );
  return [materializeTableWindowPlans(windowPlans), windowPlans.numRows];
}


type TableRenderPlan = {
  spec: VisualElementSpec,
  relationships: VisualElementRelationships,
  path: VisualElementPath,
};

type TableRowRenderPlan = TableRenderPlan & {
  attachments: Array<TableRenderPlan>,
};

type TableWindowSlotPlan =
  | { kind: "row", rowIdx: number, outIdx: number, rowPlan: TableRowRenderPlan }
  | { kind: "filler", rowIdx: number, outIdx: number, fillerPlan: TableRenderPlan };

type TableWindowPlanResult = {
  numRows: number,
  slots: Array<TableWindowSlotPlan>,
};

type TableRenderWindowState = {
  childrenVes: Array<VisualElementSignal>,
  rowSlots: Array<number>,
};

function createTableRenderWindowState(
  childrenVes: Array<VisualElementSignal>,
  rowSlots: Array<number>,
): TableRenderWindowState {
  return {
    childrenVes,
    rowSlots,
  };
}

function createEmptyTableRenderWindowState(): TableRenderWindowState {
  return createTableRenderWindowState([], []);
}

function getTableRenderWindowChild(
  state: TableRenderWindowState,
  outIdx: number,
): VisualElementSignal | undefined {
  return state.childrenVes[outIdx];
}

function getTableRenderWindowRow(
  state: TableRenderWindowState,
  outIdx: number,
): number | undefined {
  return state.rowSlots[outIdx];
}

function setTableRenderWindowSlot(
  state: TableRenderWindowState,
  outIdx: number,
  rowIdx: number,
  childVe: VisualElementSignal,
) {
  state.childrenVes[outIdx] = childVe;
  state.rowSlots[outIdx] = rowIdx;
}

function snapshotTableRenderWindowRows(state: TableRenderWindowState): Array<number> {
  return [...state.rowSlots];
}

function persistTableRenderWindowRows(tableVePath: VisualElementPath, state: TableRenderWindowState) {
  VesCache.setTableRenderRows(tableVePath, state.rowSlots);
}

function logTableRenderWindowInconsistencies(
  tableVePath: VisualElementPath,
  tableId: string,
  scrollYPos: number,
  prevScrollYPos: number,
  firstItemIdx: number,
  lastItemIdx: number,
  outCount: number,
  windowState: TableRenderWindowState,
  debugRowMapping: Map<number, { rowIdx: number, itemId: string, outIdx: number }>,
) {
  let hasInconsistency = false;
  const finalDebugInfo = {
    tableVePath,
    tableId,
    scrollYPos,
    prevScrollYPos,
    firstItemIdx,
    lastItemIdx,
    outCount,
    childrenVesLength: windowState.childrenVes.length,
    tableVesRowsSnapshot: snapshotTableRenderWindowRows(windowState),
    debugRowMapping: Array.from(debugRowMapping.entries()),
    inconsistencies: [] as any[],
    timestamp: new Date().toISOString(),
  };

  for (let i = 0; i < outCount; i++) {
    const mappingInfo = debugRowMapping.get(i);
    const vesRowValue = getTableRenderWindowRow(windowState, i);

    if (mappingInfo && mappingInfo.rowIdx !== vesRowValue) {
      hasInconsistency = true;
      finalDebugInfo.inconsistencies.push({
        outIdx: i,
        mappedRowIdx: mappingInfo.rowIdx,
        vesRowValue: vesRowValue,
        itemId: mappingInfo.itemId,
      });
    }

    const childVe = getTableRenderWindowChild(windowState, i)?.get();
    if (childVe && childVe.row !== vesRowValue) {
      hasInconsistency = true;
      finalDebugInfo.inconsistencies.push({
        outIdx: i,
        expectedRow: vesRowValue,
        actualVeRow: childVe.row,
        veItemId: childVe.displayItem.id,
        type: "ve_row_mismatch",
      });
    }
  }

  if (hasInconsistency) {
    console.error("[TABLE_DEBUG] Inconsistencies detected in final table arrangement:", finalDebugInfo);
  }
}


function walkTableRowsInWindow(
  store: StoreContextModel,
  displayItem_table: TableItem,
  tableVePath: VisualElementPath,
  firstItemIdx: number,
  lastItemIdx: number,
  computeTotalRows: boolean,
  onVisibleRow: (item: Item, rowIdx: number, indentBl: number) => void,
  onFillerRow: (rowIdx: number) => void): number {

  if (displayItem_table.computed_children.length == 0) {
    return 0;
  }

  let iterIndices = [0];
  let iterContainers: Array<ContainerItem> = [displayItem_table];
  let rowIdx = 0;
  let numRows = 0;

  while (true) {
    const itemId = iterContainers[iterContainers.length - 1].computed_children[iterIndices[iterIndices.length - 1]];
    const item = itemState.get(itemId)!;

    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, item);
    const itemVeid = VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem);
    const itemPath = VeFns.addVeidToPath(itemVeid, tableVePath);

    if (rowIdx >= firstItemIdx && rowIdx <= lastItemIdx) {
      const indentBl = iterIndices.length - 1;
      onVisibleRow(item, rowIdx, indentBl);
    }

    rowIdx += 1;
    numRows += 1;

    if (!computeTotalRows && rowIdx > lastItemIdx) {
      break;
    }

    if (isContainer(displayItem_childItem) && store.perVe.getIsExpanded(itemPath)) {
      initiateLoadChildItemsMaybe(store, itemVeid);
    }
    if (isContainer(displayItem_childItem) && asContainerItem(displayItem_childItem).computed_children.length > 0 && store.perVe.getIsExpanded(itemPath)) {
      iterIndices[iterIndices.length - 1] = iterIndices[iterIndices.length - 1] + 1;
      iterIndices.push(0);
      iterContainers.push(asContainerItem(displayItem_childItem));
    } else {
      iterIndices[iterIndices.length - 1] = iterIndices[iterIndices.length - 1] + 1;
      while (iterIndices.length > 0 && iterIndices[iterIndices.length - 1] >= iterContainers[iterContainers.length - 1].computed_children.length) {
        iterIndices.pop();
        iterContainers.pop();
      }
      if (iterIndices.length == 0) {
        while (rowIdx <= lastItemIdx) {
          onFillerRow(rowIdx);
          rowIdx += 1;
        }
        break;
      }
    }
  }

  return numRows;
}


function buildTableWindowPlans(
  store: StoreContextModel,
  displayItem_table: TableItem,
  tableVePath: VisualElementPath,
  firstItemIdx: number,
  lastItemIdx: number,
  outCount: number,
  computeTotalRows: boolean,
  flags: ArrangeItemFlags,
  sizeBl: Dimensions,
  blockSizePx: Dimensions,
  tableDimensionsPx: Dimensions): TableWindowPlanResult {

  const slots: Array<TableWindowSlotPlan> = [];
  const numRows = walkTableRowsInWindow(
    store,
    displayItem_table,
    tableVePath,
    firstItemIdx,
    lastItemIdx,
    computeTotalRows,
    (item, rowIdx, indentBl) => {
      const outIdx = rowIdx % outCount;
      const rowPlan = buildTableRowRenderPlan(
        store, item, displayItem_table, tableVePath, flags, rowIdx, sizeBl, blockSizePx, indentBl, tableDimensionsPx);
      slots.push({ kind: "row", rowIdx, outIdx, rowPlan });
    },
    (rowIdx) => {
      const outIdx = rowIdx % outCount;
      const fillerPlan = buildFillerRowPlan(displayItem_table, tableVePath);
      slots.push({ kind: "filler", rowIdx, outIdx, fillerPlan });
    },
  );

  return {
    numRows,
    slots,
  };
}


function materializeTableWindowPlans(windowPlans: TableWindowPlanResult): TableRenderWindowState {
  const windowState = createEmptyTableRenderWindowState();

  for (let i = 0; i < windowPlans.slots.length; ++i) {
    const slot = windowPlans.slots[i];
    if (slot.kind === "row") {
      setTableRenderWindowSlot(windowState, slot.outIdx, slot.rowIdx, materializeTableRowPlan(slot.rowPlan, null));
    } else {
      setTableRenderWindowSlot(windowState, slot.outIdx, slot.rowIdx, materializeTableRenderPlan(slot.fillerPlan));
    }
  }

  return windowState;
}


function buildFillerRowPlan(
  di_Table: TableItem,
  tableVePath: VisualElementPath,
): TableRenderPlan {
  const uniqueNoneItem = uniqueEmptyItem();
  const spec: VisualElementSpec = {
    displayItem: uniqueNoneItem,
    boundsPx: EMPTY_BOUNDING_BOX,
    flags: VisualElementFlags.LineItem,
  };
  const relationships: VisualElementRelationships = {};
  uniqueNoneItem.parentId = di_Table.id;
  uniqueNoneItem.relationshipToParent = RelationshipToParent.Child;
  const path = VeFns.addVeidToPath(VeFns.veidFromItems(uniqueNoneItem, null), tableVePath);
  return { spec, relationships, path };
}


function applyTableWindowPlansAfterScroll(
  store: StoreContextModel,
  tableVePath: VisualElementPath,
  windowState: TableRenderWindowState,
  windowPlans: TableWindowPlanResult,
  debugRowMapping: Map<number, { rowIdx: number, itemId: string, outIdx: number }>): boolean {

  for (let i = 0; i < windowPlans.slots.length; ++i) {
    const slot = windowPlans.slots[i];
    const outIdx = slot.outIdx;
    const rowIdx = slot.rowIdx;

    if (getTableRenderWindowRow(windowState, outIdx) != rowIdx) {
      if (slot.kind === "row") {
        const vesToOverwrite = getTableRenderWindowChild(windowState, outIdx);

        const existingVe = vesToOverwrite?.get();
        const existingPath = existingVe ? VeFns.veToPath(existingVe) : null;

        if (existingPath && !existingPath.includes(tableVePath)) {
          console.debug("rearrangeTableAfterScroll: stale VE signal detected, resorting to fullArrange.");
          recoverWithFullArrange(store, "table-scroll-stale-row-signal");
          return false;
        }

        const newPath = slot.rowPlan.path;

        try {
          const nextRowVe = materializeTableRowPlan(slot.rowPlan, vesToOverwrite);
          setTableRenderWindowSlot(windowState, outIdx, rowIdx, nextRowVe);

          debugRowMapping.set(outIdx, { rowIdx: rowIdx, itemId: slot.rowPlan.spec.displayItem.id, outIdx: outIdx });

        } catch (e: any) {
          console.error("[TABLE_DEBUG] createRow failed:", {
            tableVePath: tableVePath,
            rowIdx: rowIdx,
            outIdx: outIdx,
            itemId: slot.rowPlan.spec.displayItem.id,
            error: e.message,
            errorStack: e.stack,
            existingPath: existingPath,
            newPath: newPath,
            vesToOverwriteExists: !!vesToOverwrite,
            existingVeExists: !!existingVe,
            tableVesRows: snapshotTableRenderWindowRows(windowState),
            childrenVesLength: windowState.childrenVes.length,
            debugRowMapping: Array.from(debugRowMapping.entries()),
            timestamp: new Date().toISOString()
          });
          console.debug("rearrangeTableAfterScroll.createRow failed, resorting to fullArrange.");
          store.overlay.setTextEditInfo(store.history, null);
          recoverWithFullArrange(store, "table-scroll-create-row-failed");
          return false;
        }
      } else {
        setTableRenderWindowSlot(windowState, outIdx, rowIdx, materializeTableRenderPlan(slot.fillerPlan));
      }
    } else if (slot.kind === "row") {
      debugRowMapping.set(outIdx, { rowIdx: rowIdx, itemId: slot.rowPlan.spec.displayItem.id, outIdx: outIdx });
    }
  }

  return true;
}


export function rearrangeTableAfterScroll(store: StoreContextModel, parentPath: VisualElementPath, tableVeid: Veid, prevScrollYPos: number) {
  if (VesCache.isCurrentlyInFullArrange()) { return; }
  if (store.anItemIsMoving.get()) {
    recoverWithFullArrange(store, "table-scroll-while-moving");
    return;
  }

  let needToRearrange = () => {
    const scrollYPos = store.perItem.getTableScrollYPos(tableVeid);
    if (Math.round(prevScrollYPos) != Math.round(scrollYPos)) { return true; }
    return false;
  };
  if (!needToRearrange()) { return; }

  const tableVePath = VeFns.addVeidToPath(tableVeid, parentPath);
  const tableVe = VesCache.current.readNode(tableVePath)!;
  const displayItem_table = asTableItem(tableVe.displayItem);
  const windowState = createTableRenderWindowState(
    VesCache.render.getChildren(tableVePath)(),
    VesCache.getTableRenderRows(tableVePath) ?? [],
  );
  if (windowState.rowSlots.length != windowState.childrenVes.length) {
    // TODO (LOW): should really implement logic such that this never happens. This is lazy.
    console.debug("rearrangeTableAfterScroll: invalid tableVesRows, resorting to fullArrange.");
    console.error("[TABLE_DEBUG] Invalid state detected:", {
      tableVePath: tableVePath,
      tableVesRows: windowState.rowSlots,
      tableVesRowsLength: windowState.rowSlots.length,
      childrenVesLength: windowState.childrenVes.length,
      prevScrollYPos: prevScrollYPos,
      currentScrollYPos: store.perItem.getTableScrollYPos(tableVeid),
      tableId: displayItem_table.id,
      timestamp: new Date().toISOString()
    });
    // Clear text editing state to prevent race conditions with DOM elements
    store.overlay.setTextEditInfo(store.history, null);
    recoverWithFullArrange(store, "table-scroll-invalid-row-cache");
    return;
  }

  const blockSizePx = tableVe.blockSizePx ?? (() => {
    const fallbackSizeBl = tableVeid.linkIdMaybe
      ? { w: tableVe.linkItemMaybe!.spatialWidthGr / GRID_SIZE, h: tableVe.linkItemMaybe!.spatialHeightGr / GRID_SIZE }
      : { w: asTableItem(tableVe.displayItem).spatialWidthGr / GRID_SIZE, h: asTableItem(tableVe.displayItem).spatialHeightGr / GRID_SIZE };
    return { w: tableVe.boundsPx.w / fallbackSizeBl.w, h: tableVe.boundsPx.h / fallbackSizeBl.h };
  })();
  const sizeBl = { w: tableVe.boundsPx.w / blockSizePx.w, h: tableVe.boundsPx.h / blockSizePx.h };

  const scrollYPos = store.perItem.getTableScrollYPos(tableVeid);
  const firstItemIdx = Math.floor(scrollYPos);
  const outCount = windowState.childrenVes.length;
  const numVisibleRows = outCount - 1;
  const lastItemIdx = firstItemIdx + numVisibleRows;
  if (windowState.childrenVes.length != outCount) {
    console.error("[TABLE_DEBUG] Unexpected child ves count:", {
      tableVePath: tableVePath,
      childrenVesLength: windowState.childrenVes.length,
      expectedOutCount: outCount,
      firstItemIdx: firstItemIdx,
      lastItemIdx: lastItemIdx,
      numVisibleRows: numVisibleRows,
      sizeBl: sizeBl,
      scrollYPos: scrollYPos,
      prevScrollYPos: prevScrollYPos,
      tableId: displayItem_table.id,
      timestamp: new Date().toISOString()
    });
    panic("rearrangeTableAfterScroll: unexpected number of child ves rows. can occur if table has fractional height.");
  }

  // Debug tracking for visual element position mapping
  const debugRowMapping = new Map<number, { rowIdx: number, itemId: string, outIdx: number }>();
  const windowPlans = buildTableWindowPlans(
    store,
    displayItem_table,
    tableVePath,
    firstItemIdx,
    lastItemIdx,
    outCount,
    false,
    tableVe._arrangeFlags_useForPartialRearrangeOnly,
    sizeBl,
    blockSizePx,
    getBoundingBoxSize(tableVe.boundsPx),
  );

  if (!applyTableWindowPlansAfterScroll(store, tableVePath, windowState, windowPlans, debugRowMapping)) {
    return;
  }
  persistTableRenderWindowRows(tableVePath, windowState);

  logTableRenderWindowInconsistencies(
    tableVePath,
    displayItem_table.id,
    scrollYPos,
    prevScrollYPos,
    firstItemIdx,
    lastItemIdx,
    outCount,
    windowState,
    debugRowMapping,
  );
}


function buildTableRowRenderPlan(
  store: StoreContextModel,
  childItem: Item,
  di_Table: TableItem,
  tableVePath: VisualElementPath,
  flags: ArrangeItemFlags,
  rowIdx: number,
  sizeBl: Dimensions,
  blockSizePx: Dimensions,
  indentBl: number,
  tableDimensionsPx: Dimensions): TableRowRenderPlan {

  const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);
  const childVeid = VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem);

  if (isComposite(displayItem_childItem)) {
    initiateLoadChildItemsMaybe(store, childVeid);
  }

  let widthBl = di_Table.numberOfVisibleColumns == 1
    ? sizeBl.w
    : Math.min(di_Table.tableColumns[0].widthGr / GRID_SIZE, sizeBl.w);

  const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, rowIdx, indentBl, widthBl - indentBl, !!(flags & ArrangeItemFlags.ParentIsPopup), false, true, true);

  const tableChildVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), tableVePath);

  const highlightedPath = store.find.highlightedPath.get();
  const isHighlighted = highlightedPath !== null && highlightedPath === tableChildVePath;

  const tableChildVeSpec: VisualElementSpec = {
    displayItem: displayItem_childItem,
    linkItemMaybe: linkItemMaybe_childItem,
    actualLinkItemMaybe: linkItemMaybe_childItem,
    flags: VisualElementFlags.LineItem | VisualElementFlags.InsideTable |
      (isHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
    boundsPx: geometry.boundsPx,
    tableDimensionsPx,
    indentBl,
    hitboxes: geometry.hitboxes,
    parentPath: tableVePath,
    col: 0,
    row: rowIdx,
    blockSizePx,
  };

  const tableChildRelationships: VisualElementRelationships = {};
  const attachmentPlans: Array<TableRenderPlan> = [];

  if (isAttachmentsItem(displayItem_childItem)) {
    const attachmentsItem = asAttachmentsItem(displayItem_childItem);
    let leftBl = di_Table.tableColumns[0].widthGr / GRID_SIZE;
    let i = 0;
    for (; i < di_Table.numberOfVisibleColumns - 1; ++i) {
      if (i >= attachmentsItem.computed_attachments.length) { break; }
      if (leftBl >= sizeBl.w) { break; }

      let widthBl = i == di_Table.numberOfVisibleColumns - 2
        ? sizeBl.w - leftBl
        : di_Table.tableColumns[i + 1].widthGr / GRID_SIZE;

      const attachmentId = attachmentsItem.computed_attachments[i];
      const attachmentItem = itemState.get(attachmentId)!;
      const { displayItem: displayItem_attachment, linkItemMaybe: linkItemMaybe_attachment } = getVePropertiesForItem(store, attachmentItem);
      const attachment_veid = VeFns.veidFromItems(displayItem_attachment, linkItemMaybe_attachment);

      if (isComposite(displayItem_attachment)) {
        initiateLoadChildItemsMaybe(store, attachment_veid);
      }

      const geometry = ItemFns.calcGeometry_ListItem(attachmentItem, blockSizePx, rowIdx, leftBl, widthBl, !!(flags & ArrangeItemFlags.ParentIsPopup), false, false, true);

      const tableChildAttachmentVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_attachment, linkItemMaybe_attachment), tableChildVePath);

      const attachmentIsHighlighted = highlightedPath !== null && highlightedPath === tableChildAttachmentVePath;

      const tableChildAttachmentVeSpec: VisualElementSpec = {
        displayItem: displayItem_attachment,
        linkItemMaybe: linkItemMaybe_attachment,
        actualLinkItemMaybe: linkItemMaybe_attachment,
        flags: VisualElementFlags.InsideTable | VisualElementFlags.Attachment |
          (attachmentIsHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
        _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
        boundsPx: geometry.boundsPx,
        tableDimensionsPx,
        indentBl,
        hitboxes: geometry.hitboxes,
        col: i + 1,
        row: rowIdx,
        parentPath: tableChildVePath,
        blockSizePx
      };
      const tableChildAttachmentRelationships: VisualElementRelationships = {};
      attachmentPlans.push({
        spec: tableChildAttachmentVeSpec,
        relationships: tableChildAttachmentRelationships,
        path: tableChildAttachmentVePath,
      });

      leftBl += di_Table.tableColumns[i + 1].widthGr / GRID_SIZE;
    }

    tableChildRelationships.attachmentsPaths = attachmentPlans.map(attachmentPlan => attachmentPlan.path);
  }

  return {
    spec: tableChildVeSpec,
    relationships: tableChildRelationships,
    path: tableChildVePath,
    attachments: attachmentPlans,
  };
}


function materializeTableRenderPlan(plan: TableRenderPlan): VisualElementSignal {
  return VesCache.full_writeVisualElementSignal(plan.spec, plan.relationships, plan.path);
}


function materializeTableRowPlan(
  rowPlan: TableRowRenderPlan,
  vesToOverwrite: VisualElementSignal | null): VisualElementSignal {

  for (let i = 0; i < rowPlan.attachments.length; ++i) {
    const attachmentPlan = rowPlan.attachments[i];
    if (vesToOverwrite != null) {
      VesCache.partial_create(attachmentPlan.spec, attachmentPlan.relationships, attachmentPlan.path);
    } else {
      VesCache.full_writeVisualElement(attachmentPlan.spec, attachmentPlan.relationships, attachmentPlan.path);
    }
  }

  if (vesToOverwrite != null) {
    VesCache.partial_overwriteVisualElementSignal(rowPlan.spec, rowPlan.relationships, rowPlan.path, vesToOverwrite);
    return vesToOverwrite;
  }

  return materializeTableRenderPlan(rowPlan);
}
