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

import { Component, onCleanup, onMount } from "solid-js";
import { server } from "../../server";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { asTableItem, TableItem } from "../../items/table-item";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";
import { arrange, rearrangeVisualElementsWithItemId } from "../../layout/arrange";
import { NumberSignal, createNumberSignal } from "../../util/signals";
import { itemStore } from "../../store/ItemStore";


export const EditTable: Component<{tableItem: TableItem}> = (props: {tableItem: TableItem}) => {
  const desktopStore = useDesktopStore();

  let checkElement_ord: HTMLInputElement | undefined;
  let checkElement_header: HTMLInputElement | undefined;

  const tableId = props.tableItem.id;
  const table = () => props.tableItem;
  let colCountSignal: NumberSignal = createNumberSignal(table().tableColumns.length);

  let deleted = false;

  const handleTitleInput = (v: string) => {
    asTableItem(itemStore.getItem(tableId)!).title = v;
    rearrangeVisualElementsWithItemId(desktopStore, tableId);
  };

  const deleteTable = async () => {
    deleted = true;
    await server.deleteItem(tableId); // throws on failure.
    itemStore.deleteItem(tableId);
    desktopStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  const addCol = () => {
    if (table().tableColumns.length > 9) { return; }
    table().tableColumns.push({ name: `col ${table().tableColumns.length}`, widthGr: 120 });
    colCountSignal.set(colCountSignal.get() + 1);
    rearrangeVisualElementsWithItemId(desktopStore, tableId);
  }

  const deleteCol = () => {
    if (table().tableColumns.length == 1) { return; }
    table().tableColumns.pop();
    colCountSignal.set(colCountSignal.get() - 1);
    rearrangeVisualElementsWithItemId(desktopStore, tableId);
  }

  const changeOrderChildrenBy = async () => {
    const orderByTitle = checkElement_ord?.checked;
    if (orderByTitle) {
      asTableItem(itemStore.getItem(tableId)!).orderChildrenBy = "title[ASC]";
    } else {
      asTableItem(itemStore.getItem(tableId)!).orderChildrenBy = "";
    }
    itemStore.sortChildren(tableId);
    arrange(desktopStore);
  }

  const changeShowHeader = async () => {
    asTableItem(itemStore.getItem(tableId)!).showHeader = checkElement_header!.checked;
    itemStore.sortChildren(tableId);
    arrange(desktopStore);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(itemStore.getItem(tableId)!);
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
        <input id="header" name="header" type="checkbox" ref={checkElement_header} checked={props.tableItem.showHeader} onClick={changeShowHeader} />
        <label for="header">show header</label>
      </div>
      <div><InfuButton text="delete" onClick={deleteTable} /></div>
    </div>
  );
}
