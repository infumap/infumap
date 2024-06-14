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

import { Component, Match, Switch } from "solid-js";
import { Item } from "../../../items/base/item";
import { asImageItem, isImage } from "../../../items/image-item";
import { asTableItem, isTable } from "../../../items/table-item";
import { EditImage } from "./Panels/EditImage";
import { EditTable } from "./Panels/EditTable";
import { useStore } from "../../../store/StoreProvider";


export const EditItem: Component<{item: Item, linkedTo: boolean}> = (props: {item: Item, linkedTo: boolean}) => {
  let store = useStore();

  const copyClickHandler = () => {
    navigator.clipboard.writeText(props.item.id);
  }

  const linkClickHandler = () => {
    navigator.clipboard.writeText(window.location.origin + "/" + store.user.getUser().username + "/" + props.item.id);
  }

  return (
    <div class="p-3">
      <div class="font-bold">Edit {props.item.itemType}</div>
      <div class="text-slate-800 text-sm">
        <span class="font-mono text-slate-400">{`${props.item.id}`}</span>
        <i class={`fa fa-copy text-slate-400 cursor-pointer ml-1`} onclick={copyClickHandler} />
        <i class={`fa fa-link text-slate-400 cursor-pointer ml-1`} onclick={linkClickHandler} />
      </div>
      <Switch fallback={<div>Unknown item type: '{props.item.itemType}'</div>}>
        <Match when={isTable(props.item)}>
          <EditTable tableItem={asTableItem(props.item)} linkedTo={props.linkedTo} />
        </Match>
        <Match when={isImage(props.item)}>
          <EditImage imageItem={asImageItem(props.item)} linkedTo={props.linkedTo} />
        </Match>
      </Switch>
    </div>
  );
}
