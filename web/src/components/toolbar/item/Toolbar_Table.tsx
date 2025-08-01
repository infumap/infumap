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
import { useStore } from "../../../store/StoreProvider";
import { InfuIconButton } from "../../library/InfuIconButton";
import { asTableItem } from "../../../items/table-item";
import { itemState } from "../../../store/ItemState";
import { serverOrRemote } from "../../../server";
import { TableFlags } from "../../../items/base/flags-item";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { ClickState } from "../../../input/state";
import { fullArrange } from "../../../layout/arrange";
import { InfuButton } from "../../library/InfuButton";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";


export const Toolbar_Table: Component = () => {
  const store = useStore();

  let numColsDiv: HTMLDivElement | undefined;
  let qrDiv: HTMLDivElement | undefined;

  const tableItem = () => asTableItem(store.history.getFocusItem());

  const isSortedByTitle = () => {
    store.touchToolbarDependency();
    return tableItem().orderChildrenBy == "title[ASC]";
  }

  const handleOrderChildrenBy = async () => {
    const orderByTitle = tableItem().orderChildrenBy;
    if (orderByTitle == "") {
      tableItem().orderChildrenBy = "title[ASC]";
    } else {
      tableItem().orderChildrenBy = "";
    }
    itemState.sortChildren(tableItem().id);
    fullArrange(store);
    serverOrRemote.updateItem(tableItem(), store.general.networkStatus);
    store.touchToolbar();
  }

  const showHeader = () => {
    store.touchToolbarDependency();
    return !(!(tableItem().flags & TableFlags.ShowColHeader));
  }

  const handleChangeShowHeader = () => {
    if (tableItem().flags & TableFlags.ShowColHeader) {
      tableItem().flags &= ~TableFlags.ShowColHeader;
    } else {
      tableItem().flags |= TableFlags.ShowColHeader;
    }
    itemState.sortChildren(tableItem().id);
    fullArrange(store);
  }

  const handleQr = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.QrLink) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: qrDiv!.getBoundingClientRect().x, y: qrDiv!.getBoundingClientRect().y + 38 }, type: ToolbarPopupType.QrLink });
  }
  const handleQrDown = () => {
    ClickState.setButtonClickBoundsPx(qrDiv!.getBoundingClientRect());
  };

  const numColsText = () => {
    store.touchToolbarDependency();
    return tableItem().numberOfVisibleColumns;
  }

  // Num Cols
  const handleNumColsClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.TableNumCols) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: numColsDiv!.getBoundingClientRect().x, y: numColsDiv!.getBoundingClientRect().y + 35 }, type: ToolbarPopupType.TableNumCols });
  };
  const handleNumColsDown = () => {
    ClickState.setButtonClickBoundsPx(numColsDiv!.getBoundingClientRect());
  };

  const handleCopyId = () => {
    navigator.clipboard.writeText(tableItem().id);
    store.overlay.toolbarTransientMessage.set({ text: "table id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  return (
    <div id="toolbarItemOptionsDiv"
         class="flex-grow-0" style="flex-order: 0;">
      <div ref={numColsDiv}
           class="inline-block w-[45px] border border-slate-400 rounded-md ml-[10px] mr-[10px] hover:bg-slate-300 cursor-pointer"
           style={`font-size: 13px;`}
           onClick={handleNumColsClick}
           onMouseDown={handleNumColsDown}>
        <i class="bi-layout-three-columns ml-[4px]" />
        <div class="inline-block w-[20px] pl-[6px] text-right">
          {numColsText()}
        </div>
      </div>
      <InfuIconButton icon="bi-sort-alpha-down" highlighted={isSortedByTitle()} clickHandler={handleOrderChildrenBy} />
      <InfuIconButton icon="bi-table" highlighted={showHeader()} clickHandler={handleChangeShowHeader} />

      {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
      <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

      <div ref={qrDiv} class="inline-block pl-[20px]" onMouseDown={handleQrDown}>
        <InfuIconButton icon="bi-info-circle-fill" highlighted={false} clickHandler={handleQr} />
      </div>
      <div class="inline-block">
        <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleCopyId} />
      </div>

    </div>
  )
}
