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
import { VisualElementPath, VeFns } from "../layout/visual-element";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { asContainerItem, isContainer } from "./base/container-item";
import { ensureClientOnlyChatPageUnderQueryItem, removeClientOnlyChatPagesUnderQueries, submitChatMessage } from "./chat";
import { asLinkItem, isLink, LinkFns } from "./link-item";
import { SearchItem } from "./search-item";

export interface QuerySearchRunOptions {
  selectFirstResultRow: boolean,
  keepQueryFocusPath?: VisualElementPath,
  shouldApply?: () => boolean,
}

export interface QuerySearchMoreOptions {
  shouldApply?: () => boolean,
}

export function clearQuerySearchSelection(store: StoreContextModel, queryItem: SearchItem): void {
  store.perItem.setSearchSelectedResultIndex(queryItem.id, -1);
  store.perItem.setSearchFocusedResultIndex(queryItem.id, -1);
}

export function clearQuerySearchRuntime(store: StoreContextModel, queryItemId: string): void {
  const runtime = store.perItem.getQueryRuntime(queryItemId);
  for (const linkId of runtime.search.resultLinkIds) {
    itemState.delete(linkId);
  }
  if (runtime.search.resultsPageId != null) {
    itemState.delete(runtime.search.resultsPageId);
  }
  store.perItem.updateQueryRuntime(queryItemId, current => ({
    ...current,
    search: {
      resultsPageId: null,
      resultLinkIds: [],
    },
  }));
}

export function clearQuerySearch(store: StoreContextModel, queryItem: SearchItem, arrangeReason?: string): void {
  clearQuerySearchRuntime(store, queryItem.id);
  store.perItem.setQueryMode(queryItem.id, null);
  store.perItem.setSearchResults(queryItem.id, null);
  store.perItem.setSearchHasMoreResults(queryItem.id, false);
  store.perItem.setSearchLoadedPageCount(queryItem.id, 0);
  clearQuerySearchSelection(store, queryItem);
  if (arrangeReason != null) {
    requestArrange(store, arrangeReason);
  }
}

export function clearQuerySearchForModeSwitch(store: StoreContextModel, queryItem: SearchItem): void {
  clearQuerySearchRuntime(store, queryItem.id);
  store.perItem.setSearchResults(queryItem.id, null);
  store.perItem.setSearchHasMoreResults(queryItem.id, false);
  store.perItem.setSearchLoadedPageCount(queryItem.id, 0);
  clearQuerySearchSelection(store, queryItem);
}

async function warmResultItemDetails(store: StoreContextModel, resultItemId: string): Promise<void> {
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
}

function warmQuerySearchResults(store: StoreContextModel, result: Array<{ path: Array<{ id: string }> }>): void {
  const resultIds = [...new Set(result
    .map(r => r.path[r.path.length - 1]?.id)
    .filter((id): id is string => !!id))];
  void Promise.all(resultIds.map(id => warmResultItemDetails(store, id)));
}

export async function runQuerySearch(
  store: StoreContextModel,
  queryItem: SearchItem,
  text: string,
  options: QuerySearchRunOptions,
): Promise<boolean> {
  if (options.keepQueryFocusPath != null) {
    store.history.setFocus(options.keepQueryFocusPath);
  }

  if (text == "") {
    clearQuerySearch(store, queryItem, "search-clear-results");
    return true;
  }

  store.perItem.setQueryMode(queryItem.id, "search");
  requestArrange(store, "query-search-start");

  const response = await server.search(null, text, store.general.networkStatus, 1);
  if (options.shouldApply && !options.shouldApply()) {
    return false;
  }

  if (response.results.length == 0) {
    clearQuerySearchRuntime(store, queryItem.id);
  }
  store.perItem.setSearchResults(queryItem.id, response.results);
  store.perItem.setSearchHasMoreResults(queryItem.id, response.hasMore);
  store.perItem.setSearchLoadedPageCount(queryItem.id, 1);
  store.perItem.setSearchSelectedResultIndex(queryItem.id, options.selectFirstResultRow && response.results.length > 0 ? 0 : -1);
  store.perItem.setSearchFocusedResultIndex(queryItem.id, -1);
  requestArrange(store, "search-results");
  warmQuerySearchResults(store, response.results);
  return true;
}

export async function loadMoreQuerySearchResults(
  store: StoreContextModel,
  queryItem: SearchItem,
  options: QuerySearchMoreOptions = {},
): Promise<boolean> {
  const existingResults = store.perItem.getSearchResults(queryItem.id);
  const requestedQuery = store.perItem.getSearchQuery(queryItem.id);
  if (!existingResults || requestedQuery == "") {
    return false;
  }

  const loadedPageCount = store.perItem.getSearchLoadedPageCount(queryItem.id);
  const nextPage = Math.max(1, loadedPageCount + 1);
  const response = await server.search(null, requestedQuery, store.general.networkStatus, nextPage);
  if (options.shouldApply && !options.shouldApply()) {
    return false;
  }

  store.perItem.setSearchResults(queryItem.id, [...existingResults, ...response.results]);
  store.perItem.setSearchHasMoreResults(queryItem.id, response.hasMore);
  store.perItem.setSearchLoadedPageCount(queryItem.id, nextPage);
  requestArrange(store, "search-more-results");
  warmQuerySearchResults(store, response.results);
  return true;
}

export async function startQueryChat(
  store: StoreContextModel,
  queryItem: SearchItem,
  initialText: string,
  queryItemPath: VisualElementPath,
): Promise<void> {
  removeClientOnlyChatPagesUnderQueries(store, queryItem.parentId);
  clearQuerySearchForModeSwitch(store, queryItem);

  const chatPage = ensureClientOnlyChatPageUnderQueryItem(store, queryItem);
  store.perItem.setQueryMode(queryItem.id, "chat");
  store.history.setFocus(queryItemPath);
  store.overlay.autoFocusChatInput.set(true);
  arrangeNow(store, "query-start-chat");
  await submitChatMessage(store, chatPage, initialText);
}
