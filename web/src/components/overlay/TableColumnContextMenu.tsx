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

import { Component, Show } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { TableFns } from "../../items/table-item";
import { asTabularItem, isTabularItem } from "../../items/base/tabular-item";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { requestArrange } from "../../layout/arrange";
import { VeFns, isTableView } from "../../layout/visual-element";
import { VesCache } from "../../layout/ves-cache";
import { itemState } from "../../store/ItemState";
import { serverOrRemote } from "../../server";


export const TableColumnContextMenu: Component = () => {
  const store = useStore();

  // Prevent mouse down events bubbling up, which would trigger the handler that hides the context menu.
  let mouseDownListener = (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) {
      ev.stopPropagation();
    }
  }

  const posPx = () => store.overlay.tableColumnContextMenuInfo.get()!.posPx;
  const tableVePath = () => store.overlay.tableColumnContextMenuInfo.get()!.tablePath;
  const tableId = () => VeFns.veidFromPath(tableVePath()).itemId;
  const tableItem = () => asTabularItem(itemState.get(tableId())!);
  const colNum = () => store.overlay.tableColumnContextMenuInfo.get()!.colNum;
  const canChangeColumns = () => {
    const ve = VesCache.current.readNode(tableVePath());
    const item = itemState.get(tableId());
    return ve != null && isTableView(ve) && item != null && isTabularItem(item) &&
      itemCanEdit(item) && itemCanEdit(VeFns.treeItem(ve)) &&
      colNum() >= 0 && colNum() < asTabularItem(item).numberOfVisibleColumns &&
      colNum() < asTabularItem(item).tableColumns.length;
  };
  const finishChange = (reason: string) => {
    requestArrange(store, reason);
    serverOrRemote.updateItem(tableItem(), store.general.networkStatus);
    store.overlay.tableColumnContextMenuInfo.set(null);
    store.touchToolbar();
  };
  const menuPosPx = () => ({
    x: Math.max(0, Math.min(posPx().x + 10, store.desktopBoundsPx().w - 170)),
    y: Math.max(0, Math.min(posPx().y - 12, store.desktopBoundsPx().h - (colNum() == 0 ? 65 : 125))),
  });

  const newColToRight = () => {
    if (!canChangeColumns()) { store.overlay.tableColumnContextMenuInfo.set(null); return; }
    const insertHeaderIdx = Math.min(colNum() + 1, tableItem().tableColumns.length);
    tableItem().tableColumns.splice(insertHeaderIdx, 0, { name: `col ${insertHeaderIdx}` , widthGr: 120 });
    TableFns.insertEmptyColAt(tableId(), colNum(), store);
    tableItem().numberOfVisibleColumns += 1;
    finishChange("table-column-insert-right");
  };

  const newHeaderOnlyToRight = () => {
    if (!canChangeColumns()) { store.overlay.tableColumnContextMenuInfo.set(null); return; }
    const insertHeaderIdx = Math.min(colNum() + 1, tableItem().tableColumns.length);
    tableItem().tableColumns.splice(insertHeaderIdx, 0, { name: `col ${insertHeaderIdx}` , widthGr: 120 });
    tableItem().numberOfVisibleColumns += 1;
    finishChange("table-column-insert-header-right");
  };

  const deleteColumn = () => {
    if (!canChangeColumns() || colNum() == 0) { store.overlay.tableColumnContextMenuInfo.set(null); return; }
    TableFns.removeColItemsAt(tableId(), colNum()-1, store);
    tableItem().tableColumns.splice(colNum(), 1);
    tableItem().numberOfVisibleColumns -= 1;
    finishChange("table-column-delete");
  }

  const deleteColumnHeaderOnly = () => {
    if (!canChangeColumns() || colNum() == 0) { store.overlay.tableColumnContextMenuInfo.set(null); return; }
    tableItem().tableColumns.splice(colNum(), 1);
    tableItem().numberOfVisibleColumns -= 1;
    finishChange("table-column-delete-header");
  }

  return (
    <div class="absolute"
         style={`left: ${menuPosPx().x}px; top: ${menuPosPx().y}px; ` +
                `z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY};`}
         onMouseDown={mouseDownListener}>
      <div class="border rounded w-[160px] bg-slate-50 mb-1 shadow-lg">
        <div class="text-xs hover:bg-slate-300 ml-[3px] mr-[5px] mt-[3px] p-[3px]" onClick={newColToRight}>
          Insert 1 Column Right
        </div>
        <div class="text-xs hover:bg-slate-300 ml-[3px] mr-[5px] mt-[3px] p-[3px]" onClick={newHeaderOnlyToRight}>
          Insert 1 Column Right (Header Only)
        </div>
        <Show when={colNum() > 0}>
          <div class="text-xs hover:bg-slate-300 ml-[3px] mr-[5px] mt-[3px] p-[3px]" onClick={deleteColumn}>
            Delete column
          </div>
          <div class="text-xs hover:bg-slate-300 ml-[3px] mr-[5px] mt-[3px] p-[3px]" onClick={deleteColumnHeaderOnly}>
            Delete column (Header Only)
          </div>
        </Show>
      </div>
    </div>
  );
}
