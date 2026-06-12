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
  QueryItem,
  QUERY_WORKSPACE_SIDE_INSET_PX,
  calcQueryWorkspaceResultsBoundsPx,
  getQueryMode,
  getQueryRuntime,
  getQuerySearchArrangeAlgorithm,
  getQuerySearchResults,
  markAsQuerySearchResultLink,
  markAsQuerySearchResultsPage,
  updateQueryRuntime,
} from "../../items/query-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { newOrdering, newOrderingAtEnd } from "../../util/ordering";
import { newUid } from "../../util/uid";
import { VisualElementPath } from "../visual-element";
import { ArrangeItemFlags, arrangeItemPath } from "./item";
import { RelationshipToParent } from "../relationship-to-parent";
import { ItemGeometry } from "../item-geometry";
import { markChildrenLoadAsInitiatedOrComplete } from "../load";


function ensureTemporaryResultsPage(store: StoreContextModel, queryItem: QueryItem, results: Array<SearchResult>): PageItem {
  const runtime = getQueryRuntime(store, queryItem);
  const pageId = runtime.search.resultsPageId ?? newUid();
  if (runtime.search.resultsPageId == null) {
    updateQueryRuntime(store, queryItem, current => ({
      ...current,
      search: {
        ...current.search,
        resultsPageId: pageId,
      },
    }));
  }
  const searchArrangeAlgorithm = (() => {
    const aa = getQuerySearchArrangeAlgorithm(store, queryItem);
    return aa == ArrangeAlgorithm.Grid ? ArrangeAlgorithm.Grid : ArrangeAlgorithm.Catalog;
  })();

  let pageItem = itemState.get(pageId);
  if (!pageItem || !isPage(pageItem)) {
    const tempPage = PageFns.create(queryItem.ownerId, queryItem.id, RelationshipToParent.Child, "", newOrdering());
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
  page.parentId = queryItem.id;
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
      queryItem.ownerId,
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
  updateQueryRuntime(store, queryItem, current => ({
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

export function arrangeSearchResultsPathMaybe(
  store: StoreContextModel,
  queryItem: QueryItem,
  queryItemPath: VisualElementPath,
  queryItemGeometry: ItemGeometry,
): VisualElementPath | null {
  const queryMode = getQueryMode(store, queryItem);
  if (queryMode == "chat") {
    const chatPageId = getQueryRuntime(store, queryItem).chat.pageId;
    const chatPage = chatPageId == null ? null : itemState.get(chatPageId);
    if (!chatPage || !isPage(chatPage)) {
      return null;
    }
    const page = asPageItem(chatPage);
    const preferredWidthPx = (page.docWidthBl + PAGE_DOCUMENT_LEFT_MARGIN_BL + PAGE_DOCUMENT_RIGHT_MARGIN_BL) *
      NATURAL_BLOCK_SIZE_PX.w;
    const maxWidthPx = Math.max(
      240,
      queryItemGeometry.boundsPx.w - QUERY_WORKSPACE_SIDE_INSET_PX * 2,
    );
    const chatWidthPx = Math.min(preferredWidthPx, maxWidthPx);
    const chatBoundsPx = {
      x: Math.max(0, Math.round((queryItemGeometry.boundsPx.w - chatWidthPx) / 2)),
      y: 0,
      w: chatWidthPx,
      h: queryItemGeometry.boundsPx.h,
    };
    const pageGeometry: ItemGeometry = {
      boundsPx: chatBoundsPx,
      viewportBoundsPx: chatBoundsPx,
      blockSizePx: queryItemGeometry.blockSizePx,
      hitboxes: [],
    };
    return arrangeItemPath(
      store,
      queryItemPath,
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

  const results = getQuerySearchResults(store, queryItem);
  if (!results || results.length == 0) {
    return null;
  }

  const resultsPage = ensureTemporaryResultsPage(store, queryItem, results);
  const resultsArrangeAlgorithm = getQuerySearchArrangeAlgorithm(store, queryItem);
  const resultsBoundsPx = calcQueryWorkspaceResultsBoundsPx(queryItemGeometry.boundsPx);
  const pageGeometry: ItemGeometry = {
    boundsPx: resultsBoundsPx,
    viewportBoundsPx: resultsBoundsPx,
    blockSizePx: queryItemGeometry.blockSizePx,
    hitboxes: [],
  };

  return arrangeItemPath(
    store,
    queryItemPath,
    resultsArrangeAlgorithm,
    resultsPage,
    null,
    pageGeometry,
    ArrangeItemFlags.RenderChildrenAsFull,
  );
}
