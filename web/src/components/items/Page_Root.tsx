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

import { Component, For, Match, Show, Switch, onMount } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { VisualElement_Desktop, VisualElement_LineItem } from "../VisualElement";
import { LINE_HEIGHT_PX, PAGE_DOCUMENT_LEFT_MARGIN_BL } from "../../constants";
import { UMBRELLA_PAGE_UID } from "../../util/uid";
import { ArrangeAlgorithm, asPageItem } from "../../items/page-item";
import { edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";
import { PageVisualElementProps } from "./Page";
import { BorderType, borderColorForColorIdx } from "../../style";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Root: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  let rootDiv: any = undefined; // HTMLDivElement | undefined

  const pageFns = () => props.pageFns;

  onMount(() => {
    let veid = store.history.currentPageVeid()!;
    if (props.visualElement.flags & VisualElementFlags.ListPageRoot) {
      const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath!);
      veid = store.perItem.getSelectedListPageItem(parentVeid);
    }

    const scrollXProp = store.perItem.getPageScrollXProp(veid);
    const scrollXPx = scrollXProp * (pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);

    const scrollYProp = store.perItem.getPageScrollYProp(veid);
    const scrollYPx = scrollYProp * (pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);

    rootDiv.scrollTop = scrollYPx;
    rootDiv.scrollLeft = scrollXPx;
  });

  const renderIsPublicBorder = () =>
    <Show when={pageFns().isPublic() && store.user.getUserMaybe() != null}>
      <div class="w-full h-full" style="border-width: 3px; border-color: #ff0000;" />
    </Show>;

  const listRootScrollHandler = (_ev: Event) => {
    if (!rootDiv) { return; }

    const pageBoundsPx = props.visualElement.listChildAreaBoundsPx!.h;
    const desktopSizePx = props.visualElement.boundsPx;

    let veid = store.history.currentPageVeid()!;
    if (props.visualElement.flags & VisualElementFlags.EmbededInteractiveRoot) {
      veid = VeFns.actualVeidFromVe(props.visualElement);
    } else if (props.visualElement.parentPath != UMBRELLA_PAGE_UID) {
      const parentVeid = VeFns.actualVeidFromPath(props.visualElement.parentPath!);
      veid = store.perItem.getSelectedListPageItem(parentVeid);
    }

    if (desktopSizePx.h < pageBoundsPx) {
      const scrollYProp = rootDiv!.scrollTop / (pageBoundsPx - desktopSizePx.h);
      store.perItem.setPageScrollYProp(veid, scrollYProp);
    }
  }

  const renderListPage = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
         style={`width: ${pageFns().viewportBoundsPx().w}px; ` +
                `height: ${pageFns().viewportBoundsPx().h + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; left: 0px; ` +
                `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
                `background-color: #ffffff;` +
                `${VeFns.zIndexStyle(props.visualElement)}`}>
      <div ref={rootDiv}
           class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} `}
           style={`overflow-y: auto; ` +
                  `width: ${pageFns().viewportBoundsPx().w}px; ` +
                  `height: ${pageFns().viewportBoundsPx().h}px; ` +
                  `background-color: #ffffff;` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}
           onscroll={listRootScrollHandler}>
        <div class={`absolute ${props.visualElement.flags & VisualElementFlags.DockItem ? "" : "border-slate-300"}`}
             style={`width: ${LINE_HEIGHT_PX * pageFns().listColumnWidthBl()}px; height: ${props.visualElement.listChildAreaBoundsPx!.h}px;` +
                    `border-right-width: ${props.visualElement.focusedChildItemMaybe == null ? 1 : 2}px;` +
                    `${props.visualElement.focusedChildItemMaybe == null ? '' : 'border-right-color: ' + borderColorForColorIdx(asPageItem(props.visualElement.focusedChildItemMaybe).backgroundColorIndex, BorderType.MainPage) + ';' }`}>
          <For each={pageFns().lineChildren()}>{childVe =>
            <VisualElement_LineItem visualElement={childVe.get()} />
          }</For>
        </div>
      </div>
      <For each={pageFns().desktopChildren()}>{childVe =>
        <VisualElement_Desktop visualElement={childVe.get()} />
      }</For>
      <Show when={props.visualElement.selectedVes != null}>
        <VisualElement_Desktop visualElement={props.visualElement.selectedVes!.get()} />
      </Show>
      <Show when={props.visualElement.popupVes != null}>
        <VisualElement_Desktop visualElement={props.visualElement.popupVes!.get()} />
      </Show>
    </div>;

  const keyUpHandler = (ev: KeyboardEvent) => {
    edit_keyUpHandler(store, ev);
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    edit_keyDownHandler(store, props.visualElement, ev);
  }

  const inputListener = (ev: InputEvent) => {
    edit_inputListener(store, ev);
  }
  
  const rootScrollHandler = (_ev: Event) => {
    if (!rootDiv) { return; }

    const pageBoundsPx = props.visualElement.childAreaBoundsPx!;
    const desktopSizePx = props.visualElement.boundsPx;

    let veid = store.history.currentPageVeid()!;
    if (props.visualElement.flags & VisualElementFlags.EmbededInteractiveRoot) {
      veid = VeFns.actualVeidFromVe(props.visualElement);
    } else if (props.visualElement.parentPath != UMBRELLA_PAGE_UID) {
      const parentVeid = VeFns.actualVeidFromPath(props.visualElement.parentPath!);
      veid = store.perItem.getSelectedListPageItem(parentVeid);
    }

    if (desktopSizePx.w < pageBoundsPx.w) {
      const scrollXProp = rootDiv!.scrollLeft / (pageBoundsPx.w - desktopSizePx.w);
      store.perItem.setPageScrollXProp(veid, scrollXProp);
    }

    if (desktopSizePx.h < pageBoundsPx.h) {
      const scrollYProp = rootDiv!.scrollTop / (pageBoundsPx.h - desktopSizePx.h);
      store.perItem.setPageScrollYProp(veid, scrollYProp);
    }
  }

  const renderPage = () =>
    <div ref={rootDiv}
         class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
         style={`left: 0px; ` +
                `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
                `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
                `overflow-y: ${pageFns().viewportBoundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                `overflow-x: ${pageFns().viewportBoundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                `${VeFns.zIndexStyle(props.visualElement)}`}
         onscroll={rootScrollHandler}>
      <div class="absolute"
           style={`left: 0px; top: 0px; ` +
                  `width: ${pageFns().childAreaBoundsPx().w}px; ` +
                  `height: ${pageFns().childAreaBoundsPx().h}px;` +
                  `outline: 0px solid transparent; `}
           contentEditable={store.overlay.textEditInfo() != null && pageFns().isDocumentPage()}
           onKeyUp={keyUpHandler}
           onKeyDown={keyDownHandler}
           onInput={inputListener}>
        <For each={props.visualElement.childrenVes}>{childVes =>
          <VisualElement_Desktop visualElement={childVes.get()} />
        }</For>
        <Show when={props.visualElement.popupVes != null}>
          <VisualElement_Desktop visualElement={props.visualElement.popupVes!.get()} />
        </Show>
        <Show when={pageFns().isDocumentPage()}>
          <>
            <div class="absolute" style={`left: ${(PAGE_DOCUMENT_LEFT_MARGIN_BL - 0.5) * LINE_HEIGHT_PX}px; top: 0px; width: 1px; height: ${pageFns().childAreaBoundsPx().h}px; background-color: #eee;`} />
            <div class="absolute" style={`left: ${(asPageItem(props.visualElement.displayItem).docWidthBl + PAGE_DOCUMENT_LEFT_MARGIN_BL + 0.5) * LINE_HEIGHT_PX}px; top: 0px; width: 1px; height: ${pageFns().childAreaBoundsPx().h}px; background-color: #eee;`} />
          </>
        </Show>
        {pageFns().renderGridlinesMaybe()}
        {pageFns().renderMoveOverIndexMaybe()}
      </div>
    </div>;

  return (
    <>
      <div class={`absolute`}
           style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
                  `background-color: #ffffff;`}>
        <Switch>
          <Match when={pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
            {renderListPage()}
          </Match>
          <Match when={pageFns().pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
            {renderPage()}
          </Match>
        </Switch>
        {renderIsPublicBorder()}
      </div>
    </>
  );
}
