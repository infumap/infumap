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
import { LINE_HEIGHT_PX, Z_INDEX_HIGHLIGHT } from "../../constants";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { BorderType, Colors, borderColorForColorIdx, linearGradient } from "../../style";
import { VisualElement_Desktop, VisualElement_LineItem } from "../VisualElement";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { useStore } from "../../store/StoreProvider";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { PageVisualElementProps } from "./Page";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_EmbeddedInteractive: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  let rootDiv: any = undefined; // HTMLDivElement | undefined

  const pageFns = () => props.pageFns;

  onMount(() => {
    let veid = VeFns.veidFromVe(props.visualElement);
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

  const keyUpHandler = (ev: KeyboardEvent) => {
    edit_keyUpHandler(store, ev);
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    edit_keyDownHandler(store, props.visualElement, ev);
  }

  const inputListener = (ev: InputEvent) => {
    edit_inputListener(store, ev);
  }
  
  const titleScale = () => (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h) / LINE_HEIGHT_PX;

  const isEmbeddedInteractive = () => !!(props.visualElement.flags & VisualElementFlags.EmbeddedInteractiveRoot);

  const isDockItem = () => !!(props.visualElement.flags & VisualElementFlags.DockItem);
  const isListPage = () => pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List;

  const borderStyle = () => {
    if (isDockItem()) {
      return `${isListPage() ? 'border-bottom-width' : 'border-width'}: 1px; border-color: ${borderColorForColorIdx(pageFns().pageItem().backgroundColorIndex, BorderType.Dock)}; `;
    }
    return `border-width: 1px; border-color: ${Colors[pageFns().pageItem().backgroundColorIndex]}; `;
  }

  const renderEmbeddedInteractiveBackground = () =>
    <div class="absolute w-full"
         style={`background-image: ${linearGradient(pageFns().pageItem().backgroundColorIndex, 0.95)}; ` +
                `top: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; bottom: ${0}px;` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}` +
                borderStyle()} />;

  const renderEmbeddedInteractiveForeground = () =>
    <div class="absolute w-full pointer-events-none"
         style={`${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}` +
                `top: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; bottom: ${0}px;` +
                borderStyle()} />;

  const renderIsLinkMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
                pageFns().showTriangleDetail()}>
      <InfuLinkTriangle />
    </Show>;

  const renderResizeTriangleMaybe = () =>
    <Show when={pageFns().showTriangleDetail() && !isDockItem()}>
      <InfuResizeTriangle />
    </Show>;

  const renderEmbeddedInteractiveTitleMaybe = () =>
    <Show when={isEmbeddedInteractive()}>
      <div class={`absolute`}
           style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px;`}>
        <div id={VeFns.veToPath(props.visualElement) + ":title"}
             class="absolute font-bold"
             style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w / titleScale()}px; height: ${(pageFns().boundsPx().h - pageFns().viewportBoundsPx().h) / titleScale()}px; ` +
                    `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${titleScale()}); transform-origin: top left; ` +
                    `overflow-wrap: break-word;` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}` +
                    `outline: 0px solid transparent;`}
             spellcheck={store.overlay.textEditInfo() != null}
             contentEditable={store.overlay.textEditInfo() != null}>
          {pageFns().pageItem().title}
        </div>
      </div>
    </Show>;

  const renderFindHighlightedMaybe = () =>
    <Show when={isEmbeddedInteractive() && (props.visualElement.flags & VisualElementFlags.FindHighlighted)}>
      <div class="absolute pointer-events-none rounded-sm"
           style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; ` +
                  `width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; ` +
                  `background-color: ${FIND_HIGHLIGHT_COLOR}; ` +
                  `z-index: ${Z_INDEX_HIGHLIGHT};`} />
    </Show>;

  const renderListPage = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
         style={`width: ${pageFns().viewportBoundsPx().w}px; ` +
                `height: ${pageFns().viewportBoundsPx().h + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                `left: 0px; ` +
                `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
                `background-color: #ffffff;` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
      <div ref={rootDiv}
           class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} ` +
                  `${props.visualElement.flags & VisualElementFlags.DockItem ? "" : "border-slate-300 border-r"}`}
           style={`overflow-y: auto; ` +
                  `width: ${pageFns().viewportBoundsPx().w}px; ` +
                  `height: ${pageFns().viewportBoundsPx().h}px; ` +
                  `background-color: #ffffff;` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <div class="absolute"
             style={`width: ${LINE_HEIGHT_PX * pageFns().listColumnWidthBl()}px; ` +
                    `height: ${props.visualElement.listChildAreaBoundsPx!.h}px`}>
          <For each={pageFns().lineChildren()}>{childVe =>
            <VisualElement_LineItem visualElement={childVe.get()} />
          }</For>
        </div>
      </div>
      <For each={pageFns().desktopChildren()}>{childVe =>
        <VisualElement_Desktop visualElement={childVe.get()} />
      }</For>
      <Show when={props.visualElement.selectedVes != null && props.visualElement.selectedVes.get() != null}>
        <VisualElement_Desktop visualElement={props.visualElement.selectedVes!.get()} />
      </Show>
      <Show when={props.visualElement.popupVes != null && props.visualElement.popupVes.get() != null}>
        <VisualElement_Desktop visualElement={props.visualElement.popupVes!.get()} />
      </Show>
    </div>;

  const renderPage = () =>
    <div ref={rootDiv}
         class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
         style={`left: 0px; ` +
                `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
                `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
                `overflow-y: ${pageFns().viewportBoundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                `overflow-x: ${pageFns().viewportBoundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
      <div class="absolute"
           style={`left: 0px; top: 0px; ` +
                  `width: ${pageFns().childAreaBoundsPx().w}px; ` +
                  `height: ${pageFns().childAreaBoundsPx().h}px; ` +
                  `outline: 0px solid transparent; `}
           contentEditable={store.overlay.textEditInfo() != null && pageFns().isDocumentPage()}
           onKeyUp={keyUpHandler}
           onKeyDown={keyDownHandler}
           onInput={inputListener}>
        <For each={props.visualElement.childrenVes}>{childVes =>
          <VisualElement_Desktop visualElement={childVes.get()} />
        }</For>
        <Show when={props.visualElement.popupVes != null && props.visualElement.popupVes.get() != null}>
          <VisualElement_Desktop visualElement={props.visualElement.popupVes!.get()} />
        </Show>
        <Show when={isPage(VeFns.treeItem(props.visualElement)) && asPageItem(VeFns.treeItem(props.visualElement)).arrangeAlgorithm == ArrangeAlgorithm.Document}>
          <>
            <div class="absolute" style={`left: ${2.5 * LINE_HEIGHT_PX}px; top: 0px; width: 1px; height: ${pageFns().childAreaBoundsPx().h}px; background-color: #eee;`} />
            <div class="absolute" style={`left: ${(asPageItem(VeFns.treeItem(props.visualElement)).docWidthBl + 3.5) * LINE_HEIGHT_PX}px; top: 0px; width: 1px; height: ${pageFns().childAreaBoundsPx().h}px; background-color: #eee;`} />
          </>
        </Show>
        {pageFns().renderGridLinesMaybe()}
        {pageFns().renderMoveOverAnnotationMaybe()}
      </div>
    </div>;

  return (
    <>
      <div class={`absolute`}
           style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
                  `background-color: #ffffff;`}>
        {renderEmbeddedInteractiveBackground()}
        <Switch>
          <Match when={pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
            {renderListPage()}
          </Match>
          <Match when={pageFns().pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
            {renderPage()}
          </Match>
        </Switch>
        {renderResizeTriangleMaybe()}
        {renderIsLinkMaybe()}
        {renderEmbeddedInteractiveForeground()}
      </div>
      {renderEmbeddedInteractiveTitleMaybe()}
      {renderFindHighlightedMaybe()}
    </>
  );
}
