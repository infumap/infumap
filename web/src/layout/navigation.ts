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
import { arrange } from "./arrange";
import { initiateLoadItemMaybe } from "./load";
import { Veid } from "./visual-element";


export function updateHref(store: StoreContextModel) {
  const userMaybe = store.userStore.getUserMaybe();
  if (!userMaybe) {
    window.history.pushState(null, "", `/${store.currentPage()!.itemId}`);
  } else {
    const user = userMaybe;
    if (store.currentPage()!.itemId != user.homePageId) {
      window.history.pushState(null, "", `/${store.currentPage()!.itemId}`);
    } else {
      if (user.username == ROOT_USERNAME) {
        window.history.pushState(null, "", "/");
      } else {
        window.history.pushState(null, "", `/${user.username}`);
      }
    }
  }
}


export function switchToPage(store: StoreContextModel, pageVeid: Veid, updateHistory: boolean, clearHistory: boolean) {
  if (clearHistory) {
    store.setHistoryToSinglePage(pageVeid);
  } else {
    store.pushPage(pageVeid);
  }

  arrange(store);

  setTopLevelPageScrollPositions(store);

  if (updateHistory) {
    updateHref(store);
  }
}


export function navigateBack(store: StoreContextModel): boolean {
  if (store.currentPopupSpec() != null) {
    store.popPopup();
    const page = asPageItem(itemState.get(store.currentPage()!.itemId)!);
    page.pendingPopupAlignmentPoint = null;
    page.pendingPopupPositionGr = null;
    page.pendingPopupWidthGr = null;
    arrange(store);
    return true;
  }

  const changePages = store.popPage();
  if (changePages) {
    updateHref(store);
    arrange(store);
    setTopLevelPageScrollPositions(store);
    return true;
  }

  return false;
}


let navigateUpInProgress = false;
export async function navigateUp(store: StoreContextModel) {
  const currentPageVeid = store.currentPage();
  if (currentPageVeid == null) { return; }

  if (navigateUpInProgress) { return; }
  navigateUpInProgress = true;

  const currentPage = itemState.get(currentPageVeid.itemId)!;

  const MAX_LEVELS = 8;
  let cnt = 0;
  let parentId = currentPage.parentId;
  while (cnt++ < MAX_LEVELS) {
    if (parentId == EMPTY_UID) {
      // already at top.
      navigateUpInProgress = false;
      return;
    }

    const parentPageMaybe = itemState.get(parentId);
    if (parentPageMaybe != null) {
      if (isPage(parentPageMaybe)) {
        switchToPage(store, { itemId: parentId, linkIdMaybe: null }, true, true);
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


export function setTopLevelPageScrollPositions(store: StoreContextModel) {
  let rootPageDiv = window.document.getElementById("rootPageDiv")!;
  let veid = store.currentPage()!;

  const topLevelVisualElement = store.topLevelVisualElement.get();
  const topLevelBoundsPx = topLevelVisualElement.childAreaBoundsPx!;
  const desktopSizePx = store.desktopBoundsPx();

  const scrollXPx = store.getPageScrollXProp(veid) * (topLevelBoundsPx.w - desktopSizePx.w);
  const scrollYPx = store.getPageScrollYProp(veid) * (topLevelBoundsPx.h - desktopSizePx.h);

  if (rootPageDiv) {
    rootPageDiv.scrollTop = scrollYPx;
    rootPageDiv.scrollLeft = scrollXPx;
  }
}
