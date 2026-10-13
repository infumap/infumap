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

import { arrangeNow, requestArrange } from "../layout/arrange";
import { initiateLoadChildItemsMaybe, initiateLoadItemMaybe } from "../layout/load";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VisualElementPath, VeFns } from "../layout/visual-element";
import { server, type ContinueChatResponse } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { queryScopeIdForRequest } from "./query-scope";
import { asContainerItem, isContainer } from "./base/container-item";
import type { Uid } from "../util/uid";
import { ensureQueryItemUnderQueries, navigateToQueries } from "../layout/navigation";
import { ItemFns } from "./base/item-polymorphism";
import { SearchFlags } from "./base/flags-item";
import {
  clearQueryChat,
  ensureTemporaryQueryChatPage,
  generateQueryChatTitle,
  isLiveQueryChat,
  resetQueryChatSession,
  submitQueryChatMessage,
} from "./chat";
import {
  QueryItem,
  asQueryItem,
  isQueryItem,
  getQuerySearchLoadedPageCount,
  getQuerySearchResults,
  getQueryRuntime,
  getQueryText,
  setQueryMode,
  setQuerySearchFocusedResultIndex,
  setQuerySearchHasMoreResults,
  setQuerySearchArrangeAlgorithm,
  setQuerySearchLoadedPageCount,
  setQuerySearchResults,
  setQuerySearchSelectedResultIndex,
  setQueryText,
  updateQueryRuntime,
} from "./query-item";

export interface QuerySearchRunOptions {
  selectFirstResultRow: boolean,
  keepQueryFocusPath?: VisualElementPath,
  shouldApply?: () => boolean,
}

export interface QuerySearchMoreOptions {
  shouldApply?: () => boolean,
}

export function clearQuerySearchSelection(store: StoreContextModel, queryItem: QueryItem): void {
  setQuerySearchSelectedResultIndex(store, queryItem, -1);
  setQuerySearchFocusedResultIndex(store, queryItem, -1);
}

export function clearQuerySearchRuntime(store: StoreContextModel, queryItemId: string): void {
  const runtime = getQueryRuntime(store, queryItemId);
  if (runtime.search.resultsPageId != null) {
    itemState.pruneRelationshipSubtreeIfCurrent(
      runtime.search.resultsPageId,
      queryItemId,
      RelationshipToParent.Child,
    );
  }
  updateQueryRuntime(store, queryItemId, current => ({
    ...current,
    search: {
      resultsPageId: null,
      resultLinkIds: [],
    },
  }));
}

export function clearQuerySearch(store: StoreContextModel, queryItem: QueryItem, arrangeReason?: string): void {
  clearQuerySearchRuntime(store, queryItem.id);
  setQueryMode(store, queryItem, null);
  setQuerySearchResults(store, queryItem, null);
  setQuerySearchHasMoreResults(store, queryItem, false);
  setQuerySearchLoadedPageCount(store, queryItem, 0);
  clearQuerySearchSelection(store, queryItem);
  if (arrangeReason != null) {
    requestArrange(store, arrangeReason);
  }
}

export function resetQuerySearchSession(store: StoreContextModel, queryItem: QueryItem, arrangeReason?: string): void {
  clearQuerySearch(store, queryItem);
  setQueryText(store, queryItem, "");
  if (arrangeReason != null) {
    requestArrange(store, arrangeReason);
  }
}

async function warmResultItemDetails(store: StoreContextModel, resultItemId: string): Promise<void> {
  await initiateLoadItemMaybe(store, resultItemId);

  const targetItem = itemState.get(resultItemId);
  if (!targetItem) {
    return;
  }

  if (isContainer(targetItem) && !asContainerItem(targetItem).childrenLoaded) {
    await initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(targetItem, null));
  }
}

function warmQuerySearchResults(store: StoreContextModel, result: Array<{ path: Array<{ id: string }> }>): void {
  const resultIds = [...new Set(result
    .map(r => r.path[r.path.length - 1]?.id)
    .filter((id): id is string => !!id))];
  void Promise.all(resultIds.map(id => warmResultItemDetails(store, id)));
}

