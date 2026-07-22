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

import { EMPTY_VEID, Veid } from "../layout/visual-element";
import { BooleanSignal, InfuSignal, NumberSignal, createBooleanSignal, createInfuSignal, createNumberSignal } from "../util/signals";
import type { SearchResult } from "../server";
import type { ArrangeAlgorithm } from "../items/page-item";
import type { Uid } from "../util/uid";

export type QueryMode = "search" | "chat" | null;
export type ChatCapability = "infumap_data";

export interface QueryRuntime {
  mode: QueryMode,
  text: string,
  search: {
    resultsPageId: Uid | null,
    resultLinkIds: Array<Uid>,
  },
  chat: {
    pageId: Uid | null,
    composerHeightPx: number | null,
    rootItemIds: Array<Uid>,
    capabilities: Array<ChatCapability>,
  },
}

export interface PerItemStoreContextModel {
  getSelectedListPageItem: (listPageVeid: Veid) => Veid,
  setSelectedListPageItem: (listPageVeid: Veid, selectedVeid: Veid) => void,

  getFocusedListPageItem: (listPageVeid: Veid) => Veid,
  setFocusedListPageItem: (listPageVeid: Veid, focusedVeid: Veid) => void,
  clearFocusedListPageItem: (listPageVeid: Veid) => void,

  getTableScrollYPos: (veid: Veid) => number,
  setTableScrollYPos: (veid: Veid, pos: number) => void,

  getPageScrollXProp: (veid: Veid) => number,
  setPageScrollXProp: (veid: Veid, prop: number) => void,

  getPageScrollYProp: (veid: Veid) => number,
  setPageScrollYProp: (veid: Veid, prop: number) => void,

  getCompositeIsCollapsed: (veid: Veid) => boolean,
  setCompositeIsCollapsed: (veid: Veid, collapsed: boolean) => void,

  getSearchQuery: (itemId: string) => string,
  setSearchQuery: (itemId: string, query: string) => void,

  getQueryMode: (itemId: string) => QueryMode,
  setQueryMode: (itemId: string, mode: QueryMode) => void,

  getQueryRuntime: (itemId: string) => QueryRuntime,
  updateQueryRuntime: (itemId: string, update: (runtime: QueryRuntime) => QueryRuntime) => QueryRuntime,

  getSearchResults: (itemId: string) => Array<SearchResult> | null,
  setSearchResults: (itemId: string, results: Array<SearchResult> | null) => void,

  getSearchHasMoreResults: (itemId: string) => boolean,
  setSearchHasMoreResults: (itemId: string, hasMore: boolean) => void,

  getSearchLoadedPageCount: (itemId: string) => number,
  setSearchLoadedPageCount: (itemId: string, pageCount: number) => void,

  getSearchSelectedResultIndex: (itemId: string) => number,
  setSearchSelectedResultIndex: (itemId: string, index: number) => void,

  getSearchFocusedResultIndex: (itemId: string) => number,
  setSearchFocusedResultIndex: (itemId: string, index: number) => void,

  getSearchArrangeAlgorithm: (itemId: string) => ArrangeAlgorithm | null,
  setSearchArrangeAlgorithm: (itemId: string, arrangeAlgorithm: ArrangeAlgorithm) => void,

  clear: () => void,
}

