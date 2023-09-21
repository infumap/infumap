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

import { GRID_PAGE_CELL_ASPECT } from "../../constants";
import { ItemFns } from "../../items/base/item-polymorphism";
import { ArrangeAlgorithm, asPageItem } from "../../items/page-item";
import { DesktopStoreContextModel, PopupType } from "../../store/DesktopStoreProvider";
import { itemState } from "../../store/ItemState";
import { cloneBoundingBox } from "../../util/geometry";
import { panic } from "../../util/lang";
import { VesCache } from "../ves-cache";
import { VisualElementFlags, VisualElementSpec } from "../visual-element";
import { arrangeItem } from "./arrange";
import { arrangeCellPopup } from "./popup";


export const arrange_grid = (desktopStore: DesktopStoreContextModel): void => {
  VesCache.initFullArrange();

  const currentPage = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  const currentPath = currentPage.id;

  const pageBoundsPx = desktopStore.desktopBoundsPx();

  const numCols = currentPage.gridNumberOfColumns;
  const numRows = Math.ceil(currentPage.computed_children.length / numCols);
  const cellWPx = pageBoundsPx.w / numCols;
  const cellHPx = cellWPx * (1.0/GRID_PAGE_CELL_ASPECT);
  const marginPx = cellWPx * 0.01;
  const pageHeightPx = numRows * cellHPx;
  const boundsPx = (() => {
    const result = cloneBoundingBox(pageBoundsPx)!;
    result.h = pageHeightPx;
    return result;
  })();

  const topLevelVisualElementSpec: VisualElementSpec = {
    displayItem: currentPage,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren,
    boundsPx: boundsPx,
    childAreaBoundsPx: boundsPx,
  };

  const children = [];
  for (let i=0; i<currentPage.computed_children.length; ++i) {
    const item = itemState.get(currentPage.computed_children[i])!;
    const col = i % numCols;
    const row = Math.floor(i / numCols);
    const cellBoundsPx = {
      x: col * cellWPx + marginPx,
      y: row * cellHPx + marginPx,
      w: cellWPx - marginPx * 2.0,
      h: cellHPx - marginPx * 2.0
    };

    const geometry = ItemFns.calcGeometry_InCell(item, cellBoundsPx);
    const ves = arrangeItem(desktopStore, currentPath, ArrangeAlgorithm.Grid, item, geometry, true, false, false);
    children.push(ves);
  }

  const currentPopupSpec = desktopStore.currentPopupSpec();
  if (currentPopupSpec != null) {
    if (currentPopupSpec.type == PopupType.Page) {
      children.push(arrangeCellPopup(desktopStore));
    } else if (currentPopupSpec.type == PopupType.Attachment) {
      // Ves are created inline.
    } else if (currentPopupSpec.type == PopupType.Image) {
      children.push(arrangeCellPopup(desktopStore));
    } else {
      panic();
    }
  }

  topLevelVisualElementSpec.children = children;

  VesCache.finalizeFullArrange(topLevelVisualElementSpec, currentPath, desktopStore);
}


