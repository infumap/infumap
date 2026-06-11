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
  NATURAL_BLOCK_SIZE_PX,
  PAGE_DOCUMENT_LEFT_MARGIN_BL,
  PAGE_DOCUMENT_RIGHT_MARGIN_BL,
} from "../../constants";
import {
  SearchItem,
  SEARCH_WORKSPACE_SIDE_INSET_PX,
  calcSearchWorkspaceResultsBoundsPx,
  markAsQuerySearchResultLink,
  markAsQuerySearchResultsPage,
} from "../../items/search-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { newOrdering, newOrderingAtEnd } from "../../util/ordering";
import { newUid } from "../../util/uid";
import { VisualElementPath } from "../visual-element";
import { ArrangeItemFlags, arrangeItemPath } from "./item";
import { RelationshipToParent } from "../relationship-to-parent";
import { ItemGeometry } from "../item-geometry";
import { markChildrenLoadAsInitiatedOrComplete } from "../load";


function ensureTemporaryResultsPage(store: StoreContextModel, searchItem: SearchItem, results: Array<SearchResult>): PageItem {
  const runtime = store.perItem.getQueryRuntime(searchItem.id);
  const pageId = runtime.search.resultsPageId ?? newUid();
  if (runtime.search.resultsPageId == null) {
    store.perItem.updateQueryRuntime(searchItem.id, current => ({
      ...current,
      search: {
        ...current.search,
        resultsPageId: pageId,
      },
    }));
  }
  const searchArrangeAlgorithm = (() => {
    const aa = store.perItem.getSearchArrangeAlgorithm(searchItem.id);
    return aa == ArrangeAlgorithm.Grid ? ArrangeAlgorithm.Grid : ArrangeAlgorithm.Catalog;
  })();

  let pageItem = itemState.get(pageId);
  if (!pageItem || !isPage(pageItem)) {
    const tempPage = PageFns.create(searchItem.ownerId, searchItem.id, RelationshipToParent.Child, "", newOrdering());
    tempPage.id = pageId;
    tempPage.origin = null;
    markAsQuerySearchResultsPage(tempPage);
    tempPage.arrangeAlgorithm = searchArrangeAlgorithm;
    tempPage.orderChildrenBy = "";
    tempPage.title = "";
    pageItem = itemState.upsertItemFromServerObject(PageFns.toObject(tempPage), null);
  }

  const page = asPageItem(pageItem);
  page.origin = null;
  markAsQuerySearchResultsPage(page);
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
  const existingLinkIds = runtime.search.resultLinkIds;
  for (let idx = 0; idx < results.length; ++idx) {
    const result = results[idx];
    const resultItemId = result.path[result.path.length - 1]?.id;
    if (!resultItemId) {
      continue;
    }

    const linkId = existingLinkIds[childIds.length] ?? newUid();
    const tempLink = LinkFns.create(
      searchItem.ownerId,
      page.id,
      RelationshipToParent.Child,
      resultItemId,
      newOrderingAtEnd(childOrderings),
    );
    LinkFns.syncSizeFromLinkedItem(tempLink);
    tempLink.id = linkId;
    tempLink.origin = null;
    markAsQuerySearchResultLink(tempLink);

    const linkItem = asLinkItem(itemState.upsertItemFromServerObject(LinkFns.toObject(tempLink), null));
    linkItem.origin = null;
    markAsQuerySearchResultLink(linkItem);
    linkItem.parentId = page.id;
    linkItem.relationshipToParent = RelationshipToParent.Child;
    linkItem.ordering = tempLink.ordering;
    linkItem.spatialWidthGr = tempLink.spatialWidthGr;
    linkItem.spatialHeightGr = tempLink.spatialHeightGr;
    linkItem.linkToResolvedId = resultItemId;
    childIds.push(linkItem.id);
    childOrderings.push(linkItem.ordering);
  }

  for (const staleLinkId of existingLinkIds.slice(childIds.length)) {
    itemState.delete(staleLinkId);
  }
  store.perItem.updateQueryRuntime(searchItem.id, current => ({
    ...current,
    search: {
      ...current.search,
      resultsPageId: page.id,
      resultLinkIds: childIds,
    },
  }));

  page.computed_children = childIds;
  return page;
}

export function clearQuerySearchRuntime(store: StoreContextModel, searchItemId: string): void {
  const runtime = store.perItem.getQueryRuntime(searchItemId);
  for (const linkId of runtime.search.resultLinkIds) {
    itemState.delete(linkId);
  }
  if (runtime.search.resultsPageId != null) {
    itemState.delete(runtime.search.resultsPageId);
  }
  store.perItem.updateQueryRuntime(searchItemId, current => ({
    ...current,
    search: {
      resultsPageId: null,
      resultLinkIds: [],
    },
  }));
}

export function arrangeSearchResultsPathMaybe(
  store: StoreContextModel,
  searchItem: SearchItem,
  searchItemPath: VisualElementPath,
  searchItemGeometry: ItemGeometry,
): VisualElementPath | null {
  const queryMode = store.perItem.getQueryMode(searchItem.id);
  if (queryMode == "chat") {
    const chatPageId = store.perItem.getQueryRuntime(searchItem.id).chat.pageId;
    const chatPage = chatPageId == null ? null : itemState.get(chatPageId);
    if (!chatPage || !isPage(chatPage)) {
      return null;
    }
    const page = asPageItem(chatPage);
    const preferredWidthPx = (page.docWidthBl + PAGE_DOCUMENT_LEFT_MARGIN_BL + PAGE_DOCUMENT_RIGHT_MARGIN_BL) *
      NATURAL_BLOCK_SIZE_PX.w;
    const maxWidthPx = Math.max(
      240,
      searchItemGeometry.boundsPx.w - SEARCH_WORKSPACE_SIDE_INSET_PX * 2,
    );
    const chatWidthPx = Math.min(preferredWidthPx, maxWidthPx);
    const chatBoundsPx = {
      x: Math.max(0, Math.round((searchItemGeometry.boundsPx.w - chatWidthPx) / 2)),
      y: 0,
      w: chatWidthPx,
      h: searchItemGeometry.boundsPx.h,
    };
    const pageGeometry: ItemGeometry = {
      boundsPx: chatBoundsPx,
      viewportBoundsPx: chatBoundsPx,
      blockSizePx: searchItemGeometry.blockSizePx,
      hitboxes: [],
    };
    return arrangeItemPath(
      store,
      searchItemPath,
      ArrangeAlgorithm.Document,
      page,
      null,
      pageGeometry,
      ArrangeItemFlags.RenderChildrenAsFull | ArrangeItemFlags.IsListPageMainRoot,
    );
  }

  if (queryMode != "search") {
    return null;
  }

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
