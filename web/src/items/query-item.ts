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
import type { ArrangeAlgorithm } from "./page-item";
import type { SearchItem, SearchMeasurable } from "./search-item";
import type { ItemTypeMixin } from "./base/item";
import {
  SearchFns,
  asSearchItem,
  calcSearchWorkspaceControlsWidthPx,
  calcSearchWorkspaceInputWidthPx,
  calcSearchWorkspaceMoreButtonTopPx,
  calcSearchWorkspaceResultsBoundsPx,
  calcSearchWorkspaceResultsFooterHeightPx,
  calcSearchWorkspaceResultsTopPx,
  isQueryChatPage,
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

export function asQueryItem(item: ItemTypeMixin): QueryItem {
  return asSearchItem(item);
}

export function isQueryItem(item: ItemTypeMixin | null): item is QueryItem {
  return isSearch(item);
}

export const isQuery = isQueryItem;

export {
  isQueryChatPage,
  isQuerySearchResultLink,
  isQuerySearchResultsPage,
  markAsQuerySearchResultLink,
  markAsQuerySearchResultsPage,
};

export const QUERY_WORKSPACE_TOP_INSET_PX = SEARCH_WORKSPACE_TOP_INSET_PX;
export const QUERY_WORKSPACE_SIDE_INSET_PX = SEARCH_WORKSPACE_SIDE_INSET_PX;
export const QUERY_WORKSPACE_CONTROLS_HEIGHT_PX = SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX;
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

export const querySearchResultsFooterHostId = searchResultsFooterHostId;
export const calcQueryWorkspaceControlsWidthPx = calcSearchWorkspaceControlsWidthPx;
export const calcQueryWorkspaceInputWidthPx = calcSearchWorkspaceInputWidthPx;
export const calcQueryWorkspaceResultsTopPx = calcSearchWorkspaceResultsTopPx;
export const calcQueryWorkspaceResultsFooterHeightPx = calcSearchWorkspaceResultsFooterHeightPx;
export const calcQueryWorkspaceMoreButtonTopPx = calcSearchWorkspaceMoreButtonTopPx;
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

export function getQuerySearchSelectedResultIndex(store: StoreContextModel, queryItemOrId: QueryItemOrId): number {
  return store.perItem.getSearchSelectedResultIndex(queryItemId(queryItemOrId));
}

export function setQuerySearchSelectedResultIndex(store: StoreContextModel, queryItemOrId: QueryItemOrId, index: number): void {
  store.perItem.setSearchSelectedResultIndex(queryItemId(queryItemOrId), index);
}

export function getQuerySearchFocusedResultIndex(store: StoreContextModel, queryItemOrId: QueryItemOrId): number {
  return store.perItem.getSearchFocusedResultIndex(queryItemId(queryItemOrId));
}

export function setQuerySearchFocusedResultIndex(store: StoreContextModel, queryItemOrId: QueryItemOrId, index: number): void {
  store.perItem.setSearchFocusedResultIndex(queryItemId(queryItemOrId), index);
}

export function getQuerySearchArrangeAlgorithm(store: StoreContextModel, queryItemOrId: QueryItemOrId): ArrangeAlgorithm {
  return store.perItem.getSearchArrangeAlgorithm(queryItemId(queryItemOrId));
}

export function setQuerySearchArrangeAlgorithm(
  store: StoreContextModel,
  queryItemOrId: QueryItemOrId,
  arrangeAlgorithm: ArrangeAlgorithm,
): void {
  store.perItem.setSearchArrangeAlgorithm(queryItemId(queryItemOrId), arrangeAlgorithm);
}
