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

import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { isSearch } from "../items/search-item";
import { VesCache } from "../layout/ves-cache";
import { VeFns } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { BorderType, borderColorForColorIdx } from "../style";
import { BoundingBox } from "./geometry";


export const SEARCH_FOCUS_CHROME_WIDTH_PX = 2;

export interface SearchFocusChromeSpec {
  currentPagePath: string,
  searchVePath: string,
  desktopBoundsPx: BoundingBox,
  borderColor: string,
  borderWidthPx: number,
}

export function getFocusedSearchWorkspaceChromeSpec(store: StoreContextModel): SearchFocusChromeSpec | null {
  const currentPagePath = store.history.currentPagePath();
  const focusPath = store.history.getFocusPathMaybe();
  if (!currentPagePath || !focusPath) {
    return null;
  }

  const currentPageVe = VesCache.render.getNode(currentPagePath)?.get() ?? null;
  const focusVe = VesCache.render.getNode(focusPath)?.get() ?? null;
  if (!currentPageVe || !focusVe) {
    return null;
  }
  if (!isPage(currentPageVe.displayItem) || asPageItem(currentPageVe.displayItem).arrangeAlgorithm != ArrangeAlgorithm.List) {
    return null;
  }
  if (focusVe.parentPath != currentPagePath || !isSearch(focusVe.displayItem)) {
    return null;
  }

  const currentPage = asPageItem(currentPageVe.displayItem);
  return {
    currentPagePath,
    searchVePath: VeFns.veToPath(focusVe),
    desktopBoundsPx: VeFns.veBoundsRelativeToDesktopPx(store, focusVe),
    borderColor: borderColorForColorIdx(currentPage.backgroundColorIndex, BorderType.MainPage),
    borderWidthPx: SEARCH_FOCUS_CHROME_WIDTH_PX,
  };
}
