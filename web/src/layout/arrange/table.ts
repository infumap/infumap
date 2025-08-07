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

import { fullArrange } from ".";
import { GRID_SIZE } from "../../constants";
import { evaluateExpressions } from "../../expression/evaluate";
import { asAttachmentsItem, isAttachmentsItem } from "../../items/base/attachments-item";
import { ContainerItem, asContainerItem, isContainer } from "../../items/base/container-item";
import { TableFlags } from "../../items/base/flags-item";
import { Item, uniqueEmptyItem } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { isComposite } from "../../items/composite-item";
import { isExpression } from "../../items/expression-item";
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
import { VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { arrangeItemAttachments } from "./attachments";
import { ArrangeItemFlags } from "./item";
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

  const tableVisualElementSpec: VisualElementSpec = {
    displayItem: displayItem_Table,
    linkItemMaybe: linkItemMaybe_Table,
    actualLinkItemMaybe: actualLinkItemMaybe_Table,
    flags: VisualElementFlags.Detailed |
           VisualElementFlags.ShowChildren |
           (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsPopupRoot ? VisualElementFlags.Popup : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.InsideCompositeOrDoc ? VisualElementFlags.InsideCompositeOrDoc : VisualElementFlags.None) |
           (isTableHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: tableGeometry.boundsPx,
    viewportBoundsPx: tableGeometry.viewportBoundsPx!,
    hitboxes: tableGeometry.hitboxes,
    blockSizePx,
    parentPath,
  };

  const [childrenVes, tableVesRows, numRows] = arrangeTableChildren(
    store, displayItem_Table, linkItemMaybe_Table, tableGeometry, tableVePath, flags, sizeBl, blockSizePx);
  tableVisualElementSpec.childrenVes = childrenVes;
  tableVisualElementSpec.tableVesRows = tableVesRows;

  const childAreaBoundsPx = zeroBoundingBoxTopLeft(cloneBoundingBox(tableGeometry.viewportBoundsPx)!);
  childAreaBoundsPx.h = numRows * blockSizePx.h
  tableVisualElementSpec.childAreaBoundsPx = childAreaBoundsPx;

  const parentItemSizeBl = ItemFns.calcSpatialDimensionsBl(linkItemMaybe_Table == null ? displayItem_Table : linkItemMaybe_Table);
  const attachments = arrangeItemAttachments(store, displayItem_Table.computed_attachments, parentItemSizeBl, tableGeometry.boundsPx, tableVePath);
  tableVisualElementSpec.attachmentsVes = attachments;

  const tableVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(tableVisualElementSpec, tableVePath);

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
    blockSizePx: Dimensions): [Array<VisualElementSignal>, Array<number>, number] {

  const scrollYPos = store.perItem.getTableScrollYPos(VeFns.veidFromItems(displayItem_table, linkItemMaybe_table));
  const firstItemIdx = Math.floor(scrollYPos);
  const numVisibleRows = sizeBl.h - 1 - (displayItem_table.flags & TableFlags.ShowColHeader ? 1 : 0);
  let lastItemIdx = firstItemIdx + numVisibleRows;
  const outCount = lastItemIdx - firstItemIdx + 1;

  // outIdx:          there are a fixed number of visual elements (outCount) created, generally less than the number of
  //                  rows in the table child area, arranged in a circular buffer. outIdx is the index into this buffer.
  // rowIdx:          there is a fixed total number of rows logically present in the table child area (in turn
  //                  determining the inner div height). this is the index into that.
  // iterIndices:     keeps track of the current position (hierarchical array) in the list of (possibly nested & expanded)
  //                  containers.
  // iterContainers:  the containers item_iter indexes into.

  let tableVeChildren: Array<VisualElementSignal> = [];
  let tableVesRows: Array<number> = [];
  let iterIndices = [0];
  let iterContainers: Array<ContainerItem> = [displayItem_table];
  let rowIdx = 0;
  let currentParentPath = tableVePath;
  let numRows = 0;

  if (displayItem_table.computed_children.length == 0) { return [tableVeChildren, tableVesRows, 0]; }

  while (true) {
    let itemId = iterContainers[iterContainers.length-1].computed_children[iterIndices[iterIndices.length-1]];
    const item = itemState.get(itemId)!;

    // 1. make row.
    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, item);
    let itemVeid = VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem);
    let itemPath = VeFns.addVeidToPath(itemVeid, currentParentPath);
    if (rowIdx >= firstItemIdx && rowIdx <= lastItemIdx) {
      const indentBl = iterIndices.length - 1;
      let outIdx = rowIdx % outCount;
      tableVeChildren[outIdx] = createRow(
        store, item, displayItem_table, tableVePath, flags, rowIdx, sizeBl, blockSizePx, indentBl, getBoundingBoxSize(tableGeometry.boundsPx), null);
      tableVesRows[outIdx] = rowIdx;
    }
    rowIdx = rowIdx + 1;
    numRows += 1;

    // 2. increment iterator.
    if (isContainer(displayItem_childItem) && store.perVe.getIsExpanded(itemPath)) { initiateLoadChildItemsMaybe(store, itemVeid); }
    if (isContainer(displayItem_childItem) && asContainerItem(displayItem_childItem).computed_children.length > 0 && store.perVe.getIsExpanded(itemPath)) {
      // either step into expanded container
      iterIndices[iterIndices.length-1] = iterIndices[iterIndices.length-1] + 1;
      iterIndices.push(0);
      iterContainers.push(asContainerItem(displayItem_childItem));
    }
    else {
      // or move through current container children by one.
      iterIndices[iterIndices.length-1] = iterIndices[iterIndices.length-1] + 1;
      while (iterIndices.length > 0 && iterIndices[iterIndices.length - 1] >= iterContainers[iterContainers.length-1].computed_children.length) {
        iterIndices.pop();
        iterContainers.pop();
      }
      if (iterIndices.length == 0) {
        while (rowIdx <= lastItemIdx) {
          let outIdx = rowIdx % outCount;
          tableVeChildren[outIdx] = createFillerRow(displayItem_table, tableVePath);
          rowIdx = rowIdx + 1;
        }
        break;
      }
    }
  }

  return [tableVeChildren, tableVesRows, numRows];
}


