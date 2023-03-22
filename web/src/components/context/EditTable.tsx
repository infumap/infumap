/*
  Copyright (C) 2023 The Infumap Authors
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
import { server } from "../../server";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { asTableItem, TableItem } from "../../store/desktop/items/table-item";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";


export const EditTable: Component<{tableItem: TableItem}> = (props: {tableItem: TableItem}) => {
  const desktopStore = useDesktopStore();

  let tableId = () => props.tableItem.id;

  const handleTitleChange = (v: string) => { desktopStore.updateItem(tableId(), item => asTableItem(item).title = v); };
  const handleTitleChanged = (v: string) => { server.updateItem(desktopStore.getItem(tableId())!); }

  const deleteTable = async () => {
    await server.deleteItem(tableId());
  }

  return (
    <div>
      <div class="text-slate-800 text-sm">Title <InfuTextInput value={props.tableItem.title} onIncrementalChange={handleTitleChange} onChange={handleTitleChanged} /></div>
      <div><InfuButton text="delete" onClick={deleteTable} /></div>
    </div>
  );
}
