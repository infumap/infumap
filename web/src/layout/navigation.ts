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
import { RelationshipToParent } from "./relationship-to-parent";


export function switchToNonPage(store: StoreContextModel, url: string) {
  window.history.pushState(null, "", url);
  store.currentUrlPath.set(url);
}

function currentUrl(store: StoreContextModel): string {
  const userMaybe = store.user.getUserMaybe();
  let url = null;
  if (!userMaybe) {
    url = `/${store.history.currentPageVeid()!.itemId}`;
  } else {
    const user = userMaybe;
    if (store.history.currentPageVeid()!.itemId != user.homePageId) {
      url = `/${store.history.currentPageVeid()!.itemId}`;
    } else {
      if (user.username == ROOT_USERNAME) {
        url = "/";
      } else {
        url = `/${user.username}`;
      }
    }
  }
  return url;
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

  const url = currentUrl(store);
  if (!replace && updateHistory) {
    window.history.pushState(null, "", url);
  }
  store.currentUrlPath.set(url);
}


export function navigateBack(store: StoreContextModel): boolean {
  if (store.history.currentPopupSpec() != null) {
    store.history.popPopup();
    const page = asPageItem(itemState.get(store.history.currentPageVeid()!.itemId)!);
    page.pendingPopupAlignmentPoint = null;
    page.pendingPopupPositionGr = null;
    page.pendingPopupWidthGr = null;
    store.history.setFocus(store.history.currentPagePath()!);
    fArrange(store);
    return true;
  }

  if (store.history.peekPrevPageVeid() != null) {
    // console.debug("navigateBack: calling back from current url page", currentUrl(store));
    window.history.back();
    store.history.setFocus(store.history.currentPagePath()!);
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
      if (isPage(parentPageMaybe) && relationshipToParent == RelationshipToParent.Child) {
        switchToPage(store, { itemId: parentId, linkIdMaybe: null }, true, true, false);
        navigateUpInProgress = false;
        return;
      } else {
        parentId = parentPageMaybe!.parentId;
        relationshipToParent = parentPageMaybe.relationshipToParent;
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
