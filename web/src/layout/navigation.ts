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
import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { assert, panic } from "../util/lang";
import { EMPTY_UID, SOLO_ITEM_HOLDER_PAGE_UID, Uid } from "../util/uid";
import { fullArrange } from "./arrange";
import { initiateLoadItemMaybe, InitiateLoadResult } from "./load";
import { VeFns, Veid, VisualElementPath } from "./visual-element";
import { RelationshipToParent } from "./relationship-to-parent";


export function switchToNonPage(store: StoreContextModel, url: string) {
  window.history.pushState(null, "", url);
  store.currentUrlPath.set(url);
}

function currentUrl(store: StoreContextModel, overrideItemId: Uid | null): string {
  const currentVeid = store.history.currentPageVeid();
  const itemId = overrideItemId ?? currentVeid?.itemId;
  if (!itemId) {
    return "/";
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
  fullArrange(store);

  const url = currentUrl(store, itemId);
  window.history.pushState(null, "", url);
  store.currentUrlPath.set(url);
}

export function switchToPage(store: StoreContextModel, pageVeid: Veid, updateHistory: boolean, clearHistory: boolean, replace: boolean, focusPath?: VisualElementPath) {
  if (clearHistory) {
    store.history.setHistoryToSinglePage(pageVeid, focusPath);
  } else {
    if (replace) {
      store.history.popPageVeid();
    }
    store.history.pushPageVeid(pageVeid, focusPath);
  }

  fullArrange(store);

  const url = currentUrl(store, null);
  if ((!replace && updateHistory) || clearHistory) {
    window.history.pushState(null, "", url);
  }
  store.currentUrlPath.set(url);
}


async function navigateToLocalRoot(store: StoreContextModel): Promise<void> {
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

export async function navigateBack(store: StoreContextModel): Promise<boolean> {
  if (store.history.currentPopupSpec() != null) {
    store.history.popPopup();
    const currentPageVeid = store.history.currentPageVeid();
    if (currentPageVeid) {
      const pageItem = itemState.get(currentPageVeid.itemId);
      if (pageItem && isPage(pageItem)) {
        const page = asPageItem(pageItem);
        page.pendingPopupPositionGr = null;
        page.pendingPopupWidthGr = null;
        page.pendingCellPopupPositionNorm = null;
        page.pendingCellPopupWidthNorm = null;
      }
    }
    fullArrange(store);

    // After popup is closed and arrange is done, adjust focus appropriately.
    // For list pages, focus should go to the innermost nested page.
    // For non-list pages, focus should go to the root page.
    const afterArrangePageVeid = store.history.currentPageVeid();
    if (afterArrangePageVeid) {
      const afterArrangePageItem = itemState.get(afterArrangePageVeid.itemId);
      if (afterArrangePageItem && isPage(afterArrangePageItem)) {
        const topPages = store.topTitledPages.get();
        if (topPages.length > 0) {
          if (asPageItem(afterArrangePageItem).arrangeAlgorithm === ArrangeAlgorithm.List) {
            // For list pages, focus on the innermost nested page (last in topTitledPages)
            const innermostPagePath = topPages[topPages.length - 1];
            store.history.setFocus(innermostPagePath);
          } else {
            // For non-list pages, focus on the root page
            const rootPagePath = topPages[0];
            store.history.setFocus(rootPagePath);
          }
          // Re-arrange to update focusedChildItemMaybe (which controls the separator line)
          fullArrange(store);
        }
      }
    }

    return true;
  }

  if (store.history.peekPrevPageVeid() != null) {
    window.history.back();
    fullArrange(store);
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
    const userMaybe = store.user.getUserMaybe();
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
