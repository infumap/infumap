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

import { server } from "../server";
import { itemState } from "../store/ItemState";
import type { StoreContextModel } from "../store/StoreProvider";
import type { Uid } from "../util/uid";
import { asPageItem, isPage } from "./page-item";
import { isQueryItem } from "./query-item";

export interface QueryEntryResult {
  queryItemId: Uid,
  archivedQueryItemIds: Array<Uid>,
}

/** The server archives used pinned chats and ensures one blank pinned query, even when another tab calls this too. */
export async function ensureQueryEntryUnderQueries(
  store: StoreContextModel,
  queriesPageId: Uid,
  firstTurnQueryItemId: Uid | null = null,
  isCurrent: () => boolean = () => true,
): Promise<QueryEntryResult | null> {
  const queriesPageMaybe = itemState.get(queriesPageId);
  if (!queriesPageMaybe || !isPage(queriesPageMaybe)) {
    return null;
  }

  const queriesPage = asPageItem(queriesPageMaybe);
  const response = await server.ensureQueryEntry(firstTurnQueryItemId);
  // First-turn archiving can finish after its chat was cleared or its account logged out.
  if (!isCurrent()) { return null; }
  const archivedQueryItemIds: Array<Uid> = [];
  for (const itemObject of [...response.archivedQueryItems, response.queryItem]) {
    const item = itemState.upsertItemFromServerObject(itemObject, null);
    if (!isQueryItem(item) || item.parentId != queriesPageId) {
      throw new Error("The server returned a query entry outside the Queries page.");
    }
    if (!queriesPage.computed_children.includes(item.id)) {
      queriesPage.computed_children = [...queriesPage.computed_children, item.id];
    }
    if (itemObject != response.queryItem) {
      archivedQueryItemIds.push(item.id);
    }
  }
  itemState.sortChildren(queriesPageId);
  const queryItemId = (response.queryItem as { id: Uid }).id;
  return { queryItemId, archivedQueryItemIds };
}
