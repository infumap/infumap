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
import { ClickState } from "../../../input/state";
import { pageTableConversionEligibility } from "../../../items/page-table-conversion";
import { useStore } from "../../../store/StoreProvider";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { getToolbarFocusPathMaybe } from "../toolbarFocus";

export const Toolbar_MoreActions: Component = () => {
  const store = useStore();
  let button: HTMLButtonElement | undefined;

  const canConvert = () => {
    store.touchToolbarDependency();
    // The focused page can change before its visual element reaches the current scene.
    // topTitledPages updates after scene promotion, when eligibility can be checked again.
    store.topTitledPages.get();
    return pageTableConversionEligibility(store, getToolbarFocusPathMaybe(store)).allowed;
  };

  const handleClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get()?.type == ToolbarPopupType.MoreActions) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    const bounds = button!.getBoundingClientRect();
    store.overlay.toolbarPopupInfoMaybe.set({
      type: ToolbarPopupType.MoreActions,
      topLeftPx: { x: bounds.x, y: bounds.y + 38 },
    });
  };

  const handleMouseDown = () => {
    ClickState.setButtonClickBoundsPx(button!.getBoundingClientRect());
  };

  return (
    <Show when={canConvert()}>
      <button ref={button} type="button" title="More actions" aria-label="More actions"
        aria-expanded={store.overlay.toolbarPopupInfoMaybe.get()?.type == ToolbarPopupType.MoreActions}
        class={`inline-block ml-[3px] hover:border font-bold rounded w-[21px] h-[21px] text-center cursor-pointer text-[14px] relative text-gray-800 ` +
          (store.overlay.toolbarPopupInfoMaybe.get()?.type == ToolbarPopupType.MoreActions
            ? "bg-slate-300 hover:bg-slate-400" : "hover:bg-slate-300")}
        onMouseDown={handleMouseDown}
        onClick={handleClick}>
        <i class="fa fa-ellipsis" aria-hidden="true" />
      </button>
    </Show>
  );
};
