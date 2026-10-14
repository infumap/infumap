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
import { cloneQueryConfiguration } from "./query-configuration";
import { ensureQueryConfigurationReady } from "./query-configuration-state";
import { queryConfigurationUnavailableReason } from "./query-configuration-availability";
import type { ChatDraftAttachment } from "./chat-attachment";
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

  await ensureQueryConfigurationReady(store, queryItem);
  const unavailable = queryConfigurationUnavailableReason(store, getQueryRuntime(store, queryItem).configuration, "search");
  if (unavailable != null) { throw new Error(unavailable); }
  setQueryMode(store, queryItem, "search");
  setQuerySearchArrangeAlgorithm(store, queryItem, store.general.searchResultsArrangeAlgorithm());
  requestArrange(store, "query-search-start");

  const response = await server.search(
    null, text, store.general.networkStatus, 1,
    cloneQueryConfiguration(getQueryRuntime(store, queryItem).configuration),
  );
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

  await ensureQueryConfigurationReady(store, queryItem);
  const unavailable = queryConfigurationUnavailableReason(store, getQueryRuntime(store, queryItem).configuration, "search");
  if (unavailable != null) { throw new Error(unavailable); }
  const loadedPageCount = getQuerySearchLoadedPageCount(store, queryItem);
  const nextPage = Math.max(1, loadedPageCount + 1);
  const response = await server.search(
    null, requestedQuery, store.general.networkStatus, nextPage,
    cloneQueryConfiguration(getQueryRuntime(store, queryItem).configuration),
  );
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
  attachments: Array<ChatDraftAttachment> = [],
): Promise<boolean> {
  clearQueryChat(store, queryItem);
  ensureTemporaryQueryChatPage(store, queryItem);

  setQueryMode(store, queryItem, "chat");
  store.history.setFocus(queryItemPath);
  store.overlay.autoFocusChatInput.set(true);
  arrangeNow(store, "query-start-chat");
  return await submitQueryChatMessage(store, queryItem, initialText, deepResearch, attachments);
}

/**
 * Continues a persisted chat as the newest history entry in the Queries page and opens it there. With `trashOriginal`
 * it is a move back, and the `.chat` item goes to the trash; otherwise a copy, and it stays. New Query remains pinned
 * at the top. Throws with the server's reason.
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
  // A popup may show the moved `.chat` item, and focus may still be on it.
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
  const queriesPage = itemState.get(queryItem.parentId);
  if (itemState.get(queryItem.id) == null && queriesPage != null && isContainer(queriesPage) &&
    asContainerItem(queriesPage).childrenLoaded) {
    itemState.add(queryItem);
  }

  if (store.history.currentPageVeid()?.itemId != user.queriesPageId) {
    await navigateToQueries(store);
  } else {
    await ensureQueryItemUnderQueries(store, user.queriesPageId);
  }
  store.perItem.setSelectedListPageItem(
    { itemId: user.queriesPageId, linkIdMaybe: null },
    { itemId: queryItem.id, linkIdMaybe: null },
  );
  arrangeNow(store, "query-chat-continued");

  if (response.deletedQueryItemId != null && itemState.get(response.deletedQueryItemId) != null) {
    itemState.delete(response.deletedQueryItemId);
  }
  if (trashOriginal && itemState.get(chatItemId) != null) {
    itemState.delete(chatItemId);
  }
  requestArrange(store, "query-chat-continued-cleanup");
}

/** Whether a query item is a chat in the Queries history rather than New Query. */
export function isQueryChatHistoryEntry(store: StoreContextModel, queryItem: QueryItem): boolean {
  return isLiveQueryChat(store, queryItem) && (queryItem.flags & SearchFlags.ListPagePinTop) == 0;
}
