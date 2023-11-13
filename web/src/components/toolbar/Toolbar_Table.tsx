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
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { useUserStore } from "../../store/UserStoreProvider";
import { InfuIconButton } from "../library/InfuIconButton";
import { createBooleanSignal } from "../../util/signals";
import { panic } from "../../util/lang";
import { asTableItem } from "../../items/table-item";
import { itemState } from "../../store/ItemState";
import { arrange } from "../../layout/arrange";
import { server } from "../../server";
import { TableFlags } from "../../items/base/flags-item";


export const Toolbar_Table: Component = () => {
  const desktopStore = useDesktopStore();
  const userStore = useUserStore();

  let alwaysFalseSignal = createBooleanSignal(false);
  const rerenderToolbar = () => { alwaysFalseSignal.set(false); }

  const tableItem = () => asTableItem(itemState.get(desktopStore.getToolbarFocus()!.itemId)!);

  const isSortedByTitle = () => {
    if (alwaysFalseSignal.get()) { panic("unexpected state"); }
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
    arrange(desktopStore);
    server.updateItem(tableItem());
    rerenderToolbar();
  }

  const deleteButtonHandler = () => {};

  const showHeader = () => {
    if (alwaysFalseSignal.get()) { panic("unexpected state"); }
    return !(!(tableItem().flags & TableFlags.ShowColHeader));
  }

  const handleChangeShowHeader = () => {
    if (tableItem().flags & TableFlags.ShowColHeader) {
      tableItem().flags &= ~TableFlags.ShowColHeader;
    } else {
      tableItem().flags |= TableFlags.ShowColHeader;
    }
    itemState.sortChildren(tableItem().id);
    arrange(desktopStore);
  }

  return (
    <div class="inline-block p-[4px] flex-grow-0">
      <InfuIconButton icon="bi-sort-alpha-down" highlighted={isSortedByTitle()} clickHandler={handleOrderChildrenBy} />
      <InfuIconButton icon="bi-table" highlighted={showHeader()} clickHandler={handleChangeShowHeader} />
      <Show when={userStore.getUserMaybe() != null && userStore.getUser().userId == tableItem().ownerId}>
        <InfuIconButton icon="fa fa-trash" highlighted={false} clickHandler={deleteButtonHandler} />
      </Show>
    </div>
  )
}
