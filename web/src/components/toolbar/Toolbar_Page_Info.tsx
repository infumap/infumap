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
import { asPageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";


export const Toolbar_Page_Info: Component = () => {
  const store = useStore();

  const pageItem = () => asPageItem(itemState.get(store.getToolbarFocus()!.itemId)!);

  const copyItemIdClickHandler = (): void => { navigator.clipboard.writeText(pageItem().id); }
  const linkItemIdClickHandler = (): void => { navigator.clipboard.writeText(window.location.origin + "/" + pageItem().id); }

  return (
    <div class="inline-block text-slate-800 text-sm p-[6px]">
      <span class="font-mono text-slate-400">{`I: ${pageItem()!.id}`}</span>
      <i class={`fa fa-copy text-slate-400 cursor-pointer ml-4`} onclick={copyItemIdClickHandler} />
      <i class={`fa fa-link text-slate-400 cursor-pointer ml-1`} onclick={linkItemIdClickHandler} />
    </div>
  );
}
