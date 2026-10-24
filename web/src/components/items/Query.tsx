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

import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { arrangeNow, requestArrange } from "../../layout/arrange";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { FIND_HIGHLIGHT_COLOR, LIGHT_BORDER_COLOR, SELECTED_DARK } from "../../style";
import { VisualElementProps } from "../VisualElement";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle, highlightStyle } from "./helper";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { QueryModelPicker } from "./QueryModelPicker";
import { QueryToolsPicker } from "./QueryToolsPicker";
import { QueryScopePicker } from "./QueryScopePicker";
import { QueryProfileBar } from "./QueryProfileBar";
import { initializeQueryConfiguration, queryConfigurationChangeBlockedReason } from "../../items/query-configuration-state";
import { queryConfigurationUnavailableReason } from "../../items/query-configuration-availability";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { setCaretPosition } from "../../util/caret";
import { itemCanEdit, itemCanResize } from "../../items/base/capabilities-item";
import { ItemType } from "../../items/base/item";
import { VisualElement_Desktop } from "../VisualElement";
import { VisualElement_DesktopShadowLayer } from "../VisualElementShadow";
import { VesCache } from "../../layout/ves-cache";
import { FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_LOCAL_OVERLAY } from "../../constants";
import {
  desktopPopupIconTextIndentPx,
  getTextStyleForNote,
} from "../../layout/text";
import { TextFns } from "../../items/text-item";
import { defaultTextIconClass } from "./text-icon";
import {
  QueryFns,
  asQueryItem,
  chatPersistPreview,
  QUERY_WORKSPACE_CONTROLS_GAP_PX,
  QUERY_WORKSPACE_CONTROLS_HEIGHT_PX,
  QUERY_PROFILE_ROW_HEIGHT_PX,
  QUERY_PROFILE_ROW_GAP_PX,
  QUERY_WORKSPACE_SETTINGS_ROW_GAP_PX,
  QUERY_WORKSPACE_SETTINGS_ROW_HEIGHT_PX,
  QUERY_WORKSPACE_MATERIALIZE_BUTTON_WIDTH_PX,
  QUERY_WORKSPACE_MORE_BUTTON_HEIGHT_PX,
  QUERY_WORKSPACE_MORE_BUTTON_WIDTH_PX,
  QUERY_WORKSPACE_SIDE_INSET_PX,
  QUERY_WORKSPACE_TOP_INSET_PX,
  QUERY_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX,
  QUERY_WORKSPACE_ARRANGE_SELECTOR_WIDTH_PX,
  QUERY_WORKSPACE_ARRANGE_SELECTOR_RIGHT_INSET_PX,
  QUERY_CHAT_COMPOSER_BOTTOM_PX,
  QUERY_CHAT_SETTINGS_HEIGHT_PX,
  QUERY_CHAT_TRANSCRIPT_COMPOSER_GAP_PX,
  calcQueryWorkspaceControlsWidthPx,
  calcQueryWorkspaceResultsTopPx,
  getQueryMode,
  getQuerySearchArrangeAlgorithm,
  getQuerySearchHasMoreResults,
  getQuerySearchResults,
  getQueryRuntime,
  getQueryText,
  queryIconClass,
  querySearchResultsFooterHostId,
  setQuerySearchArrangeAlgorithm,
  setQueryChatActivityHeightPx,
  setQueryChatComposerHeightPx,
  setQueryText,
} from "../../items/query-item";
import { materializeSearchResults } from "../../layout/search_materialize";
import { TransientMessageType } from "../../store/StoreProvider_Overlay";
import { ArrangeAlgorithm } from "../../items/page-item";
import {
  clearQuerySearchSelection,
  loadMoreQuerySearchResults,
  clearQuerySearch,
  isQueryChatHistoryEntry,
  runQuerySearch,
  startQueryChat,
} from "../../items/query";
import {
  cancelQueryChatRequest,
  chatStreamingStateForQuery,
  ensureQueryChatLoaded,
  isLiveQueryChat,
  queryChatContextTokenDisplay,
  queryChatHasContent,
  queryChatUsesInfumapData,
  refreshQueryChatRunningElsewhere,
  submitQueryChatMessage,
} from "../../items/chat";
import {
  QUERY_CHAT_ACTIVITY_HEADER_HEIGHT_PX,
  QUERY_CHAT_ACTIVITY_MAX_HEIGHT_PX,
  QUERY_CHAT_ACTIVITY_MIN_HEIGHT_PX,
} from "../../items/query-chat-activity-ui";
import {
  QueryChatActivityRounds,
  formatChatActivityElapsed,
  queryChatActivityIsRunning,
} from "./QueryChatActivity";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import {
  CHAT_ATTACHMENT_FILE_ACCEPT,
  CHAT_ITEM_DROP_ATTRIBUTE,
  ChatDraftAttachment,
  chatAttachmentSizeBytes,
  chatItemDropHover,
  estimateChatAttachmentTokens,
  fileAttachment,
  itemAttachment,
  pastedTextAttachment,
  pastedTextIsAttachment,
  registerChatItemDropTarget,
} from "../../items/chat-attachment";
import { clearExternalUploadHover, dataTransferContainsFiles } from "../../upload";
import { formatBytes } from "../../util/item-metadata";
import type { QueryInputMode } from "../../store/StoreProvider_General";

const normalizeSearchText = (text: string): string =>
  text.replace(/\u200B/g, "").trim();
const QUERY_SEARCH_ARRANGE_OPTIONS = [
  { arrangeAlgorithm: ArrangeAlgorithm.Catalog, label: "catalog" },
  { arrangeAlgorithm: ArrangeAlgorithm.Grid, label: "grid" },
] as const;
/**
 * Deep research is a third entry here rather than a separate toggle: it is a choice about what the
 * send does, which is what this selector already expresses.
 */
const QUERY_INPUT_MODE_OPTIONS = [
  { value: "search", label: "Search", icon: "bi-search" },
  { value: "chat", label: "Chat", icon: "far fa-comments" },
  { value: "deep-research", label: "Deep research", icon: "bi-binoculars" },
] as const;
type QueryInputModeOption = typeof QUERY_INPUT_MODE_OPTIONS[number]["value"];
/** Square buttons whose adjacent borders overlap by 1px. */
const QUERY_WORKSPACE_MODE_SELECTOR_WIDTH_PX =
  QUERY_INPUT_MODE_OPTIONS.length * QUERY_WORKSPACE_CONTROLS_HEIGHT_PX - (QUERY_INPUT_MODE_OPTIONS.length - 1);
const QUERY_WORKSPACE_SEND_BUTTON_WIDTH_PX = 34;
const QUERY_WORKSPACE_DISCARD_BUTTON_WIDTH_PX = QUERY_WORKSPACE_CONTROLS_HEIGHT_PX;
const QUERY_CHAT_MAX_COMPOSER_HEIGHT_PX = 164;
const QUERY_CHAT_ACTIVITY_FOLLOW_THRESHOLD_PX = 24;
const QUERY_CHAT_ACTIVITY_EXPANDED_TOP_INSET_PX = 12;
const QUERY_CHAT_SEND_BUTTON_WIDTH_PX = QUERY_WORKSPACE_CONTROLS_HEIGHT_PX;
const QUERY_DRAFT_ATTACHMENTS_ROW_HEIGHT_PX = 30;
const QUERY_DRAFT_ATTACHMENTS_ROW_GAP_PX = 6;


