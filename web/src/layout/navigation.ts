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

import { ROOT_USERNAME } from "../constants";
import { requestContainerSyncSoon, server } from "../server";
import { Item } from "../items/base/item";
import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { QueryFns, asQueryItem, isQueryChatPage, isQueryItem } from "../items/query-item";
import { SearchFlags } from "../items/base/flags-item";
import { removeClientOnlyChatPagesUnderQueries } from "../items/chat";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { assert, panic } from "../util/lang";
import { EMPTY_UID, SOLO_ITEM_HOLDER_PAGE_UID, UMBRELLA_PAGE_UID, Uid, isUid } from "../util/uid";
import { arrangeNow } from "./arrange";
import { initiateLoadChildItemsMaybe, initiateLoadItemMaybe, InitiateLoadResult } from "./load";
import { isEmptyVeid, VeFns, Veid, VisualElementPath } from "./visual-element";
import { RelationshipToParent } from "./relationship-to-parent";


export function switchToNonPage(store: StoreContextModel, url: string) {
  window.history.pushState(null, "", url);
  store.currentUrlPath.set(url);
}

function internalQueryChatOwnerPageId(itemId: Uid): Uid | null {
  const item = itemState.get(itemId);
  if (!item || !isPage(item) || !isQueryChatPage(item)) {
    return null;
  }

  const parent = itemState.get(item.parentId);
  if (!parent || !isQueryItem(parent)) {
    return null;
  }

  return parent.parentId == EMPTY_UID ? null : parent.parentId;
}

function currentUrl(store: StoreContextModel, overrideItemId: Uid | null): string {
  const currentVeid = store.history.currentPageVeid();
  const itemId = overrideItemId ?? currentVeid?.itemId;
  if (!itemId || itemId == EMPTY_UID) {
    return "/";
  }

  const queryChatOwnerPageId = internalQueryChatOwnerPageId(itemId);
  if (queryChatOwnerPageId != null) {
    return currentUrl(store, queryChatOwnerPageId);
  }

  const item = itemState.get(itemId);
  if (item && item.origin != null) {
    const encodedOrigin = encodeURIComponent(item.origin);
    return `/remote/${encodedOrigin}/${itemId}`;
  }

  const userMaybe = store.user.getUserMaybe();
  if (!userMaybe) {
    return `/${itemId}`;
  }

  const user = userMaybe;
  if (overrideItemId != null) {
    return `/${overrideItemId}`;
  }

  if (itemId !== user.homePageId) {
    return `/${itemId}`;
  }

  if (user.username === ROOT_USERNAME) {
    return "/";
  }

  return `/${user.username}`;
}

export function switchToItem(store: StoreContextModel, itemId: Uid, clearHistory: boolean) {
  const selectedItem = itemState.get(itemId)!;
  assert(!isPage(selectedItem), "cannot call switchToItem on page item");

  itemState.addSoloItemHolderPage(selectedItem!.ownerId);
  asPageItem(itemState.get(SOLO_ITEM_HOLDER_PAGE_UID)!).computed_children = [itemId];
  if (clearHistory) {
    store.history.setHistoryToSinglePage(VeFns.veidFromId(SOLO_ITEM_HOLDER_PAGE_UID));
  } else {
    store.history.pushPageVeid(VeFns.veidFromId(SOLO_ITEM_HOLDER_PAGE_UID));
  }
  arrangeNow(store, "switch-to-item");
  requestContainerSyncSoon(store);

  const url = currentUrl(store, itemId);
  window.history.pushState(null, "", url);
  store.currentUrlPath.set(url);
}

function fallbackToItem(store: StoreContextModel, item: Item): boolean {
  if (isPage(item)) {
    switchToPage(store, { itemId: item.id, linkIdMaybe: null }, true, false, false);
  } else {
    switchToItem(store, item.id, false);
  }
  return true;
}

function focusPathForItemChain(pageVeid: Veid, bottomUpItemChain: Array<Veid>): VisualElementPath {
  let focusPath = VeFns.addVeidToPath(pageVeid, UMBRELLA_PAGE_UID);
  for (let i = bottomUpItemChain.length - 1; i >= 0; --i) {
    focusPath = VeFns.addVeidToPath(bottomUpItemChain[i], focusPath);
  }
  return focusPath;
}

