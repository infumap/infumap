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

import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { arrangeNow, requestArrange } from "../../layout/arrange";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR } from "../../style";
import { VisualElementProps } from "../VisualElement";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle } from "./helper";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { setCaretPosition } from "../../util/caret";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { ItemType } from "../../items/base/item";
import { server } from "../../server";
import { VisualElement_Desktop } from "../VisualElement";
import { VisualElement_DesktopShadowLayer } from "../VisualElementShadow";
import { VesCache } from "../../layout/ves-cache";
import { FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_LOCAL_OVERLAY } from "../../constants";
import { desktopPopupIconTextIndentPx, getTextStyleForNote } from "../../layout/text";
import { initiateLoadChildItemsMaybe, initiateLoadItemMaybe } from "../../layout/load";
import { itemState } from "../../store/ItemState";
import { asContainerItem, isContainer } from "../../items/base/container-item";
import { asLinkItem, isLink, LinkFns } from "../../items/link-item";
import {
  SearchFns,
  asSearchItem,
  SEARCH_WORKSPACE_BUTTON_WIDTH_PX,
  SEARCH_WORKSPACE_CONTROLS_GAP_PX,
  SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX,
  SEARCH_WORKSPACE_MATERIALIZE_BUTTON_WIDTH_PX,
  SEARCH_WORKSPACE_MORE_BUTTON_HEIGHT_PX,
  SEARCH_WORKSPACE_MORE_BUTTON_WIDTH_PX,
  SEARCH_WORKSPACE_TOP_INSET_PX,
  SEARCH_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX,
  SEARCH_WORKSPACE_ARRANGE_SELECTOR_WIDTH_PX,
  SEARCH_WORKSPACE_ARRANGE_SELECTOR_RIGHT_INSET_PX,
  calcSearchWorkspaceControlsWidthPx,
  calcSearchWorkspaceInputWidthPx,
  calcSearchWorkspaceResultsBoundsPx,
  calcSearchWorkspaceResultsTopPx,
  searchResultsFooterHostId,
} from "../../items/search-item";
import { materializeSearchResults } from "../../layout/search_materialize";
import { clearQuerySearchRuntime } from "../../layout/arrange/search";
import { TransientMessageType } from "../../store/StoreProvider_Overlay";
import { ArrangeAlgorithm } from "../../items/page-item";
import { ensureClientOnlyChatPageUnderQueryItem, removeClientOnlyChatPagesUnderQueries, submitChatMessage } from "../../items/chat";

const normalizeSearchText = (text: string): string =>
  text.replace(/\u200B/g, "").replace(/\n/g, "").trim();
const SEARCH_WORKSPACE_ARRANGE_OPTIONS = [
  { arrangeAlgorithm: ArrangeAlgorithm.Catalog, label: "catalog" },
  { arrangeAlgorithm: ArrangeAlgorithm.Grid, label: "grid" },
] as const;


