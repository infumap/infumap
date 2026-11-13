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

import type { SearchResult } from "../server";
import type { QueryMode, QueryRuntime } from "../store/StoreProvider_PerItem";
import type { StoreContextModel } from "../store/StoreProvider";
import type { Uid } from "../util/uid";
import type { BoundingBox } from "../util/geometry";
import { ArrangeAlgorithm, type ArrangeAlgorithm as ArrangeAlgorithmType } from "./page-item";
import type { SearchItem, SearchMeasurable } from "./search-item";
import type { TextItem } from "./text-item";
import { PinnedTo, type ItemTypeMixin } from "./base/item";
import {
  SearchFns,
  asSearchItem,
  calcSearchWorkspaceControlsWidthPx,
  calcSearchWorkspaceInputWidthPx,
  calcSearchWorkspaceMoreButtonTopPx,
  calcSearchWorkspaceResultsBoundsPx,
  calcSearchWorkspaceResultsFooterHeightPx,
  calcSearchWorkspaceResultsTopPx,
  isQuerySearchResultLink,
  isQuerySearchResultsPage,
  isSearch,
  markAsQuerySearchResultLink,
  markAsQuerySearchResultsPage,
  searchResultsFooterHostId,
  SEARCH_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX,
  SEARCH_WORKSPACE_ARRANGE_SELECTOR_RESULTS_GAP_PX,
  SEARCH_WORKSPACE_ARRANGE_SELECTOR_RESULTS_OVERLAP_PX,
  SEARCH_WORKSPACE_ARRANGE_SELECTOR_RIGHT_INSET_PX,
  SEARCH_WORKSPACE_ARRANGE_SELECTOR_WIDTH_PX,
  SEARCH_WORKSPACE_BUTTON_WIDTH_PX,
  SEARCH_WORKSPACE_CONTROLS_GAP_PX,
  SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX,
  SEARCH_WORKSPACE_PROFILE_ROW_HEIGHT_PX,
  SEARCH_WORKSPACE_PROFILE_ROW_GAP_PX,
  SEARCH_WORKSPACE_SETTINGS_ROW_GAP_PX,
  SEARCH_WORKSPACE_SETTINGS_ROW_HEIGHT_PX,
  SEARCH_WORKSPACE_MATERIALIZE_BUTTON_WIDTH_PX,
  SEARCH_WORKSPACE_MORE_BUTTON_HEIGHT_PX,
  SEARCH_WORKSPACE_MORE_BUTTON_WIDTH_PX,
  SEARCH_WORKSPACE_MORE_SECTION_BOTTOM_INSET_PX,
  SEARCH_WORKSPACE_MORE_SECTION_GAP_PX,
  SEARCH_WORKSPACE_RESULTS_TOP_GAP_PX,
  SEARCH_WORKSPACE_SIDE_INSET_PX,
  SEARCH_WORKSPACE_TOP_INSET_PX,
} from "./search-item";

export type QueryItem = SearchItem;
export type QueryMeasurable = SearchMeasurable;

export const QueryFns = {
  ...SearchFns,
  asQueryMeasurable: SearchFns.asSearchMeasurable,
};

/**
 * The `.chat` text item each earlier chat whose persist is in flight is expected to become, by query item id. Until the
 * server replies, the query item is measured and drawn as that item, without hitboxes, so it doesn't change size when
 * the persisted item replaces it.
 */
const chatPersistPreviews = new Map<Uid, TextItem>();

export function chatPersistPreview(queryItemId: Uid): TextItem | null {
  return chatPersistPreviews.get(queryItemId) ?? null;
}

export function setChatPersistPreview(queryItemId: Uid, preview: TextItem | null): void {
  if (preview == null) {
    chatPersistPreviews.delete(queryItemId);
  } else {
    chatPersistPreviews.set(queryItemId, preview);
  }
}

export function queryIconClass(queryItem: QueryItem): string {
  return queryItem.pinnedTo == PinnedTo.Top ? "fas fa-search" : "far fa-comment";
}

export function asQueryItem(item: ItemTypeMixin): QueryItem {
  return asSearchItem(item);
}

