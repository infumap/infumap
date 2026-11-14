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
import { parseSortOrder } from "../../../items/base/sort-order";
import { sortableColumnNames } from "../../../input/sort_order";
import { useStore } from "../../../store/StoreProvider";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { getToolbarFocusItem } from "../toolbarFocus";
import { toolbarPopupTopPx } from "../toolbarPopupStyle";

export const Toolbar_SortOrder: Component = () => {
  const store = useStore();
  let button: HTMLButtonElement | undefined;

  const order = () => parseSortOrder(asContainerItem(getToolbarFocusItem(store)).orderChildrenBy);
  const icon = () => {
    const o = order();
    if (o == null) { return "bi-sort-alpha-down"; }
    if (o.key == "type") { return o.descending ? "bi-sort-up-alt" : "bi-sort-down-alt"; }
    return o.descending ? "bi-sort-alpha-up" : "bi-sort-alpha-down";
  };
  const label = () => {
    const o = order();
    if (o == null) { return "Manual order"; }
    if (o.key == "type") { return o.descending ? "Type (reversed)" : "Type"; }
    const columns = sortableColumnNames(getToolbarFocusItem(store));
    if (columns == null) { return `Title: ${o.descending ? "Z to A" : "A to Z"}`; }
    return `${columns[o.col] ?? `Column ${o.col + 1}`}: ${o.descending ? "descending" : "ascending"}`;
  };

  const handleClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get()?.type == ToolbarPopupType.ChildSortOrder) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    const bounds = button!.getBoundingClientRect();
    store.overlay.toolbarPopupInfoMaybe.set({
      type: ToolbarPopupType.ChildSortOrder,
      topLeftPx: { x: bounds.x, y: toolbarPopupTopPx(store) },
    });
  };

  return (
    <button ref={button} id="toolbarSortOrderButton" type="button" title={`Sort: ${label()}`} aria-label={`Sort: ${label()}`}
      aria-expanded={store.overlay.toolbarPopupInfoMaybe.get()?.type == ToolbarPopupType.ChildSortOrder}
      class={`inline-block font-bold rounded-control w-[21px] h-[21px] text-center cursor-pointer text-[14px] relative text-neutral-800 ` +
        (order() != null ? "bg-control-selected" : "hover:bg-control-hover")}
      onMouseDown={() => ClickState.setButtonClickBoundsPx(button!.getBoundingClientRect())}
      onKeyDown={event => {
        if (event.key == "Enter" || event.key == " ") { event.stopPropagation(); }
      }}
      onClick={handleClick}>
      <i class={icon()} aria-hidden="true" />
    </button>
  );
};
