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

import type { StoreContextModel } from "../store/StoreProvider";
import type { ItemPathSegment } from "../util/item-path";
import type { SearchFragmentMatchDisplay } from "../util/search-result-display";
import type { Uid } from "../util/uid";
import { asContainerItem, isContainer } from "../items/base/container-item";
import { Item } from "../items/base/item";
import { asFileItem, isFile } from "../items/file-item";
import { asImageItem, isImage } from "../items/image-item";
import {
  QUERY_WORKSPACE_ARRANGE_SELECTOR_RESULTS_GAP_PX,
  QUERY_WORKSPACE_ARRANGE_SELECTOR_RESULTS_OVERLAP_PX,
  QUERY_WORKSPACE_MORE_SECTION_GAP_PX,
  calcQueryWorkspaceResultsFooterHeightPx,
  getQuerySearchHasMoreResults,
  getQuerySearchResults,
  getQuerySearchSelectedResultIndex,
  isQuerySearchResultsPage,
  querySearchResultsFooterHostId,
} from "../items/query-item";
import { PageItem } from "../items/page-item";
import { asTextItem, isText } from "../items/text-item";
import { calculateChildrenStats, formatBytes } from "../util/item-metadata";
import { itemPathSegmentsFromItem, resolvedPathTargetItemForItem } from "../util/item-path";
import { catalogSearchResultDisplay } from "../util/search-result-display";

interface ChildrenStatsLike {
  totalChildren: number,
  imageFileChildren: number,
  totalBytes: number,
}

export interface CatalogRowDisplay {
  pathSegments: Array<ItemPathSegment>,
  metadataLines: Array<string>,
  fragmentMatches: Array<CatalogRowFragmentDisplay>,
}

export type CatalogRowFragmentDisplay = SearchFragmentMatchDisplay;

export interface CatalogPageDisplayContext {
  resultControlsTopInsetPx: () => number | null,
  footerGapPx: () => number,
  footerHeightPx: () => number,
  footerHostId: () => string,
  selectedRowIndex: () => number,
  rowDisplay: (rowIndex: number, item: Item) => CatalogRowDisplay,
}

function catalogChildrenStatsMetadataLines(stats: ChildrenStatsLike): Array<string> {
  return [
    `Children: ${stats.totalChildren}`,
    `Images, Text & Files: ${stats.imageFileChildren}`,
    `Total Size: ${formatBytes(stats.totalBytes)}`,
  ];
}

function catalogSourceItem(item: Item): Item {
  return resolvedPathTargetItemForItem(item) ?? item;
}

function catalogMetadataLines(item: Item): Array<string> {
  const targetItem = catalogSourceItem(item);
  if (isImage(targetItem)) {
    const imageItem = asImageItem(targetItem);
    const result = [`Size: ${formatBytes(imageItem.fileSizeBytes || 0)}`];
    if (imageItem.imageSizePx.w > 0 && imageItem.imageSizePx.h > 0) {
      result.push(`Image Size: ${imageItem.imageSizePx.w} × ${imageItem.imageSizePx.h}`);
    }
    return result;
  }
  if (isFile(targetItem)) {
    return [`Size: ${formatBytes(asFileItem(targetItem).fileSizeBytes || 0)}`];
  }
  if (isText(targetItem)) {
    return [`Size: ${formatBytes(asTextItem(targetItem).fileSizeBytes || 0)}`];
  }
  if (isContainer(targetItem)) {
    return catalogChildrenStatsMetadataLines(calculateChildrenStats(asContainerItem(targetItem)));
  }
  return [];
}

function catalogItemRowDisplay(item: Item): CatalogRowDisplay {
  return {
    pathSegments: itemPathSegmentsFromItem(item),
    metadataLines: catalogMetadataLines(item),
    fragmentMatches: [],
  };
}

function queryResultForVisibleRow(store: StoreContextModel, queryItemId: Uid, rowIndex: number) {
  const results = getQuerySearchResults(store, queryItemId);
  if (!results) {
    return null;
  }

  let visibleRow = -1;
  for (const result of results) {
    if (!result.path[result.path.length - 1]?.id) {
      continue;
    }
    visibleRow += 1;
    if (visibleRow == rowIndex) {
      return result;
    }
  }
  return null;
}

function queryResultRowDisplay(store: StoreContextModel, queryItemId: Uid, rowIndex: number, fallbackItem: Item): CatalogRowDisplay {
  const result = queryResultForVisibleRow(store, queryItemId, rowIndex);
  if (!result) {
    return catalogItemRowDisplay(fallbackItem);
  }

  const display = catalogSearchResultDisplay(result);
  const metadataLines = display.stats
    ? catalogChildrenStatsMetadataLines(display.stats)
    : catalogMetadataLines(fallbackItem);
  return {
    pathSegments: display.pathSegments,
    metadataLines: display.overallScoreLabel ? [...metadataLines, display.overallScoreLabel] : metadataLines,
    fragmentMatches: display.fragmentMatches,
  };
}

function queryResultsSourceItemId(pageItem: PageItem): Uid | null {
  return isQuerySearchResultsPage(pageItem) ? pageItem.parentId : null;
}

export function hasCatalogResultContext(pageItem: PageItem): boolean {
  return queryResultsSourceItemId(pageItem) != null;
}

export function catalogResultControlsTopInsetPx(pageItem: PageItem): number | null {
  return hasCatalogResultContext(pageItem)
    ? QUERY_WORKSPACE_ARRANGE_SELECTOR_RESULTS_OVERLAP_PX + QUERY_WORKSPACE_ARRANGE_SELECTOR_RESULTS_GAP_PX
    : null;
}

export function catalogResultFooterGapPx(): number {
  return QUERY_WORKSPACE_MORE_SECTION_GAP_PX;
}

export function catalogResultFooterHeightPx(store: StoreContextModel, pageItem: PageItem): number {
  const queryItemId = queryResultsSourceItemId(pageItem);
  return queryItemId == null ? 0 : calcQueryWorkspaceResultsFooterHeightPx(getQuerySearchHasMoreResults(store, queryItemId));
}

export function catalogResultFooterHostId(pageItem: PageItem): string {
  const queryItemId = queryResultsSourceItemId(pageItem);
  return queryItemId == null ? "" : querySearchResultsFooterHostId(queryItemId);
}

export function catalogResultSelectedRowIndex(store: StoreContextModel, pageItem: PageItem): number {
  const queryItemId = queryResultsSourceItemId(pageItem);
  return queryItemId == null ? -1 : getQuerySearchSelectedResultIndex(store, queryItemId);
}

export function catalogPageDisplayContext(store: StoreContextModel, pageItem: PageItem): CatalogPageDisplayContext {
  return {
    resultControlsTopInsetPx: () => catalogResultControlsTopInsetPx(pageItem),
    footerGapPx: () => catalogResultFooterGapPx(),
    footerHeightPx: () => catalogResultFooterHeightPx(store, pageItem),
    footerHostId: () => catalogResultFooterHostId(pageItem),
    selectedRowIndex: () => catalogResultSelectedRowIndex(store, pageItem),
    rowDisplay: (rowIndex: number, item: Item) => {
      const queryItemId = queryResultsSourceItemId(pageItem);
      return queryItemId == null
        ? catalogItemRowDisplay(item)
        : queryResultRowDisplay(store, queryItemId, rowIndex, item);
    },
  };
}
