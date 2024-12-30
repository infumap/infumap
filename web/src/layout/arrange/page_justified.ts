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
import { LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem, asPageItem, isPage } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { assert, panic } from "../../util/lang";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItem } from "./item";
import { arrangeCellPopup } from "./popup";
import createJustifiedLayout from "justified-layout";


export function arrange_justified_page(
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

  const scale = geometry.boundsPx.w / store.desktopBoundsPx().w;

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

  // if an item is moving out of or into a justified page, then ensure the height of the page doesn't
  // change until after the move is complete to avoid a very distruptive jump in y scroll px.
  let nItemAdj = 0;
  if (movingItemInThisPage && !MouseActionState.get().linkCreatedOnMoveStart) {
    const startParentVes = VesCache.get(MouseActionState.get().startActiveElementParent)!;
    const startParent = startParentVes.get().displayItem;
    if (startParent.id == displayItem_pageWithChildren.id && movingItem!.parentId != startParent.id) {
      nItemAdj = 1;
    }
  }

  let dims = [];
  let items = [];
  for (let i=0; i<displayItem_pageWithChildren.computed_children.length; ++i) {
    const item = itemState.get(displayItem_pageWithChildren.computed_children[i])!;
    if (movingItemInThisPage && item.id == movingItemInThisPage!.id) {
      continue;
    }
    let dimensions = ItemFns.calcSpatialDimensionsBl(item);
    dims.push({ width: dimensions.w, height: dimensions.h });
    items.push(item);
  }

  const layout = createJustifiedLayout(dims, createJustifyOptions(geometry.boundsPx.w, displayItem_pageWithChildren.justifiedRowAspect));
  if (layout.boxes.length != items.length) {
    panic(`incorrect number of boxes for items: ${layout.boxes.length} vs ${items.length}.`);
  }

  const childAreaBoundsPx = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.viewportBoundsPx)!);
  childAreaBoundsPx.h = layout.containerHeight;

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
  };

  const childrenVes = [];

  for (let i=0; i<items.length; ++i) {
    const childItem = items[i];
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;
    const cellBoundsPx = {
      x: layout.boxes[i].left,
      y: layout.boxes[i].top,
      w: layout.boxes[i].width,
      h: layout.boxes[i].height
    };

    const childItemIsEmbeededInteractive = isPage(childItem) && !!(asPageItem(childItem).flags & PageFlags.EmbeddedInteractive);
    const renderChildrenAsFull = arrangeFlagIsRoot(flags);

    const cellGeometry = ItemFns.calcGeometry_InCell(childItem, cellBoundsPx, false, !!(flags & ArrangeItemFlags.IsPopupRoot), false, false, false, true, false);

    const ves = arrangeItem(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Justified, childItem, actualLinkItemMaybe, cellGeometry,
      (renderChildrenAsFull ? ArrangeItemFlags.RenderChildrenAsFull : ArrangeItemFlags.None) |
      (childItemIsEmbeededInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
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
    const mouseDestkopPosPx = CursorEventState.getLatestDesktopPx(store);
    const popupTitleHeightMaybePx = geometry.boundsPx.h - geometry.viewportBoundsPx!.h;
    // TODO (MEDIUM): adjX is a hack, the calculations should be such that an adjustment here is not necessary.
    const adjX = flags & ArrangeItemFlags.IsTopRoot ? 0 : store.getCurrentDockWidthPx();
    const cellBoundsPx = {
      x: mouseDestkopPosPx.x - geometry.boundsPx.x - adjX + xOffsetPx,
      y: mouseDestkopPosPx.y - geometry.boundsPx.y - popupTitleHeightMaybePx + yOffsetPx + pageYScrollPx,
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

function createJustifyOptions(widthPx: number, rowAspect: number) {
  const NORMAL_ROW_HEIGHT = 200;
  const targetRowHeight = widthPx / rowAspect;
  const options: JustifiedLayoutOptions = {
    containerWidth: widthPx,
    containerPadding: 10 * targetRowHeight / NORMAL_ROW_HEIGHT,
    boxSpacing: 5 * targetRowHeight / NORMAL_ROW_HEIGHT,
    targetRowHeight,
  };
  return options;
}

/**
 * Options for configuring the justified layout.
 */
interface JustifiedLayoutOptions {
  /**
   * The width that boxes will be contained within irrelevant of padding.
   * @default 1060
   */
  containerWidth?: number | undefined;
  /**
   * Provide a single integer to apply padding to all sides or provide an object to apply
   * individual values to each side.
   * @default 10
   */
  containerPadding?: number | { top: number; right: number; left: number; bottom: number } | undefined;
  /**
   * Provide a single integer to apply spacing both horizontally and vertically or provide an
   * object to apply individual values to each axis.
   * @default 10
   */
  boxSpacing?: number | { horizontal: number; vertical: number } | undefined;
  /**
   * It's called a target because row height is the lever we use in order to fit everything in
   * nicely. The algorithm will get as close to the target row height as it can.
   * @default 320
   */
  targetRowHeight?: number | undefined;
  /**
   * How far row heights can stray from targetRowHeight. `0` would force rows to be the
   * `targetRowHeight` exactly and would likely make it impossible to justify. The value must
   * be between `0` and `1`.
   * @default 0.25
   */
  targetRowHeightTolerance?: number | undefined;
  /**
   * Will stop adding rows at this number regardless of how many items still need to be laid
   * out.
   * @default Number.POSITIVE_INFINITY
   */
  maxNumRows?: number | undefined;
  /**
   * Provide an aspect ratio here to return everything in that aspect ratio. Makes the values
   * in your input array irrelevant. The length of the array remains relevant.
   * @default false
   */
  forceAspectRatio?: boolean | number | undefined;
  /**
   * If you'd like to insert a full width box every n rows you can specify it with this
   * parameter. The box on that row will ignore the targetRowHeight, make itself as wide as
   * `containerWidth - containerPadding` and be as tall as its aspect ratio defines. It'll
   * only happen if that item has an aspect ratio >= 1. Best to have a look at the examples to
   * see what this does.
   * @default false
   */
  fullWidthBreakoutRowCadence?: boolean | number | undefined;
  /**
   * By default we'll return items at the end of a justified layout even if they don't make a
   * full row. If false they'll be omitted from the output.
   * @default true
   */
  showWidows?: boolean | undefined;
  /**
   * If widows are visible, how should they be laid out?
   * @default "left"
   */
  widowLayoutStyle?: "left" | "justify" | "center" | undefined;
}
