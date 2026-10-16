/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
  Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { GRID_SIZE, RESIZE_BOX_SIZE_PX, TABLE_WRAPPED_ROW_MAX_HEIGHT_BL } from "../constants";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { ContainerItem, asContainerItem, isContainer } from "../items/base/container-item";
import { FlagsMixin, PageFlags, TableFlags, itemCanExpandInLineItem } from "../items/base/flags-item";
import { Item } from "../items/base/item";
import { TableColumnAlign, TabularItem, TabularMixin } from "../items/base/tabular-item";
import { asLinkItem, isLink } from "../items/link-item";
import { NoteFns, asNoteItem, isNote } from "../items/note-item";
import { isPage } from "../items/page-item";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { Dimensions } from "../util/geometry";
import { panic } from "../util/lang";
import { Hitbox, HitboxFlags, HitboxFns } from "./hitbox";
import { initiateLoadChildItemsMaybe } from "./load";
import { VeFns, VisualElementPath } from "./visual-element";
import { getMovingTreeItemInParentMaybe, getVePropertiesForItem } from "./arrange/util";
import { linkHasTriangle } from "./link-triangle";

export type TabularContainerItem = ContainerItem & TabularItem;

export interface TabularVisibleRowInfo {
  item: Item;
  displayItem: Item;
  parentContainer: ContainerItem;
  indexInParent: number;
  rowIdx: number;
  /** The top of the row, in blocks from the top of the first row. */
  offsetBl: number;
  heightBl: number;
  indentBl: number;
  path: VisualElementPath;
}

export interface TabularRowsExtent {
  numRows: number;
  heightBl: number;
}

export interface TabularInsertionTarget {
  parentContainer: ContainerItem;
  insertIndex: number;
}

export function tabularWrapsRows(container: TabularContainerItem): boolean {
  // Both tables and pages have flags.
  const flags = (container as unknown as FlagsMixin).flags;
  return isPage(container)
    ? !!(flags & PageFlags.TableWrapRows)
    : !!(flags & TableFlags.WrapRows);
}

/**
 * The height of a row in blocks: one, or when the table wraps the text of its rows, enough for its tallest note cell
 * (up to TABLE_WRAPPED_ROW_MAX_HEIGHT_BL).
 */
function createTabularRowHeightFn(
  store: StoreContextModel,
  container: TabularContainerItem,
  widthBl: number,
): (item: Item, displayItem: Item, indentBl: number) => number {
  if (!tabularWrapsRows(container)) { return () => 1; }
  return (item, displayItem, indentBl) => {
    const attachmentIds = isAttachmentsItem(displayItem) ? asAttachmentsItem(displayItem).computed_attachments : [];
    return wrappedRowHeightBl(container, widthBl, item, displayItem, indentBl, attachmentIds.length, attachmentIdx => {
      const attachment = itemState.get(attachmentIds[attachmentIdx]);
      return attachment == null ? null : getVePropertiesForItem(store, attachment).displayItem;
    });
  };
}

/**
 * The height in blocks of the rows of a table that is not (yet) in itemState, e.g. one being generated. Each row is
 * given with its attachments, in order. Links are not resolved.
 */
export function tabularRowsHeightBlForItems(
  container: TabularContainerItem,
  widthBl: number,
  rows: Array<{ item: Item, attachments: Array<Item> }>,
): number {
  if (!tabularWrapsRows(container)) { return rows.length; }
  let heightBl = 0;
  for (const row of rows) {
    heightBl += wrappedRowHeightBl(container, widthBl, row.item, row.item, 0, row.attachments.length, attachmentIdx => row.attachments[attachmentIdx] ?? null);
  }
  return heightBl;
}

function wrappedRowHeightBl(
  container: TabularContainerItem,
  widthBl: number,
  item: Item,
  displayItem: Item,
  indentBl: number,
  attachmentCount: number,
  attachmentDisplayItemAt: (attachmentIdx: number) => Item | null,
): number {
  let heightBl = 1;
  const columns = tabularColumnLayouts(container, widthBl);
  if (isNote(displayItem)) {
    const firstColumnWidthBl = columns.length == 0 ? widthBl : columns[0].endBl - columns[0].startBl;
    const hasLinkMarking = isLink(item) && linkHasTriangle(asLinkItem(item));
    heightBl = NoteFns.calcTableCellHeightBl(asNoteItem(displayItem), firstColumnWidthBl - indentBl, false, hasLinkMarking);
  }
  for (const cell of columns.slice(1, attachmentCount + 1)) {
    const attachmentDisplayItem = attachmentDisplayItemAt(cell.index - 1);
    if (attachmentDisplayItem == null || !isNote(attachmentDisplayItem)) { continue; }
    heightBl = Math.max(heightBl, NoteFns.calcTableCellHeightBl(asNoteItem(attachmentDisplayItem), cell.endBl - cell.startBl, true, false));
  }
  return Math.min(heightBl, TABLE_WRAPPED_ROW_MAX_HEIGHT_BL);
}

