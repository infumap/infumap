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

import { Component, For, Show, createEffect, onCleanup, onMount } from "solid-js";
import { LINE_HEIGHT_PX, PADDING_PROP, Z_INDEX_LOCAL_OVERLAY } from "../../constants";
import { PageItem } from "../../items/page-item";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { ItemType } from "../../items/base/item";
import { rearrangeTableAfterScroll } from "../../layout/arrange/table";
import { tabularColumnLayouts } from "../../layout/tabular";
import { VesCache } from "../../layout/ves-cache";
import { VeFns, VisualElement, isVeTranslucentPage } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { VisualElement_LineItem } from "../VisualElement";
import { edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";

interface PageTableContentProps {
  visualElement: VisualElement;
}

/** Table rows are positioned relative to a page-local body viewport, below the column header. */
export const Page_TableContent: Component<PageTableContentProps> = props => {
  const store = useStore();
  let bodyDiv: HTMLDivElement | undefined;
  let scrollDoneTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingProgrammaticScrollTop: number | null = null;

  const page = () => props.visualElement.displayItem as PageItem;
  const isTranslucent = () => isVeTranslucentPage(props.visualElement);
  const canEdit = () => !isTranslucent() && itemCanEdit(page()) && itemCanEdit(VeFns.treeItem(props.visualElement));
  const pagePath = () => VeFns.veToPath(props.visualElement);
  const pageVeid = () => VeFns.veidFromVe(props.visualElement);
  const viewport = () => props.visualElement.viewportBoundsPx!;
  const bodyViewport = () => props.visualElement.tableBodyViewportBoundsPx!;
  const blockSize = () => props.visualElement.tableRowBlockSizePx!;
  const headerHeightPx = () => bodyViewport().y - viewport().y;
  const headerSharesToolbarBorder = () => store.topToolbarHeightPx() > 0 &&
    store.topTitledPages.get().includes(pagePath());
  const scale = () => blockSize().h / LINE_HEIGHT_PX;
  const columns = () => tabularColumnLayouts(page(), viewport().w / blockSize().w);
  const isSortedByTitle = () => page().orderChildrenBy == "title[ASC]";
  const moveOverRowY = () => headerHeightPx() +
    (store.perVe.getMoveOverRowNumber(pagePath()) - store.perItem.getTableScrollYPos(pageVeid())) * blockSize().h;

  const syncScrollTop = () => {
    if (!bodyDiv) { return; }
    const scrollTop = store.perItem.getTableScrollYPos(pageVeid()) * blockSize().h;
    if (Math.abs(bodyDiv.scrollTop - scrollTop) > 0.5) {
      pendingProgrammaticScrollTop = scrollTop;
      bodyDiv.scrollTop = scrollTop;
    }
  };

  onMount(syncScrollTop);
  createEffect(() => {
    bodyViewport().h;
    props.visualElement.childAreaBoundsPx?.h;
    blockSize().h;
    store.perItem.getTableScrollYPos(pageVeid());
    syncScrollTop();
  });
  onCleanup(() => {
    if (scrollDoneTimer != null) { clearTimeout(scrollDoneTimer); }
  });

  const scrollHandler = () => {
    if (!bodyDiv) { return; }
    if (pendingProgrammaticScrollTop != null &&
      Math.abs(bodyDiv.scrollTop - pendingProgrammaticScrollTop) < 0.5) {
      pendingProgrammaticScrollTop = null;
      return;
    }
    if (VesCache.arrange.isInProgress() || store.anItemIsMoving.get()) {
      syncScrollTop();
      return;
    }
    const previous = store.perItem.getTableScrollYPos(pageVeid());
    const next = bodyDiv.scrollTop / blockSize().h;
    store.perItem.setTableScrollYPos(pageVeid(), next);
    if (Math.floor(previous) != Math.floor(next)) {
      rearrangeTableAfterScroll(store, props.visualElement.parentPath!, pageVeid(), previous);
    }
    if (scrollDoneTimer != null) { clearTimeout(scrollDoneTimer); }
    scrollDoneTimer = setTimeout(() => {
      scrollDoneTimer = null;
      if (!bodyDiv) { return; }
      const beforeSnap = store.perItem.getTableScrollYPos(pageVeid());
      const snapped = Math.round(beforeSnap);
      store.perItem.setTableScrollYPos(pageVeid(), snapped);
      bodyDiv.scrollTop = snapped * blockSize().h;
      if (Math.floor(beforeSnap) != snapped) {
        rearrangeTableAfterScroll(store, props.visualElement.parentPath!, pageVeid(), beforeSnap);
      }
    }, 600);
  };

  const rows = () => VesCache.render.getChildren(pagePath())();

  return (
    <div class="absolute bg-white"
      style={`left: ${viewport().x - props.visualElement.boundsPx.x}px; ` +
        `top: ${viewport().y - props.visualElement.boundsPx.y}px; ` +
        `width: ${viewport().w}px; height: ${viewport().h}px; overflow: hidden;`}>
      <Show when={headerHeightPx() > 0}>
        {/* Keep the label positions when the toolbar draws the top border one pixel above this header. */}
        <div class={`absolute border-y border-[#999] bg-slate-300 ${isTranslucent() ? "pointer-events-none" : ""}`}
          style={`left: 0px; top: 0px; width: ${viewport().w}px; height: ${headerHeightPx()}px; ` +
            `border-top-color: ${headerSharesToolbarBorder() ? "transparent" : "#999"};`}>
          <For each={columns()}>{column =>
            <div id={`${pagePath()}:col${column.index}`}
              class="absolute whitespace-nowrap overflow-hidden"
              style={`left: ${column.startBl * blockSize().w + PADDING_PROP * blockSize().w}px; top: 0px; ` +
                `width: ${Math.max(0, (column.endBl - column.startBl) * blockSize().w - PADDING_PROP * blockSize().w) / scale()}px; ` +
                `height: ${headerHeightPx() / scale()}px; line-height: ${LINE_HEIGHT_PX}px; ` +
                `transform: scale(${scale()}); transform-origin: top left; outline: 0px solid transparent;`}
              contentEditable={canEdit() && store.overlay.textEditInfo()?.itemPath == pagePath() &&
                store.overlay.textEditInfo()?.itemType == ItemType.Page && store.overlay.textEditInfo()?.colNum == column.index}
              spellcheck={canEdit() && store.overlay.textEditInfo()?.colNum == column.index}
              onInput={ev => edit_inputListener(store, ev)}
              onKeyDown={ev => edit_keyDownHandler(store, props.visualElement, ev)}
              onKeyUp={ev => edit_keyUpHandler(store, ev)}>
              {column.name}
              <Show when={!isTranslucent() && store.perVe.getMouseIsOver(pagePath()) && store.mouseOverTableHeaderColumnNumber.get() == column.index}>
                <div class="absolute" style="top: 0px; right: 7px; font-size: smaller;">
                  <i class="fas fa-chevron-down" />
                </div>
              </Show>
            </div>
          }</For>
        </div>
      </Show>
      <div ref={bodyDiv}
        class="absolute"
        style={`left: 0px; top: ${headerHeightPx()}px; ` +
          `width: ${bodyViewport().w}px; height: ${bodyViewport().h}px; ` +
          `overflow-y: auto; overflow-x: hidden;`}
        onscroll={scrollHandler}>
        <div class={`absolute ${isTranslucent() ? "pointer-events-none" : ""}`}
          style={`width: ${bodyViewport().w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
          <For each={rows()}>{childVe =>
            <>
              <VisualElement_LineItem visualElement={childVe.get()} />
              <For each={VesCache.render.getAttachments(VeFns.veToPath(childVe.get()))()}>{attachment =>
                <VisualElement_LineItem visualElement={attachment.get()} />
              }</For>
            </>
          }</For>
        </div>
      </div>
      <div class="absolute pointer-events-none"
        style={`left: 0px; top: 0px; width: ${viewport().w}px; height: ${viewport().h}px;`}>
        <For each={columns()}>{column =>
          <Show when={!column.isLast}>
            <div class="absolute bg-slate-300"
              style={`left: ${column.endBl * blockSize().w}px; top: 0px; width: 1px; height: ${viewport().h}px;`} />
          </Show>
        }</For>
      </div>
      <Show when={store.perVe.getMovingItemIsOver(pagePath()) &&
        store.perVe.getMoveOverRowNumber(pagePath()) >= 0 &&
        store.perVe.getMoveOverChildContainerPath(pagePath()) == null &&
        !isSortedByTitle()}>
        <Show when={store.perVe.getMoveOverColAttachmentNumber(pagePath()) < 0}
          fallback={<div class="absolute border border-black bg-black pointer-events-none"
            style={`left: ${(columns()[Math.min(store.perVe.getMoveOverColAttachmentNumber(pagePath()), columns().length - 1)]?.endBl ?? 0) * blockSize().w}px; ` +
              `top: ${moveOverRowY()}px; width: 4px; height: ${blockSize().h}px; z-index: ${Z_INDEX_LOCAL_OVERLAY};`} />}>
          <div class="absolute border border-black pointer-events-none"
            style={`left: 0px; top: ${moveOverRowY()}px; width: ${viewport().w}px; height: 1px; z-index: ${Z_INDEX_LOCAL_OVERLAY};`} />
        </Show>
      </Show>
    </div>
  );
};
