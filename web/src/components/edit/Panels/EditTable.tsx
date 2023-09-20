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

import { Component, Show, onCleanup } from "solid-js";
import { server } from "../../../server";
import { useDesktopStore } from "../../../store/DesktopStoreProvider";
import { asTableItem, TableItem } from "../../../items/table-item";
import { InfuButton } from "../../library/InfuButton";
import { InfuTextInput } from "../../library/InfuTextInput";
import { arrange } from "../../../layout/arrange";
import { NumberSignal, createNumberSignal } from "../../../util/signals";
import { itemState } from "../../../store/ItemState";
import { TableFlags } from "../../../items/base/flags-item";


export const EditTable: Component<{tableItem: TableItem, linkedTo: boolean}> = (props: { tableItem: TableItem, linkedTo: boolean }) => {
  const desktopStore = useDesktopStore();

  let checkElement_ord: HTMLInputElement | undefined;
  let checkElement_header: HTMLInputElement | undefined;

  const tableId = props.tableItem.id;
  const table = () => props.tableItem;
  let colCountSignal: NumberSignal = createNumberSignal(table().tableColumns.length);

  let deleted = false;

  const handleTitleInput = (v: string) => {
    asTableItem(itemState.get(tableId)!).title = v;
    arrange(desktopStore);
  };

  const deleteTable = async () => {
    deleted = true;
    await server.deleteItem(tableId); // throws on failure.
    itemState.delete(tableId);
    desktopStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  const addCol = () => {
    if (table().tableColumns.length > 9) { return; }
    table().tableColumns.push({ name: `col ${table().tableColumns.length}`, widthGr: 120 });
    colCountSignal.set(colCountSignal.get() + 1);
    arrange(desktopStore);
  }

  const deleteCol = () => {
    if (table().tableColumns.length == 1) { return; }
    table().tableColumns.pop();
    colCountSignal.set(colCountSignal.get() - 1);
    arrange(desktopStore);
  }

  const changeOrderChildrenBy = async () => {
    const orderByTitle = checkElement_ord?.checked;
    if (orderByTitle) {
      asTableItem(itemState.get(tableId)!).orderChildrenBy = "title[ASC]";
    } else {
      asTableItem(itemState.get(tableId)!).orderChildrenBy = "";
    }
    itemState.sortChildren(tableId);
    arrange(desktopStore);
  }

  const changeShowHeader = async () => {
    if (checkElement_header!.checked) {
      asTableItem(itemState.get(tableId)!).flags |= TableFlags.ShowColHeader;
    } else {
      asTableItem(itemState.get(tableId)!).flags &= ~TableFlags.ShowColHeader;
    }
    itemState.sortChildren(tableId);
    arrange(desktopStore);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(itemState.get(tableId)!);
    }
  });

  return (
    <div>
      <div class="text-slate-800 text-sm">Title <InfuTextInput value={props.tableItem.title} onInput={handleTitleInput} focus={true} /></div>
      <div>
        <InfuButton text="add col" onClick={addCol} />
        <InfuButton text="delete col" onClick={deleteCol} />
        <div>num cols: {colCountSignal!.get()}</div>
      </div>
      <div>
        <input id="ord" name="ord" type="checkbox" ref={checkElement_ord} checked={props.tableItem.orderChildrenBy == "title[ASC]"} onClick={changeOrderChildrenBy} />
        <label for="ord">order by title</label>
      </div>
      <div>
        <input id="header" name="header" type="checkbox" ref={checkElement_header} checked={(props.tableItem.flags & TableFlags.ShowColHeader) ? true : false} onClick={changeShowHeader} />
        <label for="header">show header</label>
      </div>
      <Show when={!props.linkedTo}>
        <div><InfuButton text="delete" onClick={deleteTable} /></div>
      </Show>
    </div>
  );
}
