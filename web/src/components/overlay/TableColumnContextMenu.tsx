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

import { Component } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { TableFns, asTableItem } from "../../items/table-item";
import { fullArrange } from "../../layout/arrange";
import { VeFns } from "../../layout/visual-element";
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
  const tableItem = () => asTableItem(itemState.get(tableId())!);
  const colNum = () => store.overlay.tableColumnContextMenuInfo.get()!.colNum;

  const newColToRight = () => {
    TableFns.insertEmptyColAt(tableId(), colNum());
    tableItem().numberOfVisibleColumns += 1;
    fullArrange(store);
    serverOrRemote.updateItem(tableItem());
    store.overlay.tableColumnContextMenuInfo.set(null);
  };

  return (
    <div class="absolute"
         style={`left: ${posPx().x-10}px; top: ${posPx().y-5}px; ` +
                `z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onMouseDown={mouseDownListener}>
      <div class="border rounded w-[160px] h-[30px] bg-slate-50 mb-1 shadow-lg">
        <div class="text-xs hover:bg-slate-300 ml-[3px] mr-[5px] mt-[3px] p-[3px]" onClick={newColToRight}>
          Insert 1 Column Right
        </div>
      </div>
    </div>
  );
}
