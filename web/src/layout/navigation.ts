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
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { itemState } from "../store/ItemState";
import { UserStoreContextModel } from "../store/UserStoreProvider";
import { panic } from "../util/lang";
import { EMPTY_UID } from "../util/uid";
import { arrange } from "./arrange";
import { initiateLoadItemMaybe } from "./load";
import { Veid } from "./visual-element";


export function updateHref(desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel) {
  const userMaybe = userStore.getUserMaybe();
  if (!userMaybe) {
    window.history.pushState(null, "", `/${desktopStore.currentPage()!.itemId}`);
  } else {
    const user = userMaybe;
    if (desktopStore.currentPage()!.itemId != user.homePageId) {
      window.history.pushState(null, "", `/${desktopStore.currentPage()!.itemId}`);
    } else {
      if (user.username == ROOT_USERNAME) {
        window.history.pushState(null, "", "/");
      } else {
        window.history.pushState(null, "", `/${user.username}`);
      }
    }
  }
}


export function switchToPage(desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel, pageVeid: Veid, updateHistory: boolean, clearHistory: boolean) {
  if (clearHistory) {
    desktopStore.setHistoryToSinglePage(pageVeid);
  } else {
    desktopStore.pushPage(pageVeid);
  }

  arrange(desktopStore);

  setTopLevelPageScrollPositions(desktopStore);

  if (updateHistory) {
    updateHref(desktopStore, userStore);
  }
}


export function navigateBack(desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel): boolean {
  if (desktopStore.currentPopupSpec() != null) {
    desktopStore.popPopup();
    const page = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
    page.pendingPopupAlignmentPoint = null;
    page.pendingPopupPositionGr = null;
    page.pendingPopupWidthGr = null;
    arrange(desktopStore);
    return true;
  }

  const changePages = desktopStore.popPage();
  if (changePages) {
    updateHref(desktopStore, userStore);
    arrange(desktopStore);
    setTopLevelPageScrollPositions(desktopStore);
    return true;
  }

  return false;
}


let navigateUpInProgress = false;
export async function navigateUp(desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel) {
  const currentPageVeid = desktopStore.currentPage();
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
        switchToPage(desktopStore, userStore, { itemId: parentId, linkIdMaybe: null }, true, true);
        navigateUpInProgress = false;
        return;
      } else {
        parentId = parentPageMaybe!.parentId;
        continue;
      }
    }

    await initiateLoadItemMaybe(desktopStore, parentId);
  }

  panic(`navigateUp: could not find page after ${MAX_LEVELS} levels.`);
}


export function setTopLevelPageScrollPositions(desktopStore: DesktopStoreContextModel) {
  let rootPageDiv = window.document.getElementById("rootPageDiv")!;
  let veid = desktopStore.currentPage()!;

  const topLevelVisualElement = desktopStore.topLevelVisualElementSignal().get();
  const topLevelBoundsPx = topLevelVisualElement.childAreaBoundsPx!;
  const desktopSizePx = desktopStore.desktopBoundsPx();

  const scrollXPx = desktopStore.getPageScrollXProp(veid) * (topLevelBoundsPx.w - desktopSizePx.w);
  const scrollYPx = desktopStore.getPageScrollYProp(veid) * (topLevelBoundsPx.h - desktopSizePx.h);

  if (rootPageDiv) {
    rootPageDiv.scrollTop = scrollYPx;
    rootPageDiv.scrollLeft = scrollXPx;
  }
}
