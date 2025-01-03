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
import { panic } from "../util/lang";
import { EMPTY_UID } from "../util/uid";
import { fArrange } from "./arrange";
import { initiateLoadItemMaybe, InitiateLoadResult } from "./load";
import { Veid } from "./visual-element";


export function switchToNonPage(store: StoreContextModel, url: string) {
  window.history.pushState(null, "", url);
  store.currentUrlPath.set(url);
}

function updateHrefToReflectCurrentPage(store: StoreContextModel) {
  const userMaybe = store.user.getUserMaybe();
  if (!userMaybe) {
    const url = `/${store.history.currentPageVeid()!.itemId}`;
    window.history.pushState(null, "", url);
    store.currentUrlPath.set(url);
  } else {
    const user = userMaybe;
    if (store.history.currentPageVeid()!.itemId != user.homePageId) {
      const url = `/${store.history.currentPageVeid()!.itemId}`;
      window.history.pushState(null, "", url);
      store.currentUrlPath.set(url);
    } else {
      if (user.username == ROOT_USERNAME) {
        const url = "/";
        window.history.pushState(null, "", url);
        store.currentUrlPath.set(url);
      } else {
        const url = `/${user.username}`;
        window.history.pushState(null, "", url);
        store.currentUrlPath.set(url);
      }
    }
  }
}


export function switchToPage(store: StoreContextModel, pageVeid: Veid, updateHistory: boolean, clearHistory: boolean, replace: boolean) {
  if (clearHistory) {
    store.history.setHistoryToSinglePage(pageVeid);
  } else {
    if (replace) {
      store.history.popPageVeid();
    }
    store.history.pushPageVeid(pageVeid);
  }

  fArrange(store);

  if (!replace && updateHistory) {
    updateHrefToReflectCurrentPage(store);
  }
}


export function navigateBack(store: StoreContextModel): boolean {
  if (store.history.currentPopupSpec() != null) {
    store.history.popPopup();
    const page = asPageItem(itemState.get(store.history.currentPageVeid()!.itemId)!);
    page.pendingPopupAlignmentPoint = null;
    page.pendingPopupPositionGr = null;
    page.pendingPopupWidthGr = null;
    fArrange(store);
    return true;
  }

  const changePages = store.history.popPageVeid();
  if (changePages) {
    updateHrefToReflectCurrentPage(store);
    if (!store.history.currentPopupSpec()) {
      store.history.setFocus(store.history.currentPagePath()!);
    }
    fArrange(store);
    return true;
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

  const MAX_LEVELS = 8;
  let cnt = 0;
  let parentId = currentPage.parentId;

  if (currentPage.arrangeAlgorithm == ArrangeAlgorithm.SingleCell) {
    parentId = currentPage.computed_children[0]
  }

  while (cnt++ < MAX_LEVELS) {
    // check if already at top.
    if (parentId == EMPTY_UID) {
      navigateUpInProgress = false;
      return;
    }
    const userMaybe = store.user.getUserMaybe();
    if (userMaybe) {
      if (parentId == userMaybe!.dockPageId) {
        navigateUpInProgress = false;
        return;
      }
    }

    const parentPageMaybe = itemState.get(parentId);
    if (parentPageMaybe != null) {
      if (isPage(parentPageMaybe)) {
        switchToPage(store, { itemId: parentId, linkIdMaybe: null }, true, true, false);
        navigateUpInProgress = false;
        return;
      } else {
        parentId = parentPageMaybe!.parentId;
        continue;
      }
    }

    if (await initiateLoadItemMaybe(store, parentId) == InitiateLoadResult.Failed ||
        !itemState.get(parentId)) {
      navigateUpInProgress = false;
      return;
    }
  }

  panic(`navigateUp: could not find page after ${MAX_LEVELS} levels.`);
}
