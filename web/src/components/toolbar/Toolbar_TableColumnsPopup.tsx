/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, createSignal } from "solid-js";
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { PageItem } from "../../items/page-item";
import { TableItem, asTableItem } from "../../items/table-item";
import { remapSortColumn } from "../../input/sort_order";
import { getToolbarFocusItem } from "./toolbarFocus";
import { ToolbarDialogStepper, closeToolbarDialog, toolbarDialogContentRef, toolbarDialogItemChanged } from "./toolbarDialog";


export const TABLE_COLUMNS_POPUP_WIDTH_PX = 220;
export const TABLE_COLUMNS_POPUP_HEIGHT_PX = 50;

export const MIN_TABLE_COLUMNS = 1;
export const MAX_TABLE_COLUMNS = 20;
const NEW_COLUMN_WIDTH_GR = 120;

/**
 * Sets how many columns a table item or table page shows, returning the value set. Columns hidden by reducing the
 * count keep their settings, so only columns never shown before are added.
 */
export function applyVisibleTableColumns(store: StoreContextModel, item: TableItem | PageItem, requested: number): number {
  const value = Math.max(MIN_TABLE_COLUMNS, Math.min(MAX_TABLE_COLUMNS, Math.round(requested)));
  if (item.numberOfVisibleColumns == value) { return value; }
  item.numberOfVisibleColumns = value;
  remapSortColumn(item, col => col >= value ? null : col);
  while (item.tableColumns.length < value) {
    item.tableColumns.push({ name: `col ${item.tableColumns.length}`, widthGr: NEW_COLUMN_WIDTH_GR });
  }
  toolbarDialogItemChanged(store, item, "toolbar-table-columns");
  return value;
}

/**
 * Sets the number of columns of a table item. A whole number in a small range, so a stepper, the same as for a table
 * page, rather than a slider, which is hard to set to an exact value.
 */
export const Toolbar_TableColumnsPopup: Component = () => {
  const store = useStore();
  const tableItem = () => asTableItem(getToolbarFocusItem(store));
  const [columns, setColumns] = createSignal(tableItem().numberOfVisibleColumns);
  const apply = (requested: number) => { setColumns(applyVisibleTableColumns(store, tableItem(), requested)); };

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="p-3"
      onKeyDown={ev => { if (ev.key == "Escape") { ev.stopPropagation(); closeToolbarDialog(store); } }}>
      <ToolbarDialogStepper label="Columns" value={columns} apply={apply} min={MIN_TABLE_COLUMNS} max={MAX_TABLE_COLUMNS}
        decreaseLabel="Fewer columns" increaseLabel="More columns" />
    </div>
  );
}
