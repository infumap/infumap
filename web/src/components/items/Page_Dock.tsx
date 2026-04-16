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

import { Component, For, Show, createEffect, onMount } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { requestArrange } from "../../layout/arrange";
import { VisualElement_Desktop } from "../VisualElement";
import { mainPageBorderColor, mainPageBorderWidth } from "../../style";
import { itemState } from "../../store/ItemState";
import { Z_INDEX_SHOW_TOOLBAR_ICON } from "../../constants";
import { PageVisualElementProps } from "./Page";
import { VesCache } from "../../layout/ves-cache";
import { VeFns } from "../../layout/visual-element";
import { getDockScrollYPx } from "../../layout/arrange/dock";



// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Dock: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();
  let dockDiv: HTMLDivElement | undefined;
  let updatingDockScrollTop = false;

  const showDock = () => {
    store.dockVisible.set(true);
    requestArrange(store, "dock-show");
  }

  const dockVeid = () => VeFns.actualVeidFromVe(props.visualElement);

  const syncDockScrollPosition = () => {
    if (!dockDiv) {
      return;
    }
    updatingDockScrollTop = true;
    dockDiv.scrollTop = getDockScrollYPx(store, props.visualElement);
    dockDiv.scrollLeft = 0;
    setTimeout(() => {
      updatingDockScrollTop = false;
    }, 0);
  };

  onMount(() => {
    syncDockScrollPosition();
  });

  createEffect(() => {
    if (!props.visualElement.childAreaBoundsPx || !props.visualElement.viewportBoundsPx) {
      return;
    }
    props.visualElement.childAreaBoundsPx.h;
    props.visualElement.viewportBoundsPx.h;
    store.perItem.getPageScrollYProp(dockVeid());
    syncDockScrollPosition();
  });

  const dockScrollHandler = (_ev: Event) => {
    if (!dockDiv || updatingDockScrollTop) {
      return;
    }
    const scrollableHeightPx = Math.max(0, props.visualElement.childAreaBoundsPx!.h - props.visualElement.viewportBoundsPx!.h);
    if (scrollableHeightPx == 0) {
      store.perItem.setPageScrollYProp(dockVeid(), 0);
      return;
    }
    store.perItem.setPageScrollYProp(dockVeid(), dockDiv.scrollTop / scrollableHeightPx);
  };

  const renderDockMoveOverIndexMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOver(props.pageFns.vePath())}>
      <div class="absolute pointer-events-none border border-black"
        style={`left: 0px;` +
          `top: ${store.perVe.getMoveOverIndexAndPosition(props.pageFns.vePath()).position}px; ` +
          `width: ${props.pageFns.viewportBoundsPx().w}px;`} />
    </Show>;

  return (
    <>
      <Show when={store.dockVisible.get() && !store.smallScreenMode()}>
        <div class={`absolute border-r`}
          style={`left: ${props.pageFns.boundsPx().x}px; ` +
            `top: ${props.pageFns.boundsPx().y}px; ` +
            `width: ${props.pageFns.boundsPx().w}px; ` +
            `height: ${props.pageFns.boundsPx().h}px; ` +
            `background-color: #ffffff; ` +
            `border-right-width: ${mainPageBorderWidth(store)}px; ` +
            `border-color: ${mainPageBorderColor(store, itemState.get)}; `}>
          <div ref={dockDiv}
            class="absolute"
            style={`left: 0px; top: 0px; ` +
              `width: ${props.pageFns.viewportBoundsPx().w}px; ` +
              `height: ${props.pageFns.viewportBoundsPx().h}px; ` +
              `overflow-y: auto; overflow-x: hidden; ` +
              `overscroll-behavior: contain; touch-action: pan-y;`}
            onscroll={dockScrollHandler}>
            <div class="absolute"
              style={`left: 0px; top: 0px; ` +
                `width: ${props.visualElement.childAreaBoundsPx!.w}px; ` +
                `height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
              <For each={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()}>{childVe =>
                <VisualElement_Desktop visualElement={childVe.get()} />
              }</For>
              {renderDockMoveOverIndexMaybe()}
            </div>
          </div>
        </div>
      </Show>
      <Show when={!store.dockVisible.get() && !store.smallScreenMode()}>
        <div class={`absolute`}
          style={`left: ${5}px; ` +
            `top: ${props.pageFns.boundsPx().h - 30}px; ` +
            `z-index: ${Z_INDEX_SHOW_TOOLBAR_ICON};`}
          onmousedown={showDock}>
          <i class={`fa fa-chevron-right hover:bg-slate-300 p-[2px] text-xs ${!store.topToolbarVisible.get() ? 'text-white' : 'text-slate-400'}`} />
        </div>
      </Show>
    </>);
}
