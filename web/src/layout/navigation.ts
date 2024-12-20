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
import { asPageItem, isPage } from "../items/page-item";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { panic } from "../util/lang";
import { EMPTY_UID } from "../util/uid";
import { fArrange } from "./arrange";
import { initiateLoadItemMaybe } from "./load";
import { Veid } from "./visual-element";


export function updateHref(store: StoreContextModel) {
  const userMaybe = store.user.getUserMaybe();
  if (!userMaybe) {
    window.history.pushState(null, "", `/${store.history.currentPageVeid()!.itemId}`);
  } else {
    const user = userMaybe;
    if (store.history.currentPageVeid()!.itemId != user.homePageId) {
      window.history.pushState(null, "", `/${store.history.currentPageVeid()!.itemId}`);
    } else {
      if (user.username == ROOT_USERNAME) {
        window.history.pushState(null, "", "/");
      } else {
        window.history.pushState(null, "", `/${user.username}`);
      }
    }
  }
}


export function switchToPage(store: StoreContextModel, pageVeid: Veid, updateHistory: boolean, clearHistory: boolean, replace: boolean) {
  if (clearHistory) {
    store.history.setHistoryToSinglePage(pageVeid);
  } else {
    if (replace) {
      store.history.popPage();
    }
    store.history.pushPageVeid(pageVeid);
  }

  fArrange(store);

  if (!replace && updateHistory) {
    updateHref(store);
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

  const changePages = store.history.popPage();
  if (changePages) {
    updateHref(store);
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

  const currentPage = itemState.get(currentPageVeid.itemId)!;

  const MAX_LEVELS = 8;
  let cnt = 0;
  let parentId = currentPage.parentId;
  while (cnt++ < MAX_LEVELS) {
    if (parentId == EMPTY_UID || parentId == store.user.getUser().dockPageId) {
      // already at top.
      navigateUpInProgress = false;
      return;
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

    await initiateLoadItemMaybe(store, parentId);
  }

  panic(`navigateUp: could not find page after ${MAX_LEVELS} levels.`);
}