export const Search_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();
  const [pendingInputFocus, setPendingInputFocus] = createSignal<{ caretIdx: number, selectAll: boolean } | null>(null);
  const [forceNonEditing, setForceNonEditing] = createSignal(false);
  const [isLoadingMore, setIsLoadingMore] = createSignal(false);
  const [isStartingChat, setIsStartingChat] = createSignal(false);
  const [moreButtonHost, setMoreButtonHost] = createSignal<HTMLElement | null>(null);
  let activeSearchRequestSerial = 0;
  const boundsPx = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);

  const isListPageMainRoot = () =>
    !!(props.visualElement.flags & VisualElementFlags.ListPageRoot) ||
    props.visualElement.linkItemMaybe?.id == LIST_PAGE_MAIN_ITEM_LINK_ITEM;
  const searchItem = () => asSearchItem(props.visualElement.displayItem);
  const canEdit = () => itemCanEdit(searchItem());
  const queryText = () => store.perItem.getSearchQuery(searchItem().id);
  const queryMode = () => store.perItem.getQueryMode(searchItem().id);
  const isSearchMode = () => queryMode() == "search";
  const isChatMode = () => queryMode() == "chat";
  const searchHasMoreResults = () => store.perItem.getSearchHasMoreResults(searchItem().id);
  const searchLoadedPageCount = () => store.perItem.getSearchLoadedPageCount(searchItem().id);
  const hasSubmittedQuery = () => queryMode() != null;
  const hasSearchResults = () => (store.perItem.getSearchResults(searchItem().id)?.length ?? 0) > 0;
  const searchArrangeAlgorithm = () =>
    store.perItem.getSearchArrangeAlgorithm(searchItem().id) == ArrangeAlgorithm.Grid
      ? ArrangeAlgorithm.Grid
      : ArrangeAlgorithm.Catalog;
  const isEditing = () => canEdit() && store.overlay.textEditInfo()?.itemPath == vePath() && !forceNonEditing();
  const editingDomId = () => vePath() + ":title";
  const clearSearchResultSelection = () => {
    store.perItem.setSearchSelectedResultIndex(searchItem().id, -1);
    store.perItem.setSearchFocusedResultIndex(searchItem().id, -1);
  };
  const exitEditMode = (editingElMaybe?: HTMLElement | null) => {
    if (!isEditing()) {
      return;
    }

    const editingEl = editingElMaybe ?? document.getElementById(editingDomId());
    setForceNonEditing(true);
    setPendingInputFocus(null);
    store.overlay.autoFocusSearchInput.set(false);
    if (editingEl instanceof HTMLElement) {
      editingEl.contentEditable = "false";
      if (editingEl instanceof HTMLInputElement) {
        editingEl.value = queryText();
      }
    }
    blurEditingDomMaybe(editingEl instanceof HTMLElement ? editingEl : null);
    store.overlay.setTextEditInfo(store.history, null, true);
    arrangeNow(store, "search-exit-edit");
  };
  const readQueryTextFromDom = (elMaybe?: HTMLElement | null) => {
    const el = elMaybe ?? document.getElementById(editingDomId());
    if (el instanceof HTMLInputElement) {
      return normalizeSearchText(el.value);
    }
    if (!(el instanceof HTMLElement)) {
      return queryText();
    }
    return normalizeSearchText(el.innerText);
  };
  const blurEditingDomMaybe = (editingElMaybe?: HTMLElement | null) => {
    const selection = window.getSelection();
    if (selection != null) {
      selection.removeAllRanges();
    }
    const editingEl = editingElMaybe ?? document.getElementById(editingDomId());
    if (editingEl instanceof HTMLElement) {
      editingEl.blur();
      return;
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };
  const commitEditingQuery = (editingElMaybe?: HTMLElement | null): string => {
    const editingEl = editingElMaybe ?? document.getElementById(editingDomId());
    const nextQuery = isEditing() ? readQueryTextFromDom(editingEl instanceof HTMLElement ? editingEl : null) : queryText();
    store.perItem.setSearchQuery(searchItem().id, nextQuery);
    exitEditMode(editingEl instanceof HTMLElement ? editingEl : null);
    return nextQuery;
  };
  const requestEditMode = (caretIdx: number, selectAll: boolean = false, focusInput: boolean = true) => {
    if (!canEdit()) {
      return;
    }
    setForceNonEditing(false);
    setPendingInputFocus(focusInput ? { caretIdx, selectAll } : null);
    clearSearchResultSelection();
    if (!isEditing()) {
      store.overlay.setTextEditInfo(store.history, { itemPath: vePath(), itemType: ItemType.Search });
    }
  };
  const warmResultItemDetails = async (resultItemId: string) => {
    await initiateLoadItemMaybe(store, resultItemId);

    let targetItem = itemState.get(resultItemId);
    if (!targetItem) {
      return;
    }

    if (isLink(targetItem)) {
      const linkItem = asLinkItem(targetItem);
      const linkedToId = LinkFns.getLinkToId(linkItem);
      if (linkedToId && !linkItem.linkTo.startsWith("http")) {
        await initiateLoadItemMaybe(store, linkedToId, targetItem.parentId);
        targetItem = itemState.get(linkedToId) ?? targetItem;
      }
    }

    if (isContainer(targetItem) && !asContainerItem(targetItem).childrenLoaded) {
      await initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(targetItem, null));
    }
  };

  const warmSearchResults = async (result: Array<{ path: Array<{ id: string }> }>) => {
    const resultIds = [...new Set(result
      .map(r => r.path[r.path.length - 1]?.id)
      .filter((id): id is string => !!id))];
    await Promise.all(resultIds.map(id => warmResultItemDetails(id)));
  };

  const showTransientMessage = (text: string, type: TransientMessageType) => {
    store.overlay.toolbarTransientMessage.set({ text, type });
    window.setTimeout(() => {
      const current = store.overlay.toolbarTransientMessage.get();
      if (current?.text == text) {
        store.overlay.toolbarTransientMessage.set(null);
      }
    }, 1500);
  };

  const setSearchArrangeAlgorithm = (arrangeAlgorithm: ArrangeAlgorithm) => {
    const nextArrangeAlgorithm = arrangeAlgorithm == ArrangeAlgorithm.Grid
      ? ArrangeAlgorithm.Grid
      : ArrangeAlgorithm.Catalog;
    if (searchArrangeAlgorithm() == nextArrangeAlgorithm) {
      return;
    }
    store.perItem.setSearchArrangeAlgorithm(searchItem().id, nextArrangeAlgorithm);
    store.touchToolbar();
    arrangeNow(store, "search-workspace-arrange-algorithm");
  };

  const clearSearchResults = () => {
    clearQuerySearchRuntime(store, searchItem().id);
    store.perItem.setQueryMode(searchItem().id, null);
    store.perItem.setSearchResults(searchItem().id, null);
    store.perItem.setSearchHasMoreResults(searchItem().id, false);
    store.perItem.setSearchLoadedPageCount(searchItem().id, 0);
    clearSearchResultSelection();
    requestArrange(store, "search-clear-results");
  };

  const runSearch = async (
    selectFirstResultRow: boolean,
    editingElMaybe?: HTMLElement | null,
    keepSearchWorkspaceFocus: boolean = false,
  ) => {
    const text = commitEditingQuery(editingElMaybe);
    const requestSerial = ++activeSearchRequestSerial;
    setIsLoadingMore(false);
    if (keepSearchWorkspaceFocus) {
      store.history.setFocus(vePath());
    }
    if (text == "") {
      clearSearchResults();
      return;
    }

    store.perItem.setQueryMode(searchItem().id, "search");
    requestArrange(store, "query-search-start");
    const response = await server.search(null, text, store.general.networkStatus, 1);
    if (requestSerial != activeSearchRequestSerial) {
      return;
    }
    if (response.results.length == 0) {
      clearQuerySearchRuntime(store, searchItem().id);
    }
    store.perItem.setSearchResults(searchItem().id, response.results);
    store.perItem.setSearchHasMoreResults(searchItem().id, response.hasMore);
    store.perItem.setSearchLoadedPageCount(searchItem().id, 1);
    store.perItem.setSearchSelectedResultIndex(searchItem().id, selectFirstResultRow && response.results.length > 0 ? 0 : -1);
    store.perItem.setSearchFocusedResultIndex(searchItem().id, -1);
    requestArrange(store, "search-results");
    void warmSearchResults(response.results);
  };

  const startChat = async (editingElMaybe?: HTMLElement | null) => {
    if (isStartingChat()) {
      return;
    }

    const text = commitEditingQuery(editingElMaybe);
    if (text.trim() == "") {
      requestEditMode(queryText().length, false);
      return;
    }

    setIsStartingChat(true);
    activeSearchRequestSerial++;
    try {
      const queriesPageId = searchItem().parentId;
      removeClientOnlyChatPagesUnderQueries(store, queriesPageId);
      clearQuerySearchRuntime(store, searchItem().id);
      store.perItem.setSearchResults(searchItem().id, null);
      store.perItem.setSearchHasMoreResults(searchItem().id, false);
      store.perItem.setSearchLoadedPageCount(searchItem().id, 0);
      clearSearchResultSelection();
      const chatPage = ensureClientOnlyChatPageUnderQueryItem(store, searchItem());
      store.perItem.setQueryMode(searchItem().id, "chat");
      store.history.setFocus(vePath());
      store.overlay.autoFocusChatInput.set(true);
      arrangeNow(store, "query-start-chat");
      await submitChatMessage(store, chatPage, text);
    } finally {
      setIsStartingChat(false);
    }
  };

  const loadMoreSearchResults = async () => {
    if (isEditing() || isLoadingMore() || !searchHasMoreResults()) {
      return;
    }

    const existingResults = store.perItem.getSearchResults(searchItem().id);
    const requestedQuery = queryText();
    if (!existingResults || requestedQuery == "") {
      return;
    }

    const loadedPageCount = searchLoadedPageCount();
    const nextPage = Math.max(1, loadedPageCount + 1);
    const requestSerial = ++activeSearchRequestSerial;
    setIsLoadingMore(true);
    try {
      const response = await server.search(null, requestedQuery, store.general.networkStatus, nextPage);
      if (requestSerial != activeSearchRequestSerial) {
        return;
      }
      store.perItem.setSearchResults(searchItem().id, [...existingResults, ...response.results]);
      store.perItem.setSearchHasMoreResults(searchItem().id, response.hasMore);
      store.perItem.setSearchLoadedPageCount(searchItem().id, nextPage);
      requestArrange(store, "search-more-results");
      void warmSearchResults(response.results);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const materializeCurrentResults = async (editingElMaybe?: HTMLElement | null) => {
    const title = commitEditingQuery(editingElMaybe);
    const results = store.perItem.getSearchResults(searchItem().id);
    if (!results || results.length == 0) {
      showTransientMessage("no search results to materialize", TransientMessageType.Error);
      return;
    }

    try {
      await materializeSearchResults(store, searchItem(), title);
      showTransientMessage("search results materialized", TransientMessageType.Info);
    } catch (_e) {
      showTransientMessage("failed to materialize search results", TransientMessageType.Error);
    }
  };

  const selectQueryTextElement = (el: HTMLElement) => {
    if (el instanceof HTMLInputElement) {
      if (normalizeSearchText(el.value) == "") {
        return false;
      }
      el.focus();
      el.select();
      return true;
    }
    if (normalizeSearchText(el.innerText) == "") {
      return false;
    }
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    if (selection == null) {
      return false;
    }
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  };
  const selectQueryText = () => {
    const el = document.getElementById(editingDomId());
    if (!(el instanceof HTMLElement)) {
      return false;
    }
    return selectQueryTextElement(el);
  };
  const selectQueryTextAfterFocus = (el: HTMLElement) => {
    const select = () => {
      if (el.isConnected) {
        selectQueryTextElement(el);
      }
    };
    select();
    requestAnimationFrame(select);
    window.setTimeout(select, 0);
  };

  const queryInputMouseDown = (ev: MouseEvent) => {
    if (!canEdit()) {
      ev.preventDefault();
      ev.stopPropagation();
      store.history.setFocus(vePath());
      arrangeNow(store, "search-focus-only");
      return;
    }
    ev.stopPropagation();
    if (ev.detail >= 3) {
      ev.preventDefault();
      if (isEditing()) {
        selectQueryText();
      } else {
        requestEditMode(queryText().length, true);
      }
      return;
    }
    if (!isEditing()) {
      requestEditMode(queryText().length, false, !(ev.target instanceof HTMLInputElement));
    }
  };

  const inputListener = (_ev: InputEvent) => {
    // Commit happens through the shared text-edit exit path in mouse_down.ts.
    // Updating reactive state on every keystroke here causes the contentEditable
    // subtree to rerender while the browser is editing it.
  };

  const keyDownHandler = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "Enter":
        ev.preventDefault();
        ev.stopPropagation();
        void runSearch(true, ev.currentTarget instanceof HTMLElement ? ev.currentTarget : null, true);
        return;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        exitEditMode(ev.currentTarget instanceof HTMLElement ? ev.currentTarget : null);
        return;
    }
  };

  createEffect(() => {
    if (!isListPageMainRoot() || pendingInputFocus() == null || !isEditing()) {
      return;
    }
    const pendingFocus = pendingInputFocus()!;
    const raf = requestAnimationFrame(() => {
      const freshEl = document.getElementById(editingDomId());
      if (freshEl instanceof HTMLInputElement) {
        freshEl.focus();
        if (pendingFocus.selectAll && normalizeSearchText(freshEl.value) != "") {
          selectQueryTextAfterFocus(freshEl);
        } else {
          freshEl.setSelectionRange(pendingFocus.caretIdx, pendingFocus.caretIdx);
        }
      } else if (freshEl instanceof HTMLElement) {
        freshEl.focus();
        if (pendingFocus.selectAll && normalizeSearchText(freshEl.innerText) != "") {
          selectQueryTextAfterFocus(freshEl);
        } else {
          setCaretPosition(freshEl, pendingFocus.caretIdx);
        }
      } else {
        console.warn("Could not enter search edit mode because the text element no longer exists", { itemPath: vePath() });
      }
      setPendingInputFocus(null);
      store.overlay.autoFocusSearchInput.set(false);
    });
    onCleanup(() => cancelAnimationFrame(raf));
  });

  createEffect(() => {
    if (!isListPageMainRoot()) {
      return;
    }
    if (!store.overlay.autoFocusSearchInput.get()) {
      return;
    }
    if (pendingInputFocus() != null) {
      return;
    }
    if (forceNonEditing()) {
      setForceNonEditing(false);
    }
    requestEditMode(queryText().length, true);
  });

  createEffect(() => {
    if (!isListPageMainRoot() || !isSearchMode() || !searchHasMoreResults()) {
      setMoreButtonHost(null);
      return;
    }
    searchArrangeAlgorithm();
    store.perItem.getSearchResults(searchItem().id);
    const raf = requestAnimationFrame(() => {
      const host = document.getElementById(searchResultsFooterHostId(searchItem().id));
      setMoreButtonHost(host instanceof HTMLElement ? host : null);
    });
    onCleanup(() => cancelAnimationFrame(raf));
  });

  const desktopTextStyle = () => getTextStyleForNote(0);
  const desktopSizeBl = () => SearchFns.calcSpatialDimensionsBl(searchItem());
  const desktopNaturalWidthPx = () => Math.max(desktopSizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX * 2, 0);
  const desktopNaturalHeightPx = () => Math.max(desktopSizeBl().h * LINE_HEIGHT_PX, 1);
  const desktopBlockSizePx = () => ({
    w: boundsPx().w / Math.max(desktopSizeBl().w, 1),
    h: boundsPx().h / Math.max(desktopSizeBl().h, 1),
  });
  const desktopTextBlockScale = () =>
    desktopNaturalWidthPx() <= 0 ? 1 : Math.max((boundsPx().w - NOTE_PADDING_PX * 2) / desktopNaturalWidthPx(), 0);
  const desktopLineHeightScale = () => {
    const textScale = desktopTextBlockScale();
    if (textScale <= 0) {
      return 1;
    }
    const heightScale = (boundsPx().h - NOTE_PADDING_PX * 2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / desktopNaturalHeightPx();
    return heightScale / textScale;
  };
  const desktopIconScale = () => Math.max((desktopBlockSizePx().h / LINE_HEIGHT_PX) * 0.94, 0.01);
  const desktopIconTopPx = () => -Math.max(desktopBlockSizePx().h * 0.03, 0.5);
  const desktopTextIndentPx = () => desktopPopupIconTextIndentPx(desktopSizeBl().w);

  const renderSearchWorkspace = () => {
    const controlsWidthPx = calcSearchWorkspaceControlsWidthPx(boundsPx().w);
    const inputWidthPx = calcSearchWorkspaceInputWidthPx(boundsPx().w);
    const lowerTopPx = calcSearchWorkspaceResultsTopPx();
    const arrangeSelectorTopPx = lowerTopPx - Math.round(SEARCH_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX / 2);
    const showMoreButton = () => searchHasMoreResults();
    const initialControlsTopPx = () => {
      const preferredTopPx = Math.round(boundsPx().h * 0.45 - SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX / 2);
      const maxTopPx = Math.max(0, boundsPx().h - SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX - 24);
      return Math.max(0, Math.min(maxTopPx, preferredTopPx));
    };
    const renderQueryControls = () =>
      <div class="flex items-center" style={`gap: ${SEARCH_WORKSPACE_CONTROLS_GAP_PX}px;`}>
        <div
          class="border border-[#999] rounded-xs bg-white overflow-hidden"
          style={`width: ${inputWidthPx}px; height: ${SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
          onMouseDown={queryInputMouseDown}>
          <div class="relative flex items-center h-full overflow-hidden whitespace-nowrap px-2.5"
            style="font-size: 16px;">
            <input id={editingDomId()}
              class="block h-full w-full border-0 bg-transparent p-0 text-black outline-hidden"
              style="font-size: 16px; user-select: text;"
              value={queryText()}
              placeholder="Query..."
              readOnly={!canEdit() || !isEditing()}
              spellcheck={canEdit() && isEditing()}
              onMouseDown={queryInputMouseDown}
              onKeyDown={keyDownHandler}
              onInput={inputListener} />
          </div>
        </div>
        <button
          class="border border-[#999] rounded-xs bg-white text-black cursor-pointer disabled:cursor-default disabled:opacity-40"
          style={`width: ${SEARCH_WORKSPACE_BUTTON_WIDTH_PX}px; height: ${SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
          type="button"
          disabled={isStartingChat()}
          onMouseDown={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void runSearch(false);
          }}
          onMouseUp={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
          }}
          >
          Search
        </button>
        <button
          class="border border-[#999] rounded-xs bg-white text-black cursor-pointer disabled:cursor-default disabled:opacity-40"
          style={`width: ${SEARCH_WORKSPACE_BUTTON_WIDTH_PX}px; height: ${SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
          type="button"
          disabled={!canEdit() || isStartingChat()}
          onMouseDown={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void startChat();
          }}
          onMouseUp={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
          }}
          >
          Chat
        </button>
      </div>;
    return (
      <div class="absolute bg-white"
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
          `${desktopStackRootStyle(props.visualElement)}`}>
        <Show when={props.visualElement.flags & VisualElementFlags.FindHighlighted}>
          <div class="absolute pointer-events-none"
            style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
              `background-color: ${FIND_HIGHLIGHT_COLOR};`} />
        </Show>
        <Show when={!isChatMode()}>
          <div class="absolute bg-white"
            classList={{ "border-b": isSearchMode(), "border-slate-300": isSearchMode() }}
            style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${isSearchMode() ? lowerTopPx : boundsPx().h}px;`}>
            <div class="absolute"
              style={`left: ${Math.max(0, Math.round((boundsPx().w - controlsWidthPx) / 2))}px; ` +
                `top: ${isSearchMode() ? SEARCH_WORKSPACE_TOP_INSET_PX : initialControlsTopPx()}px; width: ${controlsWidthPx}px;`}>
              {renderQueryControls()}
            </div>
          </div>
        </Show>
        <Show when={hasSubmittedQuery()}>
          <VisualElement_DesktopShadowLayer visualElementSignals={VesCache.render.getChildren(vePath())()} />
          <For each={VesCache.render.getChildren(vePath())()}>{childVe =>
            <VisualElement_Desktop visualElement={childVe.get()} suppressLocalShadow={true} />
          }</For>
        </Show>
        <Show when={isSearchMode()}>
          <div class="absolute flex items-center gap-[4px]"
            style={`right: ${SEARCH_WORKSPACE_ARRANGE_SELECTOR_RIGHT_INSET_PX}px; top: ${arrangeSelectorTopPx}px; height: ${SEARCH_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX}px; z-index: ${Z_INDEX_LOCAL_OVERLAY};`}>
            <button
              class="flex items-center justify-center border border-slate-300 rounded-[5px] bg-white text-slate-600 cursor-pointer disabled:cursor-default disabled:opacity-40"
              style={`width: ${SEARCH_WORKSPACE_MATERIALIZE_BUTTON_WIDTH_PX}px; height: ${SEARCH_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX}px; margin-right: 14px; ` +
                `box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);`}
              type="button"
              title="Create page from results"
              aria-label="Create page from results"
              disabled={!hasSearchResults() || isEditing()}
              onMouseDown={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (hasSearchResults() && !isEditing()) {
                  void materializeCurrentResults();
                }
              }}
              onMouseUp={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
              }}>
              <i class="bi-file-earmark-plus" />
            </button>
            <For each={SEARCH_WORKSPACE_ARRANGE_OPTIONS}>{option => {
              const selected = () => searchArrangeAlgorithm() == option.arrangeAlgorithm;
              return (
                <button
                  class="flex items-center justify-center cursor-pointer"
                  style={`width: ${SEARCH_WORKSPACE_ARRANGE_SELECTOR_WIDTH_PX}px; height: ${SEARCH_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX}px; ` +
                    `font-size: 11px; letter-spacing: 0; font-weight: ${selected() ? 700 : 600}; ` +
                    `color: ${selected() ? "rgba(51, 65, 85, 0.92)" : "rgba(100, 116, 139, 0.76)"}; ` +
                    `background: rgba(255, 255, 255, 0.96); ` +
                    `border: 1px solid rgba(203, 213, 225, 0.95); border-radius: 5px; ` +
                    `box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);`}
                  type="button"
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    setSearchArrangeAlgorithm(option.arrangeAlgorithm);
                  }}
                  onMouseUp={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                  }}>
                  {option.label}
                </button>
              );
            }}</For>
          </div>
        </Show>
        <Show when={isSearchMode() && showMoreButton() && moreButtonHost()}>
          <Portal mount={moreButtonHost()!}>
            <button
              class="border border-[#999] rounded-xs bg-white text-black cursor-pointer disabled:cursor-default disabled:opacity-60"
              style={`width: ${SEARCH_WORKSPACE_MORE_BUTTON_WIDTH_PX}px; height: ${SEARCH_WORKSPACE_MORE_BUTTON_HEIGHT_PX}px;`}
              type="button"
              disabled={isEditing() || isLoadingMore()}
              onMouseDown={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                void loadMoreSearchResults();
              }}
              onMouseUp={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
              }}
              >
              {isLoadingMore() ? "Loading..." : "More"}
            </button>
          </Portal>
        </Show>
        <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
          <div class="absolute pointer-events-none rounded-xs"
            style={autoMovedIntoViewWarningStyle(boundsPx().w, boundsPx().h)} />
        </Show>
      </div>
    );
  };

  if (isListPageMainRoot()) {
    return renderSearchWorkspace();
  }

  return (
    <div class="absolute rounded-xs border border-[#999] bg-white text-black overflow-hidden"
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
        `pointer-events: none; ${desktopStackRootStyle(props.visualElement)}`}>
      <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute pointer-events-none"
          style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR};`} />
      </Show>
      <div class="absolute text-center pointer-events-none"
        style={`left: 0px; top: ${desktopIconTopPx()}px; ` +
          `width: ${desktopBlockSizePx().w / desktopIconScale()}px; height: ${desktopBlockSizePx().h / desktopIconScale()}px; ` +
          `transform: scale(${desktopIconScale()}); transform-origin: top left;`}>
        <i class="fas fa-search" />
      </div>
      <span
        class={`absolute block pointer-events-none ${desktopTextStyle().alignClass}`}
        style={`left: ${NOTE_PADDING_PX * desktopTextBlockScale()}px; top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * desktopTextBlockScale()}px; ` +
          `width: ${desktopNaturalWidthPx()}px; ` +
          `line-height: ${LINE_HEIGHT_PX * desktopLineHeightScale() * desktopTextStyle().lineHeightMultiplier}px; ` +
          `transform: scale(${desktopTextBlockScale()}); transform-origin: top left; ` +
          `font-size: ${desktopTextStyle().fontSize}px; ` +
          `overflow-wrap: break-word; white-space: pre-wrap; text-indent: ${desktopTextIndentPx()}px; ` +
          `${desktopTextStyle().isBold ? "font-weight: bold; " : ""}` +
          `outline: 0px solid transparent; ` +
          `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; text-overflow: ellipsis;`}>
        Query
      </span>
      <InfuResizeTriangle />
      <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
        <div class="absolute pointer-events-none rounded-xs"
          style={autoMovedIntoViewWarningStyle(boundsPx().w, boundsPx().h)} />
      </Show>
    </div>
  );
}
