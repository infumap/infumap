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
import { asFileItem, isFile } from "../../../items/file-item";
import { asImageItem, isImage } from "../../../items/image-item";
import { asPageItem, isPage } from "../../../items/page-item";
import { asTableItem, isTable } from "../../../items/table-item";
import { EditFile } from "./Panels/EditFile";
import { EditImage } from "./Panels/EditImage";
import { EditPage } from "./Panels/EditPage";
import { EditTable } from "./Panels/EditTable";
import { asLinkItem, isLink } from "../../../items/link-item";
import { EditLink } from "./Panels/EditLink";
import { asPasswordItem, isPassword } from "../../../items/password-item";
import { EditPassword } from "./Panels/EditPassword";
import { asCompositeItem, isComposite } from "../../../items/composite-item";
import { EditComposite } from "./Panels/EditComposite";
import { useStore } from "../../../store/StoreProvider";


export const EditItem: Component<{item: Item, linkedTo: boolean}> = (props: {item: Item, linkedTo: boolean}) => {
  let store = useStore();

  const copyClickHandler = () => {
    navigator.clipboard.writeText(props.item.id);
  }

  const linkClickHandler = () => {
    navigator.clipboard.writeText(window.location.origin + "/" + store.userStore.getUser().username + "/" + props.item.id);
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
        <Match when={isPage(props.item)}>
          <EditPage pageItem={asPageItem(props.item)} linkedTo={props.linkedTo} />
        </Match>
        <Match when={isTable(props.item)}>
          <EditTable tableItem={asTableItem(props.item)} linkedTo={props.linkedTo} />
        </Match>
        <Match when={isFile(props.item)}>
          <EditFile fileItem={asFileItem(props.item)} linkedTo={props.linkedTo} />
        </Match>
        <Match when={isImage(props.item)}>
          <EditImage imageItem={asImageItem(props.item)} linkedTo={props.linkedTo} />
        </Match>
        <Match when={isLink(props.item)}>
          <EditLink linkItem={asLinkItem(props.item)} linkedTo={props.linkedTo} />
        </Match>
        <Match when={isPassword(props.item)}>
          <EditPassword passwordItem={asPasswordItem(props.item)} linkedTo={props.linkedTo} />
        </Match>
        <Match when={isComposite(props.item)}>
          <EditComposite compositeItem={asCompositeItem(props.item)} linkedTo={props.linkedTo} />
        </Match>
      </Switch>
    </div>
  );
}