async function navigateToContainingPageOfItemWithOptions(
  store: StoreContextModel,
  itemId: Uid,
  options: { focusTarget: boolean, fallbackToItem: boolean },
): Promise<boolean> {
  let currentItem = itemState.get(itemId);
  if (!currentItem) {
    const loadResult = await initiateLoadItemMaybe(store, itemId);
    if (loadResult == InitiateLoadResult.Failed || !itemState.get(itemId)) {
      return false;
    }
    currentItem = itemState.get(itemId)!;
  }

  const targetItem = currentItem;
  const targetIsRemote = currentItem.origin != null;
  const bottomUpItemChain: Array<Veid> = [VeFns.veidFromId(currentItem.id)];
  const MAX_LEVELS = 8;
  let cnt = 0;
  let parentId = currentItem.parentId;
  let relationshipToParent = currentItem.relationshipToParent;

  while (cnt++ < MAX_LEVELS) {
    if (parentId == EMPTY_UID) {
      if (options.fallbackToItem) {
        return fallbackToItem(store, targetItem);
      }
      if (targetIsRemote) {
        await navigateToLocalRoot(store);
        return true;
      }
      return false;
    }

    const userMaybe = store.user.getUserMaybe();
    if (userMaybe && parentId == userMaybe.dockPageId) {
      if (options.fallbackToItem) {
        return fallbackToItem(store, targetItem);
      }
      if (targetIsRemote) {
        await navigateToLocalRoot(store);
        return true;
      }
      return false;
    }

    let parentItem = itemState.get(parentId);
    if (!parentItem) {
      if (await initiateLoadItemMaybe(store, parentId) == InitiateLoadResult.Failed || !itemState.get(parentId)) {
        return options.fallbackToItem ? fallbackToItem(store, targetItem) : false;
      }
      parentItem = itemState.get(parentId)!;
    }

    if (targetIsRemote && parentItem.origin !== targetItem.origin) {
      if (options.fallbackToItem) {
        return fallbackToItem(store, targetItem);
      }
      await navigateToLocalRoot(store);
      return true;
    }

    if (isPage(parentItem) && relationshipToParent === RelationshipToParent.Child) {
      const page = asPageItem(parentItem);
      const pageVeid = { itemId: parentId, linkIdMaybe: null };
      let focusPath: VisualElementPath | undefined = undefined;
      if (options.focusTarget) {
        focusPath = focusPathForItemChain(pageVeid, bottomUpItemChain);
        if (page.arrangeAlgorithm == ArrangeAlgorithm.List) {
          const directChildVeid = bottomUpItemChain[bottomUpItemChain.length - 1];
          store.perItem.setSelectedListPageItem(pageVeid, directChildVeid);
        }
      }
      switchToPage(store, pageVeid, true, false, false, focusPath);
      return true;
    }

    bottomUpItemChain.push(VeFns.veidFromId(parentItem.id));
    parentId = parentItem.parentId;
    relationshipToParent = parentItem.relationshipToParent;
  }

  if (options.fallbackToItem) {
    return fallbackToItem(store, targetItem);
  }
  panic(`navigateToContainingPageOfItem: could not find page after ${MAX_LEVELS} levels.`);
}

export async function navigateToContainingPageOfItem(store: StoreContextModel, itemId: Uid): Promise<boolean> {
  return navigateToContainingPageOfItemWithOptions(store, itemId, { focusTarget: false, fallbackToItem: false });
}

export function itemIdFromInfumapUrl(url: string): Uid | null {
  const trimmed = url.trim();
  if (trimmed == "") {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol != "infumap:") {
      return null;
    }
    if (parsed.pathname != "" && parsed.pathname != "/") {
      return null;
    }
    if (parsed.search != "" || parsed.hash != "") {
      return null;
    }

    const itemId = parsed.hostname.toLowerCase();
    return isUid(itemId) ? itemId : null;
  } catch (_e) {
    return null;
  }
}

export async function navigateToInfumapItemUrl(store: StoreContextModel, url: string): Promise<boolean> {
  const itemId = itemIdFromInfumapUrl(url);
  if (itemId == null) {
    return false;
  }
  return navigateToContainingPageOfItemWithOptions(store, itemId, { focusTarget: true, fallbackToItem: true });
}

