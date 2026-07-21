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
import { arrangeNow } from "../../layout/arrange";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR } from "../../style";
import { VisualElementProps } from "../VisualElement";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle } from "./helper";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { setCaretPosition } from "../../util/caret";
import { itemCanEdit, itemCanResize } from "../../items/base/capabilities-item";
import { ItemType } from "../../items/base/item";
import { VisualElement_Desktop } from "../VisualElement";
import { VisualElement_DesktopShadowLayer } from "../VisualElementShadow";
import { VesCache } from "../../layout/ves-cache";
import { FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_LOCAL_OVERLAY } from "../../constants";
import { desktopPopupIconTextIndentPx, getTextStyleForNote } from "../../layout/text";
import {
  QueryFns,
  asQueryItem,
  QUERY_WORKSPACE_CONTROLS_GAP_PX,
  QUERY_WORKSPACE_CONTROLS_HEIGHT_PX,
  QUERY_WORKSPACE_MATERIALIZE_BUTTON_WIDTH_PX,
  QUERY_WORKSPACE_MORE_BUTTON_HEIGHT_PX,
  QUERY_WORKSPACE_MORE_BUTTON_WIDTH_PX,
  QUERY_WORKSPACE_SIDE_INSET_PX,
  QUERY_WORKSPACE_TOP_INSET_PX,
  QUERY_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX,
  QUERY_WORKSPACE_ARRANGE_SELECTOR_WIDTH_PX,
  QUERY_WORKSPACE_ARRANGE_SELECTOR_RIGHT_INSET_PX,
  calcQueryWorkspaceControlsWidthPx,
  calcQueryWorkspaceResultsTopPx,
  getQueryMode,
  getQuerySearchArrangeAlgorithm,
  getQuerySearchHasMoreResults,
  getQuerySearchResults,
  getQueryText,
  querySearchResultsFooterHostId,
  setQuerySearchArrangeAlgorithm,
  setQueryText,
} from "../../items/query-item";
import { materializeSearchResults } from "../../layout/search_materialize";
import { itemIdFromInfumapUrl, navigateToInfumapItemUrl } from "../../layout/navigation";
import { TransientMessageType } from "../../store/StoreProvider_Overlay";
import { ArrangeAlgorithm } from "../../items/page-item";
import {
  clearQuerySearchSelection,
  loadMoreQuerySearchResults,
  resetQuerySearchSession,
  runQuerySearch,
  startQueryChat,
} from "../../items/query";
import {
  chatProgressForQuery,
  materializeQueryChat,
  queryChatUsesInfumapData,
  queryChatHasContent,
  queryChatTurns,
  resetQueryChatSession,
  setQueryChatUsesInfumapData,
  submitQueryChatMessage,
} from "../../items/chat";
import { NoteInlineText } from "./NoteInlineText";
import { MOUSE_LEFT, MOUSE_RIGHT, mouseDownHandler } from "../../input/mouse_down";
import { mouseUpHandler } from "../../input/mouse_up";
import { CursorEventState } from "../../input/state";
import type { QueryInputMode } from "../../store/StoreProvider_General";

const normalizeSearchText = (text: string): string =>
  text.replace(/\u200B/g, "").replace(/\n/g, "").trim();
const QUERY_SEARCH_ARRANGE_OPTIONS = [
  { arrangeAlgorithm: ArrangeAlgorithm.Catalog, label: "catalog" },
  { arrangeAlgorithm: ArrangeAlgorithm.Grid, label: "grid" },
] as const;
const QUERY_INPUT_MODE_OPTIONS = [
  { mode: "search", label: "Search" },
  { mode: "chat", label: "Chat" },
] as const;
const QUERY_WORKSPACE_MODE_SELECTOR_WIDTH_PX = 104;
const QUERY_WORKSPACE_SEND_BUTTON_WIDTH_PX = 34;
const QUERY_WORKSPACE_DISCARD_BUTTON_WIDTH_PX = QUERY_WORKSPACE_CONTROLS_HEIGHT_PX;
const QUERY_CHAT_MAX_COMPOSER_HEIGHT_PX = 164;
const QUERY_CHAT_COMPOSER_BOTTOM_PX = 18;
const QUERY_CHAT_SEND_BUTTON_WIDTH_PX = QUERY_WORKSPACE_CONTROLS_HEIGHT_PX;
const QUERY_CHAT_MATERIALIZE_BUTTON_WIDTH_PX = QUERY_WORKSPACE_CONTROLS_HEIGHT_PX;
const QUERY_CHAT_DISCARD_BUTTON_WIDTH_PX = QUERY_WORKSPACE_CONTROLS_HEIGHT_PX;
const QUERY_CHAT_PROGRESS_HEIGHT_PX = 24;
const QUERY_CHAT_SETTINGS_HEIGHT_PX = 28;


