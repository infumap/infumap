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

import { asPageItem } from "../items/page-item";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { itemState } from "../store/ItemState";
import { EMPTY_UID } from "../util/uid";
import { ARRANGE_ALGO_LIST, arrange } from "./arrange";
import { Veid, prependVeidToPath, veidFromId } from "./visual-element";


export function updateHref(desktopStore: DesktopStoreContextModel) {
  if (itemState.getItem(desktopStore.currentPage()!.itemId)?.parentId == EMPTY_UID) {
    window.history.pushState(null, "", "/"); 
  } else {
    window.history.pushState(null, "", `/items/${desktopStore.currentPage()!.itemId}`);
  }
}

export const switchToPage = (desktopStore: DesktopStoreContextModel, veid: Veid) => {
  desktopStore.pushPage(veid);
  arrange(desktopStore);

  const currentPage = asPageItem(itemState.getItem(veid.itemId)!);
  if (currentPage.arrangeAlgorithm == ARRANGE_ALGO_LIST) {
    if (desktopStore.getSelectedListPageItem(veid) == "") {
      if (currentPage.computed_children.length > 0) {
        const firstItemId = currentPage.computed_children[0];
        const veid = veidFromId(firstItemId);
        const path = prependVeidToPath(veid, currentPage.id);
        desktopStore.setSelectedListPageItem(desktopStore.currentPage()!, path);
      }
    }
  }

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

  updateHref(desktopStore);
}