/**
 * Walk the same expanded row tree for rendering, navigation, and insertion. Return false to stop early, in which case
 * the returned extent covers only the rows walked. widthBl is the width of the table, which the height of its rows
 * can depend on.
 * indexInParent is an index into the unfiltered computed_children, even when a row is skipped.
 */
export function walkTabularRows(
  store: StoreContextModel,
  container: TabularContainerItem,
  containerPath: VisualElementPath,
  widthBl: number,
  onRow: (row: TabularVisibleRowInfo) => boolean | void,
): TabularRowsExtent {
  const rowHeightBl = createTabularRowHeightFn(store, container, widthBl);
  const iterIndices = [0];
  const iterContainers: Array<ContainerItem> = [container];
  let rowIdx = 0;
  let offsetBl = 0;
  // Like an item dragged out of a table, a moving direct child has no row until it is dropped: it is
  // drawn under the pointer instead. This includes an item dragged out of an attachment cell, which
  // is parented here during the move - showing it would add a row (or shift sorted rows).
  const movingItem = getMovingTreeItemInParentMaybe(container.id);

  while (iterIndices.length > 0) {
    const depth = iterIndices.length - 1;
    const parentContainer = iterContainers[depth];
    const indexInParent = iterIndices[depth];
    if (indexInParent >= parentContainer.computed_children.length) {
      iterIndices.pop();
      iterContainers.pop();
      continue;
    }

    const itemId = parentContainer.computed_children[indexInParent];
    if (depth == 0 && movingItem != null && itemId == movingItem.id) {
      iterIndices[depth] = indexInParent + 1;
      continue;
    }
    const item = itemState.get(itemId);
    if (item == null) { panic(`walkTabularRows: row item '${itemId}' not found.`); }

    const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, item);
    const itemVeid = VeFns.veidFromItems(displayItem, linkItemMaybe);
    const path = VeFns.addVeidToPath(itemVeid, containerPath);
    const heightBl = rowHeightBl(item, displayItem, depth);
    const row: TabularVisibleRowInfo = {
      item,
      displayItem,
      parentContainer,
      indexInParent,
      rowIdx,
      offsetBl,
      heightBl,
      indentBl: depth,
      path,
    };
    rowIdx += 1;
    offsetBl += heightBl;
    if (onRow(row) === false) { break; }

    iterIndices[depth] = indexInParent + 1;
    const expandable = isContainer(displayItem) && itemCanExpandInLineItem(displayItem);
    if (expandable && store.perVe.getIsExpanded(path)) {
      initiateLoadChildItemsMaybe(store, itemVeid);
      const childContainer = asContainerItem(displayItem);
      if (childContainer.computed_children.length > 0) {
        iterIndices.push(0);
        iterContainers.push(childContainer);
      }
    }
  }

  return { numRows: rowIdx, heightBl: offsetBl };
}

export function tabularVisibleRows(
  store: StoreContextModel,
  container: TabularContainerItem,
  containerPath: VisualElementPath,
  widthBl: number,
): Array<TabularVisibleRowInfo> {
  const rows: Array<TabularVisibleRowInfo> = [];
  walkTabularRows(store, container, containerPath, widthBl, row => { rows.push(row); });
  return rows;
}

export function tabularInsertionTarget(
  container: TabularContainerItem,
  rows: Array<TabularVisibleRowInfo>,
  insertRow: number,
): TabularInsertionTarget {
  const clampedInsertRow = Math.max(0, Math.min(Math.floor(insertRow), rows.length));
  if (clampedInsertRow >= rows.length) {
    const previousRow = rows[rows.length - 1] ?? null;
    if (previousRow != null && previousRow.parentContainer.id != container.id) {
      return {
        parentContainer: previousRow.parentContainer,
        insertIndex: previousRow.indexInParent + 1,
      };
    }
    return { parentContainer: container, insertIndex: container.computed_children.length };
  }
  const nextRow = rows[clampedInsertRow];
  return { parentContainer: nextRow.parentContainer, insertIndex: nextRow.indexInParent };
}

export function tabularRowsHeightBl(rows: Array<TabularVisibleRowInfo>): number {
  const last = rows[rows.length - 1];
  return last == null ? 0 : last.offsetBl + last.heightBl;
}

/** The vertical extent of row idx. idx == rows.length is the one block position after the last row. */
export function tabularRowSpanBl(rows: Array<TabularVisibleRowInfo>, idx: number): { offsetBl: number, heightBl: number } {
  const row = rows[idx];
  if (row != null) { return { offsetBl: row.offsetBl, heightBl: row.heightBl }; }
  return { offsetBl: tabularRowsHeightBl(rows), heightBl: 1 };
}

