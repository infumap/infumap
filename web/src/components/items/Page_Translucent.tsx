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

import { Component, For, Match, Show, Switch, createEffect, createMemo, onMount } from "solid-js";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { VisualElement_Desktop, VisualElement_LineItem } from "../VisualElement";
import { useStore } from "../../store/StoreProvider";
import { LINE_HEIGHT_PX, Z_INDEX_SHADOW } from "../../constants";
import { FEATURE_COLOR, linearGradient } from "../../style";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { ArrangeAlgorithm } from "../../items/page-item";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { PageVisualElementProps } from "./Page";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Translucent: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  let updatingTranslucentScrollTop = false;
  let translucentDiv: any = undefined; // HTMLDivElement | undefined

  const pageFns = () => props.pageFns;

  onMount(() => {
    let veid = VeFns.veidFromVe(props.visualElement);

    const scrollXProp = store.perItem.getPageScrollXProp(veid);
    const scrollXPx = scrollXProp * (pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);

    const scrollYProp = store.perItem.getPageScrollYProp(veid);
    const scrollYPx = scrollYProp * (pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);

    translucentDiv.scrollTop = scrollYPx;
    translucentDiv.scrollLeft = scrollXPx;
  });

  createEffect(() => {
    // occurs on page arrange algorithm change.
    if (!pageFns().childAreaBoundsPx()) { return; }

    updatingTranslucentScrollTop = true;
    if (translucentDiv) {
      translucentDiv.scrollTop =
        store.perItem.getPageScrollYProp(VeFns.veidFromVe(props.visualElement)) *
        (pageFns().childAreaBoundsPx().h - props.visualElement.boundsPx.h);
      translucentDiv.scrollLeft =
        store.perItem.getPageScrollXProp(VeFns.veidFromVe(props.visualElement)) *
        (pageFns().childAreaBoundsPx().w - props.visualElement.boundsPx.w);
    }

    setTimeout(() => {
      updatingTranslucentScrollTop = false;
    }, 0);
  });

  const translucentTitleInBoxScale = createMemo((): number => pageFns().calcTitleInBoxScale("lg"));

  const translucentScrollHandler = (_ev: Event) => {
    if (!translucentDiv) { return; }
    if (updatingTranslucentScrollTop) { return; }

    const pageBoundsPx = props.visualElement.boundsPx;
    const childAreaBounds = pageFns().childAreaBoundsPx();
    const pageVeid = VeFns.veidFromVe(props.visualElement);

    if (childAreaBounds.h > pageBoundsPx.h) {
      const scrollYProp = translucentDiv!.scrollTop / (childAreaBounds.h - pageBoundsPx.h);
      store.perItem.setPageScrollYProp(pageVeid, scrollYProp);
    }
  };

  const renderListPage = () =>
    <>
      <div class={`absolute ${borderClass()}`}
           style={`overflow-y: auto; overflow-x: hidden; ` +
                  `width: ${LINE_HEIGHT_PX * pageFns().listColumnWidthBl() * pageFns().listViewScale()}px; ` +
                  `height: ${pageFns().boundsPx().h}px; ` +
                  `left: ${pageFns().boundsPx().x}px; ` +
                  `top: ${pageFns().boundsPx().y}px; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <div class="absolute"
             style={`width: ${LINE_HEIGHT_PX * pageFns().listColumnWidthBl()}px; ` +
                    `height: ${LINE_HEIGHT_PX * pageFns().lineChildren().length}px`}>
          <For each={pageFns().lineChildren()}>{childVe =>
            <VisualElement_LineItem visualElement={childVe.get()} />
          }</For>
        </div>
      </div>
      <div ref={translucentDiv}
           class={`absolute`}
           style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px;` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <For each={pageFns().desktopChildren()}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
        <Show when={props.visualElement.selectedVes != null}>
          <VisualElement_Desktop visualElement={props.visualElement.selectedVes!.get()} />
        </Show>
      </div>
    </>;

  const renderPage = () =>
    <div ref={translucentDiv}
         class={`absolute ${borderClass()} rounded-sm`}
         style={`left: ${pageFns().boundsPx().x}px; ` +
                `top: ${pageFns().boundsPx().y}px; ` +
                `width: ${pageFns().boundsPx().w}px; ` +
                `height: ${pageFns().boundsPx().h}px; ` +
                `background-color: #ffffff; ` +
                `overflow-y: ${pageFns().boundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                `overflow-x: ${pageFns().boundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}
         onscroll={translucentScrollHandler}>
      <div class="absolute"
           style={`left: ${0}px; top: ${0}px; ` +
                  `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
        <For each={props.visualElement.childrenVes}>{childVes =>
          <VisualElement_Desktop visualElement={childVes.get()} />
        }</For>
        {pageFns().renderMoveOverAnnotationMaybe()}
      </div>
    </div>;

  const renderBoxTitleMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.ListPageRoot)}>
      <div id={VeFns.veToPath(props.visualElement) + ":title"}
           class={`absolute flex font-bold text-white pointer-events-none`}
           style={`left: ${pageFns().boundsPx().x}px; ` +
                  `top: ${pageFns().boundsPx().y}px; ` +
                  `width: ${pageFns().boundsPx().w}px; ` +
                  `height: ${pageFns().boundsPx().h}px;` +
                  `font-size: ${20 * translucentTitleInBoxScale()}px; ` +
                  `justify-content: center; align-items: center; text-align: center; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}` +
                  `outline: 0px solid transparent;`}
           spellcheck={store.overlay.textEditInfo() != null}
           contentEditable={store.overlay.textEditInfo() != null}>
          {pageFns().pageItem().title}
      </div>
    </Show>;

  const renderHoverOverMaybe = () =>
    <Show when={store.perVe.getMouseIsOver(pageFns().vePath()) && !store.anItemIsMoving.get()}>
      <>
        <Show when={!pageFns().isInComposite()}>
          <div class={`absolute rounded-sm pointer-events-none`}
               style={`left: ${pageFns().clickBoundsPx()!.x}px; top: ${pageFns().clickBoundsPx()!.y}px; width: ${pageFns().clickBoundsPx()!.w}px; height: ${pageFns().clickBoundsPx()!.h}px; ` +
                      `background-color: #ffffff33;`} />
        </Show>
        <Show when={pageFns().hasPopupClickBoundsPx()}>
          <div class={`absolute rounded-sm pointer-events-none`}
               style={`left: ${pageFns().popupClickBoundsPx()!.x}px; top: ${pageFns().popupClickBoundsPx()!.y}px; width: ${pageFns().popupClickBoundsPx()!.w}px; height: ${pageFns().popupClickBoundsPx()!.h}px; ` +
                      `background-color: ${pageFns().isInComposite() ? '#ffffff33' : '#ffffff55'};`} />
        </Show>
      </>
    </Show>;

  const renderMovingOverMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOver(pageFns().vePath())}>
      <div class={`absolute rounded-sm pointer-events-none`}
           style={`left: ${pageFns().clickBoundsPx()!.x}px; top: ${pageFns().clickBoundsPx()!.y}px; width: ${pageFns().clickBoundsPx()!.w}px; height: ${pageFns().clickBoundsPx()!.h}px; ` +
                  `background-color: #ffffff33;`} />
    </Show>;

  const renderMovingOverAttachMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOverAttach(pageFns().vePath())}>
      <div class={`absolute rounded-sm pointer-events-none`}
           style={`left: ${pageFns().attachBoundsPx().x}px; top: ${pageFns().attachBoundsPx().y}px; width: ${pageFns().attachBoundsPx().w}px; height: ${pageFns().attachBoundsPx().h}px; ` +
                  `background-color: #ff0000;`} />
    </Show>;

  const renderMovingOverAttachCompositeMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOverAttachComposite(pageFns().vePath())}>
      <div class={`absolute rounded-sm`}
           style={`left: ${pageFns().attachCompositeBoundsPx().x}px; top: ${pageFns().attachCompositeBoundsPx().y}px; width: ${pageFns().attachCompositeBoundsPx().w}px; height: ${pageFns().attachCompositeBoundsPx().h}px; ` +
                  `background-color: ${FEATURE_COLOR};`} />
    </Show>;

  const renderPopupSelectedOverlayMaybe = () =>
    <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || pageFns().isPoppedUp()}>
      <div class="absolute pointer-events-none"
           style={`left: ${pageFns().innerBoundsPx().x}px; top: ${pageFns().innerBoundsPx().y}px; width: ${pageFns().innerBoundsPx().w}px; height: ${pageFns().innerBoundsPx().h}px; ` +
                  `background-color: #dddddd88;`} />
    </Show>;

  const renderIsLinkMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
                pageFns().showTriangleDetail()}>
      <InfuLinkTriangle />
    </Show>;

  const backgroundStyle = () => pageFns().parentPageArrangeAlgorithm() == ArrangeAlgorithm.List
      ? ''
      : `background-image: ${linearGradient(pageFns().pageItem().backgroundColorIndex, 0.636)};`;

  const borderClass = () => pageFns().parentPageArrangeAlgorithm() == ArrangeAlgorithm.List
      ? ''
      : 'border border-[#777] hover:shadow-md';

  const shadowClass = () => pageFns().parentPageArrangeAlgorithm() == ArrangeAlgorithm.List
      ? ''
      : 'shadow-xl';

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc)}>
      <div class={`absolute border border-transparent rounded-sm ${shadowClass()} overflow-hidden`}
           style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
                  `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
    </Show>;

  const renderResizeTriangleMaybe = () =>
    <Show when={pageFns().showTriangleDetail()}>
      <div class={`absolute border border-transparent rounded-sm overflow-hidden pointer-events-none`}
           style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
                  `${VeFns.opacityStyle(props.visualElement)}; ${VeFns.zIndexStyle(props.visualElement)}`}>
          <InfuResizeTriangle />
      </div>
    </Show>;

  return (
    <>
      {renderShadowMaybe()}
      <Switch>
        <Match when={pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
          {renderListPage()}
        </Match>
        <Match when={pageFns().pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
          {renderPage()}
        </Match>
      </Switch>
      {renderResizeTriangleMaybe()}
      <div class={`absolute ${borderClass()} rounded-sm pointer-events-none`}
           style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
                  backgroundStyle() +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        {renderHoverOverMaybe()}
        {renderMovingOverMaybe()}
        {renderMovingOverAttachMaybe()}
        {renderMovingOverAttachCompositeMaybe()}
        {renderPopupSelectedOverlayMaybe()}
        <For each={props.visualElement.attachmentsVes}>{attachmentVe =>
          <VisualElement_Desktop visualElement={attachmentVe.get()} />
        }</For>
        <Show when={pageFns().showMoveOutOfCompositeArea()}>
          <div class={`absolute rounded-sm`}
               style={`left: ${pageFns().moveOutOfCompositeBox().x}px; top: ${pageFns().moveOutOfCompositeBox().y}px; width: ${pageFns().moveOutOfCompositeBox().w}px; height: ${pageFns().moveOutOfCompositeBox().h}px; ` +
                      `background-color: ${FEATURE_COLOR};`} />
        </Show>
        {renderIsLinkMaybe()}
      </div>
      {renderBoxTitleMaybe()}
    </>
  );
}