export function makePerItemStore(): PerItemStoreContextModel {
  // TODO (LOW): Unsure if lots of these signals, after lots of navigation, will create a perf issue. possibly
  // want to keep the number under control on page changes (delete those with value 0).
  const tableScrollPositions = new Map<string, NumberSignal>();
  const pageScrollXPxs = new Map<string, NumberSignal>();
  const pageScrollYPxs = new Map<string, NumberSignal>();
  const compositeCollapsedStates = new Map<string, BooleanSignal>();
  const selectedItems = new Map<string, InfuSignal<Veid>>();
  const focusedItems = new Map<string, InfuSignal<Veid>>();
  const queryRuntimes = new Map<string, InfuSignal<QueryRuntime>>();
  const searchResults = new Map<string, InfuSignal<Array<SearchResult> | null>>();
  const searchHasMoreResults = new Map<string, InfuSignal<boolean>>();
  const searchLoadedPageCounts = new Map<string, NumberSignal>();
  const searchSelectedResultIndexes = new Map<string, NumberSignal>();
  const searchFocusedResultIndexes = new Map<string, NumberSignal>();
  const searchArrangeAlgorithms = new Map<string, InfuSignal<ArrangeAlgorithm>>();

  const veidKey = (veid: Veid): string =>
    veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");

  const newQueryRuntime = (): QueryRuntime => ({
    mode: null,
    text: "",
    search: {
      resultsPageId: null,
      resultLinkIds: [],
    },
    chat: {
      pageId: null,
      composerHeightPx: null,
      rootItemIds: [],
      capabilities: ["infumap_data"],
    },
  });

  const getQueryRuntimeSignal = (itemId: string): InfuSignal<QueryRuntime> => {
    if (!queryRuntimes.get(itemId)) {
      queryRuntimes.set(itemId, createInfuSignal<QueryRuntime>(newQueryRuntime()));
    }
    return queryRuntimes.get(itemId)!;
  };

  const getQueryRuntime = (itemId: string): QueryRuntime =>
    getQueryRuntimeSignal(itemId).get();

  const updateQueryRuntime = (itemId: string, update: (runtime: QueryRuntime) => QueryRuntime): QueryRuntime => {
    const signal = getQueryRuntimeSignal(itemId);
    const next = update(signal.get());
    signal.set(next);
    return next;
  };

  const getTableScrollYPos = (veid: Veid): number => {
    const key = veidKey(veid);
    if (!tableScrollPositions.get(key)) {
      tableScrollPositions.set(key, createNumberSignal(0.0));
    }
    return tableScrollPositions.get(key)!.get();
  };

  const setTableScrollYPos = (veid: Veid, pos: number): void => {
    const key = veidKey(veid);
    if (!tableScrollPositions.get(key)) {
      tableScrollPositions.set(key, createNumberSignal(pos));
      return;
    }
    tableScrollPositions.get(key)!.set(pos);
  };

  const getPageScrollXProp = (veid: Veid): number => {
    const key = veidKey(veid);
    if (!pageScrollXPxs.get(key)) {
      pageScrollXPxs.set(key, createNumberSignal(0.0));
    }
    return pageScrollXPxs.get(key)!.get();
  };

  const setPageScrollXProp = (veid: Veid, prop: number): void => {
    const key = veidKey(veid);
    if (!pageScrollXPxs.get(key)) {
      pageScrollXPxs.set(key, createNumberSignal(prop));
      return;
    }
    pageScrollXPxs.get(key)!.set(prop);
  };

  const getPageScrollYProp = (veid: Veid): number => {
    const key = veidKey(veid);
    if (!pageScrollYPxs.get(key)) {
      pageScrollYPxs.set(key, createNumberSignal(0.0));
    }
    return pageScrollYPxs.get(key)!.get();
  };

  const setPageScrollYProp = (veid: Veid, prop: number): void => {
    const key = veidKey(veid);
    if (!pageScrollYPxs.get(key)) {
      pageScrollYPxs.set(key, createNumberSignal(prop));
      return;
    }
    pageScrollYPxs.get(key)!.set(prop);
  };

  const getCompositeIsCollapsed = (veid: Veid): boolean => {
    const key = veidKey(veid);
    if (!compositeCollapsedStates.get(key)) {
      compositeCollapsedStates.set(key, createBooleanSignal(false));
    }
    return compositeCollapsedStates.get(key)!.get();
  };

  const setCompositeIsCollapsed = (veid: Veid, collapsed: boolean): void => {
    const key = veidKey(veid);
    if (!compositeCollapsedStates.get(key)) {
      compositeCollapsedStates.set(key, createBooleanSignal(collapsed));
      return;
    }
    compositeCollapsedStates.get(key)!.set(collapsed);
  };

  const getSearchQuery = (itemId: string): string => {
    return getQueryRuntime(itemId).text;
  };

  const setSearchQuery = (itemId: string, query: string): void => {
    updateQueryRuntime(itemId, runtime => ({ ...runtime, text: query }));
  };

  const getQueryMode = (itemId: string): QueryMode => {
    return getQueryRuntime(itemId).mode;
  };

  const setQueryMode = (itemId: string, mode: QueryMode): void => {
    updateQueryRuntime(itemId, runtime => ({ ...runtime, mode }));
  };

  const getSearchResults = (itemId: string): Array<SearchResult> | null => {
    if (!searchResults.get(itemId)) {
      searchResults.set(itemId, createInfuSignal<Array<SearchResult> | null>(null));
    }
    return searchResults.get(itemId)!.get();
  };

  const setSearchResults = (itemId: string, results: Array<SearchResult> | null): void => {
    if (!searchResults.get(itemId)) {
      searchResults.set(itemId, createInfuSignal<Array<SearchResult> | null>(results));
      return;
    }
    searchResults.get(itemId)!.set(results);
  };

  const getSearchHasMoreResults = (itemId: string): boolean => {
    if (!searchHasMoreResults.get(itemId)) {
      searchHasMoreResults.set(itemId, createInfuSignal<boolean>(false));
    }
    return searchHasMoreResults.get(itemId)!.get();
  };

  const setSearchHasMoreResults = (itemId: string, hasMore: boolean): void => {
    if (!searchHasMoreResults.get(itemId)) {
      searchHasMoreResults.set(itemId, createInfuSignal<boolean>(hasMore));
      return;
    }
    searchHasMoreResults.get(itemId)!.set(hasMore);
  };

  const getSearchLoadedPageCount = (itemId: string): number => {
    if (!searchLoadedPageCounts.get(itemId)) {
      searchLoadedPageCounts.set(itemId, createNumberSignal(0));
    }
    return searchLoadedPageCounts.get(itemId)!.get();
  };

  const setSearchLoadedPageCount = (itemId: string, pageCount: number): void => {
    if (!searchLoadedPageCounts.get(itemId)) {
      searchLoadedPageCounts.set(itemId, createNumberSignal(pageCount));
      return;
    }
    searchLoadedPageCounts.get(itemId)!.set(pageCount);
  };

  const getSearchSelectedResultIndex = (itemId: string): number => {
    if (!searchSelectedResultIndexes.get(itemId)) {
      searchSelectedResultIndexes.set(itemId, createNumberSignal(-1));
    }
    return searchSelectedResultIndexes.get(itemId)!.get();
  };

  const setSearchSelectedResultIndex = (itemId: string, index: number): void => {
    if (!searchSelectedResultIndexes.get(itemId)) {
      searchSelectedResultIndexes.set(itemId, createNumberSignal(index));
      return;
    }
    searchSelectedResultIndexes.get(itemId)!.set(index);
  };

  const getSearchFocusedResultIndex = (itemId: string): number => {
    if (!searchFocusedResultIndexes.get(itemId)) {
      searchFocusedResultIndexes.set(itemId, createNumberSignal(-1));
    }
    return searchFocusedResultIndexes.get(itemId)!.get();
  };

  const setSearchFocusedResultIndex = (itemId: string, index: number): void => {
    if (!searchFocusedResultIndexes.get(itemId)) {
      searchFocusedResultIndexes.set(itemId, createNumberSignal(index));
      return;
    }
    searchFocusedResultIndexes.get(itemId)!.set(index);
  };

  const getSearchArrangeAlgorithm = (itemId: string): ArrangeAlgorithm | null => {
    return searchArrangeAlgorithms.get(itemId)?.get() ?? null;
  };

  const setSearchArrangeAlgorithm = (itemId: string, arrangeAlgorithm: ArrangeAlgorithm): void => {
    if (!searchArrangeAlgorithms.get(itemId)) {
      searchArrangeAlgorithms.set(itemId, createInfuSignal<ArrangeAlgorithm>(arrangeAlgorithm));
      return;
    }
    searchArrangeAlgorithms.get(itemId)!.set(arrangeAlgorithm);
  };

  const getSelectedListPageItem = (listPageVeid: Veid): Veid => {
    const key = veidKey(listPageVeid);
    if (!selectedItems.get(key)) {
      selectedItems.set(key, createInfuSignal<Veid>(EMPTY_VEID));
    }
    return selectedItems.get(key)!.get();
  };

  const setSelectedListPageItem = (listPageVeid: Veid, selectedVeid: Veid): void => {
    const key = veidKey(listPageVeid);
    if (!selectedItems.get(key)) {
      selectedItems.set(key, createInfuSignal<Veid>(selectedVeid));
      return;
    }
    selectedItems.get(key)!.set(selectedVeid);
  };

  const getFocusedListPageItem = (listPageVeid: Veid): Veid => {
    const key = veidKey(listPageVeid);
    if (!focusedItems.get(key)) {
      focusedItems.set(key, createInfuSignal<Veid>(EMPTY_VEID));
    }
    return focusedItems.get(key)!.get();
  };

  const setFocusedListPageItem = (listPageVeid: Veid, focusedVeid: Veid): void => {
    const key = veidKey(listPageVeid);
    if (!focusedItems.get(key)) {
      focusedItems.set(key, createInfuSignal<Veid>(focusedVeid));
      return;
    }
    focusedItems.get(key)!.set(focusedVeid);
  };

  const clearFocusedListPageItem = (listPageVeid: Veid): void => {
    const key = veidKey(listPageVeid);
    if (focusedItems.get(key)) {
      focusedItems.get(key)!.set(EMPTY_VEID);
    }
  };

  function clear() {
    tableScrollPositions.clear();
    pageScrollXPxs.clear();
    pageScrollYPxs.clear();
    compositeCollapsedStates.clear();
    selectedItems.clear();
    focusedItems.clear();
    queryRuntimes.clear();
    searchResults.clear();
    searchHasMoreResults.clear();
    searchLoadedPageCounts.clear();
    searchSelectedResultIndexes.clear();
    searchFocusedResultIndexes.clear();
    searchArrangeAlgorithms.clear();
  }

  return ({
    getSelectedListPageItem, setSelectedListPageItem,
    getFocusedListPageItem, setFocusedListPageItem, clearFocusedListPageItem,
    getTableScrollYPos, setTableScrollYPos,
    getPageScrollXProp, setPageScrollXProp,
    getPageScrollYProp, setPageScrollYProp,
    getCompositeIsCollapsed, setCompositeIsCollapsed,
    getSearchQuery, setSearchQuery,
    getQueryMode, setQueryMode,
    getQueryRuntime, updateQueryRuntime,
    getSearchResults, setSearchResults,
    getSearchHasMoreResults, setSearchHasMoreResults,
    getSearchLoadedPageCount, setSearchLoadedPageCount,
    getSearchSelectedResultIndex, setSearchSelectedResultIndex,
    getSearchFocusedResultIndex, setSearchFocusedResultIndex,
    getSearchArrangeAlgorithm, setSearchArrangeAlgorithm,
    clear
  });
}
