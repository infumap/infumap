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

import { GRID_SIZE, RESIZE_BOX_SIZE_PX } from "../constants";
import { ContainerItem, asContainerItem, isContainer } from "../items/base/container-item";
import { itemCanExpandInLineItem } from "../items/base/flags-item";
import { Item } from "../items/base/item";
import { TabularItem, TabularMixin } from "../items/base/tabular-item";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { Dimensions } from "../util/geometry";
import { panic } from "../util/lang";
import { Hitbox, HitboxFlags, HitboxFns } from "./hitbox";
import { initiateLoadChildItemsMaybe } from "./load";
import { VeFns, VisualElementPath } from "./visual-element";
import { getMovingTreeItemInParentMaybe, getVePropertiesForItem } from "./arrange/util";

export type TabularContainerItem = ContainerItem & TabularItem;

export interface TabularVisibleRowInfo {
  item: Item;
  displayItem: Item;
  parentContainer: ContainerItem;
  indexInParent: number;
  rowIdx: number;
  indentBl: number;
  path: VisualElementPath;
}

export interface TabularInsertionTarget {
  parentContainer: ContainerItem;
  insertIndex: number;
}

/**
 * Walk the same expanded row tree for rendering, navigation, and insertion. Return false to stop early.
 * indexInParent is an index into the unfiltered computed_children, even when a row is skipped.
 */
export function walkTabularRows(
  store: StoreContextModel,
  container: TabularContainerItem,
  containerPath: VisualElementPath,
  onRow: (row: TabularVisibleRowInfo) => boolean | void,
): number {
  const iterIndices = [0];
  const iterContainers: Array<ContainerItem> = [container];
  let rowIdx = 0;
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
    const row: TabularVisibleRowInfo = {
      item,
      displayItem,
      parentContainer,
      indexInParent,
      rowIdx,
      indentBl: depth,
      path,
    };
    rowIdx += 1;
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

  return rowIdx;
}

export function tabularVisibleRows(
  store: StoreContextModel,
  container: TabularContainerItem,
  containerPath: VisualElementPath,
): Array<TabularVisibleRowInfo> {
  const rows: Array<TabularVisibleRowInfo> = [];
  walkTabularRows(store, container, containerPath, row => { rows.push(row); });
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
