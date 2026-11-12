/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, createSignal } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { asPageItem } from "../../items/page-item";
import { getToolbarFocusItem } from "./toolbarFocus";
import { remapSortColumn } from "../../input/sort_order";
import {
  TOOLBAR_DIALOG_INPUT_CLASS, ToolbarDialogHeader, ToolbarDialogPageShapeSection, closeToolbarDialog, toolbarDialogContentRef,
  toolbarDialogNumberInput, toolbarDialogPageChanged,
} from "./toolbarDialog";


export const PAGE_TABLE_LAYOUT_POPUP_HEIGHT_PX = 180;

const MIN_COLUMNS = 1;
const MAX_COLUMNS = 20;
const NEW_COLUMN_WIDTH_GR = 120;

/**
 * Sets the columns of a table page, and, separately, the page's shape where it is shown inside something else. Column
 * widths and names are set on the table itself, by dragging and editing its headings.
 */
export const Toolbar_PageTableLayoutPopup: Component = () => {
  const store = useStore();

  const pageItem = () => asPageItem(getToolbarFocusItem(store));
  const [columns, setColumns] = createSignal(pageItem().numberOfVisibleColumns);

  const applyColumns = (requested: number) => {
    const value = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(requested)));
    setColumns(value);
    const page = pageItem();
    if (page.numberOfVisibleColumns == value) { return; }
    page.numberOfVisibleColumns = value;
    remapSortColumn(page, col => col >= value ? null : col);
    // Columns hidden by reducing the count keep their settings, so only columns never shown before need adding.
    while (page.tableColumns.length < value) {
      page.tableColumns.push({ name: `col ${page.tableColumns.length}`, widthGr: NEW_COLUMN_WIDTH_GR });
    }
    toolbarDialogPageChanged(store, page, "toolbar-table-columns");
  };

  const close = () => closeToolbarDialog(store);

  const stepperButtonClass = "h-[24px] w-[24px] rounded-md border border-[#d6d6d6] bg-white text-[12px] text-[#555] hover:bg-slate-50 disabled:cursor-default disabled:opacity-50";

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="flex flex-col" onKeyDown={ev => { if (ev.key == "Escape") { ev.stopPropagation(); close(); } }}>
      <ToolbarDialogHeader title="Table layout" onClose={close}
        description="Each item is a row: its title, then its attachments. Drag a column's edge on the table to resize it." />

      <div class="px-3 py-3">
        <div class="flex items-center gap-2">
          <div class="w-[72px] text-[12px] text-slate-600">Columns</div>
          <button type="button" class={stepperButtonClass} aria-label="Fewer columns" disabled={columns() <= MIN_COLUMNS}
            onClick={() => applyColumns(columns() - 1)}><i class="bi-dash" /></button>
          <input class={`${TOOLBAR_DIALOG_INPUT_CLASS} !w-[44px] text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
            type="number" min={MIN_COLUMNS} max={MAX_COLUMNS} step="1" aria-label="Columns"
            value={columns()} {...toolbarDialogNumberInput(store, columns, applyColumns, 1)} />
          <button type="button" class={stepperButtonClass} aria-label="More columns" disabled={columns() >= MAX_COLUMNS}
            onClick={() => applyColumns(columns() + 1)}><i class="bi-plus" /></button>
        </div>
      </div>

      <ToolbarDialogPageShapeSection page={pageItem} />
    </div>
  );
}
