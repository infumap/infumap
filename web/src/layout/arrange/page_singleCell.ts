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
import { ItemType } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asLinkItem, isLink, LinkItem } from "../../items/link-item";
import { ArrangeAlgorithm, asPageItem, isPage, PageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { assert } from "../../util/lang";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { arrangeFlagIsRoot, arrangeItem, ArrangeItemFlags } from "./item";
import { arrangeCellPopup } from "./popup";

export function arrange_single_cell_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    actualLinkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSpec {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : actualLinkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const parentIsPopup = flags & ArrangeItemFlags.IsPopupRoot;

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  if (isFull) {
    VesCache.pushTopTitledPage(pageWithChildrenVePath);
  }

  let movingItem = null;
  let movingItemInThisPage = null;
  if (!MouseActionState.empty() && (MouseActionState.get().action == MouseAction.Moving)) {
    movingItemInThisPage = VeFns.canonicalItemFromPath(MouseActionState.get().activeElementPath);
    movingItem = movingItemInThisPage;
    if (movingItemInThisPage!.parentId != displayItem_pageWithChildren.id) {
      movingItemInThisPage = null;
    }
  }

  const scale = geometry.boundsPx.w / store.desktopBoundsPx().w;

  const pageItem = asPageItem(displayItem_pageWithChildren);

  const childAreaBoundsPx = (() => {
    const result = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.viewportBoundsPx)!);
    return result;
  })();

  const isEmbeddedInteractive =
    !!(displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) &&
    (VeFns.pathDepth(parentPath) >= 2) &&
    !(flags & ArrangeItemFlags.IsTopRoot) &&
    !(flags & ArrangeItemFlags.IsPopupRoot) &&
    !(flags & ArrangeItemFlags.IsListPageMainRoot);

  pageWithChildrenVisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    actualLinkItemMaybe: actualLinkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
           (flags & ArrangeItemFlags.IsPopupRoot ? VisualElementFlags.Popup : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsTopRoot ? VisualElementFlags.TopLevelRoot : VisualElementFlags.None) |
           (isEmbeddedInteractive ? VisualElementFlags.EmbeddedInteractiveRoot : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsPopupRoot && store.history.getFocusItem().id ==  pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsDockRoot ? VisualElementFlags.DockItem : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.InsideCompositeOrDoc ? VisualElementFlags.InsideCompositeOrDoc : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: geometry.viewportBoundsPx!,
    hitboxes: geometry.hitboxes,
    childAreaBoundsPx,
    parentPath,
    cellSizePx: { w: childAreaBoundsPx.w, h: childAreaBoundsPx.h },
    numRows: 1,
  };

  const childrenVes = [];
  for (let i=0; i<pageItem.computed_children.length; ++i) {
    const childItem = itemState.get(pageItem.computed_children[i])!;
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;
    if (movingItemInThisPage && childItem.id == movingItemInThisPage!.id) {
      continue;
    }
    const cellBoundsPx = {
      x: 0,
      y: 0,
      w: childAreaBoundsPx.w,
      h: childAreaBoundsPx.h
    };

    const childItemIsEmbeddedInteractive = isPage(childItem) && !!(asPageItem(childItem).flags & PageFlags.EmbeddedInteractive);
    const renderChildrenAsFull = arrangeFlagIsRoot(flags);

    const cellGeometry = ItemFns.calcGeometry_InCell(childItem, cellBoundsPx, false, !!(flags & ArrangeItemFlags.IsPopupRoot), false, false, false, false, false);

    const ves = arrangeItem(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Grid, childItem, actualLinkItemMaybe, cellGeometry,
      (renderChildrenAsFull ? ArrangeItemFlags.RenderChildrenAsFull : ArrangeItemFlags.None) |
      (childItemIsEmbeddedInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
      (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));
    childrenVes.push(ves);
  }

  if (movingItemInThisPage) {
    const actualMovingItemLinkItemMaybe = isLink(movingItemInThisPage) ? asLinkItem(movingItemInThisPage) : null;

    let scrollPropY;
    let scrollPropX;
    if (flags & ArrangeItemFlags.IsPopupRoot) {
      const popupSpec = store.history.currentPopupSpec();
      assert(itemState.get(popupSpec!.actualVeid.itemId)!.itemType == ItemType.Page, "popup spec does not have type page.");
      scrollPropY = store.perItem.getPageScrollYProp(popupSpec!.actualVeid);
      scrollPropX = store.perItem.getPageScrollXProp(popupSpec!.actualVeid);
    } else {
      scrollPropY = store.perItem.getPageScrollYProp(VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren));
      scrollPropX = store.perItem.getPageScrollXProp(VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren));
    }

    const umbrellaVisualElement = store.umbrellaVisualElement.get();
    const umbrellaBoundsPx = umbrellaVisualElement.childAreaBoundsPx!;
    const desktopSizePx = store.desktopBoundsPx();
    const pageYScrollProp = store.perItem.getPageScrollYProp(store.history.currentPageVeid()!);
    const pageYScrollPx = pageYScrollProp * (umbrellaBoundsPx.h - desktopSizePx.h);

    const yOffsetPx = scrollPropY * (childAreaBoundsPx.h - geometry.boundsPx.h);
    const xOffsetPx = scrollPropX * (childAreaBoundsPx.w - geometry.boundsPx.w);
    const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItemInThisPage);
    const mouseDesktopPosPx = CursorEventState.getLatestDesktopPx(store);
    const popupTitleHeightMaybePx = geometry.boundsPx.h - geometry.viewportBoundsPx!.h;
    // TODO (MEDIUM): adjX is a hack, the calculations should be such that an adjustment here is not necessary.
    const adjX = flags & ArrangeItemFlags.IsTopRoot ? 0 : store.getCurrentDockWidthPx();
    const cellBoundsPx = {
      x: mouseDesktopPosPx.x - geometry.boundsPx.x - adjX + xOffsetPx,
      y: mouseDesktopPosPx.y - geometry.boundsPx.y - popupTitleHeightMaybePx + yOffsetPx + pageYScrollPx,
      w: dimensionsBl.w * LINE_HEIGHT_PX * scale,
      h: dimensionsBl.h * LINE_HEIGHT_PX * scale,
    };

    cellBoundsPx.x -= MouseActionState.get().clickOffsetProp!.x * cellBoundsPx.w;
    cellBoundsPx.y -= MouseActionState.get().clickOffsetProp!.y * cellBoundsPx.h;
    const cellGeometry = ItemFns.calcGeometry_InCell(movingItemInThisPage, cellBoundsPx, false, !!(flags & ArrangeItemFlags.ParentIsPopup), false, false, false, false, false);
    const ves = arrangeItem(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Grid, movingItemInThisPage, actualMovingItemLinkItemMaybe, cellGeometry,
      ArrangeItemFlags.RenderChildrenAsFull | (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));
    childrenVes.push(ves);
  }

  pageWithChildrenVisualElementSpec.childrenVes = childrenVes;

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store);
    }
  }

  return pageWithChildrenVisualElementSpec;
}