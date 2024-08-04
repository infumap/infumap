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

import { Component, For, Match, Show, Switch } from "solid-js";
import { ANCHOR_BOX_SIZE_PX, LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL, RESIZE_BOX_SIZE_PX } from "../../constants";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { BorderType, Colors, LIGHT_BORDER_COLOR, borderColorForColorIdx, linearGradient } from "../../style";
import { hexToRGBA } from "../../util/color";
import { VisualElement_Desktop, VisualElement_LineItem } from "../VisualElement";
import { ArrangeAlgorithm, PageFns } from "../../items/page-item";
import { PageVisualElementProps } from "./Page";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Popup: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  const pageFns = () => props.pageFns;

  const borderColorVal = () => {
    if (props.visualElement.flags & VisualElementFlags.HasToolbarFocus) {
      return `${borderColorForColorIdx(pageFns().pageItem().backgroundColorIndex, BorderType.Popup)}; `
    }
    return LIGHT_BORDER_COLOR;
  };

  const titleScale = () => (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h) / LINE_HEIGHT_PX;

  const titleColor = () => `${hexToRGBA(Colors[pageFns().pageItem().backgroundColorIndex], 1.0)}; `;

  const popupScrollHandler = (_ev: Event) => {
    if (!pageFns().popupDiv) { return; }
    if (pageFns().updatingPopupScrollTop) { return; }

    const viewportBoundsPx = props.visualElement.viewportBoundsPx!;
    const childAreaBoundsPx_ = pageFns().childAreaBoundsPx();
    const popupVeid = store.history.currentPopupSpec()!.actualVeid;

    if (childAreaBoundsPx_.h > viewportBoundsPx.h) {
      const scrollYProp = pageFns().popupDiv!.scrollTop / (childAreaBoundsPx_.h - viewportBoundsPx.h);
      store.perItem.setPageScrollYProp(popupVeid, scrollYProp);
    }
  };

  const renderShadow = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} text-xl font-bold rounded-md p-8 blur-md`}
         style={`left: ${pageFns().boundsPx().x - 10}px; ` +
                `top: ${pageFns().boundsPx().y-10 + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                `width: ${pageFns().boundsPx().w+20}px; height: ${pageFns().boundsPx().h+20}px; ` +
                `background-color: #606060e8;` +
                `${VeFns.zIndexStyle(props.visualElement)}`}>
    </div>;

  const renderPopupTitle = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"}`}
         style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; ` +
                `background-color: #fff; ` +
                `${VeFns.zIndexStyle(props.visualElement)}` +
                `background-image: ${linearGradient(pageFns().pageItem().backgroundColorIndex, 0.9)};`}>
      <div class="absolute font-bold"
           style={`left: 0px; top: ${(pageFns().boundsPx().h - pageFns().viewportBoundsPx().h) / titleScale() * 0.05}px; ` +
                  `width: ${pageFns().boundsPx().w / titleScale() * 0.9}px; ` +
                  `height: ${(pageFns().boundsPx().h - pageFns().viewportBoundsPx().h) / titleScale() * 0.9}px; ` +
                  `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${titleScale() * 0.9}); ` +
                  `transform-origin: top left; ` +
                  `overflow-wrap: break-word; ` +
                  `padding-left: 4px; ` +
                  `margin-left: 3px;` +
                  `color: ${titleColor()}`}>
        {pageFns().pageItem().title}
      </div>
    </div>;

  const renderListPage = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"}`}
         style={`width: ${pageFns().viewportBoundsPx().w}px; ` +
                `height: ${pageFns().viewportBoundsPx().h}px; ` +
                `left: ${pageFns().viewportBoundsPx().x}px; ` +
                `top: ${pageFns().viewportBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                `background-color: #ffffff;` +
                `${VeFns.zIndexStyle(props.visualElement)}`}>
      <div ref={pageFns().popupDiv}
           class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} border-r border-slate-100`}
           style={`overflow-y: auto; overflow-x: hidden; ` +
                  `width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL * pageFns().listViewScale()}px; ` +
                  `height: ${pageFns().viewportBoundsPx().h}px; ` +
                  `background-color: #ffffff;` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}>
        <div class="absolute"
             style={`width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; height: ${LINE_HEIGHT_PX * pageFns().lineChildren().length}px`}>
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
    </div>;

  const renderPage = () =>
    <div ref={pageFns().popupDiv}
         class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} border-t border-slate-300`}
         style={`left: ${pageFns().viewportBoundsPx().x}px; ` +
                `top: ${pageFns().viewportBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
                `background-color: #ffffff;` +
                `overflow-y: ${pageFns().viewportBoundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                `overflow-x: ${pageFns().viewportBoundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                `${VeFns.zIndexStyle(props.visualElement)}`}
         onscroll={popupScrollHandler}>
      <div class="absolute"
           style={`left: ${pageFns().viewportBoundsPx().w - pageFns().childAreaBoundsPx().w}px; ` +
                  `top: ${0}px; ` +
                  `width: ${pageFns().childAreaBoundsPx().w}px; ` +
                  `height: ${pageFns().childAreaBoundsPx().h}px;`}>
        <For each={props.visualElement.childrenVes}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
        {pageFns().renderGridlinesMaybe()}
        {pageFns().renderMoveOverIndexMaybe()}
      </div>
    </div>;

  const renderAnchorMaybe = () =>
    <Show when={PageFns.popupPositioningHasChanged(pageFns().parentPage())}>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm text-gray-100`}
           style={`left: ${pageFns().boundsPx().x + pageFns().boundsPx().w - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX}px; ` +
                  `top: ${pageFns().boundsPx().y + pageFns().boundsPx().h - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                  `width: ${ANCHOR_BOX_SIZE_PX}px; ` +
                  `height: ${ANCHOR_BOX_SIZE_PX}px; ` +
                  `background-color: #ff0000;` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}>
        <div class={`absolute`} style={"cursor: pointer;"}>
          <i class={`fa fa-anchor`} />
        </div>
      </div>
    </Show>;

  const renderBorder = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} pointer-events-none`}
         style={`left: ${pageFns().boundsPx().x}px; ` +
                `top: ${pageFns().boundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                `border-width: 2px;` +
                `border-color: ${borderColorVal()}; ` +
                `width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
                `${VeFns.zIndexStyle(props.visualElement)}`} />;

  return (
    <>
      {renderShadow()}
      <Switch>
        <Match when={pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
          {renderListPage()}
        </Match>
        <Match when={pageFns().pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
          {renderPage()}
        </Match>
      </Switch>
      {renderAnchorMaybe()}
      {renderPopupTitle()}
      {renderBorder()}
    </>
  );
}