export const Query_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();
  const [pendingInputFocus, setPendingInputFocus] = createSignal<{ caretIdx: number, selectAll: boolean } | null>(null);
  const [forceNonEditing, setForceNonEditing] = createSignal(false);
  const [isLoadingMore, setIsLoadingMore] = createSignal(false);
  /** The request serial of the search in flight, so only the latest search clears it. */
  const [searchingSerial, setSearchingSerial] = createSignal<number | null>(null);
  const isSearching = () => searchingSerial() != null;
  const [isStartingChat, setIsStartingChat] = createSignal(false);
  const [chatText, setChatText] = createSignal("");
  /** Attachments of the message being written, in the chat composer or in the query input in chat mode. */
  const [draftAttachments, setDraftAttachments] = createSignal<Array<ChatDraftAttachment>>([]);
  const [deepResearch, setDeepResearch] = createSignal(false);
  const [isSendingChat, setIsSendingChat] = createSignal(false);
  const [queryTextareaHeightPx, setQueryTextareaHeightPx] = createSignal(QUERY_WORKSPACE_CONTROLS_HEIGHT_PX);
  const [chatTextareaHeightPx, setChatTextareaHeightPx] = createSignal(QUERY_WORKSPACE_CONTROLS_HEIGHT_PX);
  const [chatActivityNowMs, setChatActivityNowMs] = createSignal(Date.now());
  const [chatActivityFollowingLatest, setChatActivityFollowingLatest] = createSignal(true);
  const [chatActivityExpanded, setChatActivityExpanded] = createSignal(false);
  const [moreButtonHost, setMoreButtonHost] = createSignal<HTMLElement | null>(null);
  let queryInput: HTMLTextAreaElement | undefined;
  const queryModeButtons: Partial<Record<QueryInputModeOption, HTMLButtonElement>> = {};
  let querySendButton: HTMLButtonElement | undefined;
  let queryDiscardButton: HTMLButtonElement | undefined;
  let queryScopeButton: HTMLButtonElement | undefined;
  let queryModelButton: HTMLButtonElement | undefined;
  let queryToolsButton: HTMLButtonElement | undefined;
  let queryProfileBar: HTMLDivElement | undefined;
  let queryAttachButton: HTMLButtonElement | undefined;
  let chatTextarea: HTMLTextAreaElement | undefined;
  let attachFileInput: HTMLInputElement | undefined;
  let chatActivityBody: HTMLDivElement | undefined;
  let activeSearchRequestSerial = 0;
  let chatRequestWasActive = false;
  const boundsPx = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);

  const isListPageMainRoot = () =>
    !!(props.visualElement.flags & VisualElementFlags.ListPageRoot) ||
    props.visualElement.linkItemMaybe?.id == LIST_PAGE_MAIN_ITEM_LINK_ITEM;
  const queryItem = () => asQueryItem(props.visualElement.displayItem);
  const liveChatActivity = () => chatStreamingStateForQuery(queryItem().id);
  const chatStreamingRequestId = createMemo(() => liveChatActivity()?.requestId ?? null);
  const chatContextTokens = () => queryChatContextTokenDisplay(store, queryItem(), chatText(), draftAttachments());
  const draftAttachmentsRowPx = () => draftAttachments().length > 0
    ? QUERY_DRAFT_ATTACHMENTS_ROW_HEIGHT_PX + QUERY_DRAFT_ATTACHMENTS_ROW_GAP_PX
    : 0;
  const chatActivityHeaderVisible = () => liveChatActivity() != null && chatActivityPanelHeightPx() > 0;
  const chatActivityContentRevision = createMemo(() => {
    const live = liveChatActivity();
    if (live == null) {
      return null;
    }
    const roundsRevision = live.rounds.map(round =>
      `${round.number}:${round.reasoning.length}:${round.answer.length}:` +
      round.toolCalls.map(toolCall =>
        `${toolCall.callId}:${toolCall.status}:${toolCall.summary ?? ""}:${toolCall.durationMs ?? ""}:${toolCall.query ?? ""}:${toolCall.url ?? ""}`
      ).join(",")
    ).join("|");
    return `${live.requestId}:${live.phase}:${roundsRevision}:${live.answerPreview.length}`;
  });
  const chatActivityPanelHeightPx = () => {
    if (!isChatMode() || liveChatActivity() == null) {
      return 0;
    }
    const headersPx = QUERY_CHAT_ACTIVITY_HEADER_HEIGHT_PX;
    if (chatActivityExpanded()) {
      const activityBottomPx = QUERY_CHAT_COMPOSER_BOTTOM_PX +
        QUERY_PROFILE_ROW_HEIGHT_PX + QUERY_PROFILE_ROW_GAP_PX +
        QUERY_CHAT_SETTINGS_HEIGHT_PX +
        chatTextareaHeightPx() +
        draftAttachmentsRowPx() +
        QUERY_CHAT_TRANSCRIPT_COMPOSER_GAP_PX / 2;
      return Math.max(
        headersPx,
        boundsPx().h - activityBottomPx - QUERY_CHAT_ACTIVITY_EXPANDED_TOP_INSET_PX,
      );
    }
    const reservedWithoutActivityPx = QUERY_CHAT_COMPOSER_BOTTOM_PX +
      QUERY_PROFILE_ROW_HEIGHT_PX + QUERY_PROFILE_ROW_GAP_PX +
      QUERY_CHAT_SETTINGS_HEIGHT_PX +
      chatTextareaHeightPx() +
      draftAttachmentsRowPx() +
      QUERY_CHAT_TRANSCRIPT_COMPOSER_GAP_PX;
    const availablePx = Math.max(0, boundsPx().h - reservedWithoutActivityPx - 80);
    const preferredPx = Math.max(QUERY_CHAT_ACTIVITY_MIN_HEIGHT_PX, Math.round(boundsPx().h * 0.34));
    return Math.min(
      QUERY_CHAT_ACTIVITY_MAX_HEIGHT_PX,
      Math.max(headersPx, Math.min(preferredPx, availablePx)),
    );
  };
  const chatActivityIsNearBottom = (el: HTMLDivElement): boolean =>
    Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop) <= QUERY_CHAT_ACTIVITY_FOLLOW_THRESHOLD_PX;
  const scrollChatActivityToLatest = () => {
    setChatActivityFollowingLatest(true);
    window.requestAnimationFrame(() => {
      if (chatActivityBody != null) {
        chatActivityBody.scrollTop = chatActivityBody.scrollHeight;
      }
    });
  };
  const chatActivityScrollHandler = () => {
    if (chatActivityBody == null) {
      return;
    }
    setChatActivityFollowingLatest(chatActivityIsNearBottom(chatActivityBody));
  };
  const canEdit = () => itemCanEdit(queryItem());
  const canResize = () => itemCanResize(queryItem());
  const queryText = () => getQueryText(store, queryItem());
  const queryMode = () => getQueryMode(store, queryItem());
  const isSearchMode = () => queryMode() == "search";
  const isChatMode = () => queryMode() == "chat";
  const searchHasMoreResults = () => getQuerySearchHasMoreResults(store, queryItem());
  const hasSubmittedQuery = () => queryMode() != null;
  const hasSearchResults = () => (getQuerySearchResults(store, queryItem())?.length ?? 0) > 0;
  /** An earlier chat in the Queries page can only be continued, not used to search. */
  const isChatHistoryEntry = () => isQueryChatHistoryEntry(store, queryItem());
  const queryProfileBlockedReason = () => queryConfigurationChangeBlockedReason(store, queryItem()) ??
    (isChatHistoryEntry() && getQueryRuntime(store, queryItem()).chat.loadState == "unloaded" ? "Wait for this chat to load before changing settings." : null);
  const queryRequestActive = () => isStartingChat() || isSendingChat() || getQueryRuntime(store, queryItem()).chat.requestId != null ||
    getQueryRuntime(store, queryItem()).chat.runningElsewhere;
  const chatSettingsNote = () => queryChatHasContent(store, queryItem())
    ? "Changes apply from your next message." : null;
  /** Search mode hides the mode selector, so a submit from there always refines the search. */
  const selectedInputMode = (): QueryInputMode =>
    isSearchMode() ? "search" : (isChatHistoryEntry() ? "chat" : store.general.queryInputMode());
  const configurationUnavailableReason = () => getQueryRuntime(store, queryItem()).configurationInitialized
    ? queryConfigurationUnavailableReason(store, getQueryRuntime(store, queryItem()).configuration, selectedInputMode()) : null;
  const sendButtonTitle = () => selectedInputMode() == "chat"
    ? (deepResearch() ? "Start deep research" : "Send chat")
    : "Run search";
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
      if (editingEl instanceof HTMLInputElement || editingEl instanceof HTMLTextAreaElement) {
        editingEl.value = queryText();
      }
    }
    blurEditingDomMaybe(editingEl instanceof HTMLElement ? editingEl : null);
    store.overlay.setTextEditInfo(store.history, null, true);
    arrangeNow(store, "search-exit-edit");
  };
  const readQueryTextFromDom = (elMaybe?: HTMLElement | null) => {
    const el = elMaybe ?? document.getElementById(editingDomId());
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
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
    const unavailable = configurationUnavailableReason();
    if (unavailable != null) { showTransientMessage(unavailable, TransientMessageType.Error); return; }
    const text = commitEditingQuery(editingElMaybe);
    const requestSerial = ++activeSearchRequestSerial;
    setIsLoadingMore(false);
    setSearchingSerial(requestSerial);
    try {
      await runQuerySearch(store, queryItem(), text, {
        selectFirstResultRow,
        keepQueryFocusPath: keepSearchWorkspaceFocus ? vePath() : undefined,
        shouldApply: () => requestSerial == activeSearchRequestSerial,
      });
    } catch (error) {
      if (requestSerial == activeSearchRequestSerial) {
        showTransientMessage(error instanceof Error ? error.message : String(error), TransientMessageType.Error);
      }
    } finally {
      if (searchingSerial() == requestSerial) {
        setSearchingSerial(null);
      }
    }
  };

  const startChat = async (editingElMaybe?: HTMLElement | null) => {
    if (queryRequestActive()) {
      return;
    }
    const unavailable = configurationUnavailableReason();
    if (unavailable != null) { showTransientMessage(unavailable, TransientMessageType.Error); return; }

    const text = commitEditingQuery(editingElMaybe);
    const attachments = draftAttachments();
    if (text.trim() == "" && attachments.length == 0) {
      requestEditMode(queryText().length, false);
      return;
    }

    setIsStartingChat(true);
    activeSearchRequestSerial++;
    setSearchingSerial(null);
    setDraftAttachments([]);
    const useDeepResearch = deepResearch();
    let recorded = false;
    try {
      recorded = await startQueryChat(store, queryItem(), text, vePath(), useDeepResearch, attachments);
      if (!recorded && chatText() == "") {
        setChatText(text);
        resizeChatTextareaSoon();
      }
      if (!recorded && draftAttachments().length == 0) {
        setDraftAttachments(attachments);
      }
    } finally {
      if (recorded) { setDeepResearch(false); }
      setIsStartingChat(false);
    }
  };

  const focusQueryInputControl = () => {
    if (!canEdit()) {
      queryInput?.focus();
      return;
    }
    if (!isEditing()) {
      requestEditMode(queryText().length, false, false);
    }
    requestAnimationFrame(() => {
      const input = queryInput ?? document.getElementById(editingDomId());
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
        return;
      }
      input.focus();
      const caretIdx = input.value.length;
      input.setSelectionRange(caretIdx, caretIdx);
    });
  };

  const focusModeSelector = () => {
    const button = queryModeButtons[selectedInputModeOption()];
    if (!button || button.disabled) {
      focusQueryInputControl();
      return;
    }
    button.focus();
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

  type QueryControlName = "mode" | "attach" | "input" | "send" | "discard" | "scope" | "model" | "tools" | `profile:${number}`;

  const queryProfileButtons = () => Array.from(queryProfileBar?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []).filter(button => button.isConnected);

  const queryControlButton = (control: QueryControlName): HTMLButtonElement | undefined => {
    if (control.startsWith("profile:")) { return queryProfileButtons()[Number(control.slice("profile:".length))]; }
    switch (control) {
      case "mode": return queryModeButtons[selectedInputModeOption()];
      case "attach": return queryAttachButton;
      case "send": return querySendButton;
      case "discard": return queryDiscardButton;
      case "scope": return queryScopeButton;
      case "model": return queryModelButton;
      case "tools": return queryToolsButton;
      default: return undefined;
    }
  };

  const queryControlOrder = (): Array<QueryControlName> => {
    const controls: Array<QueryControlName> = isSearchMode()
      ? ["input", "send"]
      : selectedInputMode() == "chat" ? ["mode", "attach", "input", "send"] : ["mode", "input", "send"];
    controls.unshift(...queryProfileButtons().map((_, index): QueryControlName => `profile:${index}`));
    if (hasSubmittedQuery()) { controls.push("discard"); }
    if (queryScopeButton?.isConnected && !queryScopeButton.disabled) { controls.push("scope"); }
    if (selectedInputMode() == "chat") {
      if (queryModelButton?.isConnected && !queryModelButton.disabled) { controls.push("model"); }
      if (queryToolsButton?.isConnected && !queryToolsButton.disabled) { controls.push("tools"); }
    }
    return controls.filter(control => {
      if (control == "input") { return queryInput?.isConnected && !queryInput.disabled; }
      const button = queryControlButton(control);
      return button?.isConnected && !button.disabled;
    });
  };

  const focusQueryControl = (control: QueryControlName) => {
    if (control.startsWith("profile:")) {
      queryProfileButtons()[Number(control.slice("profile:".length))]?.focus();
    } else if (control == "mode") {
      focusModeSelector();
    } else if (control == "attach") {
      if (queryAttachButton == null || queryAttachButton.disabled) {
        focusQueryInputControl();
      } else {
        queryAttachButton.focus();
      }
    } else if (control == "input") {
      focusQueryInputControl();
    } else if (control == "send") {
      focusSendButton();
    } else if (control == "discard") {
      focusDiscardButton();
    } else {
      const button = control == "scope" ? queryScopeButton : control == "model" ? queryModelButton : queryToolsButton;
      if (button?.isConnected && !button.disabled) { button.focus(); }
      else { focusQueryInputControl(); }
    }
  };

  const focusAdjacentQueryControl = (currentControl: QueryControlName, direction: -1 | 1) => {
    const order = queryControlOrder();
    if (order.length == 0) { return; }
    const currentIndex = Math.max(0, order.indexOf(currentControl));
    const nextIndex = (currentIndex + direction + order.length) % order.length;
    focusQueryControl(order[nextIndex]);
  };

  const handleQueryControlTab = (ev: KeyboardEvent, currentControl: QueryControlName) => {
    ev.preventDefault();
    ev.stopPropagation();
    focusAdjacentQueryControl(currentControl, ev.shiftKey ? -1 : 1);
  };

  const handleQueryProfileTab = (ev: KeyboardEvent) => {
    const index = queryProfileButtons().indexOf(ev.currentTarget as HTMLButtonElement);
    if (index >= 0) { handleQueryControlTab(ev, `profile:${index}`); }
  };

  /** Deep research is chat plus a flag, so the three selector entries map onto two pieces of state. */
  const selectedInputModeOption = (): QueryInputModeOption =>
    selectedInputMode() == "chat" && deepResearch() ? "deep-research" : selectedInputMode();

  const setSelectedInputModeOption = (option: QueryInputModeOption) => {
    const mode: QueryInputMode = option == "search" ? "search" : "chat";
    store.general.setQueryInputMode(mode);
    setDeepResearch(option == "deep-research");
  };

  const submitQueryInput = (editingElMaybe?: HTMLElement | null) => {
    if (selectedInputMode() == "chat") {
      void startChat(editingElMaybe);
      return;
    }
    void runSearch(false, editingElMaybe, false);
  };

  const loadMoreSearchResults = async () => {
    if (isEditing() || isLoadingMore() || isSearching() || !searchHasMoreResults()) {
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
    setSearchingSerial(null);
    setMoreButtonHost(null);
    setChatText("");
    setDraftAttachments([]);
    setDeepResearch(false);
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
    // Keeps the query text, so switching to chat or deep research doesn't mean retyping it.
    clearQuerySearch(store, queryItem(), "query-search-discard");
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

  const resizeQueryTextarea = (elMaybe?: HTMLTextAreaElement) => {
    const el = elMaybe ?? queryInput;
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
    setQueryTextareaHeightPx(nextHeight);
  };

  const resizeChatTextareaSoon = () => {
    window.setTimeout(() => resizeChatTextarea(), 0);
  };

  const focusChatTextareaSoon = () => {
    window.setTimeout(() => chatTextarea?.focus(), 0);
  };

  /** A long paste becomes an attachment of the message, not part of its text. */
  const attachPastedText = (ev: ClipboardEvent) => {
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (!pastedTextIsAttachment(text)) {
      return;
    }
    ev.preventDefault();
    const attachment = pastedTextAttachment(draftAttachments(), text);
    if (typeof attachment == "string") {
      showTransientMessage(attachment, TransientMessageType.Error);
      return;
    }
    setDraftAttachments([...draftAttachments(), attachment]);
  };

  /** Adds text files to the message being written, one at a time, so each is checked against those before it. */
  const attachFiles = async (files: Array<File>) => {
    for (const file of files) {
      const attachment = await fileAttachment(draftAttachments(), file);
      if (typeof attachment == "string") {
        showTransientMessage(attachment, TransientMessageType.Error);
        continue;
      }
      setDraftAttachments([...draftAttachments(), attachment]);
    }
  };

  createEffect(() => {
    // Items dragged onto the composer are attached (`attachDroppedItemToChatMaybe` in mouse_up.ts).
    const unregister = registerChatItemDropTarget(vePath(), (item) => {
      void itemAttachment(draftAttachments(), item).then(attachment => {
        if (typeof attachment == "string") {
          showTransientMessage(attachment, TransientMessageType.Error);
          return;
        }
        setDraftAttachments([...draftAttachments(), attachment]);
      });
    });
    onCleanup(unregister);
  });
  /** An item is being moved over this composer, and dropping it would attach its content. */
  const itemDropHover = () => store.anItemIsMoving.get() && chatItemDropHover() == vePath();

  const openAttachFilePicker = () => {
    attachFileInput?.click();
  };

  /** Files dropped on the message being written are attached to it, not uploaded to the page under it. */
  const dropFilesToAttach = (ev: DragEvent) => {
    if (!dataTransferContainsFiles(ev.dataTransfer)) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    clearExternalUploadHover(store);
    void attachFiles(Array.from(ev.dataTransfer.files));
  };

  const renderAttachFileInput = () =>
    <input ref={attachFileInput} type="file" multiple accept={CHAT_ATTACHMENT_FILE_ACCEPT} class="hidden"
      onChange={(ev) => {
        const files = Array.from(ev.currentTarget.files ?? []);
        ev.currentTarget.value = "";
        void attachFiles(files);
      }} />;

  const removeDraftAttachment = (attachment: ChatDraftAttachment) => {
    setDraftAttachments(draftAttachments().filter(a => a.id != attachment.id));
  };

  /** Puts an attachment's text into the message at the caret, as a plain paste would have, in place of the attachment. */
  const insertDraftAttachmentAsText = (attachment: ChatDraftAttachment) => {
    removeDraftAttachment(attachment);
    if (isChatMode()) {
      if (chatTextarea == null) { return; }
      chatTextarea.focus();
      chatTextarea.setRangeText(attachment.text, chatTextarea.selectionStart, chatTextarea.selectionEnd, "end");
      setChatText(chatTextarea.value);
      resizeChatTextarea(chatTextarea);
      return;
    }
    // The query input's text is read from the DOM while it is edited, and committed when editing ends.
    if (isEditing() && queryInput != null) {
      queryInput.focus();
      queryInput.setRangeText(attachment.text, queryInput.selectionStart, queryInput.selectionEnd, "end");
      resizeQueryTextarea(queryInput);
      return;
    }
    const current = queryText();
    setQueryText(store, queryItem(), current == "" ? attachment.text : current + "\n" + attachment.text);
  };

  const sendChatMessage = async () => {
    const value = chatText();
    const attachments = draftAttachments();
    if (queryRequestActive() || (value.trim() == "" && attachments.length == 0)) {
      focusChatTextareaSoon();
      return;
    }
    const unavailable = configurationUnavailableReason();
    if (unavailable != null) { showTransientMessage(unavailable, TransientMessageType.Error); return; }
    setChatText("");
    setDraftAttachments([]);
    resizeChatTextareaSoon();
    setIsSendingChat(true);
    const useDeepResearch = deepResearch();
    let recorded = false;
    try {
      recorded = await submitQueryChatMessage(store, queryItem(), value, useDeepResearch, attachments);
      if (!recorded && chatText() == "") {
        setChatText(value);
        resizeChatTextareaSoon();
      }
      if (!recorded && draftAttachments().length == 0) {
        setDraftAttachments(attachments);
      }
    } finally {
      if (recorded) { setDeepResearch(false); }
      setIsSendingChat(false);
    }
  };

  const selectQueryTextElement = (el: HTMLElement) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
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
      requestEditMode(queryText().length, false, !(ev.target instanceof HTMLTextAreaElement));
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
        if (ev.shiftKey) {
          return;
        }
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
    initializeQueryConfiguration(store, queryItem());
  });

  createEffect(() => {
    const requestId = chatStreamingRequestId();
    if (requestId == null) {
      return;
    }
    setChatActivityNowMs(Date.now());
    const interval = window.setInterval(() => setChatActivityNowMs(Date.now()), 1000);
    onCleanup(() => window.clearInterval(interval));
  });

  createEffect(() => {
    const liveRequestId = chatStreamingRequestId();
    if (liveRequestId == null) {
      return;
    }
    setChatActivityFollowingLatest(true);
  });

  createEffect(() => {
    const contentRevision = chatActivityContentRevision();
    const followingLatest = chatActivityFollowingLatest();
    if (contentRevision == null || !followingLatest) {
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      if (chatActivityBody != null) {
        chatActivityBody.scrollTop = chatActivityBody.scrollHeight;
      }
    });
    onCleanup(() => window.cancelAnimationFrame(raf));
  });

  createEffect(() => {
    // The transcript ends above the composer: the input and any attachments of the message being written.
    if (!isChatMode()) {
      return;
    }
    const nextHeightPx = chatTextareaHeightPx() + draftAttachmentsRowPx();
    if (getQueryRuntime(store, queryItem()).chat.composerHeightPx == nextHeightPx) {
      return;
    }
    setQueryChatComposerHeightPx(store, queryItem(), nextHeightPx);
    requestArrange(store, "query-chat-composer-resize");
  });

  createEffect(() => {
    const nextHeightPx = chatActivityPanelHeightPx();
    const currentHeightPx = getQueryRuntime(store, queryItem()).chat.activityHeightPx ?? 0;
    if (currentHeightPx == nextHeightPx) {
      return;
    }
    setQueryChatActivityHeightPx(store, queryItem(), nextHeightPx);
    requestArrange(store, "query-chat-activity-resize");
  });

  createEffect(() => {
    // A chat's transcript is on the server; show it when the query item is shown, including after a reload.
    if (isListPageMainRoot() && getQueryRuntime(store, queryItem()).chat.loadState == "unloaded") {
      void ensureQueryChatLoaded(store, queryItem());
    }
  });

  createEffect(() => {
    const item = queryItem();
    const chat = getQueryRuntime(store, item).chat;
    if (!isListPageMainRoot() || !chat.runningElsewhere || chat.requestId != null) { return; }
    let refreshing = false;
    const interval = window.setInterval(() => {
      if (refreshing) { return; }
      refreshing = true;
      void refreshQueryChatRunningElsewhere(store, item).finally(() => { refreshing = false; });
    }, 2000);
    onCleanup(() => window.clearInterval(interval));
  });

  createEffect(() => {
    queryText();
    boundsPx().w;
    const raf = requestAnimationFrame(() => resizeQueryTextarea());
    onCleanup(() => cancelAnimationFrame(raf));
  });

  createEffect(() => {
    if (isListPageMainRoot() && isChatMode() && pendingInputFocus() != null) {
      // A loaded transcript switched the query item to its chat, which has no query input.
      setPendingInputFocus(null);
      return;
    }
    if (!isListPageMainRoot() || pendingInputFocus() == null || !isEditing()) {
      return;
    }
    const pendingFocus = pendingInputFocus()!;
    const raf = requestAnimationFrame(() => {
      const freshEl = document.getElementById(editingDomId());
      if (freshEl instanceof HTMLInputElement || freshEl instanceof HTMLTextAreaElement) {
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
    // A chat has no query input. Leaves the request for the New Query item that has one.
    if (!isListPageMainRoot() || isChatMode()) {
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
  // Drawn as the `.chat` text item it will become while its persist is in flight, so nothing moves when it is replaced.
  const persistPreview = () => chatPersistPreview(queryItem().id);
  const desktopSizeBl = () => {
    const preview = persistPreview();
    return preview != null ? TextFns.calcSpatialDimensionsBl(preview) : QueryFns.calcSpatialDimensionsBl(queryItem());
  };
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

  /** The attachments of the message being written, as chips, each of which can be removed or inserted as text. */
  const renderDraftAttachments = () => {
    const stopMouse = (ev: MouseEvent) => {
      // Keeps the focus, and the caret, in the input.
      ev.preventDefault();
      ev.stopPropagation();
    };
    return (
      <div class="flex items-center overflow-x-auto overflow-y-hidden"
        style={`height: ${QUERY_DRAFT_ATTACHMENTS_ROW_HEIGHT_PX}px; gap: ${QUERY_DRAFT_ATTACHMENTS_ROW_GAP_PX}px;`}
        onMouseDown={stopMouse}
        onMouseUp={stopMouse}
        onClick={(ev) => ev.stopPropagation()}>
        <For each={draftAttachments()}>{attachment => {
          const tokens = estimateChatAttachmentTokens([attachment]).toLocaleString("en-US");
          return (
            <div
              class="flex min-w-0 shrink-0 items-center gap-1.5 rounded-xs border border-[#999] bg-white pl-2 text-black"
              style={`height: ${QUERY_DRAFT_ATTACHMENTS_ROW_HEIGHT_PX}px; max-width: 320px; font-size: 13px; line-height: 20px;`}
              title={attachment.text.slice(0, 400)}>
              <i class="bi-file-earmark-text shrink-0 text-[#555]" />
              <span class="min-w-0 truncate">{attachment.title}</span>
              <span class="shrink-0 tabular-nums text-[#777]" style="font-size: 11px;">
                {formatBytes(chatAttachmentSizeBytes(attachment.text))} · ~{tokens} tokens
              </span>
              <button
                type="button"
                class="flex h-full w-6 shrink-0 cursor-pointer items-center justify-center text-[#555] hover:bg-slate-100 hover:text-black"
                title="Insert as text"
                aria-label={`Insert ${attachment.title} as text`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  insertDraftAttachmentAsText(attachment);
                }}>
                <i class="bi-text-left" />
              </button>
              <button
                type="button"
                class="flex h-full w-6 shrink-0 cursor-pointer items-center justify-center text-[#555] hover:bg-slate-100 hover:text-black"
                title="Remove"
                aria-label={`Remove ${attachment.title}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  removeDraftAttachment(attachment);
                }}>
                <i class="bi-x-lg" />
              </button>
            </div>
          );
        }}</For>
      </div>
    );
  };

  const renderQueryChatSurface = () => {
    const contentWidthPx = () => Math.min(
      Math.max(240, boundsPx().w - QUERY_WORKSPACE_SIDE_INSET_PX * 2),
      960,
    );
    const contentLeftPx = () => Math.max(0, Math.round((boundsPx().w - contentWidthPx()) / 2));
    const wrapperHeightPx = () => QUERY_PROFILE_ROW_HEIGHT_PX + QUERY_PROFILE_ROW_GAP_PX +
      chatTextareaHeightPx() + draftAttachmentsRowPx() + QUERY_CHAT_SETTINGS_HEIGHT_PX;
    const activityBottomPx = () =>
      QUERY_CHAT_COMPOSER_BOTTOM_PX + wrapperHeightPx() + QUERY_CHAT_TRANSCRIPT_COMPOSER_GAP_PX / 2;
    const activityIsRunning = () => {
      const phase = liveChatActivity()?.phase;
      return phase != null && queryChatActivityIsRunning(phase);
    };
    const chatRequestActive = queryRequestActive;
    const chatSettingsDisabled = () => chatRequestActive() || queryProfileBlockedReason() != null;
    const chatRequestCanCancel = () => chatRequestActive() && activityIsRunning();
    const stop = (ev: Event) => {
      if (ev instanceof MouseEvent && ev.button == MOUSE_RIGHT) {
        return;
      }
      // An item moved here ends its move in mouse_up.ts, which attaches it (`attachDroppedItemToChatMaybe`).
      if (ev.type == "mouseup" && store.anItemIsMoving.get()) {
        return;
      }
      ev.stopPropagation();
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
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
        <Show when={liveChatActivity() != null && chatActivityPanelHeightPx() > 0}>
          <div
            class="absolute flex flex-col overflow-hidden rounded-xs border bg-white pointer-events-auto"
            style={`left: ${contentLeftPx()}px; bottom: ${activityBottomPx()}px; ` +
              `width: ${contentWidthPx()}px; height: ${chatActivityPanelHeightPx()}px; z-index: ${Z_INDEX_LOCAL_OVERLAY}; ` +
              `border-color: ${LIGHT_BORDER_COLOR};`}
            role="region"
            aria-label="Assistant activity"
            onMouseDown={stop}
            onMouseUp={stop}
            onClick={stop}
            onKeyDown={stop}
            onKeyUp={stop}>
            <div
              class="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-slate-700"
              style={`background-color: #fafafa; border-color: ${LIGHT_BORDER_COLOR};`}
              aria-live="polite">
              <Show
                when={activityIsRunning()}
                fallback={<i class={liveChatActivity()!.phase == "error" ? "bi-exclamation-circle" : "bi-check-circle"} />}>
                <i class="fa fa-circle-notch fa-spin" />
              </Show>
              <span class="min-w-0 grow truncate text-[13px] font-medium">
                {liveChatActivity()!.statusText}
              </span>
              <Show when={chatContextTokens()}>
                {(display) =>
                  <span
                    class="shrink-0 text-[11px] tabular-nums text-slate-500"
                    title={display().exact
                      ? "Tokens in the last model request"
                      : "Estimated tokens in context"}>
                    {display().label}
                  </span>
                }
              </Show>
              <span class="shrink-0 text-[11px] tabular-nums text-slate-500">
                {formatChatActivityElapsed(liveChatActivity()!.startedAt, chatActivityNowMs())}
              </span>
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-slate-500 hover:bg-slate-200 hover:text-slate-700"
                title={chatActivityExpanded() ? "Restore activity panel" : "Expand activity panel"}
                aria-label={chatActivityExpanded() ? "Restore activity panel" : "Expand activity panel"}
                aria-pressed={chatActivityExpanded()}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setChatActivityExpanded(!chatActivityExpanded());
                }}>
                <i class={chatActivityExpanded() ? "bi-fullscreen-exit" : "bi-arrows-fullscreen"} />
              </button>
            </div>
            <div
              ref={chatActivityBody}
              class="min-h-0 grow overflow-y-auto px-3 py-2 text-[13px] text-slate-700"
              style={`padding-bottom: ${chatActivityFollowingLatest() ? 8 : 44}px;`}
              onScroll={chatActivityScrollHandler}>
              <QueryChatActivityRounds
                rounds={() => liveChatActivity()!.rounds}
                errorMessage={() => liveChatActivity()!.errorMessage}
                running={activityIsRunning}
                requestId={chatStreamingRequestId} />
            </div>
            <Show when={!chatActivityFollowingLatest()}>
              <button
                type="button"
                class="absolute bottom-2 right-3 flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-600 shadow-sm hover:bg-slate-50"
                onClick={(ev) => {
                  ev.stopPropagation();
                  scrollChatActivityToLatest();
                }}>
                <span>Jump to latest</span>
                <i class="bi-arrow-down" />
              </button>
            </Show>
          </div>
        </Show>
        <div
          class="absolute pointer-events-auto"
          style={`left: ${contentLeftPx()}px; bottom: ${QUERY_CHAT_COMPOSER_BOTTOM_PX}px; ` +
            `width: ${contentWidthPx()}px; height: ${wrapperHeightPx()}px; z-index: ${Z_INDEX_LOCAL_OVERLAY};`}
          {...{ [CHAT_ITEM_DROP_ATTRIBUTE]: vePath() }}
          onDrop={dropFilesToAttach}
          onMouseDown={stop}
          onMouseUp={stop}
          onClick={stop}
          onKeyDown={stop}
          onKeyUp={stop}>
          <div style={`height: ${QUERY_PROFILE_ROW_HEIGHT_PX}px; margin-bottom: ${QUERY_PROFILE_ROW_GAP_PX}px;`}>
            <QueryProfileBar queryItem={queryItem} searchMode={() => false} disabled={chatRequestActive}
              blockedReason={queryProfileBlockedReason} />
          </div>
          <Show when={draftAttachments().length > 0}>
            <div style={`margin-bottom: ${QUERY_DRAFT_ATTACHMENTS_ROW_GAP_PX}px;`}>
              {renderDraftAttachments()}
            </div>
          </Show>
          <div class="flex items-end"
            style={`height: ${chatTextareaHeightPx()}px; gap: ${QUERY_WORKSPACE_CONTROLS_GAP_PX}px;`}>
            {renderAttachFileInput()}
            <button
              class="flex shrink-0 cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white text-black disabled:cursor-default disabled:opacity-40"
              style={`width: ${QUERY_CHAT_SEND_BUTTON_WIDTH_PX}px; height: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
              type="button"
              title="Attach text files"
              aria-label="Attach text files"
              disabled={chatRequestActive()}
              onClick={openAttachFilePicker}>
              <i class="bi-plus-lg" />
            </button>
            <div
              class="min-w-0 grow overflow-hidden rounded-xs border bg-white"
              classList={{ "border-[#999]": !itemDropHover(), "border-blue-500": itemDropHover() }}
              style={`height: ${chatTextareaHeightPx()}px;` + (itemDropHover() ? " box-shadow: 0 0 0 2px rgb(59 130 246 / 0.35);" : "")}>
              <textarea
                ref={chatTextarea}
                data-query-chat-composer
                class="block w-full resize-none border-0 bg-transparent px-2.5 py-[9px] text-black outline-hidden"
                style={`height: ${chatTextareaHeightPx()}px; font-size: 16px; line-height: 24px; user-select: text;`}
                value={chatText()}
                rows={1}
                spellcheck={false}
                placeholder="Ask"
                disabled={chatRequestActive()}
                onFocus={(ev) => { ev.currentTarget.spellcheck = true; }}
                onBlur={(ev) => { ev.currentTarget.spellcheck = false; }}
                onInput={(ev) => {
                  const el = ev.currentTarget as HTMLTextAreaElement;
                  setChatText(el.value);
                  resizeChatTextarea(el);
                }}
                onKeyDown={chatKeyDown}
                onPaste={attachPastedText}
                onMouseDown={stop}
                onMouseUp={stop}
                onClick={stop} />
            </div>
            <button
              class="flex shrink-0 cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white text-black disabled:cursor-default disabled:opacity-40"
              style={`width: ${QUERY_CHAT_SEND_BUTTON_WIDTH_PX}px; height: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
              type="button"
              title={chatRequestCanCancel() ? "Stop generating" : configurationUnavailableReason() ?? (deepResearch() ? "Start deep research" : "Send")}
              aria-label={chatRequestCanCancel() ? "Stop generating" : (deepResearch() ? "Start deep research" : "Send")}
              disabled={chatRequestActive()
                ? !chatRequestCanCancel()
                : configurationUnavailableReason() != null || (chatText().trim() == "" && draftAttachments().length == 0)}
              onClick={() => {
                if (chatRequestCanCancel()) {
                  cancelQueryChatRequest(queryItem().id);
                  return;
                }
                void sendChatMessage();
              }}>
              <i class={chatRequestCanCancel() ? "fa fa-stop" : "fa fa-arrow-up"} />
            </button>
          </div>
          <div
            class="flex items-center gap-3 pl-1 text-[#555]"
            style={`height: ${QUERY_CHAT_SETTINGS_HEIGHT_PX}px;`}>
            <Show when={!chatActivityHeaderVisible() && chatContextTokens()}>
              {(display) =>
                <span
                  class="shrink-0 tabular-nums"
                  style="font-size: 12px; line-height: 20px;"
                  title={display().exact
                    ? "Tokens in the last model request"
                    : "Estimated tokens in context"}>
                  {display().label}
                </span>
              }
            </Show>
            <Show when={liveChatActivity() != null && chatActivityPanelHeightPx() == 0}>
              <div class="min-w-0 grow truncate" style="font-size: 12px; line-height: 20px;">
                {liveChatActivity()!.statusText}
              </div>
            </Show>
            <Show when={getQueryRuntime(store, queryItem()).chat.runningElsewhere}>
              <div class="min-w-0 grow truncate" style="font-size: 12px; line-height: 20px;"
                title="A response is running in another window. This chat will refresh when it finishes.">
                Response running in another window…
              </div>
            </Show>
            <div class="ml-auto flex min-w-0 items-center gap-2 pl-2">
              <Show when={isLiveQueryChat(store, queryItem()) && queryChatHasContent(store, queryItem())}>
                {/* Chats in the Queries page are kept in the server's data directory, outside backups. */}
                <span
                  class="flex shrink-0 items-center text-[#999]"
                  style="font-size: 13px; line-height: 20px;"
                  title={"Not backed up. Chats in the Queries page are kept on the server but not in backups. " +
                    "To keep this chat with your items, drag it out of the Queries page."}
                  aria-label="Not backed up">
                  <i class="bi-cloud-slash" />
                </span>
              </Show>
              {/* The same icons as New Query's mode selector, styled like the configuration pills beside it. */}
              <div role="radiogroup" aria-label="Chat mode"
                class="flex h-[22px] shrink-0 overflow-hidden rounded-md border border-[#d6d6d6] bg-white text-[12px]"
                onMouseDown={ev => ev.stopPropagation()} onKeyDown={ev => ev.stopPropagation()}>
                <For each={QUERY_INPUT_MODE_OPTIONS.filter(option => option.value != "search")}>{option => {
                  const selected = () => (option.value == "deep-research") == deepResearch();
                  return <button type="button" role="radio" aria-checked={selected()} aria-label={option.label} title={option.label}
                    class="flex w-[26px] cursor-pointer items-center justify-center text-[#555] hover:bg-slate-50 disabled:cursor-default disabled:opacity-50"
                    classList={{ "bg-slate-200 text-slate-900 hover:bg-slate-200": selected() }}
                    disabled={chatSettingsDisabled()} onClick={() => setDeepResearch(option.value == "deep-research")}>
                    <i class={option.icon} />
                  </button>;
                }}</For>
              </div>
              <QueryScopePicker
                queryItem={queryItem} disabled={chatSettingsDisabled} inUse={() => queryChatUsesInfumapData(store, queryItem())} note={chatSettingsNote} />
              <QueryModelPicker queryItem={queryItem} disabled={chatSettingsDisabled} note={chatSettingsNote} />
              <QueryToolsPicker queryItem={queryItem} locked={chatSettingsDisabled} note={chatSettingsNote}
                lockedReason={queryProfileBlockedReason() ?? "Wait for the current response to finish."} />
            </div>
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
    const showModeSelector = () => !isSearchMode() && !isChatHistoryEntry();
    const inputShellWidthPx = () => Math.max(
      160,
      controlsWidthPx()
        - (showModeSelector() ? QUERY_WORKSPACE_MODE_SELECTOR_WIDTH_PX + QUERY_WORKSPACE_CONTROLS_GAP_PX : 0)
        - (showDiscardButton() ? QUERY_WORKSPACE_DISCARD_BUTTON_WIDTH_PX + QUERY_WORKSPACE_CONTROLS_GAP_PX : 0),
    );
    const lowerTopPx = calcQueryWorkspaceResultsTopPx();
    const arrangeSelectorTopPx = lowerTopPx - Math.round(QUERY_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX / 2);
    const showMoreButton = () => searchHasMoreResults();
    const initialControlsTopPx = () => {
      const aboveInputPx = QUERY_PROFILE_ROW_HEIGHT_PX + QUERY_PROFILE_ROW_GAP_PX +
        (showDraftAttachments() ? draftAttachmentsRowPx() : 0);
      const groupHeightPx = aboveInputPx + queryTextareaHeightPx() +
        QUERY_WORKSPACE_SETTINGS_ROW_GAP_PX + QUERY_WORKSPACE_SETTINGS_ROW_HEIGHT_PX;
      const preferredTopPx = Math.round(boundsPx().h * 0.45 - aboveInputPx - queryTextareaHeightPx() / 2);
      const maxTopPx = Math.max(0, boundsPx().h - groupHeightPx - 24);
      return Math.max(0, Math.min(maxTopPx, preferredTopPx));
    };
    /** Attachments are for a chat; a search ignores them, but they stay for a chat started later. */
    const showDraftAttachments = () => selectedInputMode() == "chat" && draftAttachments().length > 0;
    const renderQueryControls = () => <>
      {/* Search uses only the scope, so search results have no profile row. New Query keeps the row's height while
          Search is selected, so switching modes does not move the input. */}
      <Show when={!isSearchMode()}>
        <div style={`height: ${QUERY_PROFILE_ROW_HEIGHT_PX}px; margin-bottom: ${QUERY_PROFILE_ROW_GAP_PX}px;`}>
          <QueryProfileBar queryItem={queryItem} searchMode={() => selectedInputMode() == "search"} disabled={queryRequestActive}
            blockedReason={queryProfileBlockedReason}
            beforeChange={() => setQueryText(store, queryItem(), readQueryTextFromDom())}
            barRef={el => { queryProfileBar = el; }} onTabKey={handleQueryProfileTab} />
        </div>
      </Show>
      <Show when={showDraftAttachments()}>
        <div
          style={`width: ${inputShellWidthPx()}px; margin-bottom: ${QUERY_DRAFT_ATTACHMENTS_ROW_GAP_PX}px; ` +
            `margin-left: ${showModeSelector() ? QUERY_WORKSPACE_MODE_SELECTOR_WIDTH_PX + QUERY_WORKSPACE_CONTROLS_GAP_PX : 0}px;`}>
          {renderDraftAttachments()}
        </div>
      </Show>
      <div class="flex items-start" style={`gap: ${QUERY_WORKSPACE_CONTROLS_GAP_PX}px;`}>
        <Show when={showModeSelector()}>
          <div
            class="relative flex shrink-0"
            style={`width: ${QUERY_WORKSPACE_MODE_SELECTOR_WIDTH_PX}px; height: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
            role="radiogroup"
            aria-label="Query mode">
            <For each={QUERY_INPUT_MODE_OPTIONS}>{(option, idx) => {
              const selected = () => selectedInputModeOption() == option.value;
              return (
                <button
                  ref={(el) => { queryModeButtons[option.value] = el; }}
                  class="flex shrink-0 cursor-pointer items-center justify-center border border-[#999] outline-hidden focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 disabled:cursor-default disabled:opacity-40"
                  classList={{
                    "-ml-px": idx() > 0,
                    "rounded-l-xs": idx() == 0,
                    "rounded-r-xs": idx() == QUERY_INPUT_MODE_OPTIONS.length - 1,
                  }}
                  style={`width: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX}px; height: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX}px; font-size: 17px; ` +
                    `background-color: ${selected() ? SELECTED_DARK : "white"}; color: black;`}
                  type="button"
                  role="radio"
                  aria-checked={selected()}
                  aria-label={option.label}
                  title={option.label}
                  tabIndex={selected() ? 0 : -1}
                  disabled={queryRequestActive()}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    setSelectedInputModeOption(option.value);
                  }}
                  onMouseUp={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                  }}
                  onClick={(ev) => ev.stopPropagation()}
                  onKeyDown={(ev) => {
                    ev.stopPropagation();
                    if (ev.key == "Tab") {
                      handleQueryControlTab(ev, "mode");
                      return;
                    }
                    if (ev.key == "ArrowLeft" || ev.key == "ArrowRight") {
                      ev.preventDefault();
                      const n = QUERY_INPUT_MODE_OPTIONS.length;
                      const next = QUERY_INPUT_MODE_OPTIONS[(idx() + (ev.key == "ArrowLeft" ? n - 1 : 1)) % n].value;
                      setSelectedInputModeOption(next);
                      queryModeButtons[next]?.focus();
                    }
                  }}>
                  <i class={option.icon} />
                </button>
              );
            }}</For>
            <div
              class="pointer-events-none absolute left-0 w-full text-center text-[#555]"
              style={`top: ${QUERY_WORKSPACE_CONTROLS_HEIGHT_PX + 4}px; font-size: 12px; line-height: 16px;`}>
              {QUERY_INPUT_MODE_OPTIONS.find(o => o.value == selectedInputModeOption())!.label}
            </div>
          </div>
        </Show>
        <div
          class="border rounded-xs bg-white overflow-hidden"
          classList={{ "border-[#999]": !itemDropHover(), "border-blue-500": itemDropHover() }}
          style={`width: ${inputShellWidthPx()}px; height: ${queryTextareaHeightPx()}px;` +
            (itemDropHover() ? " box-shadow: 0 0 0 2px rgb(59 130 246 / 0.35);" : "")}
          onMouseDown={queryInputMouseDown}>
          <div class="relative flex items-end h-full overflow-hidden pr-[4px]"
            classList={{ "pl-2.5": selectedInputMode() != "chat", "pl-[4px]": selectedInputMode() == "chat" }}
            style="font-size: 16px;">
            <Show when={selectedInputMode() == "chat"}>
              {renderAttachFileInput()}
              <button
                ref={queryAttachButton}
                class="mb-[4px] mr-[6px] flex shrink-0 cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white text-black disabled:cursor-default disabled:opacity-40"
                style={`width: ${QUERY_WORKSPACE_SEND_BUTTON_WIDTH_PX}px; height: ${QUERY_WORKSPACE_SEND_BUTTON_WIDTH_PX}px;`}
                type="button"
                title="Attach text files"
                aria-label="Attach text files"
                disabled={queryRequestActive() || !canEdit()}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                }}
                onMouseUp={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                }}
                onClick={(ev) => {
                  ev.stopPropagation();
                  openAttachFilePicker();
                }}
                onKeyDown={(ev) => {
                  ev.stopPropagation();
                  if (ev.key == "Tab") {
                    handleQueryControlTab(ev, "attach");
                  }
                }}>
                <i class="bi-plus-lg" />
              </button>
            </Show>
            <textarea id={editingDomId()}
              ref={queryInput}
              class="block min-w-0 grow resize-none border-0 bg-transparent py-[9px] pl-0 pr-0 text-black outline-hidden"
              style={`height: ${queryTextareaHeightPx()}px; font-size: 16px; line-height: 24px; user-select: text;`}
              value={queryText()}
              rows={1}
              placeholder="Query..."
              readOnly={!canEdit() || !isEditing()}
              spellcheck={canEdit() && isEditing()}
              onMouseDown={queryInputMouseDown}
              onKeyDown={keyDownHandler}
              onPaste={(ev) => {
                if (selectedInputMode() == "chat" && isEditing()) {
                  attachPastedText(ev);
                }
              }}
              onInput={(ev) => {
                inputListener(ev);
                resizeQueryTextarea(ev.currentTarget);
              }} />
            <button
              ref={querySendButton}
              class="mb-[4px] ml-[6px] flex shrink-0 cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white text-black disabled:cursor-default disabled:opacity-40"
              style={`width: ${QUERY_WORKSPACE_SEND_BUTTON_WIDTH_PX}px; height: ${QUERY_WORKSPACE_SEND_BUTTON_WIDTH_PX}px;`}
              type="button"
              title={configurationUnavailableReason() ?? sendButtonTitle()}
              aria-label={sendButtonTitle()}
              disabled={queryRequestActive() || configurationUnavailableReason() != null || (selectedInputMode() == "chat" && !canEdit())}
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
              <i class={isSearching() ? "fa fa-circle-notch fa-spin" : "fa fa-arrow-up"} />
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
            disabled={queryRequestActive()}
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
      {/* Spans the input, not the mode selector (whose caption sits below it) or the discard button, so the
          controls stay put once a search runs. */}
      <div
        class="flex w-full items-center justify-end gap-2 text-[#555]"
        style={`height: ${QUERY_WORKSPACE_SETTINGS_ROW_HEIGHT_PX}px; margin-top: ${QUERY_WORKSPACE_SETTINGS_ROW_GAP_PX}px; ` +
          `padding-left: ${showModeSelector() ? QUERY_WORKSPACE_MODE_SELECTOR_WIDTH_PX + QUERY_WORKSPACE_CONTROLS_GAP_PX : 0}px; ` +
          `padding-right: ${showDiscardButton() ? QUERY_WORKSPACE_DISCARD_BUTTON_WIDTH_PX + QUERY_WORKSPACE_CONTROLS_GAP_PX : 0}px; ` +
          `font-size: 13px; line-height: 20px;`}
        onMouseDown={(ev) => ev.stopPropagation()}
        onMouseUp={(ev) => ev.stopPropagation()}
        onClick={(ev) => ev.stopPropagation()}>
        <QueryScopePicker
          queryItem={queryItem} disabled={queryRequestActive}
          inUse={() => selectedInputMode() == "search" || queryChatUsesInfumapData(store, queryItem())}
          beforeChange={() => setQueryText(store, queryItem(), readQueryTextFromDom())}
          onChange={() => { if (isSearchMode()) { void runSearch(false); } }}
          buttonRef={el => { queryScopeButton = el; }} onTabKey={ev => handleQueryControlTab(ev, "scope")} />
        <Show when={selectedInputMode() == "chat"}>
          <QueryModelPicker queryItem={queryItem} disabled={queryRequestActive}
            beforeChange={() => setQueryText(store, queryItem(), readQueryTextFromDom())}
            buttonRef={el => { queryModelButton = el; }} onTabKey={ev => handleQueryControlTab(ev, "model")} />
          <QueryToolsPicker queryItem={queryItem} locked={queryRequestActive} lockedReason="Wait for the chat to start."
            beforeChange={() => setQueryText(store, queryItem(), readQueryTextFromDom())}
            buttonRef={el => { queryToolsButton = el; }} onTabKey={ev => handleQueryControlTab(ev, "tools")} />
        </Show>
      </div>
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
                `top: ${isSearchMode()
                  ? QUERY_WORKSPACE_TOP_INSET_PX
                  : initialControlsTopPx()}px; ` +
                `width: ${controlsWidthPx()}px;`}
              {...{ [CHAT_ITEM_DROP_ATTRIBUTE]: selectedInputMode() == "chat" ? vePath() : undefined }}
              onDrop={(ev) => {
                if (selectedInputMode() == "chat") {
                  dropFilesToAttach(ev);
                }
              }}>
              {renderQueryControls()}
            </div>
          </div>
        </Show>
        <Show when={isChatMode()}>
          {renderQueryChatSurface()}
        </Show>
        {/* Results stay visible but faded while a new search runs. The delay avoids a flicker for fast searches. */}
        <div style={isSearchMode() && isSearching()
          ? "opacity: 0.4; transition: opacity 150ms ease 150ms;"
          : "transition: opacity 150ms ease;"}>
          <Show when={isSearchMode()}>
            <VisualElement_DesktopShadowLayer visualElementSignals={VesCache.render.getChildren(vePath())()} />
          </Show>
          <Show when={isSearchMode() || isChatMode()}>
            <For each={VesCache.render.getChildren(vePath())()}>{childVe =>
              <VisualElement_Desktop visualElement={childVe.get()} suppressLocalShadow={true} />
            }</For>
          </Show>
        </div>
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
              disabled={!hasSearchResults()}
              onMouseDown={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (hasSearchResults()) {
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
          <div class="absolute pointer-events-none rounded-item"
            style={autoMovedIntoViewWarningStyle(boundsPx().w, boundsPx().h)} />
        </Show>
      </div>
    );
  };

  if (isListPageMainRoot()) {
    return renderSearchWorkspace();
  }

  return (
    <div class="absolute rounded-item border border-item-border bg-white text-black overflow-hidden"
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
        `pointer-events: none; ${desktopStackRootStyle(props.visualElement)}`}>
      <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute pointer-events-none"
          style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `${highlightStyle(props.visualElement.flags)}`} />
      </Show>
      <div class="absolute text-center pointer-events-none"
        style={`left: 0px; top: ${desktopIconTopPx()}px; ` +
          `width: ${desktopBlockSizePx().w / desktopIconScale()}px; height: ${desktopBlockSizePx().h / desktopIconScale()}px; ` +
          `transform: scale(${desktopIconScale()}); transform-origin: top left;`}>
        <i class={persistPreview() != null ? defaultTextIconClass(persistPreview()!) : queryIconClass(queryItem())} />
      </div>
      <span
        class={`absolute block pointer-events-none ${desktopTextStyle().alignClass} ${persistPreview() != null ? "text-purple-800" : ""}`}
        style={`left: ${NOTE_PADDING_PX * desktopTextBlockScale()}px; top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * desktopTextBlockScale()}px; ` +
          `width: ${desktopNaturalWidthPx()}px; ` +
          `line-height: ${LINE_HEIGHT_PX * desktopLineHeightScale() * desktopTextStyle().lineHeightMultiplier}px; ` +
          `transform: scale(${desktopTextBlockScale()}); transform-origin: top left; ` +
          `font-size: ${desktopTextStyle().fontSize}px; ` +
          `overflow-wrap: break-word; white-space: pre-wrap; text-indent: ${desktopTextIndentPx()}px; ` +
          `${desktopTextStyle().isBold ? "font-weight: bold; " : ""}` +
          `outline: 0px solid transparent; ` +
          (persistPreview() != null ? "" :
            `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; text-overflow: ellipsis;`)}>
        {persistPreview()?.title ?? QueryFns.displayTitle(queryItem())}
      </span>
      <Show when={canResize()}>
        <InfuResizeTriangle />
      </Show>
      <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
        <div class="absolute pointer-events-none rounded-item"
          style={autoMovedIntoViewWarningStyle(boundsPx().w, boundsPx().h)} />
      </Show>
    </div>
  );
}