export const Query_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();
  const [pendingInputFocus, setPendingInputFocus] = createSignal<{ caretIdx: number, selectAll: boolean } | null>(null);
  const [forceNonEditing, setForceNonEditing] = createSignal(false);
  const [isLoadingMore, setIsLoadingMore] = createSignal(false);
  const [isStartingChat, setIsStartingChat] = createSignal(false);
  const [chatText, setChatText] = createSignal("");
  const [isSendingChat, setIsSendingChat] = createSignal(false);
  const [isMaterializingChat, setIsMaterializingChat] = createSignal(false);
  const [chatTextareaHeightPx, setChatTextareaHeightPx] = createSignal(QUERY_WORKSPACE_CONTROLS_HEIGHT_PX);
  const [moreButtonHost, setMoreButtonHost] = createSignal<HTMLElement | null>(null);
  let queryInput: HTMLInputElement | undefined;
  let queryModeSelect: HTMLSelectElement | undefined;
  let querySendButton: HTMLButtonElement | undefined;
  let queryDiscardButton: HTMLButtonElement | undefined;
  let queryInfumapDataCheckbox: HTMLInputElement | undefined;
  let chatTextarea: HTMLTextAreaElement | undefined;
  let activeSearchRequestSerial = 0;
  let chatRequestWasActive = false;
  const boundsPx = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);

  const isListPageMainRoot = () =>
    !!(props.visualElement.flags & VisualElementFlags.ListPageRoot) ||
    props.visualElement.linkItemMaybe?.id == LIST_PAGE_MAIN_ITEM_LINK_ITEM;
  const queryItem = () => asQueryItem(props.visualElement.displayItem);
  const canEdit = () => itemCanEdit(queryItem());
  const canResize = () => itemCanResize(queryItem());
  const queryText = () => getQueryText(store, queryItem());
  const queryMode = () => getQueryMode(store, queryItem());
  const isSearchMode = () => queryMode() == "search";
  const isChatMode = () => queryMode() == "chat";
  const searchHasMoreResults = () => getQuerySearchHasMoreResults(store, queryItem());
  const hasSubmittedQuery = () => queryMode() != null;
  const hasSearchResults = () => (getQuerySearchResults(store, queryItem())?.length ?? 0) > 0;
  const selectedInputMode = () => store.general.queryInputMode();
  const sendButtonTitle = () => selectedInputMode() == "chat" ? "Send chat" : "Run search";
  const searchArrangeAlgorithm = () =>
    getQuerySearchArrangeAlgorithm(store, queryItem()) == ArrangeAlgorithm.Grid
      ? ArrangeAlgorithm.Grid
      : ArrangeAlgorithm.Catalog;
  const isEditing = () => canEdit() && store.overlay.textEditInfo()?.itemPath == vePath() && !forceNonEditing();
  const editingDomId = () => vePath() + ":title";
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
    setQueryText(store, queryItem(), nextQuery);
    exitEditMode(editingEl instanceof HTMLElement ? editingEl : null);
    return nextQuery;
  };
  const requestEditMode = (caretIdx: number, selectAll: boolean = false, focusInput: boolean = true) => {
    if (!canEdit()) {
      return;
    }
    setForceNonEditing(false);
    setPendingInputFocus(focusInput ? { caretIdx, selectAll } : null);
    clearQuerySearchSelection(store, queryItem());
    if (!isEditing()) {
      store.overlay.setTextEditInfo(store.history, { itemPath: vePath(), itemType: ItemType.Search });
    }
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

  const setQuerySearchArrangeAlgorithmForItem = (arrangeAlgorithm: ArrangeAlgorithm) => {
    const nextArrangeAlgorithm = arrangeAlgorithm == ArrangeAlgorithm.Grid
      ? ArrangeAlgorithm.Grid
      : ArrangeAlgorithm.Catalog;
    if (searchArrangeAlgorithm() == nextArrangeAlgorithm) {
      return;
    }
    setQuerySearchArrangeAlgorithm(store, queryItem(), nextArrangeAlgorithm);
    store.touchToolbar();
    arrangeNow(store, "search-workspace-arrange-algorithm");
  };

  const runSearch = async (
    selectFirstResultRow: boolean,
    editingElMaybe?: HTMLElement | null,
    keepSearchWorkspaceFocus: boolean = false,
  ) => {
    const text = commitEditingQuery(editingElMaybe);
    const requestSerial = ++activeSearchRequestSerial;
    setIsLoadingMore(false);
    await runQuerySearch(store, queryItem(), text, {
      selectFirstResultRow,
      keepQueryFocusPath: keepSearchWorkspaceFocus ? vePath() : undefined,
      shouldApply: () => requestSerial == activeSearchRequestSerial,
    });
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
      await startQueryChat(store, queryItem(), text, vePath());
    } finally {
      setIsStartingChat(false);
    }
  };

  const focusQueryInputControl = () => {
    if (!canEdit()) {
      return;
    }
    if (!isEditing()) {
      requestEditMode(queryText().length, false, false);
    }
    requestAnimationFrame(() => {
      const input = queryInput ?? document.getElementById(editingDomId());
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      input.focus();
      const caretIdx = input.value.length;
      input.setSelectionRange(caretIdx, caretIdx);
    });
  };

  const focusModeSelector = () => {
    if (!queryModeSelect || queryModeSelect.disabled) {
      focusQueryInputControl();
      return;
    }
    queryModeSelect.focus();
  };

  const focusSendButton = () => {
    if (!querySendButton || querySendButton.disabled) {
      focusQueryInputControl();
      return;
    }
    querySendButton.focus();
  };

  const focusDiscardButton = () => {
    if (!queryDiscardButton || queryDiscardButton.disabled) {
      focusQueryInputControl();
      return;
    }
    queryDiscardButton.focus();
  };

  const focusInfumapDataCheckbox = () => {
    if (!queryInfumapDataCheckbox || queryInfumapDataCheckbox.disabled) {
      focusQueryInputControl();
      return;
    }
    queryInfumapDataCheckbox.focus();
  };

  type QueryControlName = "mode" | "input" | "send" | "discard" | "infumap-data";

  const queryControlOrder = (): Array<QueryControlName> => {
    const controls: Array<QueryControlName> = ["mode", "input", "send"];
    if (hasSubmittedQuery()) {
      controls.push("discard");
    }
    if (selectedInputMode() == "chat") {
      controls.push("infumap-data");
    }
    return controls;
  };

  const focusQueryControl = (control: QueryControlName) => {
    if (control == "mode") {
      focusModeSelector();
    } else if (control == "input") {
      focusQueryInputControl();
    } else if (control == "send") {
      focusSendButton();
    } else if (control == "discard") {
      focusDiscardButton();
    } else {
      focusInfumapDataCheckbox();
    }
  };

  const focusAdjacentQueryControl = (currentControl: QueryControlName, direction: -1 | 1) => {
    const order = queryControlOrder();
    const currentIndex = Math.max(0, order.indexOf(currentControl));
    const nextIndex = (currentIndex + direction + order.length) % order.length;
    focusQueryControl(order[nextIndex]);
  };

  const handleQueryControlTab = (ev: KeyboardEvent, currentControl: QueryControlName) => {
    ev.preventDefault();
    ev.stopPropagation();
    focusAdjacentQueryControl(currentControl, ev.shiftKey ? -1 : 1);
  };

  const setSelectedInputMode = (mode: QueryInputMode) => {
    store.general.setQueryInputMode(mode);
  };

  const submitQueryInput = (editingElMaybe?: HTMLElement | null) => {
    const mode = selectedInputMode();
    store.general.setQueryInputMode(mode);
    if (mode == "chat") {
      void startChat(editingElMaybe);
      return;
    }
    void runSearch(false, editingElMaybe, false);
  };

  const loadMoreSearchResults = async () => {
    if (isEditing() || isLoadingMore() || !searchHasMoreResults()) {
      return;
    }

    const requestSerial = ++activeSearchRequestSerial;
    setIsLoadingMore(true);
    try {
      await loadMoreQuerySearchResults(store, queryItem(), {
        shouldApply: () => requestSerial == activeSearchRequestSerial,
      });
    } finally {
      setIsLoadingMore(false);
    }
  };

  const resetLocalQuerySessionUi = () => {
    activeSearchRequestSerial++;
    setIsLoadingMore(false);
    setMoreButtonHost(null);
    setChatText("");
    setChatTextareaHeightPx(QUERY_WORKSPACE_CONTROLS_HEIGHT_PX);
    store.overlay.autoFocusSearchInput.set(false);
    store.overlay.autoFocusChatInput.set(false);
  };

  const focusNewQueryInput = () => {
    setForceNonEditing(false);
    store.history.setFocus(vePath());
    store.overlay.autoFocusSearchInput.set(true);
  };

  const discardCurrentSearch = () => {
    if (isStartingChat()) {
      return;
    }
    exitEditMode();
    resetLocalQuerySessionUi();
    resetQuerySearchSession(store, queryItem(), "query-search-discard");
    focusNewQueryInput();
  };

  const discardCurrentChat = () => {
    if (isStartingChat() || isSendingChat() || isMaterializingChat()) {
      return;
    }
    resetLocalQuerySessionUi();
    resetQueryChatSession(store, queryItem(), "query-chat-discard");
    focusNewQueryInput();
  };

  const materializeCurrentResults = async (editingElMaybe?: HTMLElement | null) => {
    const title = commitEditingQuery(editingElMaybe);
    const results = getQuerySearchResults(store, queryItem());
    if (!results || results.length == 0) {
      showTransientMessage("no search results to materialize", TransientMessageType.Error);
      return;
    }

    try {
      await materializeSearchResults(store, queryItem(), title);
      resetLocalQuerySessionUi();
      setForceNonEditing(false);
      showTransientMessage("search results materialized", TransientMessageType.Info);
    } catch (_e) {
      showTransientMessage("failed to materialize search results", TransientMessageType.Error);
    }
  };

  const resizeChatTextarea = (elMaybe?: HTMLTextAreaElement) => {
    const el = elMaybe ?? chatTextarea;
    if (!el) {
      return;
    }
    el.style.height = "0px";
    const nextHeight = Math.min(
      QUERY_CHAT_MAX_COMPOSER_HEIGHT_PX,
      Math.max(QUERY_WORKSPACE_CONTROLS_HEIGHT_PX, el.scrollHeight),
    );
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > QUERY_CHAT_MAX_COMPOSER_HEIGHT_PX ? "auto" : "hidden";
    setChatTextareaHeightPx(nextHeight);
  };

  const resizeChatTextareaSoon = () => {
    window.setTimeout(() => resizeChatTextarea(), 0);
  };

  const focusChatTextareaSoon = () => {
    window.setTimeout(() => chatTextarea?.focus(), 0);
  };

  const sendChatMessage = async () => {
    const value = chatText();
    if (isStartingChat() || isSendingChat() || value.trim() == "") {
      focusChatTextareaSoon();
      return;
    }
    setChatText("");
    resizeChatTextareaSoon();
    setIsSendingChat(true);
    try {
      await submitQueryChatMessage(store, queryItem(), value);
    } finally {
      setIsSendingChat(false);
    }
  };

  const materializeCurrentChat = async () => {
    if (isMaterializingChat() || !queryChatHasContent(store, queryItem())) {
      return;
    }
    setIsMaterializingChat(true);
    try {
      const ok = await materializeQueryChat(store, queryItem());
      if (ok) {
        resetLocalQuerySessionUi();
        setForceNonEditing(false);
      } else {
        focusChatTextareaSoon();
      }
    } finally {
      setIsMaterializingChat(false);
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
    if (ev.button == MOUSE_RIGHT) {
      return;
    }
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
        submitQueryInput(ev.currentTarget instanceof HTMLElement ? ev.currentTarget : null);
        return;
      case "Tab":
        handleQueryControlTab(ev, "input");
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
    if (!isListPageMainRoot() || !isChatMode() || !store.overlay.autoFocusChatInput.get()) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      chatTextarea?.focus();
      store.overlay.autoFocusChatInput.set(false);
    });
    onCleanup(() => cancelAnimationFrame(raf));
  });

  createEffect(() => {
    const requestActive = isStartingChat() || isSendingChat();
    if (!isListPageMainRoot() || !isChatMode()) {
      chatRequestWasActive = requestActive;
      return;
    }
    if (requestActive) {
      chatRequestWasActive = true;
      return;
    }
    if (!chatRequestWasActive) {
      return;
    }
    chatRequestWasActive = false;
    const raf = requestAnimationFrame(() => chatTextarea?.focus());
    onCleanup(() => cancelAnimationFrame(raf));
  });

  createEffect(() => {
    if (!isListPageMainRoot() || !isSearchMode() || !searchHasMoreResults()) {
      setMoreButtonHost(null);
      return;
    }
    searchArrangeAlgorithm();
    getQuerySearchResults(store, queryItem());
    const raf = requestAnimationFrame(() => {
      const host = document.getElementById(querySearchResultsFooterHostId(queryItem().id));
      setMoreButtonHost(host instanceof HTMLElement ? host : null);
    });
    onCleanup(() => cancelAnimationFrame(raf));
  });

  const desktopTextStyle = () => getTextStyleForNote(0);
  const desktopSizeBl = () => QueryFns.calcSpatialDimensionsBl(queryItem());
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

  const renderQueryChatSurface = () => {
    const contentWidthPx = () => Math.min(
      Math.max(240, boundsPx().w - QUERY_WORKSPACE_SIDE_INSET_PX * 2),
      960,
    );
    const contentLeftPx = () => Math.max(0, Math.round((boundsPx().w - contentWidthPx()) / 2));
    const progress = () => chatProgressForQuery(queryItem().id);
    const wrapperHeightPx = () =>
      chatTextareaHeightPx() + QUERY_CHAT_SETTINGS_HEIGHT_PX +
      (progress() == null ? 0 : QUERY_CHAT_PROGRESS_HEIGHT_PX);
    const transcriptBottomPx = () => wrapperHeightPx() + QUERY_CHAT_COMPOSER_BOTTOM_PX + 24;
    const chatRequestActive = () => isStartingChat() || isSendingChat();
    const chatTurnIsCollapsed = (turnId: string) =>
      store.perItem.getCompositeIsCollapsed({ itemId: turnId, linkIdMaybe: null });
    const toggleChatTurnCollapsed = (turnId: string, ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      store.perItem.setCompositeIsCollapsed(
        { itemId: turnId, linkIdMaybe: null },
        !chatTurnIsCollapsed(turnId),
      );
    };
    const stop = (ev: Event) => {
      if (ev instanceof MouseEvent && ev.button == MOUSE_RIGHT) {
        return;
      }
      ev.stopPropagation();
    };
    const chatSurfaceMouseDown = (ev: MouseEvent) => {
      if (ev.button == MOUSE_RIGHT) {
        chatTextarea?.blur();
      }
    };
    const chatTranscriptMouseDown = (ev: MouseEvent) => {
      if (ev.button == MOUSE_RIGHT) {
        const selection = window.getSelection();
        if (selection != null && !selection.isCollapsed) {
          selection.removeAllRanges();
        }
        return;
      }
      if (ev.button == MOUSE_LEFT) {
        CursorEventState.setFromMouseEvent(ev);
        void mouseDownHandler(store, MOUSE_LEFT);
      }
      ev.stopPropagation();
    };
    const chatTranscriptMouseUp = (ev: MouseEvent) => {
      if (ev.button == MOUSE_RIGHT) {
        return;
      }
      if (ev.button == MOUSE_LEFT) {
        CursorEventState.setFromMouseEvent(ev);
        mouseUpHandler(store);
      }
      ev.stopPropagation();
    };
    const chatLinkMouseDown = (url: string, ev: MouseEvent) => {
      if (ev.button != MOUSE_LEFT) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      if (itemIdFromInfumapUrl(url) != null) {
        void navigateToInfumapItemUrl(store, url);
      } else {
        window.open(url, "_blank");
      }
    };
    const chatKeyDown = (ev: KeyboardEvent) => {
      ev.stopPropagation();
      if (ev.key == "Escape") {
        ev.preventDefault();
        chatTextarea?.blur();
        store.history.setFocus(vePath());
        arrangeNow(store, "query-chat-exit-edit");
        return;
      }
      if (ev.key == "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void sendChatMessage();
      }
    };

    return (
      <div class="absolute bg-white"
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}
        onMouseDown={chatSurfaceMouseDown}>
        <div
          class="absolute overflow-y-auto"
          style={`left: 0px; top: 0px; width: ${boundsPx().w}px; ` +
            `height: ${Math.max(0, boundsPx().h - transcriptBottomPx())}px; ` +
            `cursor: default;`}>
          <div
            class="absolute pointer-events-auto select-text"
            style={`left: ${contentLeftPx()}px; top: 34px; width: ${contentWidthPx()}px; ` +
              `cursor: text; user-select: text; -webkit-user-select: text;`}
            onMouseDown={chatTranscriptMouseDown}
            onMouseMove={stop}
            onMouseUp={chatTranscriptMouseUp}
            onClick={stop}>
            <For each={queryChatTurns(store, queryItem())}>{turn =>
              <div style="margin-bottom: 34px;">
                <div class="flex items-center"
                  style="font-size: 18px; line-height: 24px; font-weight: 700;">
                  <button
                    class="flex shrink-0 cursor-pointer select-none items-center justify-center border-0 bg-transparent p-0 text-slate-400"
                    style="font-size: 13px; width: 18px; height: 24px; margin-right: 6px;"
                    type="button"
                    title={chatTurnIsCollapsed(turn.id) ? "Expand turn" : "Collapse turn"}
                    aria-label={chatTurnIsCollapsed(turn.id) ? "Expand turn" : "Collapse turn"}
                    aria-expanded={!chatTurnIsCollapsed(turn.id)}
                    onClick={(ev) => toggleChatTurnCollapsed(turn.id, ev)}>
                    <i class={`fa ${chatTurnIsCollapsed(turn.id) ? "fa-caret-right" : "fa-caret-down"}`} />
                  </button>
                  <div class="grow border-b border-[#999]">
                    {turn.title || "Assistant"}
                  </div>
                </div>
                <Show when={!chatTurnIsCollapsed(turn.id)}>
                  <div style="font-size: 18px; line-height: 28px; padding-left: 30px; white-space: pre-wrap;">
                    <For each={turn.bodyLines}>{line =>
                      <div>
                        <NoteInlineText
                          text={line.text}
                          inlineMarks={line.inlineMarks}
                          urls={line.urls}
                          linksEnabled
                          onLinkMouseDown={chatLinkMouseDown} />
                      </div>
                    }</For>
                  </div>
                </Show>
              </div>
            }</For>
          </div>
        </div>
        <div
          class="absolute pointer-events-auto"
          style={`left: ${contentLeftPx()}px; bottom: ${QUERY_CHAT_COMPOSER_BOTTOM_PX}px; ` +
            `width: ${contentWidthPx()}px; height: ${wrapperHeightPx()}px;`}
          onMouseDown={stop}
          onMouseUp={stop}
          onClick={stop}
          onKeyDown={stop}
          onKeyUp={stop}>
          <label
            class="flex items-center gap-2 px-1 text-[#555]"
            style={`height: ${QUERY_CHAT_SETTINGS_HEIGHT_PX}px; font-size: 13px; line-height: 20px;`}
            title={queryChatUsesInfumapData(store, queryItem())
              ? "The assistant can search and read this Infumap instance. Start a new chat to change this setting."
              : "The assistant can only use this conversation. Start a new chat to change this setting."}>
            <input
              type="checkbox"
              checked={queryChatUsesInfumapData(store, queryItem())}
              disabled />
            <i class="bi-database" />
            <span>Infumap data {queryChatUsesInfumapData(store, queryItem()) ? "enabled" : "disabled"}</span>
            <i class="bi-lock-fill text-slate-400" style="font-size: 10px;" aria-hidden="true" />
          </label>
          <Show when={progress() != null}>
            <div
              class="truncate px-1 pb-1 text-[#555]"
              style={`height: ${QUERY_CHAT_PROGRESS_HEIGHT_PX}px; font-size: 12px; line-height: 20px;`}>
              {progress()!.text}
            </div>
          </Show>
          <div class="flex items-end"
            style={`height: ${chatTextareaHeightPx()}px; gap: ${QUERY_WORKSPACE_CONTROLS_GAP_PX}px;`}>
            <div
              class="min-w-0 grow overflow-hidden rounded-xs border border-[#999] bg-white"
              style={`height: ${chatTextareaHeightPx()}px;`}>
              <textarea
                ref={chatTextarea}
                class="block w-full resize-none border-0 bg-transparent px-2.5 py-[9px] text-black outline-hidden"
                style={`height: ${chatTextareaHeightPx()}px; font-size: 16px; line-height: 24px; user-select: text;`}
                value={chatText()}
                rows={1}
                spellcheck={true}
                placeholder="Ask"
                disabled={chatRequestActive()}
                onInput={(ev) => {
                  const el = ev.currentTarget as HTMLTextAreaElement;
                  setChatText(el.value);
                  resizeChatTextarea(el);
                }}
                onKeyDown={chatKeyDown}
                onMouseDown={stop}
                onMouseUp={stop}
                onClick={stop} />
            </div>
            <button
              class="flex shrink-0 cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white text-black disabled:cursor-default disabled:opacity-40"
              style={`width: ${QUERY_CHAT_SEND_BUTTON_WIDTH_PX}px; height: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
              type="button"
              title="Send"
              aria-label="Send"
              disabled={chatRequestActive() || chatText().trim() == ""}
              onClick={() => void sendChatMessage()}>
              <i class="fa fa-arrow-up" />
            </button>
            <button
              class="flex shrink-0 cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white text-black disabled:cursor-default disabled:opacity-40"
              style={`width: ${QUERY_CHAT_MATERIALIZE_BUTTON_WIDTH_PX}px; height: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
              type="button"
              title="Create page from chat"
              aria-label="Create page from chat"
              disabled={chatRequestActive() || isMaterializingChat() || !queryChatHasContent(store, queryItem())}
              onClick={() => void materializeCurrentChat()}>
              <i class="bi-file-earmark-plus" />
            </button>
            <button
              class="flex shrink-0 cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white text-black disabled:cursor-default disabled:opacity-40"
              style={`width: ${QUERY_CHAT_DISCARD_BUTTON_WIDTH_PX}px; height: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
              type="button"
              title="Discard chat"
              aria-label="Discard chat"
              disabled={chatRequestActive() || isMaterializingChat()}
              onClick={discardCurrentChat}>
              <i class="bi-x-lg" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderSearchWorkspace = () => {
    const showDiscardButton = () => hasSubmittedQuery();
    const controlsWidthPx = () => {
      if (!showDiscardButton()) {
        return calcQueryWorkspaceControlsWidthPx(boundsPx().w);
      }
      return Math.min(
        760,
        Math.max(360, boundsPx().w - QUERY_WORKSPACE_SIDE_INSET_PX * 2),
      );
    };
    const inputShellWidthPx = () => Math.max(
      160,
      controlsWidthPx()
        - QUERY_WORKSPACE_MODE_SELECTOR_WIDTH_PX
        - (showDiscardButton() ? QUERY_WORKSPACE_DISCARD_BUTTON_WIDTH_PX : 0)
        - QUERY_WORKSPACE_CONTROLS_GAP_PX * (showDiscardButton() ? 2 : 1),
    );
    const lowerTopPx = calcQueryWorkspaceResultsTopPx();
    const arrangeSelectorTopPx = lowerTopPx - Math.round(QUERY_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX / 2);
    const showMoreButton = () => searchHasMoreResults();
    const initialControlsTopPx = () => {
      const preferredTopPx = Math.round(boundsPx().h * 0.45 - QUERY_WORKSPACE_CONTROLS_HEIGHT_PX / 2);
      const maxTopPx = Math.max(0, boundsPx().h - QUERY_WORKSPACE_CONTROLS_HEIGHT_PX - 24);
      return Math.max(0, Math.min(maxTopPx, preferredTopPx));
    };
    const renderQueryControls = () => <>
      <div class="flex items-center" style={`gap: ${QUERY_WORKSPACE_CONTROLS_GAP_PX}px;`}>
        <div
          class="relative shrink-0"
          style={`width: ${QUERY_WORKSPACE_MODE_SELECTOR_WIDTH_PX}px; height: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}>
          <select
            ref={queryModeSelect}
            class="h-full w-full cursor-pointer appearance-none rounded-xs border border-[#999] bg-white pl-2 pr-[30px] text-black outline-hidden focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 disabled:cursor-default disabled:opacity-40"
            style="font-size: 15px;"
            value={selectedInputMode()}
            disabled={isStartingChat()}
            onChange={(ev) => setSelectedInputMode(ev.currentTarget.value == "chat" ? "chat" : "search")}
            onMouseDown={(ev) => ev.stopPropagation()}
            onMouseUp={(ev) => ev.stopPropagation()}
            onClick={(ev) => ev.stopPropagation()}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key == "Tab") {
                handleQueryControlTab(ev, "mode");
              }
            }}
            aria-label="Query mode">
            <For each={QUERY_INPUT_MODE_OPTIONS}>{option =>
              <option value={option.mode}>{option.label}</option>
            }</For>
          </select>
          <i
            class="bi-chevron-down pointer-events-none absolute text-black"
            style="right: 12px; top: 50%; transform: translateY(-50%); font-size: 15px; line-height: 15px;" />
        </div>
        <div
          class="border border-[#999] rounded-xs bg-white overflow-hidden"
          style={`width: ${inputShellWidthPx()}px; height: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
          onMouseDown={queryInputMouseDown}>
          <div class="relative flex items-center h-full overflow-hidden whitespace-nowrap pl-2.5 pr-[4px]"
            style="font-size: 16px;">
            <input id={editingDomId()}
              ref={queryInput}
              class="block h-full min-w-0 grow border-0 bg-transparent p-0 text-black outline-hidden"
              style="font-size: 16px; user-select: text;"
              value={queryText()}
              placeholder="Query..."
              readOnly={!canEdit() || !isEditing()}
              spellcheck={canEdit() && isEditing()}
              onMouseDown={queryInputMouseDown}
              onKeyDown={keyDownHandler}
              onInput={inputListener} />
            <button
              ref={querySendButton}
              class="ml-[6px] flex shrink-0 cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white text-black disabled:cursor-default disabled:opacity-40"
              style={`width: ${QUERY_WORKSPACE_SEND_BUTTON_WIDTH_PX}px; height: ${QUERY_WORKSPACE_SEND_BUTTON_WIDTH_PX}px;`}
              type="button"
              title={sendButtonTitle()}
              aria-label={sendButtonTitle()}
              disabled={isStartingChat() || (selectedInputMode() == "chat" && !canEdit())}
              onMouseDown={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                submitQueryInput();
              }}
              onMouseUp={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
              }}
              onKeyDown={(ev) => {
                ev.stopPropagation();
                if (ev.key == "Tab") {
                  handleQueryControlTab(ev, "send");
                  return;
                }
                if (ev.key == "Enter") {
                  ev.preventDefault();
                  submitQueryInput();
                }
              }}>
              <i class="fa fa-arrow-up" />
            </button>
          </div>
        </div>
        <Show when={showDiscardButton()}>
          <button
            ref={queryDiscardButton}
            class="flex shrink-0 cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white text-black disabled:cursor-default disabled:opacity-40"
            style={`width: ${QUERY_WORKSPACE_DISCARD_BUTTON_WIDTH_PX}px; height: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
            type="button"
            title="Discard search"
            aria-label="Discard search"
            disabled={isStartingChat()}
            onMouseDown={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              discardCurrentSearch();
            }}
            onMouseUp={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
            }}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key == "Tab") {
                handleQueryControlTab(ev, "discard");
                return;
              }
              if (ev.key == "Enter") {
                ev.preventDefault();
                discardCurrentSearch();
              }
            }}>
            <i class="bi-x-lg" />
          </button>
        </Show>
      </div>
      <Show when={selectedInputMode() == "chat"}>
        <label
          class="flex w-fit cursor-pointer items-center gap-2 px-1 text-[#555]"
          style="height: 20px; margin-top: 4px; font-size: 13px; line-height: 20px;"
          title={queryChatUsesInfumapData(store, queryItem())
            ? "The assistant can search and read this Infumap instance."
            : "The assistant can only use this conversation."}
          onMouseDown={(ev) => ev.stopPropagation()}
          onMouseUp={(ev) => ev.stopPropagation()}
          onClick={(ev) => ev.stopPropagation()}>
          <input
            ref={queryInfumapDataCheckbox}
            type="checkbox"
            checked={queryChatUsesInfumapData(store, queryItem())}
            disabled={isStartingChat()}
            onChange={(ev) => {
              const enabled = ev.currentTarget.checked;
              setQueryText(store, queryItem(), readQueryTextFromDom());
              setQueryChatUsesInfumapData(store, queryItem(), enabled);
            }}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key == "Tab") {
                handleQueryControlTab(ev, "infumap-data");
              }
            }} />
          <i class="bi-database" aria-hidden="true" />
          <span>Use Infumap data</span>
        </label>
      </Show>
    </>;
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
              style={`left: ${Math.max(0, Math.round((boundsPx().w - controlsWidthPx()) / 2))}px; ` +
                `top: ${isSearchMode() ? QUERY_WORKSPACE_TOP_INSET_PX : initialControlsTopPx()}px; width: ${controlsWidthPx()}px;`}>
              {renderQueryControls()}
            </div>
          </div>
        </Show>
        <Show when={isChatMode()}>
          {renderQueryChatSurface()}
        </Show>
        <Show when={isSearchMode()}>
          <VisualElement_DesktopShadowLayer visualElementSignals={VesCache.render.getChildren(vePath())()} />
          <For each={VesCache.render.getChildren(vePath())()}>{childVe =>
            <VisualElement_Desktop visualElement={childVe.get()} suppressLocalShadow={true} />
          }</For>
        </Show>
        <Show when={isSearchMode()}>
          <div class="absolute flex items-center gap-[4px]"
            style={`right: ${QUERY_WORKSPACE_ARRANGE_SELECTOR_RIGHT_INSET_PX}px; top: ${arrangeSelectorTopPx}px; height: ${QUERY_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX}px; z-index: ${Z_INDEX_LOCAL_OVERLAY};`}>
            <button
              class="flex items-center justify-center border border-slate-300 rounded-[5px] bg-white text-slate-600 cursor-pointer disabled:cursor-default disabled:opacity-40"
              style={`width: ${QUERY_WORKSPACE_MATERIALIZE_BUTTON_WIDTH_PX}px; height: ${QUERY_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX}px; margin-right: 14px; ` +
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
            <For each={QUERY_SEARCH_ARRANGE_OPTIONS}>{option => {
              const selected = () => searchArrangeAlgorithm() == option.arrangeAlgorithm;
              return (
                <button
                  class="flex items-center justify-center cursor-pointer"
                  style={`width: ${QUERY_WORKSPACE_ARRANGE_SELECTOR_WIDTH_PX}px; height: ${QUERY_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX}px; ` +
                    `font-size: 11px; letter-spacing: 0; font-weight: ${selected() ? 700 : 600}; ` +
                    `color: ${selected() ? "rgba(51, 65, 85, 0.92)" : "rgba(100, 116, 139, 0.76)"}; ` +
                    `background: rgba(255, 255, 255, 0.96); ` +
                    `border: 1px solid rgba(203, 213, 225, 0.95); border-radius: 5px; ` +
                    `box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);`}
                  type="button"
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    setQuerySearchArrangeAlgorithmForItem(option.arrangeAlgorithm);
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
              style={`width: ${QUERY_WORKSPACE_MORE_BUTTON_WIDTH_PX}px; height: ${QUERY_WORKSPACE_MORE_BUTTON_HEIGHT_PX}px;`}
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
      <Show when={canResize()}>
        <InfuResizeTriangle />
      </Show>
      <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
        <div class="absolute pointer-events-none rounded-xs"
          style={autoMovedIntoViewWarningStyle(boundsPx().w, boundsPx().h)} />
      </Show>
    </div>
  );
}
