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

import { Component, For, Show } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { fArrange } from "../../layout/arrange";
import { VisualElement_Desktop } from "../VisualElement";
import { mainPageBorderColor, mainPageBorderWidth } from "../../style";
import { itemState } from "../../store/ItemState";
import { Z_INDEX_SHOW_TOOLBAR_ICON } from "../../constants";
import { PageVisualElementProps } from "./Page";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Dock: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  const showDock = () => {
    store.dockVisible.set(true);
    fArrange(store);
  }

  const renderDockMoveOverIndexMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOver(props.pageFns.vePath())}>
        <div class="absolute border border-black"
             style={`left: 0px;` +
                    `top: ${store.perVe.getMoveOverIndexAndPosition(props.pageFns.vePath()).position}px; ` +
                    `width: ${store.getCurrentDockWidthPx()}px;`} />
    </Show>;

  return (
    <>
      <Show when={store.dockVisible.get()}>
        <div class={`absolute border-r`}
             style={`left: ${props.pageFns.boundsPx().x}px; top: ${props.pageFns.boundsPx().y}px; width: ${props.pageFns.boundsPx().w}px; height: ${props.pageFns.boundsPx().h}px; ` +
                    `background-color: #ffffff; border-right-width: ${mainPageBorderWidth(store)}px; ` +
                    `border-color: ${mainPageBorderColor(store, itemState.get)}; `}>
          <For each={props.visualElement.childrenVes}>{childVe =>
            <VisualElement_Desktop visualElement={childVe.get()} />
          }</For>
          {renderDockMoveOverIndexMaybe()}
        </div>
      </Show>
      <Show when={!store.dockVisible.get()}>
        <div class={`absolute`}
             style={`left: ${5}px; top: ${props.pageFns.boundsPx().h - 30}px; z-index: ${Z_INDEX_SHOW_TOOLBAR_ICON};`}
             onmousedown={showDock}>
          <i class={`fa fa-chevron-right hover:bg-slate-300 p-[2px] text-xs ${!store.topToolbarVisible.get() ? 'text-white' : 'text-slate-400'}`} />
        </div>
      </Show>
    </>);
}
