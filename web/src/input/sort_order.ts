/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { ContainerItem } from "../items/base/container-item";
import { Item } from "../items/base/item";
import { formatSortOrder, parseSortOrder } from "../items/base/sort-order";
import { asTabularItem } from "../items/base/tabular-item";
import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { isTable } from "../items/table-item";
import { requestArrange } from "../layout/arrange";
import { serverOrRemote } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";


/** Order the children of container by orderChildrenBy (see items/base/sort-order.ts), and save it. */
export function setSortOrder(store: StoreContextModel, container: ContainerItem, orderChildrenBy: string, reason: string): void {
  if (container.orderChildrenBy == orderChildrenBy) { return; }
  container.orderChildrenBy = orderChildrenBy;
  itemState.sortChildren(container.id);
  requestArrange(store, reason);
  serverOrRemote.updateItem(container);
  store.touchToolbar();
}

/**
 * Keep a table sorted by a column sorted by the same cells when its columns change. map gives the new index of a
 * column, or null when the column goes (it's deleted, or hidden), which sorts by column 0 instead. Changes
 * orderChildrenBy and re-sorts, but leaves saving the item to the caller, which has changed its columns too.
 */
export function remapSortColumn(container: ContainerItem, map: (col: number) => number | null): void {
  const order = parseSortOrder(container.orderChildrenBy);
  if (order == null || order.col == 0) { return; }
  const orderChildrenBy = formatSortOrder({ ...order, col: map(order.col) ?? 0 });
  if (orderChildrenBy == container.orderChildrenBy) { return; }
  container.orderChildrenBy = orderChildrenBy;
  itemState.sortChildren(container.id);
}

/** The names of the columns item can be sorted by, if it shows as a table: a table, or a page arranged as one. */
export function sortableColumnNames(item: Item): Array<string> | null {
  if (!isTable(item) && !(isPage(item) && asPageItem(item).arrangeAlgorithm == ArrangeAlgorithm.Table)) { return null; }
  const tabular = asTabularItem(item);
  return tabular.tableColumns.slice(0, tabular.numberOfVisibleColumns)
    .map((column, idx) => column.name.trim() == "" ? `Column ${idx + 1}` : column.name);
}
