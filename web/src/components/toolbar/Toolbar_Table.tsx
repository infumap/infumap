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
import { InfuIconButton } from "../library/InfuIconButton";
import { panic } from "../../util/lang";
import { asTableItem } from "../../items/table-item";
import { itemState } from "../../store/ItemState";
import { arrange } from "../../layout/arrange";
import { server } from "../../server";
import { TableFlags } from "../../items/base/flags-item";
import { ToolbarOverlayType } from "../../store/StoreProvider_Overlay";


export const Toolbar_Table: Component = () => {
  const store = useStore();

  const tableItem = () => asTableItem(itemState.get(store.getToolbarFocus()!.itemId)!);

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
    arrange(store);
    server.updateItem(tableItem());
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
    arrange(store);
  }

  const tableTitleText = () => {
    store.touchToolbarDependency();
    return tableItem().title;
  }

  const handleQr = () => {
    store.overlay.toolbarOverlayInfoMaybe.set(
      { topLeftPx: { x: 0, y: 0 }, type: ToolbarOverlayType.Ids });
  }

  return (
    <div class="flex-grow-0" style="flex-order: 0;">
      <InfuIconButton icon="bi-sort-alpha-down" highlighted={isSortedByTitle()} clickHandler={handleOrderChildrenBy} />
      <InfuIconButton icon="bi-table" highlighted={showHeader()} clickHandler={handleChangeShowHeader} />
      <div class="pl-[4px] inline-block">
        <InfuIconButton icon="bi-qr-code" highlighted={false} clickHandler={handleQr} />
      </div>
    </div>
  )
}
