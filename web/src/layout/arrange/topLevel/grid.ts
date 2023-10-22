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
import { LinkFns, isLink } from "../../../items/link-item";
import { ArrangeAlgorithm, PageFns, asPageItem } from "../../../items/page-item";
import { LastMouseMoveEventState, MouseAction, MouseActionState } from "../../../mouse/state";
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
  if (!MouseActionState.empty()) {
    if (MouseActionState.get().action & MouseAction.Moving) {
      const veid = VeFns.veidFromPath(MouseActionState.get().activeElement);
      if (veid.linkIdMaybe) {
        movingItem = itemState.get(veid.linkIdMaybe);
      } else {
        movingItem = itemState.get(veid.itemId);
      }
    }
  }

  const pageBoundsPx = desktopStore.desktopBoundsPx();

  const headingMarginPx = LINE_HEIGHT_PX * PageFns.pageTitleStyle().lineHeightMultiplier;

  const numCols = currentPage.gridNumberOfColumns;
  const numRows = Math.ceil((currentPage.computed_children.length - (movingItem == null ? 0 : 1)) / numCols);
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
    boundsPx: boundsPx,
    childAreaBoundsPx: boundsPx,
  };

  function arrangePageTitle(): VisualElementSignal {
    const pageTitleDimensionsBl = PageFns.calcTitleSpatialDimensionsBl(currentPage);

    const li = LinkFns.create(currentPage.ownerId, currentPage.id, RelationshipToParent.Child, itemState.newOrderingAtBeginningOfChildren(currentPage.id), currentPage.id!);
    li.id = PAGE_TITLE_UID;
    li.spatialWidthGr = pageTitleDimensionsBl.w * GRID_SIZE;
    li.spatialPositionGr = { x: 0, y: 0 };

    const geometry = PageFns.calcGeometry_GridPageTitle(desktopStore, currentPage, boundsPx);

    const pageTitleElementSpec: VisualElementSpec = {
      displayItem: currentPage,
      linkItemMaybe: li,
      flags: VisualElementFlags.PageTitle,
      boundsPx: geometry.boundsPx,
      hitboxes: geometry.hitboxes,
      parentPath: currentPath,
    };

    const pageTitlePath = VeFns.addVeidToPath({ itemId: currentPage.id, linkIdMaybe: PAGE_TITLE_UID }, currentPath);
    return VesCache.createOrRecycleVisualElementSignal(pageTitleElementSpec, pageTitlePath);
  }

  const children = [];

  children.push(arrangePageTitle());

  let passedMoving = false;
  for (let i=0; i<currentPage.computed_children.length; ++i) {
    const item = itemState.get(currentPage.computed_children[i])!;
    if (movingItem != null && item.id == movingItem.id) {
      passedMoving = true;
      continue;
    }

    const adjustedI = i - (passedMoving ? 1 : 0);
    const col = adjustedI % numCols;
    const row = Math.floor(adjustedI / numCols);
    const cellBoundsPx = {
      x: col * cellWPx + marginPx,
      y: row * cellHPx + marginPx + headingMarginPx,
      w: cellWPx - marginPx * 2.0,
      h: cellHPx - marginPx * 2.0
    };

    const geometry = ItemFns.calcGeometry_InCell(item, cellBoundsPx, false);
    const ves = arrangeItem(desktopStore, currentPath, ArrangeAlgorithm.Grid, item, geometry, true, false, false);
    children.push(ves);
  }

  if (movingItem) {
    const cellBoundsPx = {
      x: LastMouseMoveEventState.get().clientX - MouseActionState.get().startPx.x,
      y: LastMouseMoveEventState.get().clientY - MouseActionState.get().startPx.y,
      w: cellWPx - marginPx * 2.0,
      h: cellHPx - marginPx * 2.0
    };
    const geometry = ItemFns.calcGeometry_InCell(movingItem, cellBoundsPx, false);
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
      panic();
    }
  }

  topLevelVisualElementSpec.children = children;

  VesCache.finalizeFullArrange(topLevelVisualElementSpec, currentPath, desktopStore);
}