function createFillerRow(
    di_Table: TableItem,
    tableVePath: VisualElementPath,
  ) {
  const uniqueNoneItem = uniqueEmptyItem();
  const tableChildVeSpec: VisualElementSpec = {
    displayItem: uniqueNoneItem,
    boundsPx: EMPTY_BOUNDING_BOX,
    flags: VisualElementFlags.LineItem,
  };
  uniqueNoneItem.parentId = di_Table.id;
  uniqueNoneItem.relationshipToParent = RelationshipToParent.Child;
  const tableChildVePath = VeFns.addVeidToPath(VeFns.veidFromItems(uniqueNoneItem, null), tableVePath);
  return VesCache.full_createOrRecycleVisualElementSignal(tableChildVeSpec, tableChildVePath);
}


export function rearrangeTableAfterScroll(store: StoreContextModel, parentPath: VisualElementPath, tableVeid: Veid, prevScrollYPos: number) {
  if (VesCache.isCurrentlyInFullArrange()) { return; }

  const existingEvaluationQueue = VesCache.getEvaluationRequired();

  let needToRearrange = () => {
    const scrollYPos = store.perItem.getTableScrollYPos(tableVeid);
    if (Math.round(prevScrollYPos) != Math.round(scrollYPos)) { return true; }
    return false;
  };
  if (!needToRearrange()) { return; }

  const tableVePath = VeFns.addVeidToPath(tableVeid, parentPath);
  const tableVe = VesCache.get(tableVePath)!.get();
  const displayItem_table = asTableItem(tableVe.displayItem);
  const childrenVes = tableVe.childrenVes;
  const tableVesRows = tableVe.tableVesRows;
  if (tableVesRows == null || tableVesRows!.length != childrenVes.length) {
    // TODO (LOW): should really implement logic such that this never happens. This is lazy.
    console.debug("rearrangeTableAfterScroll: invalid tableVesRows, resorting to fullArrange.");
    console.error("[TABLE_DEBUG] Invalid state detected:", {
      tableVePath: tableVePath,
      tableVesRows: tableVesRows,
      tableVesRowsLength: tableVesRows?.length,
      childrenVesLength: childrenVes.length,
      prevScrollYPos: prevScrollYPos,
      currentScrollYPos: store.perItem.getTableScrollYPos(tableVeid),
      tableId: displayItem_table.id,
      timestamp: new Date().toISOString()
    });
    // Clear text editing state to prevent race conditions with DOM elements
    store.overlay.setTextEditInfo(store.history, null);
    fullArrange(store);
    return;
  }

  const sizeBl = tableVeid.linkIdMaybe
    ? { w: tableVe.linkItemMaybe!.spatialWidthGr / GRID_SIZE, h: tableVe.linkItemMaybe!.spatialHeightGr / GRID_SIZE }
    : { w: asTableItem(tableVe.displayItem).spatialWidthGr / GRID_SIZE, h: asTableItem(tableVe.displayItem).spatialHeightGr / GRID_SIZE };
  const blockSizePx = { w: tableVe.boundsPx.w / sizeBl.w, h: tableVe.boundsPx.h / sizeBl.h };

  const numVisibleRows = sizeBl.h - 1 - (asTableItem(tableVe.displayItem).flags & TableFlags.ShowColHeader ? 1 : 0);
  const scrollYPos = store.perItem.getTableScrollYPos(tableVeid);
  const firstItemIdx = Math.floor(scrollYPos);
  const lastItemIdx = firstItemIdx + numVisibleRows;
  const outCount = lastItemIdx - firstItemIdx + 1;
  if (childrenVes.length != outCount) {
    console.error("[TABLE_DEBUG] Unexpected child ves count:", {
      tableVePath: tableVePath,
      childrenVesLength: childrenVes.length,
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

  let tableVeChildren: Array<VisualElementSignal> = [];
  let iterIndices = [0];
  let iterContainers: Array<ContainerItem> = [displayItem_table];
  let rowIdx = 0;
  let finished = displayItem_table.computed_children.length == 0;
  let currentParentPath = tableVePath;
  
  // Debug tracking for visual element position mapping
  const debugRowMapping = new Map<number, {rowIdx: number, itemId: string, outIdx: number}>();

  while (!finished) {
    let itemId = iterContainers[iterContainers.length-1].computed_children[iterIndices[iterIndices.length-1]];
    const item = itemState.get(itemId)!;

    // 1. make row.
    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, item);
    let itemVeid = VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem);
    let itemPath = VeFns.addVeidToPath(itemVeid, currentParentPath);
    if (rowIdx >= firstItemIdx) {
      let outIdx = rowIdx % outCount;
      if (tableVesRows[outIdx] != rowIdx) {
        const indentBl = iterIndices.length - 1;
        const vesToOverwrite = childrenVes[outIdx];
        
        // Debug logging for problematic cases
        const existingVe = vesToOverwrite?.get();
        const existingPath = existingVe ? VeFns.veToPath(existingVe) : null;
        const newPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), tableVePath);
        
        console.debug("[TABLE_DEBUG] Rearranging row:", {
          tableVePath: tableVePath,
          rowIdx: rowIdx,
          outIdx: outIdx,
          expectedRowForOutIdx: tableVesRows[outIdx],
          actualRowIdx: rowIdx,
          itemId: item.id,
          existingPath: existingPath,
          newPath: newPath,
          vesToOverwriteExists: !!vesToOverwrite,
          existingVeExists: !!existingVe,
          itemType: displayItem_childItem.itemType,
          iterIndicesDepth: iterIndices.length,
          timestamp: new Date().toISOString()
        });
        
        try {
          tableVeChildren[outIdx] = createRow(
            store, item, displayItem_table, tableVePath, tableVe._arrangeFlags_useForPartialRearrangeOnly, rowIdx, sizeBl, blockSizePx, indentBl, getBoundingBoxSize(tableVe.boundsPx), vesToOverwrite);
          
          // Track the mapping for debugging
          debugRowMapping.set(outIdx, {rowIdx: rowIdx, itemId: item.id, outIdx: outIdx});
          
        } catch (e: any) {
          // TODO (LOW): should really implement logic such that this never happens. This clumsy catch-all is lazy.
          console.error("[TABLE_DEBUG] createRow failed:", {
            tableVePath: tableVePath,
            rowIdx: rowIdx,
            outIdx: outIdx,
            itemId: item.id,
            error: e.message,
            errorStack: e.stack,
            existingPath: existingPath,
            newPath: newPath,
            vesToOverwriteExists: !!vesToOverwrite,
            existingVeExists: !!existingVe,
            tableVesRows: [...tableVesRows],
            childrenVesLength: childrenVes.length,
            debugRowMapping: Array.from(debugRowMapping.entries()),
            timestamp: new Date().toISOString()
          });
          console.debug("rearrangeTableAfterScroll.createRow failed, resorting to fullArrange.");
          // Clear text editing state to prevent race conditions with DOM elements
          store.overlay.setTextEditInfo(store.history, null);
          fullArrange(store);
          return;
        }
        tableVesRows[outIdx] = rowIdx;
      } else {
        // Track non-rearranged rows too for complete picture
        debugRowMapping.set(outIdx, {rowIdx: rowIdx, itemId: item.id, outIdx: outIdx});
      }
    }
    rowIdx = rowIdx + 1;
    if (rowIdx > lastItemIdx) {
      finished = true;
      break;
    }

    // 2. increment iterator.
    if (isContainer(displayItem_childItem) && store.perVe.getIsExpanded(itemPath)) { initiateLoadChildItemsMaybe(store, itemVeid); }
    if (isContainer(displayItem_childItem) && asContainerItem(displayItem_childItem).computed_children.length > 0 && store.perVe.getIsExpanded(itemPath)) {
      // either step into expanded container
      iterIndices[iterIndices.length-1] = iterIndices[iterIndices.length-1] + 1;
      iterIndices.push(0);
      iterContainers.push(asContainerItem(displayItem_childItem));
    }
    else {
      // or move through current container children by one.
      iterIndices[iterIndices.length-1] = iterIndices[iterIndices.length-1] + 1;
      while (iterIndices.length > 0 && iterIndices[iterIndices.length - 1] >= iterContainers[iterContainers.length-1].computed_children.length) {
        iterIndices.pop();
        iterContainers.pop();
      }
      if (iterIndices.length == 0) {
        while (rowIdx <= lastItemIdx) {
          let outIdx = rowIdx % outCount;
          if (tableVesRows[outIdx] != rowIdx) {
            createFillerRow(displayItem_table, tableVePath);
            rowIdx = rowIdx + 1;
          }
        }
        finished = true;
        break;
      }
    }
  }
  
  // Final validation and comprehensive debug logging
  let hasInconsistency = false;
  const finalDebugInfo = {
    tableVePath: tableVePath,
    tableId: displayItem_table.id,
    scrollYPos: scrollYPos,
    prevScrollYPos: prevScrollYPos,
    firstItemIdx: firstItemIdx,
    lastItemIdx: lastItemIdx,
    outCount: outCount,
    childrenVesLength: childrenVes.length,
    tableVesRowsSnapshot: [...tableVesRows],
    debugRowMapping: Array.from(debugRowMapping.entries()),
    inconsistencies: [] as any[],
    timestamp: new Date().toISOString()
  };
  
  // Check for inconsistencies in the final mapping
  for (let i = 0; i < outCount; i++) {
    const mappingInfo = debugRowMapping.get(i);
    const vesRowValue = tableVesRows[i];
    
    if (mappingInfo && mappingInfo.rowIdx !== vesRowValue) {
      hasInconsistency = true;
      finalDebugInfo.inconsistencies.push({
        outIdx: i,
        mappedRowIdx: mappingInfo.rowIdx,
        vesRowValue: vesRowValue,
        itemId: mappingInfo.itemId
      });
    }
    
    // Also check if childrenVes exists and has the right structure
    const childVe = childrenVes[i]?.get();
    if (childVe && childVe.row !== vesRowValue) {
      hasInconsistency = true;
      finalDebugInfo.inconsistencies.push({
        outIdx: i,
        expectedRow: vesRowValue,
        actualVeRow: childVe.row,
        veItemId: childVe.displayItem.id,
        type: 've_row_mismatch'
      });
    }
  }
  
    if (hasInconsistency) {
    console.error("[TABLE_DEBUG] Inconsistencies detected in final table arrangement:", finalDebugInfo);
  } else if (debugRowMapping.size > 0) {
    // Only log when we actually rearranged something
    console.debug("[TABLE_DEBUG] Table rearrangement completed successfully:", {
      tableId: displayItem_table.id,
      rearrangedCount: debugRowMapping.size,
      scrollChange: `${prevScrollYPos} -> ${scrollYPos}`,
      timestamp: new Date().toISOString()
    });
  }

  for (const path of existingEvaluationQueue) {
    VesCache.markEvaluationRequired(path);
  }

  evaluateExpressions(false);
}