export async function runQuerySearch(
  store: StoreContextModel,
  queryItem: QueryItem,
  text: string,
  options: QuerySearchRunOptions,
): Promise<boolean> {
  clearQueryChat(store, queryItem);
  if (options.keepQueryFocusPath != null) {
    store.history.setFocus(options.keepQueryFocusPath);
  }

  if (text == "") {
    clearQuerySearch(store, queryItem, "search-clear-results");
    return true;
  }

  setQueryMode(store, queryItem, "search");
  setQuerySearchArrangeAlgorithm(store, queryItem, store.general.searchResultsArrangeAlgorithm());
  requestArrange(store, "query-search-start");

  const response = await server.search(null, text, store.general.networkStatus, 1, queryScopeIdForRequest(store, queryItem));
  if (options.shouldApply && !options.shouldApply()) {
    return false;
  }

  if (response.results.length == 0) {
    clearQuerySearchRuntime(store, queryItem.id);
  }
  setQuerySearchResults(store, queryItem, response.results);
  setQuerySearchHasMoreResults(store, queryItem, response.hasMore);
  setQuerySearchLoadedPageCount(store, queryItem, 1);
  setQuerySearchSelectedResultIndex(store, queryItem, options.selectFirstResultRow && response.results.length > 0 ? 0 : -1);
  setQuerySearchFocusedResultIndex(store, queryItem, -1);
  requestArrange(store, "search-results");
  warmQuerySearchResults(store, response.results);
  return true;
}

export async function loadMoreQuerySearchResults(
  store: StoreContextModel,
  queryItem: QueryItem,
  options: QuerySearchMoreOptions = {},
): Promise<boolean> {
  const existingResults = getQuerySearchResults(store, queryItem);
  const requestedQuery = getQueryText(store, queryItem);
  if (!existingResults || requestedQuery == "") {
    return false;
  }

  const loadedPageCount = getQuerySearchLoadedPageCount(store, queryItem);
  const nextPage = Math.max(1, loadedPageCount + 1);
  const response = await server.search(
    null, requestedQuery, store.general.networkStatus, nextPage, queryScopeIdForRequest(store, queryItem));
  if (options.shouldApply && !options.shouldApply()) {
    return false;
  }

  setQuerySearchResults(store, queryItem, [...existingResults, ...response.results]);
  setQuerySearchHasMoreResults(store, queryItem, response.hasMore);
  setQuerySearchLoadedPageCount(store, queryItem, nextPage);
  requestArrange(store, "search-more-results");
  warmQuerySearchResults(store, response.results);
  return true;
}

/** Returns false if the message was not recorded, and should be given back to the user as a draft. */
export async function startQueryChat(
  store: StoreContextModel,
  queryItem: QueryItem,
  initialText: string,
  queryItemPath: VisualElementPath,
  deepResearch: boolean = false,
): Promise<boolean> {
  clearQueryChat(store, queryItem);
  ensureTemporaryQueryChatPage(store, queryItem);

  setQueryMode(store, queryItem, "chat");
  store.history.setFocus(queryItemPath);
  store.overlay.autoFocusChatInput.set(true);
  arrangeNow(store, "query-start-chat");
  return await submitQueryChatMessage(store, queryItem, initialText, deepResearch);
}

/**
 * Continues a persisted chat as the current chat in the Queries page, and opens it there. With `trashOriginal` it is a
 * move back, and the `.chat` item goes to the trash; otherwise a copy, and it stays. The previous current chat becomes
 * an earlier chat (and gets a generated title), or is deleted if it was never used. Throws with the server's reason.
 */
export async function continuePersistedChat(store: StoreContextModel, chatItemId: Uid, trashOriginal: boolean): Promise<void> {
  const response = await server.continueChat(chatItemId, trashOriginal);
  // The server has acted, so a local error must not look like a refusal: when moving back by drag, that would roll the
  // move back locally only. Logged instead; syncing corrects the local state.
  try {
    await applyContinuedChat(store, chatItemId, trashOriginal, response);
  } catch (e) {
    console.error("The chat was continued, but showing it failed:", e);
  }
}

