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

import { Component, For, createEffect, onMount } from "solid-js";
import { VeFns } from "../../layout/visual-element";
import { VisualElement_Desktop } from "../VisualElement";
import { VisualElement_DesktopShadowLayer } from "../VisualElementShadow";
import { useStore } from "../../store/StoreProvider";
import { VesCache } from "../../layout/ves-cache";
import { PageVisualElementProps } from "./Page";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { ClientOnlyItemKind } from "../../items/base/item";
import { desktopStackRootStyle, miniatureChildItemRadiusStyle, scrollGestureStyleForArrangeAlgorithm } from "./helper";
import { PageGroupBoxes } from "./PageGroupBoxes";
import { LinearSelectionGapCover, linearSelectionGapAfterBoundsPx } from "./LinearSelectionGapCover";
import { createDocumentTextContainerHandlers } from "./document-text-container";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

const CHAT_FOLLOW_LATEST_THRESHOLD_PX = 8;

/**
 * The chat transcript (a read-only document page) or search results (a grid or catalog page) of a query, filling the
 * query's workspace below its search box. Unlike a translucent page, which also shows its children inside another
 * item, this is not a preview: it has no chrome, and its contents are interactive.
 */
export const Page_QueryWorkspace: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  let scrollDiv: HTMLDivElement | undefined;
  let updatingScrollTop = false;
  let previousChildAreaHeightPx: number | null = null;
  let latestScrollTopPx = 0;
  let followingLatestChatTurn = true;

  const pageFns = () => props.pageFns;
  const isChat = () => pageFns().pageItem().clientOnlyKind == ClientOnlyItemKind.QueryChatPage;
  const pageChildren = () => VesCache.render.getChildren(VeFns.veToPath(props.visualElement))();

  // As for a read-only document page shown as the root (e.g. a markdown file), so that text selection runs across
  // paragraphs and table cells, copies with the document's structure, and extends with the keyboard.
  const readOnlyDocumentTextSelectionIsActive = () =>
    pageFns().isDocumentPage() && !itemCanEdit(pageFns().pageItem());
  const { keyUpHandler, keyDownHandler, inputListener, beforeInputListener } =
    createDocumentTextContainerHandlers(store, () => props.visualElement, readOnlyDocumentTextSelectionIsActive);

  const maxScrollYPx = () => Math.max(0, pageFns().childAreaBoundsPx().h - pageFns().boundsPx().h);

  onMount(() => {
    const veid = VeFns.veidFromVe(props.visualElement);
    const scrollXPx = store.perItem.getPageScrollXProp(veid) *
      (pageFns().childAreaBoundsPx().w - pageFns().boundsPx().w);
    const scrollYProp = isChat() && followingLatestChatTurn
      ? 1
      : store.perItem.getPageScrollYProp(veid);
    const scrollYPx = scrollYProp * maxScrollYPx();
    if (isChat() && followingLatestChatTurn) {
      store.perItem.setPageScrollYProp(veid, 1);
    }
    scrollDiv!.scrollTop = scrollYPx;
    scrollDiv!.scrollLeft = scrollXPx;
    latestScrollTopPx = scrollYPx;
  });

  createEffect(() => {
    if (!pageFns().childAreaBoundsPx()) { return; }

    updatingScrollTop = true;
    if (scrollDiv) {
      const pageVeid = VeFns.veidFromVe(props.visualElement);
      const maxPx = maxScrollYPx();
      // Read on every run, whichever branch is taken below: Solid tracks only what a run reads, so a run that skipped
      // it would stop this effect following later scroll changes (e.g. arrow keys moving the focus through search
      // results after more of them were loaded).
      const scrollYProp = store.perItem.getPageScrollYProp(pageVeid);
      // More catalog results were loaded below: keep the ones in view where they are.
      const shouldPreserveAbsoluteScrollTop =
        pageFns().hasCatalogResultContext() &&
        previousChildAreaHeightPx != null &&
        pageFns().childAreaBoundsPx().h > previousChildAreaHeightPx;

      if (isChat() && followingLatestChatTurn) {
        scrollDiv.scrollTop = maxPx;
        latestScrollTopPx = maxPx;
        // The scroll signal has equals: false and this effect reads it above, so an unconditional write here re-runs
        // the effect forever (stack overflow in Solid's runUpdates).
        if (scrollYProp != 1) { store.perItem.setPageScrollYProp(pageVeid, 1); }
      } else if (shouldPreserveAbsoluteScrollTop) {
        const preservedScrollTopPx = Math.min(latestScrollTopPx, maxPx);
        scrollDiv.scrollTop = preservedScrollTopPx;
        latestScrollTopPx = preservedScrollTopPx;
        store.perItem.setPageScrollYProp(pageVeid, maxPx > 0 ? preservedScrollTopPx / maxPx : 0);
      } else {
        const nextScrollTopPx = scrollYProp * maxPx;
        scrollDiv.scrollTop = nextScrollTopPx;
        latestScrollTopPx = nextScrollTopPx;
      }
      scrollDiv.scrollLeft =
        store.perItem.getPageScrollXProp(pageVeid) *
        (pageFns().childAreaBoundsPx().w - pageFns().boundsPx().w);
    }
    previousChildAreaHeightPx = pageFns().childAreaBoundsPx().h;

    setTimeout(() => {
      updatingScrollTop = false;
    }, 0);
  });

  const scrollHandler = (_ev: Event) => {
    if (!scrollDiv || updatingScrollTop) { return; }

    if (isChat()) {
      const distanceFromBottomPx = Math.max(0, scrollDiv.scrollHeight - scrollDiv.clientHeight - scrollDiv.scrollTop);
      // Any upward scroll that leaves the bottom stops following. A threshold alone does not work: each scroll event
      // re-runs the layout effect (the scroll signal has equals: false), which snaps back to the bottom while
      // following, and trackpad gestures start with deltas smaller than the threshold, so they could never escape.
      // Being exactly at the bottom keeps following, so a browser clamp after the content shrinks doesn't count.
      if (distanceFromBottomPx < 1) {
        followingLatestChatTurn = true;
      } else if (scrollDiv.scrollTop < latestScrollTopPx) {
        followingLatestChatTurn = false;
      } else {
        followingLatestChatTurn = distanceFromBottomPx <= CHAT_FOLLOW_LATEST_THRESHOLD_PX;
      }
    }

    const maxPx = maxScrollYPx();
    if (maxPx > 0) {
      latestScrollTopPx = scrollDiv.scrollTop;
      store.perItem.setPageScrollYProp(VeFns.veidFromVe(props.visualElement), scrollDiv.scrollTop / maxPx);
    } else {
      latestScrollTopPx = 0;
    }
  };

  return (
    <div class="absolute"
      style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; ` +
        `width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
        `${desktopStackRootStyle(props.visualElement)}`}>
      <div ref={scrollDiv}
        class="absolute"
        style={`left: 0px; top: 0px; ` +
          `width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          `background-color: #ffffff; ` +
          `overflow-y: ${pageFns().boundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
          `overflow-x: ${pageFns().boundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
          `${scrollGestureStyleForArrangeAlgorithm(pageFns().pageItem().arrangeAlgorithm)}` +
          `z-index: 1;`}
        onscroll={scrollHandler}>
        <div class="absolute"
          style={`left: ${pageFns().isDocumentPage() ? pageFns().documentContentLeftPx() : 0}px; top: 0px; ` +
            `width: ${pageFns().childAreaBoundsPx().w}px; height: ${pageFns().childAreaBoundsPx().h}px; ` +
            `outline: 0px solid transparent; ` +
            `${miniatureChildItemRadiusStyle(store, pageFns().boundsPx().w)}`}
          contentEditable={readOnlyDocumentTextSelectionIsActive()}
          data-infumap-read-only-document={readOnlyDocumentTextSelectionIsActive() ? "" : undefined}
          onBeforeInput={beforeInputListener}
          onKeyUp={keyUpHandler}
          onKeyDown={keyDownHandler}
          onInput={inputListener}>
          <PageGroupBoxes childVes={pageChildren()} childAreaBoundsPx={pageFns().childAreaBoundsPx()} pageItemId={props.visualElement.displayItem.id} />
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
                  enabled={readOnlyDocumentTextSelectionIsActive}
                  inheritCursor={readOnlyDocumentTextSelectionIsActive}
                  boundsPx={gapAfterBoundsPx} />
              </>
            );
          }}</For>
          {pageFns().renderCatalogFooterHostMaybe()}
          {pageFns().renderGridLinesMaybe()}
          {pageFns().renderCatalogResultHoverMaybe()}
          {pageFns().renderCatalogMetadataMaybe(pageFns().hasCatalogResultContext())}
          {pageFns().renderMoveOverAnnotationMaybe()}
        </div>
      </div>
    </div>
  );
}