function createRow(
    store: StoreContextModel,
    childItem: Item,
    di_Table: TableItem,
    tableVePath: VisualElementPath,
    flags: ArrangeItemFlags,
    rowIdx: number,
    sizeBl: Dimensions,
    blockSizePx: Dimensions,
    indentBl: number,
    tableDimensionsPx: Dimensions,
    vesToOverwrite: VisualElementSignal | null): VisualElementSignal {

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

  if (isAttachmentsItem(displayItem_childItem)) {
    let tableItemVeAttachments: Array<VisualElementSignal> = [];
    const attachmentsItem = asAttachmentsItem(displayItem_childItem);
    let leftBl = di_Table.tableColumns[0].widthGr / GRID_SIZE;
    let i=0;
    for (; i<di_Table.numberOfVisibleColumns-1; ++i) {
      if (i >= attachmentsItem.computed_attachments.length) { break; }
      if (leftBl >= sizeBl.w) { break; }

      let widthBl = i == di_Table.numberOfVisibleColumns - 2
        ? sizeBl.w - leftBl
        : di_Table.tableColumns[i+1].widthGr / GRID_SIZE;

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
      let tableChildAttachmentVes;
      if (vesToOverwrite != null) {
        // TODO (MEDIUM): re-use these.
        console.debug("[TABLE_DEBUG] Creating new attachment VE (not reusing):", {
          tableVePath: tableVePath,
          attachmentIndex: i,
          attachmentId: attachmentId,
          parentRowIdx: rowIdx,
          parentItemId: displayItem_childItem.id,
          existingAttachmentsCount: vesToOverwrite.get()?.attachmentsVes?.length || 0,
          timestamp: new Date().toISOString()
        });
        tableChildAttachmentVes = VesCache.partial_create(tableChildAttachmentVeSpec, tableChildAttachmentVePath);
      } else {
        tableChildAttachmentVes = VesCache.full_createOrRecycleVisualElementSignal(tableChildAttachmentVeSpec, tableChildAttachmentVePath);
      }

      if (isExpression(tableChildAttachmentVeSpec.displayItem)) {
        VesCache.markEvaluationRequired(VeFns.veToPath(tableChildAttachmentVes.get()));
      }

      tableItemVeAttachments.push(tableChildAttachmentVes);

      leftBl += di_Table.tableColumns[i+1].widthGr / GRID_SIZE;
    }

    tableChildVeSpec.attachmentsVes = tableItemVeAttachments;
  }

  let tableItemVisualElementSignal;

  if (vesToOverwrite != null) {
    VesCache.partial_overwriteVisualElementSignal(tableChildVeSpec, tableChildVePath, vesToOverwrite)
    tableItemVisualElementSignal = vesToOverwrite;
  } else {
    tableItemVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(tableChildVeSpec, tableChildVePath);
  }

  if (isExpression(tableChildVeSpec.displayItem)) {
    VesCache.markEvaluationRequired(VeFns.veToPath(tableItemVisualElementSignal.get()));
  }

  return tableItemVisualElementSignal;
}