export function switchToPage(store: StoreContextModel, pageVeid: Veid, updateHistory: boolean, clearHistory: boolean, replace: boolean, focusPath?: VisualElementPath) {
  if (isEmptyVeid(pageVeid)) {
    console.warn("switchToPage: ignored empty page veid.", { pageVeid, focusPath });
    return;
  }
  const queryChatOwnerPageId = internalQueryChatOwnerPageId(pageVeid.itemId);
  if (queryChatOwnerPageId != null) {
    console.warn("switchToPage: ignored internal query chat page veid.", { pageVeid, focusPath });
    return;
  }

  if (clearHistory) {
    store.history.setHistoryToSinglePage(pageVeid, focusPath);
  } else {
    if (replace) {
      store.history.popPageVeid();
    }
    store.history.pushPageVeid(pageVeid, focusPath);
  }

  arrangeNow(store, "switch-to-page");
  requestContainerSyncSoon(store);

  const url = currentUrl(store, null);
  if ((!replace && updateHistory) || clearHistory) {
    window.history.pushState(null, "", url);
  }
  store.currentUrlPath.set(url);
}

export async function ensureQueryItemUnderQueries(store: StoreContextModel, queriesPageId: Uid): Promise<Uid | null> {
  const queriesPageMaybe = itemState.get(queriesPageId);
  if (!queriesPageMaybe || !isPage(queriesPageMaybe)) {
    return null;
  }

  await initiateLoadChildItemsMaybe(store, { itemId: queriesPageId, linkIdMaybe: null });

  const queriesPage = asPageItem(itemState.get(queriesPageId)!);
  for (const childId of queriesPage.computed_children) {
    const childMaybe = itemState.get(childId);
    if (isQueryItem(childMaybe)) {
      const child = asQueryItem(childMaybe!);
      if (!(child.flags & SearchFlags.ListPagePinTop) || (child.flags & SearchFlags.ListPagePinBottom)) {
        child.flags &= ~SearchFlags.ListPagePinBottom;
        child.flags |= SearchFlags.ListPagePinTop;
        void server.updateItem(child, store.general.networkStatus, false);
      }
      return childId;
    }
  }

  const queryItem = QueryFns.create(
    queriesPage.ownerId,
    queriesPageId,
    RelationshipToParent.Child,
    itemState.newOrderingAtBeginningOfChildren(queriesPageId),
  );
  queryItem.flags |= SearchFlags.ListPagePinTop;
  itemState.add(queryItem);

  try {
    await server.addItem(queryItem, null, store.general.networkStatus);
    return queryItem.id;
  } catch (e) {
    console.error("Failed to create default query item under Queries page:", e);
    itemState.delete(queryItem.id);
    return null;
  }
}

export async function navigateToQueries(store: StoreContextModel): Promise<void> {
  const userMaybe = store.user.getUserMaybe();
  if (!userMaybe) { return; }
  store.overlay.autoFocusSearchInput.set(true);

  const queriesPageId = userMaybe.queriesPageId;
  let queriesPageMaybe = itemState.get(queriesPageId);
  if (!queriesPageMaybe) {
    const loadResult = await initiateLoadItemMaybe(store, queriesPageId);
    if (loadResult == InitiateLoadResult.Failed || !itemState.get(queriesPageId)) {
      return;
    }
    queriesPageMaybe = itemState.get(queriesPageId);
  }

  if (!queriesPageMaybe || !isPage(queriesPageMaybe)) {
    return;
  }

  const queriesPage = asPageItem(queriesPageMaybe);
  if (queriesPage.title == "Searches") {
    queriesPage.title = "Queries";
    void server.updateItem(queriesPage, store.general.networkStatus, false);
  }

  const queryItemId = await ensureQueryItemUnderQueries(store, queriesPageId);
  removeClientOnlyChatPagesUnderQueries(store, queriesPageId);
  if (queryItemId != null) {
    store.perItem.setSelectedListPageItem({ itemId: queriesPageId, linkIdMaybe: null }, { itemId: queryItemId, linkIdMaybe: null });
  }

  const currentPageVeid = store.history.currentPageVeid();
  if (currentPageVeid?.itemId == queriesPageId && currentPageVeid.linkIdMaybe == null) {
    arrangeNow(store, "navigate-to-queries");
    return;
  }

  switchToPage(store, { itemId: queriesPageId, linkIdMaybe: null }, true, false, false);
}


export async function navigateToLocalRoot(store: StoreContextModel): Promise<void> {
  const userMaybe = store.user.getUserMaybe();
  if (!userMaybe) {
    window.history.pushState(null, "", "/");
    store.currentUrlPath.set("/");
    return;
  }
  const user = userMaybe;
  let homePageItem = itemState.get(user.homePageId);
  if (!homePageItem) {
    const loadResult = await initiateLoadItemMaybe(store, user.homePageId);
    if (loadResult == InitiateLoadResult.Failed || !itemState.get(user.homePageId)) {
      if (user.username == ROOT_USERNAME) {
        window.location.href = "/";
      } else {
        window.location.href = `/${user.username}`;
      }
      return;
    }
    homePageItem = itemState.get(user.homePageId);
  }
  if (homePageItem) {
    switchToPage(store, { itemId: user.homePageId, linkIdMaybe: null }, false, true, false);
  }
}

