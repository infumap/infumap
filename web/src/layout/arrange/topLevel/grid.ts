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

import { GRID_PAGE_CELL_ASPECT, GRID_SIZE, LINE_HEIGHT_PX } from "../../../constants";
import { ItemFns } from "../../../items/base/item-polymorphism";
import { LinkFns } from "../../../items/link-item";
import { ArrangeAlgorithm, PageFns, asPageItem } from "../../../items/page-item";
import { CursorEventState, MouseAction, MouseActionState } from "../../../input/state";
import { DesktopStoreContextModel, PopupType } from "../../../store/DesktopStoreProvider";
import { itemState } from "../../../store/ItemState";
import { cloneBoundingBox } from "../../../util/geometry";
import { panic } from "../../../util/lang";
import { VisualElementSignal } from "../../../util/signals";
import { newUid } from "../../../util/uid";
import { RelationshipToParent } from "../../relationship-to-parent";
import { VesCache } from "../../ves-cache";
import { VeFns, VisualElementFlags, VisualElementSpec } from "../../visual-element";
import { arrangeItem } from "../item";
import { arrangeCellPopup } from "../popup";


const PAGE_TITLE_UID = newUid();

export const arrange_grid = (desktopStore: DesktopStoreContextModel): void => {
  VesCache.initFullArrange();

  const currentPage = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  const currentPath = currentPage.id;

  let movingItem = null;
  let movingItemInThisPage = null;
  if (!MouseActionState.empty() && (MouseActionState.get().action == MouseAction.Moving)) {
    const veid = VeFns.veidFromPath(MouseActionState.get().activeElement);
    if (veid.linkIdMaybe) {
      movingItemInThisPage = itemState.get(veid.linkIdMaybe);
    } else {
      movingItemInThisPage = itemState.get(veid.itemId);
    }
    movingItem = movingItemInThisPage;
    if (movingItemInThisPage!.parentId != currentPage.id) {
      movingItemInThisPage = null;
    }
  }

  const pageBoundsPx = desktopStore.desktopBoundsPx();

  const headingMarginPx = LINE_HEIGHT_PX * PageFns.pageTitleStyle().lineHeightMultiplier;

  const numCols = currentPage.gridNumberOfColumns;

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
  const cellHPx = cellWPx * (1.0/GRID_PAGE_CELL_ASPECT);
  const marginPx = cellWPx * 0.01;
  const pageHeightPx = numRows * cellHPx + headingMarginPx;
  const boundsPx = (() => {
    const result = cloneBoundingBox(pageBoundsPx)!;
    result.h = pageHeightPx;
    return result;
  })();

  const topLevelVisualElementSpec: VisualElementSpec = {
    displayItem: currentPage,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren,
    boundsPx: desktopStore.desktopBoundsPx(),
    childAreaBoundsPx: boundsPx,
  };

  // TODO (HIGH): add related hitboxes.
  // Do this here rather than in the component, as the hitboxes need to be in the visual element tree for mouse interaction.
  const geometry = PageFns.calcGeometry_GridPageTitle(desktopStore, currentPage, boundsPx);
  topLevelVisualElementSpec.titleBoundsPx = geometry.boundsPx;

  const children = [];

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
      y: row * cellHPx + marginPx + headingMarginPx,
      w: cellWPx - marginPx * 2.0,
      h: cellHPx - marginPx * 2.0
    };

    if (movingItem != null && item.id == movingItem.id) {
      // TODO (placeholder).
    } else {
      const geometry = ItemFns.calcGeometry_InCell(item, cellBoundsPx, false, false, false);
      const ves = arrangeItem(desktopStore, currentPath, ArrangeAlgorithm.Grid, item, geometry, true, false, false);
      children.push(ves);
    }
  }

  if (movingItem) {
    const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItem);
    const mouseDestkopPosPx = CursorEventState.getLastestDesktopPx();
    const cellBoundsPx = {
      x: mouseDestkopPosPx.x,
      y: mouseDestkopPosPx.y,
      w: dimensionsBl.w * LINE_HEIGHT_PX,
      h: dimensionsBl.h * LINE_HEIGHT_PX,
    };
    cellBoundsPx.x -= MouseActionState.get().clickOffsetProp!.x * cellBoundsPx.w;
    cellBoundsPx.y -= MouseActionState.get().clickOffsetProp!.y * cellBoundsPx.h;
    const geometry = ItemFns.calcGeometry_InCell(movingItem, cellBoundsPx, false, false, false);
    const ves = arrangeItem(desktopStore, currentPath, ArrangeAlgorithm.Grid, movingItem, geometry, true, false, false);
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
      panic(`arrange_grid: unknown popup type: ${currentPopupSpec.type}.`);
    }
  }

  topLevelVisualElementSpec.children = children;

  VesCache.finalizeFullArrange(topLevelVisualElementSpec, currentPath, desktopStore);
}