async function applyContinuedChat(
  store: StoreContextModel,
  chatItemId: Uid,
  trashOriginal: boolean,
  response: ContinueChatResponse,
): Promise<void> {
  const user = store.user.getUserMaybe();
  if (user == null) { return; }
  // A popup may show the moved `.chat` item, and focus may be on it or on the previous current chat.
  store.history.popAllPopups();
  const pagePath = store.history.currentPagePath();
  if (pagePath != null) {
    store.history.setFocus(pagePath);
  }

  if (response.unpinnedQueryItemId != null) {
    const unpinned = itemState.get(response.unpinnedQueryItemId);
    if (unpinned != null && isQueryItem(unpinned)) {
      asQueryItem(unpinned).flags &= ~SearchFlags.ListPagePinTop;
      unpinned.capabilities = { resize: false };
    }
    void generateQueryChatTitle(store, response.unpinnedQueryItemId);
  }
  const queryItem = ItemFns.fromObject(response.queryItem, null);
  queryItem.capabilities = { move: false, resize: false };
  const queriesPage = itemState.get(queryItem.parentId);
  if (itemState.get(queryItem.id) == null && queriesPage != null && isContainer(queriesPage) &&
    asContainerItem(queriesPage).childrenLoaded) {
    itemState.add(queryItem);
  }

  // Show the continued chat before removing anything locally: until the selection moves to it, the previous current
  // chat may still be shown, and may take focus.
  if (store.history.currentPageVeid()?.itemId == user.queriesPageId) {
    store.perItem.setSelectedListPageItem(
      { itemId: user.queriesPageId, linkIdMaybe: null },
      { itemId: queryItem.id, linkIdMaybe: null },
    );
    arrangeNow(store, "query-chat-continued");
  } else {
    await navigateToQueries(store);
  }

  if (response.deletedQueryItemId != null && itemState.get(response.deletedQueryItemId) != null) {
    itemState.delete(response.deletedQueryItemId);
  }
  if (trashOriginal && itemState.get(chatItemId) != null) {
    itemState.delete(chatItemId);
  }
  requestArrange(store, "query-chat-continued-cleanup");
}

/** Whether a query item is an earlier chat in the Queries page, rather than the current one. */
export function isQueryChatHistoryEntry(store: StoreContextModel, queryItem: QueryItem): boolean {
  return isLiveQueryChat(store, queryItem) && (queryItem.flags & SearchFlags.ListPagePinTop) == 0;
}

/**
 * Starts a new chat. The current chat keeps its transcript and becomes the newest earlier chat in the Queries page,
 * and a new pinned query item becomes the current chat. A chat without a transcript is just reset.
 */
export async function startNewQueryChat(store: StoreContextModel, queryItemMaybeStale: QueryItem): Promise<void> {
  // Syncing replaces item objects, so change the current one, not a reference that may be from before a sync.
  const queryItemMaybe = itemState.get(queryItemMaybeStale.id);
  if (queryItemMaybe == null || !isQueryItem(queryItemMaybe)) {
    return;
  }
  const queryItem = asQueryItem(queryItemMaybe);
  const user = store.user.getUserMaybe();
  const hasTranscript = getQueryRuntime(store, queryItem).chat.revision > 0;
  if (user == null || !isLiveQueryChat(store, queryItem) || (!hasTranscript && !isQueryChatHistoryEntry(store, queryItem))) {
    resetQueryChatSession(store, queryItem, "query-chat-discard");
    return;
  }

  if ((queryItem.flags & SearchFlags.ListPagePinTop) != 0) {
    // Unpinning is a flag change, which the server allows. It is already ordered before every earlier chat, since
    // each pinned query item is created at the start of the page's children.
    queryItem.flags &= ~SearchFlags.ListPagePinTop;
    // The server sends an earlier chat as movable (to the trash or out of the Queries page), and the current one as not.
    // Match it now, rather than when the item is next synced.
    queryItem.capabilities = { resize: false };
    await server.updateItem(queryItem, store.general.networkStatus);
    // After the chat, not alongside a response, so it does not compete with one for a local model.
    void generateQueryChatTitle(store, queryItem.id);
  }
  const queriesPageVeid = { itemId: user.queriesPageId, linkIdMaybe: null };
  const currentId = await ensureQueryItemUnderQueries(store, user.queriesPageId);
  if (currentId != null) {
    store.perItem.setSelectedListPageItem(queriesPageVeid, { itemId: currentId, linkIdMaybe: null });
    store.overlay.autoFocusSearchInput.set(true);
  }
  arrangeNow(store, "query-new-chat");
}
