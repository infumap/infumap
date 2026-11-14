/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, createSignal } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { asPageItem } from "../../items/page-item";
import { getToolbarFocusItem } from "./toolbarFocus";
import {
  ToolbarDialogPageShapeSection, ToolbarDialogStepper, closeToolbarDialog, toolbarDialogContentRef,
} from "./toolbarDialog";
import { DialogHeader } from "../library/dialogStyle";
import { MAX_TABLE_COLUMNS, MIN_TABLE_COLUMNS, applyVisibleTableColumns } from "./Toolbar_TableColumnsPopup";


/**
 * Sets the columns of a table page, and, separately, the page's shape where it is shown inside something else. Column
 * widths and names are set on the table itself, by dragging and editing its headings.
 */
export const Toolbar_PageTableLayoutPopup: Component = () => {
  const store = useStore();

  const pageItem = () => asPageItem(getToolbarFocusItem(store));
  const [columns, setColumns] = createSignal(pageItem().numberOfVisibleColumns);

  const applyColumns = (requested: number) => { setColumns(applyVisibleTableColumns(store, pageItem(), requested)); };

  const close = () => closeToolbarDialog(store);

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="flex flex-col" onKeyDown={ev => { if (ev.key == "Escape") { ev.stopPropagation(); close(); } }}>
      <DialogHeader title="Table layout" onClose={close}
        description="Each item is a row: its title, then its attachments. Drag a column's edge on the table to resize it." />

      <div class="px-3 py-3">
        <ToolbarDialogStepper label="Columns" value={columns} apply={applyColumns} min={MIN_TABLE_COLUMNS} max={MAX_TABLE_COLUMNS}
          decreaseLabel="Fewer columns" increaseLabel="More columns" />
      </div>

      <ToolbarDialogPageShapeSection page={pageItem} />
    </div>
  );
}