export function isQueryItem(item: ItemTypeMixin | null): item is QueryItem {
  return isSearch(item);
}

export const isQuery = isQueryItem;

export {
  isQuerySearchResultLink,
  isQuerySearchResultsPage,
  markAsQuerySearchResultLink,
  markAsQuerySearchResultsPage,
};

export const QUERY_WORKSPACE_TOP_INSET_PX = SEARCH_WORKSPACE_TOP_INSET_PX;
export const QUERY_WORKSPACE_SIDE_INSET_PX = SEARCH_WORKSPACE_SIDE_INSET_PX;
export const QUERY_WORKSPACE_CONTROLS_HEIGHT_PX = SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX;
export const QUERY_PROFILE_ROW_HEIGHT_PX = SEARCH_WORKSPACE_PROFILE_ROW_HEIGHT_PX;
export const QUERY_PROFILE_ROW_GAP_PX = SEARCH_WORKSPACE_PROFILE_ROW_GAP_PX;
export const QUERY_WORKSPACE_SETTINGS_ROW_GAP_PX = SEARCH_WORKSPACE_SETTINGS_ROW_GAP_PX;
export const QUERY_WORKSPACE_SETTINGS_ROW_HEIGHT_PX = SEARCH_WORKSPACE_SETTINGS_ROW_HEIGHT_PX;
export const QUERY_WORKSPACE_RESULTS_TOP_GAP_PX = SEARCH_WORKSPACE_RESULTS_TOP_GAP_PX;
export const QUERY_WORKSPACE_BUTTON_WIDTH_PX = SEARCH_WORKSPACE_BUTTON_WIDTH_PX;
export const QUERY_WORKSPACE_CONTROLS_GAP_PX = SEARCH_WORKSPACE_CONTROLS_GAP_PX;
export const QUERY_WORKSPACE_MORE_BUTTON_WIDTH_PX = SEARCH_WORKSPACE_MORE_BUTTON_WIDTH_PX;
export const QUERY_WORKSPACE_MORE_BUTTON_HEIGHT_PX = SEARCH_WORKSPACE_MORE_BUTTON_HEIGHT_PX;
export const QUERY_WORKSPACE_MORE_SECTION_GAP_PX = SEARCH_WORKSPACE_MORE_SECTION_GAP_PX;
export const QUERY_WORKSPACE_MORE_SECTION_BOTTOM_INSET_PX = SEARCH_WORKSPACE_MORE_SECTION_BOTTOM_INSET_PX;
export const QUERY_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX = SEARCH_WORKSPACE_ARRANGE_SELECTOR_HEIGHT_PX;
export const QUERY_WORKSPACE_MATERIALIZE_BUTTON_WIDTH_PX = SEARCH_WORKSPACE_MATERIALIZE_BUTTON_WIDTH_PX;
export const QUERY_WORKSPACE_ARRANGE_SELECTOR_WIDTH_PX = SEARCH_WORKSPACE_ARRANGE_SELECTOR_WIDTH_PX;
export const QUERY_WORKSPACE_ARRANGE_SELECTOR_RIGHT_INSET_PX = SEARCH_WORKSPACE_ARRANGE_SELECTOR_RIGHT_INSET_PX;
export const QUERY_WORKSPACE_ARRANGE_SELECTOR_RESULTS_OVERLAP_PX = SEARCH_WORKSPACE_ARRANGE_SELECTOR_RESULTS_OVERLAP_PX;
export const QUERY_WORKSPACE_ARRANGE_SELECTOR_RESULTS_GAP_PX = SEARCH_WORKSPACE_ARRANGE_SELECTOR_RESULTS_GAP_PX;
export const QUERY_CHAT_COMPOSER_BOTTOM_PX = 18;
/** Space for the scope, model and tools controls underneath the composer. */
export const QUERY_CHAT_SETTINGS_HEIGHT_PX = 38;
export const QUERY_CHAT_TRANSCRIPT_COMPOSER_GAP_PX = 24;

