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

import { LINE_HEIGHT_PX } from "../../../constants";
import { ItemFns } from "../../../items/base/item-polymorphism";
import { ArrangeAlgorithm, asPageItem } from "../../../items/page-item";
import { CursorEventState, MouseAction, MouseActionState } from "../../../input/state";
import { StoreContextModel } from "../../../store/StoreProvider";
import { itemState } from "../../../store/ItemState";
import { cloneBoundingBox } from "../../../util/geometry";
import { panic } from "../../../util/lang";
import { VesCache } from "../../ves-cache";
import { VeFns, VisualElementFlags, VisualElementSpec } from "../../visual-element";
import { arrangeItem } from "../item";
import { arrangeCellPopup } from "../popup";
import { PopupType } from "../../../store/StoreProvider_History";
import { renderDockMaybe } from ".";


export const arrange_grid = (store: StoreContextModel): void => {
  VesCache.initFullArrange();

  const currentPage = asPageItem(itemState.get(store.history.currentPage()!.itemId)!);
  const currentPath = currentPage.id;

  const pageBoundsPx = store.desktopMainAreaBoundsPx();

  const numCols = currentPage.gridNumberOfColumns;

  let movingItem = null;
  if (!MouseActionState.empty() && (MouseActionState.get().action == MouseAction.Moving)) {
    movingItem = VeFns.canonicalItemFromPath(MouseActionState.get().activeElement);
  }

  // if an item is moving out of or in a grid page, then ensure the height of the grid page doesn't
  // change until after the move is complete to avoid a very distruptive jump in y scroll px.
  let nItemAdj = 0;
  if (movingItem && !MouseActionState.get().linkCreatedOnMoveStart) {
    const startParentVes = VesCache.get(MouseActionState.get().startActiveElementParent)!;
    const startParent = startParentVes.get().displayItem;
    if (startParent.id == currentPage.id && movingItem!.parentId != startParent.id) {
      nItemAdj = 1;
    }
  }

  const numRows = Math.ceil((currentPage.computed_children.length + nItemAdj) / numCols);
  const cellWPx = pageBoundsPx.w / numCols;
  const cellHPx = cellWPx * (1.0/currentPage.gridCellAspect);
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
    boundsPx: store.desktopMainAreaBoundsPx(),
    childAreaBoundsPx: boundsPx,
  };

  const childrenVes = [];

  let idx = 0;
  for (let i=0; i<currentPage.computed_children.length; ++i) {
    const item = itemState.get(currentPage.computed_children[i])!;
    if (movingItem && item.id == movingItem!.id) {
      continue;
    }
    const col = idx % numCols;
    const row = Math.floor(idx / numCols);
    idx += 1;
    const cellBoundsPx = {
      x: col * cellWPx + marginPx,
      y: row * cellHPx + marginPx,
      w: cellWPx - marginPx * 2.0,
      h: cellHPx - marginPx * 2.0
    };

    const geometry = ItemFns.calcGeometry_InCell(item, cellBoundsPx, false, false, false, false, false);
    const ves = arrangeItem(store, currentPath, ArrangeAlgorithm.Grid, item, geometry, true, false, false, false, false);
    childrenVes.push(ves);
  }

  if (movingItem) {
    const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItem);
    const mouseDestkopPosPx = CursorEventState.getLatestDesktopPx();
    const cellBoundsPx = {
      x: mouseDestkopPosPx.x,
      y: mouseDestkopPosPx.y,
      w: dimensionsBl.w * LINE_HEIGHT_PX,
      h: dimensionsBl.h * LINE_HEIGHT_PX,
    };
    cellBoundsPx.x -= MouseActionState.get().clickOffsetProp!.x * cellBoundsPx.w;
    cellBoundsPx.y -= MouseActionState.get().clickOffsetProp!.y * cellBoundsPx.h;
    const geometry = ItemFns.calcGeometry_InCell(movingItem, cellBoundsPx, false, false, false, false, false);
    const ves = arrangeItem(store, currentPath, ArrangeAlgorithm.Grid, movingItem, geometry, true, false, false, false, false);
    childrenVes.push(ves);
  }

  const dockVesMaybe = renderDockMaybe(store, currentPath);
  if (dockVesMaybe) {
    topLevelVisualElementSpec.dockVes = dockVesMaybe;
  }

  const currentPopupSpec = store.history.currentPopupSpec();
  if (currentPopupSpec != null) {
    if (currentPopupSpec.type == PopupType.Page) {
      topLevelVisualElementSpec.popupVes = arrangeCellPopup(store);
    } else if (currentPopupSpec.type == PopupType.Attachment) {
      // Ves are created inline.
    } else if (currentPopupSpec.type == PopupType.Image) {
      topLevelVisualElementSpec.popupVes = arrangeCellPopup(store);
    } else {
      panic(`arrange_grid: unknown popup type: ${currentPopupSpec.type}.`);
    }
  }

  topLevelVisualElementSpec.childrenVes = childrenVes;

  VesCache.finalizeFullArrange(topLevelVisualElementSpec, currentPath, store);
}
