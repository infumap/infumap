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

import { LINE_HEIGHT_PX } from "../../constants";
import { CursorEventState, MouseAction, MouseActionState } from "../../input/state";
import { PageFlags } from "../../items/base/flags-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem, asPageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { PopupType } from "../../store/StoreProvider_History";
import { cloneBoundingBox } from "../../util/geometry";
import { assert } from "../../util/lang";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeItem } from "./item";
import { arrangeCellPopup } from "./popup";


export function arrange_grid_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    realParentVeid: Veid | null,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSpec {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const outerBoundsPx = geometry.boundsPx;
  const hitboxes = geometry.hitboxes;

  const parentIsPopup = flags & ArrangeItemFlags.IsPopup;

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
    if (movingItemInThisPage!.parentId != displayItem_pageWithChildren.id) {
      movingItemInThisPage = null;
    }
  }

  const scale = geometry.boundsPx.w / store.desktopBoundsPx().w;

  const pageItem = asPageItem(displayItem_pageWithChildren);
  const numCols = pageItem.gridNumberOfColumns;

  // if an item is moving out of or in a grid page, then ensure the height of the grid page doesn't
  // change until after the move is complete to avoid a very distruptive jump in y scroll px.
  let nItemAdj = 0;
  if (movingItem && !MouseActionState.get().linkCreatedOnMoveStart) {
    const startParentVes = VesCache.get(MouseActionState.get().startActiveElementParent)!;
    const startParent = startParentVes.get().displayItem;
    if (startParent.id == displayItem_pageWithChildren.id && movingItem!.parentId != startParent.id) {
      nItemAdj = 1;
    }
  }

  const numRows = Math.ceil((pageItem.computed_children.length + nItemAdj) / numCols);
  const cellWPx = geometry.boundsPx.w / numCols;
  const cellHPx = cellWPx * (1.0/pageItem.gridCellAspect);
  const marginPx = cellWPx * 0.01;
  const pageHeightPx = numRows * cellHPx;
  const boundsPx = (() => {
    const result = cloneBoundingBox(geometry.boundsPx)!;
    result.h = pageHeightPx;
    return result;
  })();

  const isEmbeddedInteractive = (displayItem_pageWithChildren.flags & PageFlags.Interactive) && VeFns.pathDepth(parentPath) == 2;

  pageWithChildrenVisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
          (flags & ArrangeItemFlags.IsPopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
          (flags & ArrangeItemFlags.IsPopup && store.getToolbarFocus()!.itemId ==  pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
          (flags & ArrangeItemFlags.IsRoot || isEmbeddedInteractive ? VisualElementFlags.Root : VisualElementFlags.None) |
          (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
          (flags & ArrangeItemFlags.IsListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None) |
          (isEmbeddedInteractive ? VisualElementFlags.EmbededInteractive : VisualElementFlags.None),
    boundsPx: outerBoundsPx,
    childAreaBoundsPx: boundsPx,
    hitboxes,
    parentPath,
  };

  const childrenVes = [];
  let idx = 0;
  for (let i=0; i<pageItem.computed_children.length; ++i) {
    const item = itemState.get(pageItem.computed_children[i])!;
    if (movingItemInThisPage && item.id == movingItemInThisPage!.id) {
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

    let geometry = ItemFns.calcGeometry_InCell(item, cellBoundsPx, false, !!(flags & ArrangeItemFlags.IsPopup), false, false, false);
    const renderChildrenAsFull = flags & ArrangeItemFlags.IsPopup || flags & ArrangeItemFlags.IsRoot;
    const ves = arrangeItem(
      store, pageWithChildrenVePath, pageWithChildrenVeid, ArrangeAlgorithm.Grid, item, geometry,
      (renderChildrenAsFull ? ArrangeItemFlags.RenderChildrenAsFull : ArrangeItemFlags.None) |
      (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));
    childrenVes.push(ves);
  }

  if (movingItemInThisPage) {
    let scrollPropY;
    let scrollPropX;
    if (flags & ArrangeItemFlags.IsPopup) {
      const popupSpec = store.history.currentPopupSpec();
      assert(popupSpec!.type == PopupType.Page, "popup spec does not have type page.");
      scrollPropY = store.perItem.getPageScrollYProp(VeFns.veidFromPath(popupSpec!.vePath));
      scrollPropX = store.perItem.getPageScrollXProp(VeFns.veidFromPath(popupSpec!.vePath));
    } else {
      scrollPropY = store.perItem.getPageScrollYProp(VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren));
      scrollPropX = store.perItem.getPageScrollXProp(VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren));
    }

    const topLevelVisualElement = store.topLevelVisualElement.get();
    const topLevelBoundsPx = topLevelVisualElement.childAreaBoundsPx!;
    const desktopSizePx = store.desktopBoundsPx();
    const pageYScrollProp = store.perItem.getPageScrollYProp(store.history.currentPage()!);
    const pageYScrollPx = pageYScrollProp * (topLevelBoundsPx.h - desktopSizePx.h);
    const pageXScrollProp = store.perItem.getPageScrollXProp(store.history.currentPage()!);
    const pageXScrollPx = pageXScrollProp * (topLevelBoundsPx.w - desktopSizePx.w);

    const yOffsetPx = scrollPropY * (boundsPx.h - outerBoundsPx.h);
    const xOffsetPx = scrollPropX * (boundsPx.w - outerBoundsPx.w);
    const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItemInThisPage);
    const mouseDestkopPosPx = CursorEventState.getLatestDesktopPx();
    const cellBoundsPx = {
      x: mouseDestkopPosPx.x - outerBoundsPx.x + xOffsetPx + pageXScrollPx,
      y: mouseDestkopPosPx.y - outerBoundsPx.y + yOffsetPx + pageYScrollPx,
      w: dimensionsBl.w * LINE_HEIGHT_PX * scale,
      h: dimensionsBl.h * LINE_HEIGHT_PX * scale,
    };
    cellBoundsPx.x -= MouseActionState.get().clickOffsetProp!.x * cellBoundsPx.w;
    cellBoundsPx.y -= MouseActionState.get().clickOffsetProp!.y * cellBoundsPx.h;
    const geometry = ItemFns.calcGeometry_InCell(movingItemInThisPage, cellBoundsPx, false, !!(flags & ArrangeItemFlags.ParentIsPopup), false, false, false);
    const ves = arrangeItem(
      store, pageWithChildrenVePath, pageWithChildrenVeid, ArrangeAlgorithm.Grid, movingItemInThisPage, geometry,
      ArrangeItemFlags.RenderChildrenAsFull | (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));
    childrenVes.push(ves);
  }

  pageWithChildrenVisualElementSpec.childrenVes = childrenVes;

  if (flags & ArrangeItemFlags.IsRoot && !(flags & ArrangeItemFlags.IsPopup)) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store, realParentVeid);
    }
  }

  return pageWithChildrenVisualElementSpec;
}