export const querySearchResultsFooterHostId = searchResultsFooterHostId;
export const calcQueryWorkspaceControlsWidthPx = calcSearchWorkspaceControlsWidthPx;
export const calcQueryWorkspaceInputWidthPx = calcSearchWorkspaceInputWidthPx;
export const calcQueryWorkspaceResultsTopPx = calcSearchWorkspaceResultsTopPx;
export const calcQueryWorkspaceResultsFooterHeightPx = calcSearchWorkspaceResultsFooterHeightPx;
export const calcQueryWorkspaceMoreButtonTopPx = calcSearchWorkspaceMoreButtonTopPx;

export function calcQueryChatTranscriptBoundsPx(
  boundsPx: BoundingBox,
  composerHeightPx: number = QUERY_WORKSPACE_CONTROLS_HEIGHT_PX,
  activityHeightPx: number = 0,
): BoundingBox {
  const reservedBottomPx = QUERY_CHAT_COMPOSER_BOTTOM_PX +
    QUERY_PROFILE_ROW_HEIGHT_PX + QUERY_PROFILE_ROW_GAP_PX +
    QUERY_CHAT_SETTINGS_HEIGHT_PX +
    Math.max(QUERY_WORKSPACE_CONTROLS_HEIGHT_PX, composerHeightPx) +
    Math.max(0, activityHeightPx) +
    QUERY_CHAT_TRANSCRIPT_COMPOSER_GAP_PX;
  return {
    x: 0,
    y: 0,
    w: boundsPx.w,
    h: Math.max(0, boundsPx.h - reservedBottomPx),
  };
}
export const calcQueryWorkspaceResultsBoundsPx = calcSearchWorkspaceResultsBoundsPx;

type QueryItemOrId = QueryItem | Uid;

function queryItemId(queryItemOrId: QueryItemOrId): Uid {
  return typeof queryItemOrId == "string" ? queryItemOrId : queryItemOrId.id;
}

export function getQueryText(store: StoreContextModel, queryItemOrId: QueryItemOrId): string {
  return store.perItem.getSearchQuery(queryItemId(queryItemOrId));
}

export function setQueryText(store: StoreContextModel, queryItemOrId: QueryItemOrId, text: string): void {
  store.perItem.setSearchQuery(queryItemId(queryItemOrId), text);
}

export function getQueryMode(store: StoreContextModel, queryItemOrId: QueryItemOrId): QueryMode {
  return store.perItem.getQueryMode(queryItemId(queryItemOrId));
}

export function setQueryMode(store: StoreContextModel, queryItemOrId: QueryItemOrId, mode: QueryMode): void {
  store.perItem.setQueryMode(queryItemId(queryItemOrId), mode);
}

export function setQueryChatComposerHeightPx(
  store: StoreContextModel,
  queryItemOrId: QueryItemOrId,
  composerHeightPx: number,
): void {
  updateQueryRuntime(store, queryItemOrId, current => ({
    ...current,
    chat: {
      ...current.chat,
      composerHeightPx: Math.max(QUERY_WORKSPACE_CONTROLS_HEIGHT_PX, composerHeightPx),
    },
  }));
}

export function setQueryChatActivityHeightPx(
  store: StoreContextModel,
  queryItemOrId: QueryItemOrId,
  activityHeightPx: number,
): void {
  updateQueryRuntime(store, queryItemOrId, current => ({
    ...current,
    chat: {
      ...current.chat,
      activityHeightPx: Math.max(0, activityHeightPx),
    },
  }));
}

export function getQueryRuntime(store: StoreContextModel, queryItemOrId: QueryItemOrId): QueryRuntime {
  return store.perItem.getQueryRuntime(queryItemId(queryItemOrId));
}

export function updateQueryRuntime(
  store: StoreContextModel,
  queryItemOrId: QueryItemOrId,
  update: (runtime: QueryRuntime) => QueryRuntime,
): QueryRuntime {
  return store.perItem.updateQueryRuntime(queryItemId(queryItemOrId), update);
}

export function getQuerySearchResults(store: StoreContextModel, queryItemOrId: QueryItemOrId): Array<SearchResult> | null {
  return store.perItem.getSearchResults(queryItemId(queryItemOrId));
}

export function setQuerySearchResults(
  store: StoreContextModel,
  queryItemOrId: QueryItemOrId,
  results: Array<SearchResult> | null,
): void {
  store.perItem.setSearchResults(queryItemId(queryItemOrId), results);
}

