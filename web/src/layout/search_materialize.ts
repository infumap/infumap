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

import { LinkFns } from "../items/link-item";
import { PageFns, asPageItem, isPage } from "../items/page-item";
import {
  QueryItem,
  getQueryRuntime,
  getQuerySearchArrangeAlgorithm,
  getQuerySearchResults,
} from "../items/query-item";
import { resetQuerySearchSession } from "../items/query";
import { RelationshipToParent } from "./relationship-to-parent";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { newOrderingAtEnd } from "../util/ordering";
import { requestArrange } from "./arrange";
import { CALENDAR_DAY_ROW_HEIGHT_BL } from "../constants";
import type { SearchResult } from "../server";

function copyCurrentSearchResultsLayout(store: StoreContextModel, queryItem: QueryItem, materializedPage: ReturnType<typeof PageFns.create>) {
  const resultsPageId = getQueryRuntime(store, queryItem).search.resultsPageId;
  const resultsPageMaybe = resultsPageId == null ? null : itemState.get(resultsPageId);
  if (resultsPageMaybe && isPage(resultsPageMaybe)) {
    const resultsPage = asPageItem(resultsPageMaybe);
    materializedPage.arrangeAlgorithm = resultsPage.arrangeAlgorithm;
    materializedPage.gridNumberOfColumns = resultsPage.gridNumberOfColumns;
    materializedPage.gridCellAspect = resultsPage.gridCellAspect;
    materializedPage.docWidthBl = resultsPage.docWidthBl;
    materializedPage.justifiedRowAspect = resultsPage.justifiedRowAspect;
    materializedPage.calendarDayRowHeightBl = CALENDAR_DAY_ROW_HEIGHT_BL;
    materializedPage.orderChildrenBy = "";
  }

  // Keep the new page aligned with the active search layout choices even if the
  // temporary results page has not been instantiated yet.
  materializedPage.arrangeAlgorithm = getQuerySearchArrangeAlgorithm(store, queryItem);
}

function makeMaterializedLink(
  queryItem: QueryItem,
  pageId: string,
  results: Array<SearchResult>,
  index: number,
  childOrderings: Array<Uint8Array>,
) {
  const result = results[index];
  const resultItemId = result.path[result.path.length - 1]?.id;
  if (!resultItemId) {
    return null;
  }

  const link = LinkFns.create(
    queryItem.ownerId,
    pageId,
    RelationshipToParent.Child,
    resultItemId,
    newOrderingAtEnd(childOrderings),
  );
  LinkFns.syncSizeFromLinkedItem(link);
  return link;
}

export async function materializeSearchResults(
  store: StoreContextModel,
  queryItem: QueryItem,
  title: string,
): Promise<string | null> {
  const results = getQuerySearchResults(store, queryItem);
  if (!results || results.length == 0) {
    return null;
  }

  const ordering = itemState.newOrderingDirectlyAfterChild(queryItem.parentId, queryItem.id);
  const page = PageFns.create(
    queryItem.ownerId,
    queryItem.parentId,
    RelationshipToParent.Child,
    title,
    ordering,
  );
  page.childrenLoaded = true;
  page.orderChildrenBy = "";
  page.arrangeAlgorithm = getQuerySearchArrangeAlgorithm(store, queryItem);
  copyCurrentSearchResultsLayout(store, queryItem, page);

  itemState.add(page);

  const createdLinkIds: Array<string> = [];
  const createdLinks = [];
  const childOrderings: Array<Uint8Array> = [];
  for (let idx = 0; idx < results.length; ++idx) {
    const link = makeMaterializedLink(queryItem, page.id, results, idx, childOrderings);
    if (!link) {
      continue;
    }
    childOrderings.push(link.ordering);
    createdLinks.push(link);
    createdLinkIds.push(link.id);
    itemState.add(link);
  }

  requestArrange(store, "search-materialize-local");

  try {
    await server.addItem(page, null, store.general.networkStatus);
    for (const link of createdLinks) {
      await server.addItem(link, null, store.general.networkStatus);
    }
    resetQuerySearchSession(store, queryItem);
    requestArrange(store, "search-materialize-complete");
    return page.id;
  } catch (e) {
    console.error("Failed to materialize search results:", e);
    for (const linkId of createdLinkIds.reverse()) {
      itemState.delete(linkId);
    }
    itemState.delete(page.id);
    requestArrange(store, "search-materialize-rollback");
    throw e;
  }
}
