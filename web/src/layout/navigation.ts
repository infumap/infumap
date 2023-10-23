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
import { asPageItem } from "../items/page-item";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { itemState } from "../store/ItemState";
import { UserStoreContextModel } from "../store/UserStoreProvider";
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


export function switchToPage(desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel, veid: Veid, updateHistory: boolean) {
  desktopStore.pushPage(veid);
  arrange(desktopStore);

  let desktopEl = window.document.getElementById("desktop")!;

  const topLevelVisualElement = desktopStore.topLevelVisualElementSignal().get();
  const topLevelBoundsPx = topLevelVisualElement.boundsPx;
  const desktopSizePx = desktopStore.desktopBoundsPx();

  const scrollXPx = desktopStore.getPageScrollXProp(desktopStore.currentPage()!) * (topLevelBoundsPx.w - desktopSizePx.w);
  const scrollYPx = desktopStore.getPageScrollYProp(desktopStore.currentPage()!) * (topLevelBoundsPx.h - desktopSizePx.h)

  if (desktopEl) {
    desktopEl.scrollTop = scrollYPx;
    desktopEl.scrollLeft = scrollXPx;
  }

  if (updateHistory) {
    updateHref(desktopStore, userStore);
  }
}


export function navigateBack(desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel) {
  if (desktopStore.currentPopupSpec() != null) {
    desktopStore.popPopup();
    const page = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
    page.pendingPopupAlignmentPoint = null;
    page.pendingPopupPositionGr = null;
    page.pendingPopupWidthGr = null;
    arrange(desktopStore);
    return;
  }

  desktopStore.popPage();
  updateHref(desktopStore, userStore);
  arrange(desktopStore);
}


export async function navigateUp(desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel) {
  const currentPageVeid = desktopStore.currentPage();
  if (currentPageVeid == null) { return; }
  const currentPage = itemState.get(currentPageVeid.itemId)!;
  const parentId = currentPage.parentId;
  if (parentId == EMPTY_UID) {
    // already at top.
    return;
  }
  const parentPage = itemState.get(parentId);
  if (parentPage != null) {
    switchToPage(desktopStore, userStore, { itemId: parentId, linkIdMaybe: null }, true);
    return;
  }

  await initiateLoadItemMaybe(desktopStore, parentId);
  switchToPage(desktopStore, userStore, { itemId: parentId, linkIdMaybe: null }, true);
}
