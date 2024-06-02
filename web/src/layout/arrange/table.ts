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
import { asAttachmentsItem, isAttachmentsItem } from "../../items/base/attachments-item";
import { ContainerItem, asContainerItem, isContainer } from "../../items/base/container-item";
import { TableFlags } from "../../items/base/flags-item";
import { Item, uniqueEmptyItem } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asTitledItem, isTitledItem } from "../../items/base/titled-item";
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
    flags: ArrangeItemFlags): VisualElementSignal => {

  const sizeBl = linkItemMaybe_Table
    ? { w: linkItemMaybe_Table!.spatialWidthGr / GRID_SIZE, h: linkItemMaybe_Table!.spatialHeightGr / GRID_SIZE }
    : { w: displayItem_Table.spatialWidthGr / GRID_SIZE, h: displayItem_Table.spatialHeightGr / GRID_SIZE };
  const blockSizePx = { w: tableGeometry.boundsPx.w / sizeBl.w, h: tableGeometry.boundsPx.h / sizeBl.h };

  const tableVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_Table, linkItemMaybe_Table), parentPath);

  const tableVisualElementSpec: VisualElementSpec = {
    displayItem: displayItem_Table,
    linkItemMaybe: linkItemMaybe_Table,
    actualLinkItemMaybe: actualLinkItemMaybe_Table,
    flags: VisualElementFlags.Detailed |
          (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
          (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None),
    arrangeFlags: flags,
    boundsPx: tableGeometry.boundsPx,
    viewportBoundsPx: tableGeometry.viewportBoundsPx!,
    hitboxes: tableGeometry.hitboxes,
    blockSizePx,
    parentPath,
  };

  const [childrenVes, tableVesRows, numRows] = arrangeTableChildren(store, displayItem_Table, linkItemMaybe_Table, tableGeometry, tableVePath, flags);
  tableVisualElementSpec.childrenVes = childrenVes;
  tableVisualElementSpec.tableVesRows = tableVesRows;

  const childAreaBoundsPx = zeroBoundingBoxTopLeft(cloneBoundingBox(tableGeometry.viewportBoundsPx)!);
  childAreaBoundsPx.h = numRows * tableGeometry.blockSizePx.h
  tableVisualElementSpec.childAreaBoundsPx = childAreaBoundsPx;

  const attachments = arrangeItemAttachments(store, displayItem_Table, linkItemMaybe_Table, tableGeometry.boundsPx, tableVePath);
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
    flags: ArrangeItemFlags): [Array<VisualElementSignal>, Array<number>, number] {

  const sizeBl = linkItemMaybe_table
    ? { w: linkItemMaybe_table!.spatialWidthGr / GRID_SIZE, h: linkItemMaybe_table!.spatialHeightGr / GRID_SIZE }
    : { w: displayItem_table.spatialWidthGr / GRID_SIZE, h: displayItem_table.spatialHeightGr / GRID_SIZE };
  const blockSizePx = { w: tableGeometry.boundsPx.w / sizeBl.w, h: tableGeometry.boundsPx.h / sizeBl.h };

  const scrollYPos = store.perItem.getTableScrollYPos(VeFns.veidFromItems(displayItem_table, linkItemMaybe_table));
  const firstItemIdx = Math.floor(scrollYPos);
  const numVisibleRows = (linkItemMaybe_table ? linkItemMaybe_table.spatialHeightGr / GRID_SIZE : displayItem_table.spatialHeightGr / GRID_SIZE)
                          - 1
                          - (displayItem_table.flags & TableFlags.ShowColHeader ? 1 : 0);
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
      // or move through current container childern by one.
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
    fullArrange(store);
    return;
  }

  const numVisibleRows = (tableVe.linkItemMaybe ? tableVe.linkItemMaybe.spatialHeightGr / GRID_SIZE : asTableItem(tableVe.displayItem).spatialHeightGr / GRID_SIZE)
                         - 1
                         - (asTableItem(tableVe.displayItem).flags & TableFlags.ShowColHeader ? 1 : 0);

  const scrollYPos = store.perItem.getTableScrollYPos(tableVeid);
  const firstItemIdx = Math.floor(scrollYPos);
  const lastItemIdx = firstItemIdx + numVisibleRows;
  const outCount = lastItemIdx - firstItemIdx + 1;
  if (childrenVes.length != outCount) {
    // TODO (LOW): should really implement logic such that this never happens. This is lazy.
    console.debug("rearrangeTableAfterScroll: unexpected number of child ves rows.");
    fullArrange(store);
    return;
  }

  const sizeBl = tableVeid.linkIdMaybe
    ? { w: tableVe.linkItemMaybe!.spatialWidthGr / GRID_SIZE, h: tableVe.linkItemMaybe!.spatialHeightGr / GRID_SIZE }
    : { w: asTableItem(tableVe.displayItem).spatialWidthGr / GRID_SIZE, h: asTableItem(tableVe.displayItem).spatialHeightGr / GRID_SIZE };
  const blockSizePx = { w: tableVe.boundsPx.w / sizeBl.w, h: tableVe.boundsPx.h / sizeBl.h };

  let tableVeChildren: Array<VisualElementSignal> = [];
  let iterIndices = [0];
  let iterContainers: Array<ContainerItem> = [displayItem_table];
  let rowIdx = 0;
  let finished = displayItem_table.computed_children.length == 0;
  let currentParentPath = tableVePath;

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
        try {
          tableVeChildren[outIdx] = createRow(
            store, item, displayItem_table, tableVePath, tableVe.arrangeFlags, rowIdx, sizeBl, blockSizePx, indentBl, getBoundingBoxSize(tableVe.boundsPx), vesToOverwrite);
        } catch (e: any) {
          // TODO (LOW): should really implement logic such that this never happens. This clumsy catch-all is lazy.
          console.debug("rearrangeTableAfterScroll.createRow failed, resorting to fullArrange.");
          fullArrange(store);
          return;
        }
        tableVesRows[outIdx] = rowIdx;
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
      // or move through current container childern by one.
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

  const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, rowIdx, indentBl, widthBl - indentBl, !!(flags & ArrangeItemFlags.ParentIsPopup), false, true);

  const tableChildVeSpec: VisualElementSpec = {
    displayItem: displayItem_childItem,
    linkItemMaybe: linkItemMaybe_childItem,
    actualLinkItemMaybe: linkItemMaybe_childItem,
    flags: VisualElementFlags.LineItem | VisualElementFlags.InsideTable,
    arrangeFlags: ArrangeItemFlags.None,
    boundsPx: geometry.boundsPx,
    tableDimensionsPx,
    indentBl,
    hitboxes: geometry.hitboxes,
    parentPath: tableVePath,
    col: 0,
    row: rowIdx,
    blockSizePx,
  };
  const tableChildVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), tableVePath);

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

      const geometry = ItemFns.calcGeometry_ListItem(attachmentItem, blockSizePx, rowIdx, leftBl, widthBl, !!(flags & ArrangeItemFlags.ParentIsPopup), false, false);

      const tableChildAttachmentVeSpec: VisualElementSpec = {
        displayItem: displayItem_attachment,
        linkItemMaybe: linkItemMaybe_attachment,
        actualLinkItemMaybe: linkItemMaybe_attachment,
        flags: VisualElementFlags.InsideTable | VisualElementFlags.Attachment,
        arrangeFlags: ArrangeItemFlags.None,
        boundsPx: geometry.boundsPx,
        tableDimensionsPx,
        indentBl,
        hitboxes: geometry.hitboxes,
        col: i + 1,
        row: rowIdx,
        parentPath: tableChildVePath,
        blockSizePx
      };
      const tableChildAttachmentVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_attachment, linkItemMaybe_attachment), tableChildVePath);
      let tableChildAttachmentVeSignal;
      if (vesToOverwrite != null) {
        // TODO (MEDIUM): re-use these.
        tableChildAttachmentVeSignal = VesCache.partial_create(tableChildAttachmentVeSpec, tableChildAttachmentVePath);
      } else {
        tableChildAttachmentVeSignal = VesCache.full_createOrRecycleVisualElementSignal(tableChildAttachmentVeSpec, tableChildAttachmentVePath);
      }

      if (isExpression(tableChildAttachmentVeSpec.displayItem)) {
        VesCache.markEvaluationRequired(VeFns.veToPath(tableChildAttachmentVeSignal.get()));
      }

      tableItemVeAttachments.push(tableChildAttachmentVeSignal);

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