export function getQuerySearchHasMoreResults(store: StoreContextModel, queryItemOrId: QueryItemOrId): boolean {
  return store.perItem.getSearchHasMoreResults(queryItemId(queryItemOrId));
}

export function setQuerySearchHasMoreResults(store: StoreContextModel, queryItemOrId: QueryItemOrId, hasMore: boolean): void {
  store.perItem.setSearchHasMoreResults(queryItemId(queryItemOrId), hasMore);
}

export function getQuerySearchLoadedPageCount(store: StoreContextModel, queryItemOrId: QueryItemOrId): number {
  return store.perItem.getSearchLoadedPageCount(queryItemId(queryItemOrId));
}

export function setQuerySearchLoadedPageCount(store: StoreContextModel, queryItemOrId: QueryItemOrId, pageCount: number): void {
  store.perItem.setSearchLoadedPageCount(queryItemId(queryItemOrId), pageCount);
}

/**
 * The focused result index while the "More" button below the results has the keyboard focus ring. It is a value of the
 * focused index rather than separate state so that everything that resets the focused index (a new search, a click,
 * keyboard moves) also takes the ring off the button. Negative, so code that clamps the index reads it as "no result".
 */
export const QUERY_SEARCH_MORE_BUTTON_FOCUS_INDEX = -2;

/**
 * The "More" button's own load function, registered by the search workspace that draws it, so the keyboard loads
 * through the same path as a click: that path tracks the loading state the button shows and drops a response that
 * arrives after a new search has started.
 */
const querySearchLoadMoreHandlers = new Map<Uid, () => Promise<boolean>>();

export function registerQuerySearchLoadMoreHandler(queryItemId: Uid, handler: () => Promise<boolean>): () => void {
  querySearchLoadMoreHandlers.set(queryItemId, handler);
  return () => {
    if (querySearchLoadMoreHandlers.get(queryItemId) == handler) {
      querySearchLoadMoreHandlers.delete(queryItemId);
    }
  };
}

/** Resolves true if more results were added; false if nothing loaded (none to load, a load already running, etc.). */
export function requestQuerySearchLoadMore(queryItemId: Uid): Promise<boolean> {
  const handler = querySearchLoadMoreHandlers.get(queryItemId);
  return handler ? handler() : Promise.resolve(false);
}

export function getQuerySearchFocusedResultIndex(store: StoreContextModel, queryItemOrId: QueryItemOrId): number {
  return store.perItem.getSearchFocusedResultIndex(queryItemId(queryItemOrId));
}

export function setQuerySearchFocusedResultIndex(store: StoreContextModel, queryItemOrId: QueryItemOrId, index: number): void {
  store.perItem.setSearchFocusedResultIndex(queryItemId(queryItemOrId), index);
}

const normalizeQuerySearchArrangeAlgorithm = (arrangeAlgorithm: string | null | undefined): ArrangeAlgorithmType =>
  arrangeAlgorithm == ArrangeAlgorithm.Grid ? ArrangeAlgorithm.Grid : ArrangeAlgorithm.Catalog;

export function getQuerySearchArrangeAlgorithm(store: StoreContextModel, queryItemOrId: QueryItemOrId): ArrangeAlgorithmType {
  return normalizeQuerySearchArrangeAlgorithm(
    store.perItem.getSearchArrangeAlgorithm(queryItemId(queryItemOrId)) ??
    store.general.searchResultsArrangeAlgorithm()
  );
}

export function setQuerySearchArrangeAlgorithm(
  store: StoreContextModel,
  queryItemOrId: QueryItemOrId,
  arrangeAlgorithm: ArrangeAlgorithmType,
): void {
  const normalizedArrangeAlgorithm = normalizeQuerySearchArrangeAlgorithm(arrangeAlgorithm);
  store.perItem.setSearchArrangeAlgorithm(queryItemId(queryItemOrId), normalizedArrangeAlgorithm);
  if (store.general.searchResultsArrangeAlgorithm() != normalizedArrangeAlgorithm) {
    store.general.setSearchResultsArrangeAlgorithm(normalizedArrangeAlgorithm);
  }
}
