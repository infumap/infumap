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
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { asContainerItem, isContainer } from "./base/container-item";
import { submitQueryChatMessage } from "./chat";
import { asLinkItem, isLink, LinkFns } from "./link-item";
import {
  QueryItem,
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

export function clearQuerySearchForModeSwitch(store: StoreContextModel, queryItem: QueryItem): void {
  clearQuerySearchRuntime(store, queryItem.id);
  setQuerySearchResults(store, queryItem, null);
  setQuerySearchHasMoreResults(store, queryItem, false);
  setQuerySearchLoadedPageCount(store, queryItem, 0);
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
  queryItem: QueryItem,
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

  setQueryMode(store, queryItem, "search");
  setQuerySearchArrangeAlgorithm(store, queryItem, store.general.searchResultsArrangeAlgorithm());
  requestArrange(store, "query-search-start");

  const response = await server.search(null, text, store.general.networkStatus, 1);
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
  const response = await server.search(null, requestedQuery, store.general.networkStatus, nextPage);
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

export async function startQueryChat(
  store: StoreContextModel,
  queryItem: QueryItem,
  initialText: string,
  queryItemPath: VisualElementPath,
): Promise<void> {
  clearQuerySearchForModeSwitch(store, queryItem);

  setQueryMode(store, queryItem, "chat");
  store.history.setFocus(queryItemPath);
  store.overlay.autoFocusChatInput.set(true);
  arrangeNow(store, "query-start-chat");
  await submitQueryChatMessage(store, queryItem, initialText);
}