export async function navigateBack(store: StoreContextModel, focusRootPageOnPopupClose: boolean = false): Promise<boolean> {
  if (store.history.currentPopupSpec() != null) {
    store.history.popPopup(focusRootPageOnPopupClose);
    const currentPageVeid = store.history.currentPageVeid();
    if (currentPageVeid) {
      const pageItem = itemState.get(currentPageVeid.itemId);
      if (pageItem && isPage(pageItem)) {
        const page = asPageItem(pageItem);
        page.pendingPopupPositionGr = null;
        page.pendingPopupWidthGr = null;
        page.pendingCellPopupPositionNorm = null;
        page.pendingCellPopupWidthNorm = null;
        // Focus is already set by popPopup() according to the caller's policy.
      }
    }
    arrangeNow(store, "navigate-back-pop-popup");

    return true;
  }

  if (store.history.peekPrevPageVeid() != null) {
    window.history.back();
    return true;
  }

  const currentPageVeid = store.history.currentPageVeid();
  if (currentPageVeid != null) {
    const currentItem = itemState.get(currentPageVeid.itemId);
    if (currentItem && currentItem.origin != null) {
      await navigateToLocalRoot(store);
      return true;
    }
  }

  return false;
}


let navigateUpInProgress = false;
export async function navigateUp(store: StoreContextModel) {
  const currentPageVeid = store.history.currentPageVeid();
  if (currentPageVeid == null) { return; }

  if (navigateUpInProgress) { return; }
  navigateUpInProgress = true;

  const userMaybe = store.user.getUserMaybe();
  if (userMaybe && currentPageVeid.itemId == userMaybe.queriesPageId && currentPageVeid.linkIdMaybe == null) {
    await navigateToLocalRoot(store);
    navigateUpInProgress = false;
    return;
  }

  const currentPage = asPageItem(itemState.get(currentPageVeid.itemId)!);
  const currentItem = itemState.get(currentPageVeid.itemId)!;
  const isRemote = currentItem.origin != null;

  const MAX_LEVELS = 8;
  let cnt = 0;
  let parentId = currentPage.parentId;

  let relationshipToParent = currentPage.relationshipToParent;

  // single cell pages are used to house non-page items at the top level.
  if (currentPage.arrangeAlgorithm == ArrangeAlgorithm.SingleCell) {
    const itemId = currentPage.computed_children[0];
    const item = itemState.get(itemId)!;
    parentId = item.parentId;
    relationshipToParent = item.relationshipToParent;
  }

  while (cnt++ < MAX_LEVELS) {
    // check if already at top.
    if (parentId == EMPTY_UID) {
      if (isRemote) {
        await navigateToLocalRoot(store);
      }
      navigateUpInProgress = false;
      return;
    }
    if (userMaybe) {
      if (parentId == userMaybe!.dockPageId) {
        if (isRemote) {
          await navigateToLocalRoot(store);
        }
        navigateUpInProgress = false;
        return;
      }
    }

    const parentPageMaybe = itemState.get(parentId);
    if (parentPageMaybe) {
      if (isRemote) {
        if (parentPageMaybe.origin !== currentItem.origin) {
          await navigateToLocalRoot(store);
          navigateUpInProgress = false;
          return;
        }
      }
      if (isPage(parentPageMaybe) && relationshipToParent === RelationshipToParent.Child) {
        switchToPage(store, { itemId: parentId, linkIdMaybe: null }, true, true, false);
        navigateUpInProgress = false;
        return;
      } else {
        parentId = parentPageMaybe.parentId;
        relationshipToParent = parentPageMaybe.relationshipToParent;
        continue;
      }
    }

    if (isRemote) {
      await navigateToLocalRoot(store);
      navigateUpInProgress = false;
      return;
    }

    if (await initiateLoadItemMaybe(store, parentId) == InitiateLoadResult.Failed ||
      !itemState.get(parentId)) {
      navigateUpInProgress = false;
      return;
    }
  }

  panic(`navigateUp: could not find page after ${MAX_LEVELS} levels.`);
}
