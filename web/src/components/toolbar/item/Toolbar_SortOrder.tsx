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
import { ClickState } from "../../../input/state";
import { asContainerItem } from "../../../items/base/container-item";
import { useStore } from "../../../store/StoreProvider";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { getToolbarFocusItem } from "../toolbarFocus";

export const Toolbar_SortOrder: Component = () => {
  const store = useStore();
  let button: HTMLButtonElement | undefined;

  const order = () => asContainerItem(getToolbarFocusItem(store)).orderChildrenBy;
  const icon = () => order() == "title[DESC]" ? "bi-sort-alpha-up" : "bi-sort-alpha-down";
  const label = () => order() == "title[ASC]" ? "Title: A to Z"
    : order() == "title[DESC]" ? "Title: Z to A" : "Manual order";

  const handleClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get()?.type == ToolbarPopupType.ChildSortOrder) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    const bounds = button!.getBoundingClientRect();
    store.overlay.toolbarPopupInfoMaybe.set({
      type: ToolbarPopupType.ChildSortOrder,
      topLeftPx: { x: bounds.x, y: bounds.y + 35 },
    });
  };

  return (
    <button ref={button} id="toolbarSortOrderButton" type="button" title={`Sort: ${label()}`} aria-label={`Sort: ${label()}`}
      aria-expanded={store.overlay.toolbarPopupInfoMaybe.get()?.type == ToolbarPopupType.ChildSortOrder}
      class={`inline-block hover:border font-bold rounded w-[21px] h-[21px] text-center cursor-pointer text-[14px] relative text-gray-800 ` +
        (order() != "" ? "bg-slate-300 hover:bg-slate-400" : "hover:bg-slate-300")}
      onMouseDown={() => ClickState.setButtonClickBoundsPx(button!.getBoundingClientRect())}
      onKeyDown={event => {
        if (event.key == "Enter" || event.key == " ") { event.stopPropagation(); }
      }}
      onClick={handleClick}>
      <i class={icon()} aria-hidden="true" />
    </button>
  );
};
