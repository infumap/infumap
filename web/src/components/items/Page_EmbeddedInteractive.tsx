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

import { Component, For, Match, Show, Switch, createEffect, onMount } from "solid-js";
import { LINE_HEIGHT_PX, Z_INDEX_LOCAL_HIGHLIGHT, Z_INDEX_LOCAL_SHADOW } from "../../constants";
import { VeFns, VisualElementFlags, isVeTranslucentPage } from "../../layout/visual-element";
import { requestArrange } from "../../layout/arrange";
import { VesCache } from "../../layout/ves-cache";
import { BorderType, Colors, FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW, borderColorForColorIdx, linearGradient } from "../../style";
import { VisualElement_Desktop, VisualElement_LineItem } from "../VisualElement";
import { VisualElement_DesktopShadowLayer } from "../VisualElementShadow";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { useStore } from "../../store/StoreProvider";
import { ArrangeAlgorithm, PageFns, isPage } from "../../items/page-item";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { PageVisualElementProps } from "./Page";
import { autoMovedIntoViewWarningStyle, createPageTitleEditHandlers, desktopStackRootStyle, scrollGestureStyleForArrangeAlgorithm, shouldShowFocusRingForVisualElement } from "./helper";
import { switchToPage } from "../../layout/navigation";
import { DocumentPageTitle } from "./DocumentPageTitle";
import { VisualElementSignal } from "../../util/signals";
import { appendNewlineIfEmpty } from "../../util/string";
import { PageGroupBoxes } from "./PageGroupBoxes";
import { LinearSelectionGapCover, linearSelectionGapAfterBoundsPx } from "./LinearSelectionGapCover";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_EmbeddedInteractive: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  let rootDiv: any = undefined; // HTMLDivElement | undefined
  let updatingRootScrollTop = false;
  const SCROLL_PROP_EPSILON = 0.000001;

  const pageFns = () => props.pageFns;
  const canEditPage = () => itemCanEdit(pageFns().pageItem());
  const pageChildren = () => VesCache.render.getChildren(VeFns.veToPath(props.visualElement))();
  const isMinimalDocumentPage = () => pageFns().isDocumentPage();
  const documentTextEditIsActive = () => {
    if (!canEditPage() || !pageFns().isDocumentPage()) { return false; }
    const itemPath = store.overlay.textEditInfo()?.itemPath;
    if (itemPath == null) { return false; }
    const pagePath = pageFns().vePath();
    return itemPath == pagePath || VeFns.parentPath(itemPath) == pagePath;
  };
  const getScrollVeid = () => {
    let veid = VeFns.veidFromVe(props.visualElement);
    if ((props.visualElement.flags & VisualElementFlags.ListPageRoot) && props.visualElement.parentPath) {
      veid = VeFns.actualVeidFromVe(props.visualElement);
    }
    return veid;
  };
  const syncRootScrollPosition = () => {
    if (!rootDiv) {
      return;
    }

    const veid = getScrollVeid();
    updatingRootScrollTop = true;

    if (isListPage() && props.visualElement.listChildAreaBoundsPx) {
      const viewportH = pageFns().viewportBoundsPx().h;
      const scrollableHeightPx = Math.max(0, props.visualElement.listChildAreaBoundsPx.h - viewportH);
      rootDiv.scrollTop = store.perItem.getPageScrollYProp(veid) * scrollableHeightPx;
      rootDiv.scrollLeft = 0;
    } else {
      const scrollableWidthPx = Math.max(0, pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);
      const scrollableHeightPx = Math.max(0, pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);
      rootDiv.scrollLeft = store.perItem.getPageScrollXProp(veid) * scrollableWidthPx;
      rootDiv.scrollTop = store.perItem.getPageScrollYProp(veid) * scrollableHeightPx;
    }

    setTimeout(() => {
      updatingRootScrollTop = false;
    }, 0);
  };

  onMount(() => {
    syncRootScrollPosition();
  });

  createEffect(() => {
    if (!rootDiv) {
      return;
    }

    if (isListPage()) {
      props.visualElement.listChildAreaBoundsPx?.h;
      store.perItem.getPageScrollYProp(getScrollVeid());
    } else {
      pageFns().childAreaBoundsPx();
      pageFns().viewportBoundsPx();
      store.perItem.getPageScrollXProp(getScrollVeid());
      store.perItem.getPageScrollYProp(getScrollVeid());
    }

    syncRootScrollPosition();
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

  const vePath = () => VeFns.veToPath(props.visualElement);
  const titleEditHandlers = createPageTitleEditHandlers(
    store,
    () => props.visualElement,
    () => requestArrange(store, "embedded-interactive-escape"),
  );

  // Check if this page is currently focused (via focusPath or textEditInfo)
  const isFocused = () => {
    const focusPath = store.history.getFocusPath();
    const textEditInfo = store.overlay.textEditInfo();
    return focusPath === vePath() || (textEditInfo != null && textEditInfo.itemPath === vePath());
  };

  const isEmbeddedInteractive = () => !!(props.visualElement.flags & VisualElementFlags.EmbeddedInteractiveRoot);
  const isInsideTranslucentPage = () => {
    const parentPath = props.visualElement.parentPath;
    if (!parentPath) {
      return false;
    }
    const parentVe = VesCache.current.readNode(parentPath) ?? VesCache.render.getNode(parentPath)?.get() ?? null;
    return parentVe != null && isVeTranslucentPage(parentVe);
  };

  const isDockItem = () => !!(props.visualElement.flags & VisualElementFlags.DockItem);
  const visibleDesktopChildren = () =>
    pageFns().desktopChildren().filter((childVe: VisualElementSignal) =>
      !(isDockItem() && (childVe.get().flags & VisualElementFlags.Moving)));
  const isListPage = () => pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List;
  const selectedRootVe = () => {
    const selectedVeSignal = VesCache.render.getSelected(vePath())();
    return selectedVeSignal?.get() ?? null;
  };
  const popupRootVeMaybe = () => VesCache.render.getPopup(vePath())()?.get() ?? null;
  const isSelectedRootPageFocused = () => {
    const selectedVe = selectedRootVe();
    const focusPath = store.history.getFocusPathMaybe();
    return selectedVe != null &&
      isPage(selectedVe.displayItem) &&
      focusPath === VeFns.veToPath(selectedVe) &&
      shouldShowFocusRingForVisualElement(store, () => selectedVe);
  };

  const borderStyle = () => {
    if (isDockItem()) {
      return `${isListPage() ? 'border-bottom-width' : 'border-width'}: 1px; border-color: ${borderColorForColorIdx(pageFns().pageItem().backgroundColorIndex, BorderType.Dock)}; `;
    }
    return `border-top-width: 1px; border-right-width: 1px; border-bottom-width: 1px; ` +
      `border-left-width: ${isInsideTranslucentPage() ? 0 : 1}px; ` +
      `border-color: ${Colors[pageFns().pageItem().backgroundColorIndex]}; `;
  }

  const renderShadowMaybe = () =>
    <Show when={isEmbeddedInteractive()}>
      <div class={`absolute border border-transparent rounded-xs pointer-events-none`}
        style={`left: 0px; top: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; ` +
          `width: ${pageFns().boundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
          `z-index: ${Z_INDEX_LOCAL_SHADOW};`} />
    </Show>;

  const renderFocusRingMaybe = () =>
    <Show when={isFocused() && shouldShowFocusRingForVisualElement(store, () => props.visualElement)}>
      <div class="absolute pointer-events-none rounded-xs"
        style={`left: 0px; top: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; ` +
          `width: ${pageFns().boundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
          `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
    </Show>;

  const renderSelectedPageFocusRingMaybe = () =>
    <Show when={isSelectedRootPageFocused()}>
      <div class="absolute pointer-events-none rounded-xs"
        style={`left: ${pageFns().listViewportWidthPx()}px; top: 0px; ` +
          `width: ${Math.max(0, pageFns().viewportBoundsPx().w - pageFns().listViewportWidthPx())}px; ` +
          `height: ${pageFns().viewportBoundsPx().h}px; ` +
          `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
    </Show>;

  const renderEmbeddedInteractiveBackground = () =>
    isMinimalDocumentPage()
      ? <div class="absolute w-full bg-white"
        style={`top: 0px; bottom: 0px; ` +
          `z-index: 1;`} />
      : <div class="absolute w-full"
        style={`background-image: ${linearGradient(pageFns().pageItem().backgroundColorIndex, 0.95)}; ` +
          `top: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; bottom: ${0}px;` +
          `z-index: 1; ` +
          borderStyle()} />;

  const renderEmbeddedInteractiveForeground = () =>
    <Show when={!isMinimalDocumentPage()}>
      <div class="absolute w-full pointer-events-none"
        style={`z-index: 3; ` +
          `top: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; bottom: ${0}px;` +
          borderStyle()} />
    </Show>;

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
    <Show when={isEmbeddedInteractive() && !isMinimalDocumentPage()}>
      <div class={`absolute`}
        style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; z-index: 4;`}>
        <div id={VeFns.veToPath(props.visualElement) + ":title"}
          class={`absolute font-bold ${titleEditHandlers.isEditingTitle() ? "select-text cursor-text" : ""}`}
          style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w / titleScale()}px; height: ${(pageFns().boundsPx().h - pageFns().viewportBoundsPx().h) / titleScale()}px; ` +
            `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${titleScale()}); transform-origin: top left; ` +
            `overflow-wrap: break-word;` +
            `outline: 0px solid transparent;`}
          spellcheck={canEditPage() && titleEditHandlers.isEditingTitle()}
          contentEditable={canEditPage() && titleEditHandlers.isEditingTitle()}
          onKeyDown={titleEditHandlers.titleKeyDownHandler}
          onKeyUp={titleEditHandlers.titleKeyUpHandler}
          onInput={titleEditHandlers.titleInputListener}>
          {appendNewlineIfEmpty(pageFns().pageItem().title)}
        </div>
      </div>
    </Show>;

  const renderHighlightMaybe = () =>
    <Show when={isEmbeddedInteractive() &&
      ((props.visualElement.flags & VisualElementFlags.FindHighlighted) ||
        (props.visualElement.flags & VisualElementFlags.SelectionHighlighted))}>
      <div class="absolute pointer-events-none rounded-xs"
        style={`left: 0px; top: 0px; ` +
          `width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; ` +
          `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR}; ` +
          `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
      <div class="absolute pointer-events-none rounded-xs"
        style={`left: 0px; top: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; ` +
          `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
          `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR}; ` +
          `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
    </Show>;

  const backgroundDoubleClickHandler = (ev: MouseEvent) => {
    if (ev.target !== ev.currentTarget) { return; }
    ev.preventDefault();
    ev.stopPropagation();
    switchToPage(store, VeFns.actualVeidFromVe(props.visualElement), true, false, false);
  };

  const listScrollHandler = (_ev: Event) => {
    if (!rootDiv || updatingRootScrollTop || !props.visualElement.listChildAreaBoundsPx) {
      return;
    }

    const veid = getScrollVeid();
    const viewportH = pageFns().viewportBoundsPx().h;
    const scrollableHeightPx = Math.max(0, props.visualElement.listChildAreaBoundsPx.h - viewportH);
    const nextScrollYProp = scrollableHeightPx > 0 ? rootDiv.scrollTop / scrollableHeightPx : 0;
    if (Math.abs(store.perItem.getPageScrollYProp(veid) - nextScrollYProp) > SCROLL_PROP_EPSILON) {
      store.perItem.setPageScrollYProp(veid, nextScrollYProp);
    }
  };

  const rootScrollHandler = (_ev: Event) => {
    if (!rootDiv || updatingRootScrollTop) {
      return;
    }

    const veid = getScrollVeid();
    const scrollableWidthPx = Math.max(0, pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);
    const scrollableHeightPx = Math.max(0, pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);

    const nextScrollYProp = scrollableHeightPx > 0 ? rootDiv.scrollTop / scrollableHeightPx : 0;
    const nextScrollXProp = scrollableWidthPx > 0 ? rootDiv.scrollLeft / scrollableWidthPx : 0;

    if (Math.abs(store.perItem.getPageScrollYProp(veid) - nextScrollYProp) > SCROLL_PROP_EPSILON) {
      store.perItem.setPageScrollYProp(veid, nextScrollYProp);
    }
    if (Math.abs(store.perItem.getPageScrollXProp(veid) - nextScrollXProp) > SCROLL_PROP_EPSILON) {
      store.perItem.setPageScrollXProp(veid, nextScrollXProp);
    }
  };

  const renderListPage = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} rounded-xs`}
      style={`width: ${pageFns().viewportBoundsPx().w}px; ` +
        `height: ${pageFns().viewportBoundsPx().h + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
        `left: 0px; ` +
        `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
        `background-color: #ffffff; z-index: 2;`}>
      <div ref={rootDiv}
        class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} ` +
          `${props.visualElement.flags & VisualElementFlags.DockItem ? "" : "border-slate-300 border-r"}`}
        style={`left: 0px; top: 0px; ` +
          `overflow-y: auto; overflow-x: hidden; ` +
          `width: ${pageFns().listViewportWidthPx()}px; ` +
          `height: ${pageFns().viewportBoundsPx().h}px; ` +
          `background-color: #ffffff;`}
        onscroll={listScrollHandler}
        ondblclick={backgroundDoubleClickHandler}>
        <div class="absolute"
          style={`width: ${props.visualElement.listChildAreaBoundsPx!.w}px; ` +
            `height: ${props.visualElement.listChildAreaBoundsPx!.h}px`}
          ondblclick={backgroundDoubleClickHandler}>
          <PageGroupBoxes childVes={pageFns().lineChildren()} childAreaBoundsPx={props.visualElement.listChildAreaBoundsPx!} pageItemId={props.visualElement.displayItem.id} />
          <For each={pageFns().lineChildren()}>{childVe =>
            <VisualElement_LineItem visualElement={childVe.get()} />
          }</For>
          {pageFns().renderMoveOverAnnotationMaybe()}
        </div>
      </div>
      <VisualElement_DesktopShadowLayer visualElementSignals={visibleDesktopChildren()} />
      <For each={visibleDesktopChildren()}>{childVe =>
        <VisualElement_Desktop visualElement={childVe.get()} suppressLocalShadow={true} />
      }</For>
      {renderSelectedRootMaybe()}
      {renderPopupRootMaybe()}
      {renderSelectedPageFocusRingMaybe()}
    </div>;

  const renderPage = () =>
    <div ref={rootDiv}
      class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} rounded-xs`}
      style={`left: 0px; ` +
        `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
        `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
        `overflow-y: ${pageFns().viewportBoundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
        `overflow-x: ${pageFns().viewportBoundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
        `${scrollGestureStyleForArrangeAlgorithm(pageFns().pageItem().arrangeAlgorithm)}` +
        `background-color: #ffffff; z-index: 2;`}
      onscroll={rootScrollHandler}
      ondblclick={backgroundDoubleClickHandler}>
      <div class="absolute"
        style={`left: ${pageFns().documentContentLeftPx()}px; top: 0px; ` +
          `width: ${pageFns().childAreaBoundsPx().w}px; ` +
          `height: ${pageFns().childAreaBoundsPx().h}px; ` +
          `outline: 0px solid transparent; `}
        contentEditable={documentTextEditIsActive()}
        onKeyUp={keyUpHandler}
        onKeyDown={keyDownHandler}
        onInput={inputListener}
        ondblclick={backgroundDoubleClickHandler}>
        <PageGroupBoxes childVes={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()} childAreaBoundsPx={pageFns().childAreaBoundsPx()} pageItemId={props.visualElement.displayItem.id} />
        <Show when={PageFns.showDocumentTitleInDocument(pageFns().pageItem())}>
          <DocumentPageTitle visualElement={props.visualElement} pageFns={props.pageFns} allowEditing={true} />
        </Show>
        {pageFns().renderSearchSelectionMaybe()}
        <VisualElement_DesktopShadowLayer visualElementSignals={pageChildren()} />
        <For each={pageChildren()}>{(childVes, index) => {
          const gapAfterBoundsPx = () => linearSelectionGapAfterBoundsPx(
            childVes.get().boundsPx,
            pageChildren()[index() + 1]?.get().boundsPx ?? null,
            pageFns().childAreaBoundsPx().w,
          );
          return (
            <>
              <VisualElement_Desktop visualElement={childVes.get()} suppressLocalShadow={true} />
              <LinearSelectionGapCover
                enabled={documentTextEditIsActive}
                boundsPx={gapAfterBoundsPx} />
            </>
          );
        }}</For>
        {pageFns().renderGridLinesMaybe()}
        {pageFns().renderSearchHoverMaybe()}
        {pageFns().renderCatalogMetadataMaybe()}
        {pageFns().renderMoveOverAnnotationMaybe()}
      </div>
      {renderSelectedRootMaybe()}
      {renderPopupRootMaybe()}
    </div>;

  const renderSelectedRootMaybe = () =>
    <Show when={selectedRootVe()}>
      {selectedVe => <VisualElement_Desktop visualElement={selectedVe()} />}
    </Show>;

  const renderPopupRootMaybe = () =>
    <Show when={popupRootVeMaybe()}>
      {popupVe => <VisualElement_Desktop visualElement={popupVe()} />}
    </Show>;

  return (
    <div class={`absolute`}
      style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px;`}>
      <div class="absolute"
        style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ${desktopStackRootStyle(props.visualElement)}`}>
        {renderShadowMaybe()}
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
        {renderEmbeddedInteractiveTitleMaybe()}
        {renderHighlightMaybe()}
        {renderFocusRingMaybe()}
        <Show when={store.perVe.getAutoMovedIntoView(pageFns().vePath())}>
          <div class="absolute pointer-events-none rounded-xs"
            style={autoMovedIntoViewWarningStyle(pageFns().boundsPx().w, pageFns().boundsPx().h)} />
        </Show>
      </div>
    </div>
  );
}
