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

import type { SearchResult } from "../../server";
import { LinkFns, LinkItem, asLinkItem } from "../../items/link-item";
import {
  ArrangeAlgorithm,
  PageFns,
  PageItem,
  asPageItem,
  isPage,
} from "../../items/page-item";
import {
  SearchItem,
  TEMP_SEARCH_RESULTS_ORIGIN,
  calcSearchWorkspaceResultsBoundsPx,
  tempSearchResultLinkUid,
  tempSearchResultsPageUid,
} from "../../items/search-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { newOrdering, newOrderingAtEnd } from "../../util/ordering";
import { VisualElementPath } from "../visual-element";
import { ArrangeItemFlags, arrangeItemPath } from "./item";
import { RelationshipToParent } from "../relationship-to-parent";
import { ItemGeometry } from "../item-geometry";
import { markChildrenLoadAsInitiatedOrComplete } from "../load";


function fallbackPathTitle(itemType: string): string {
  return `[${itemType}]`;
}

function ensureTemporaryResultsPage(store: StoreContextModel, searchItem: SearchItem, results: Array<SearchResult>): PageItem {
  const pageId = tempSearchResultsPageUid(searchItem.id);
  const searchArrangeAlgorithm = (() => {
    const aa = store.perItem.getSearchArrangeAlgorithm(searchItem.id);
    return aa == ArrangeAlgorithm.Grid ? ArrangeAlgorithm.Grid : ArrangeAlgorithm.Catalog;
  })();

  let pageItem = itemState.get(pageId);
  if (!pageItem || !isPage(pageItem)) {
    const tempPage = PageFns.create(searchItem.ownerId, searchItem.id, RelationshipToParent.Child, "", newOrdering());
    tempPage.id = pageId;
    tempPage.origin = TEMP_SEARCH_RESULTS_ORIGIN;
    tempPage.arrangeAlgorithm = searchArrangeAlgorithm;
    tempPage.orderChildrenBy = "";
    tempPage.title = "";
    pageItem = itemState.upsertItemFromServerObject(PageFns.toObject(tempPage), TEMP_SEARCH_RESULTS_ORIGIN);
  }

  const page = asPageItem(pageItem);
  page.origin = TEMP_SEARCH_RESULTS_ORIGIN;
  page.parentId = searchItem.id;
  page.relationshipToParent = RelationshipToParent.Child;
  page.arrangeAlgorithm = searchArrangeAlgorithm;
  page.orderChildrenBy = "";
  page.title = "";
  page.childrenLoaded = true;
  page.computed_attachments = [];
  markChildrenLoadAsInitiatedOrComplete(page.id);

  const childIds: Array<string> = [];
  const childOrderings: Array<Uint8Array> = [];
  for (let idx = 0; idx < results.length; ++idx) {
    const result = results[idx];
    const resultItemId = result.path[result.path.length - 1]?.id;
    if (!resultItemId) {
      continue;
    }

    const tempLink = LinkFns.create(
      searchItem.ownerId,
      page.id,
      RelationshipToParent.Child,
      resultItemId,
      newOrderingAtEnd(childOrderings),
    );
    LinkFns.syncSizeFromLinkedItem(tempLink);
    tempLink.id = tempSearchResultLinkUid(searchItem.id, idx);
    tempLink.origin = TEMP_SEARCH_RESULTS_ORIGIN;
    tempLink.catalogPathOverride = result.path.map(segment => ({
      id: segment.id,
      itemType: segment.itemType,
      title: segment.title ?? fallbackPathTitle(segment.itemType),
    }));

    const linkItem = asLinkItem(itemState.upsertItemFromServerObject(LinkFns.toObject(tempLink), TEMP_SEARCH_RESULTS_ORIGIN));
    linkItem.origin = TEMP_SEARCH_RESULTS_ORIGIN;
    linkItem.parentId = page.id;
    linkItem.relationshipToParent = RelationshipToParent.Child;
    linkItem.ordering = tempLink.ordering;
    linkItem.spatialWidthGr = tempLink.spatialWidthGr;
    linkItem.spatialHeightGr = tempLink.spatialHeightGr;
    linkItem.linkToResolvedId = resultItemId;
    linkItem.catalogPathOverride = tempLink.catalogPathOverride;
    childIds.push(linkItem.id);
    childOrderings.push(linkItem.ordering);
  }

  page.computed_children = childIds;
  return page;
}

export function arrangeSearchResultsPathMaybe(
  store: StoreContextModel,
  searchItem: SearchItem,
  searchItemPath: VisualElementPath,
  searchItemGeometry: ItemGeometry,
): VisualElementPath | null {
  const results = store.perItem.getSearchResults(searchItem.id);
  if (!results || results.length == 0) {
    return null;
  }

  const resultsPage = ensureTemporaryResultsPage(store, searchItem, results);
  const resultsArrangeAlgorithm = store.perItem.getSearchArrangeAlgorithm(searchItem.id);
  const resultsBoundsPx = calcSearchWorkspaceResultsBoundsPx(searchItemGeometry.boundsPx);
  const pageGeometry: ItemGeometry = {
    boundsPx: resultsBoundsPx,
    viewportBoundsPx: resultsBoundsPx,
    blockSizePx: searchItemGeometry.blockSizePx,
    hitboxes: [],
  };

  return arrangeItemPath(
    store,
    searchItemPath,
    resultsArrangeAlgorithm,
    resultsPage,
    null,
    pageGeometry,
    ArrangeItemFlags.RenderChildrenAsFull,
  );
}