/** The index of the row containing offsetBl, clamped to 0..rows.length (rows.length is below the last row). */
export function tabularRowIndexAtOffsetBl(rows: Array<TabularVisibleRowInfo>, offsetBl: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].offsetBl + rows[mid].heightBl <= offsetBl) { lo = mid + 1; } else { hi = mid; }
  }
  return lo;
}

/** The row boundary nearest offsetBl, as the index of the row below it (0..rows.length). */
export function tabularRowBoundaryNearestOffsetBl(rows: Array<TabularVisibleRowInfo>, offsetBl: number): number {
  const idx = tabularRowIndexAtOffsetBl(rows, offsetBl);
  if (idx >= rows.length) { return rows.length; }
  const row = rows[idx];
  return offsetBl < row.offsetBl + row.heightBl / 2 ? idx : idx + 1;
}

export interface TabularColumnLayout {
  index: number;
  name: string;
  startBl: number;
  endBl: number;
  isLast: boolean;
}

/** Resolve visible columns against the displayed width; the final column fills the remaining space. */
export function tabularColumnLayouts(tabular: TabularMixin, widthBl: number): Array<TabularColumnLayout> {
  const columns: Array<TabularColumnLayout> = [];
  const count = Math.min(tabular.numberOfVisibleColumns, tabular.tableColumns.length);
  let startBl = 0;
  for (let index = 0; index < count && startBl < widthBl; ++index) {
    const column = tabular.tableColumns[index];
    const configuredEndBl = startBl + column.widthGr / GRID_SIZE;
    const isLast = index == count - 1 || configuredEndBl >= widthBl;
    columns.push({
      index,
      name: column.name,
      startBl,
      endBl: isLast ? widthBl : configuredEndBl,
      isLast,
    });
    if (isLast) { break; }
    startBl = configuredEndBl;
  }
  return columns;
}

export function tabularAttachmentCellLayouts(
  tabular: TabularMixin,
  widthBl: number,
  attachmentCount: number,
): Array<TabularColumnLayout> {
  return tabularColumnLayouts(tabular, widthBl).slice(1, attachmentCount + 1);
}

export function tabularColumnWidthBl(tabular: TabularMixin, widthBl: number, index: number): number {
  const count = Math.min(tabular.numberOfVisibleColumns, tabular.tableColumns.length);
  if (index >= count - 1) {
    let precedingWidthBl = 0;
    for (let i = 0; i < count - 1; ++i) {
      precedingWidthBl += tabular.tableColumns[i].widthGr / GRID_SIZE;
    }
    return Math.max(1, widthBl - precedingWidthBl);
  }
  return tabular.tableColumns[index].widthGr / GRID_SIZE;
}

export function tabularColumnAlign(tabular: TabularMixin, index: number): TableColumnAlign | null {
  return tabular.tableColumns[index]?.align ?? null;
}

export function tabularColumnAtBl(tabular: TabularMixin, widthBl: number, xBl: number): number {
  const columns = tabularColumnLayouts(tabular, widthBl);
  if (columns.length == 0) { return -1; }
  return columns.find(column => xBl < column.endBl)?.index ?? columns[columns.length - 1].index;
}

export function tabularColumnHitboxes(
  tabular: TabularMixin,
  widthPx: number,
  heightPx: number,
  blockSizePx: Dimensions,
  headerTopPx: number,
  headerHeightPx: number,
  showHeader: boolean,
): { resize: Array<Hitbox>; header: Array<Hitbox> } {
  const resize: Array<Hitbox> = [];
  const header: Array<Hitbox> = [];
  const widthBl = widthPx / blockSizePx.w;
  for (const column of tabularColumnLayouts(tabular, widthBl)) {
    const startXPx = column.startBl * blockSizePx.w - RESIZE_BOX_SIZE_PX / 2;
    const endXPx = column.isLast ? widthPx : column.endBl * blockSizePx.w - RESIZE_BOX_SIZE_PX / 2;
    if (!column.isLast) {
      resize.push(HitboxFns.create(
        HitboxFlags.HorizontalResize,
        { x: endXPx, y: headerTopPx, w: RESIZE_BOX_SIZE_PX, h: heightPx - headerTopPx },
        HitboxFns.createMeta({ colNum: column.index }),
      ));
    }
    if (showHeader) {
      const menuWidthPx = Math.min(blockSizePx.w, (column.endBl - column.startBl) * blockSizePx.w);
      header.push(HitboxFns.create(
        HitboxFlags.Click | HitboxFlags.ContentEditable,
        { x: startXPx, y: headerTopPx, w: endXPx - startXPx, h: headerHeightPx },
        HitboxFns.createMeta({ colNum: column.index, startBl: column.startBl, endBl: column.endBl }),
      ));
      header.push(HitboxFns.create(
        HitboxFlags.TableColumnContextMenu,
        { x: column.endBl * blockSizePx.w - menuWidthPx, y: headerTopPx, w: menuWidthPx, h: headerHeightPx },
        HitboxFns.createMeta({ colNum: column.index }),
      ));
    }
  }
  return { resize, header };
}
