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
import { orderedGroupMoveItems } from "../../input/move_group";
import { PageFlags } from "../../items/base/flags-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem, asPageItem, isPage, pageUsesEmbeddedInteractiveMode } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { panic } from "../../util/lang";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItemPath, arrangedItemIsInOverlaySelection, getCommonVisualElementFlags, pageContentScale } from "./item";
import { calcJustifiedBoxSpacingPx, calcJustifiedPagePaddingPx, calcJustifiedTargetRowHeightPx } from "./justified_metrics";
import { arrangeMovingPile } from "./moving";
import { arrangeCellPopupPath, arrangeSourceAnchoredPopupPath, shouldArrangeSourceAnchoredPopup } from "./popup";
import { childIdsSizingPageDuringMove, getMovingTreeItemInParentMaybe } from "./util";
import { addLinkTriangleHitboxMaybe } from "../link-triangle";
import { addAttachCompositeHitboxMaybe, setNaturalAttachmentBlockSizePx } from "./attachments";
import createJustifiedLayout from "justified-layout";


export function arrange_justified_page(
  store: StoreContextModel,
  parentPath: VisualElementPath,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  actualLinkItemMaybe_pageWithChildren: LinkItem | null,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags): { spec: VisualElementSpec, relationships: VisualElementRelationships } {

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : actualLinkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const attachmentBlockSizePx = LINE_HEIGHT_PX * geometry.boundsPx.w / store.desktopMainAreaBoundsPx().w;

  const parentIsPopup = flags & ArrangeItemFlags.IsPopupRoot;

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  if (isFull) {
    VesCache.titles.pushTopTitledPage(pageWithChildrenVePath);
  }

  const movingItemInThisPage = getMovingTreeItemInParentMaybe(displayItem_pageWithChildren.id);
  const movingItemsInThisPage = movingItemInThisPage ? orderedGroupMoveItems(movingItemInThisPage) : [];
  const movingIds = new Set(movingItemsInThisPage.map(item => item.id));

  let dims = [];
  let items = [];
  for (let i = 0; i < displayItem_pageWithChildren.computed_children.length; ++i) {
    const item = itemState.get(displayItem_pageWithChildren.computed_children[i])!;
    if (movingIds.has(item.id)) {
      continue;
    }
    let dimensions = ItemFns.calcSpatialDimensionsBl(item);
    dims.push({ width: dimensions.w, height: dimensions.h });
    items.push(item);
  }

  const justifyOptions = createJustifyOptions(geometry.boundsPx.w, displayItem_pageWithChildren.justifiedRowAspect);
  const layout = createJustifiedLayout(dims, justifyOptions);
  if (layout.boxes.length != items.length) {
    panic(`incorrect number of boxes for items: ${layout.boxes.length} vs ${items.length}.`);
  }

  const childAreaBoundsPx = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.viewportBoundsPx)!);
  const sizingChildIds = childIdsSizingPageDuringMove(displayItem_pageWithChildren, movingIds);
  childAreaBoundsPx.h = sizingChildIds.length == items.length
    ? layout.containerHeight
    : createJustifiedLayout(sizingChildIds.map(id => {
      const dimensions = ItemFns.calcSpatialDimensionsBl(itemState.get(id)!);
      return { width: dimensions.w, height: dimensions.h };
    }), justifyOptions).containerHeight;

  const isEmbeddedInteractive =
    !!(flags & ArrangeItemFlags.IsDockRoot) ||
    (!!(displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) &&
      (VeFns.pathDepth(parentPath) >= 2) &&
      !(flags & ArrangeItemFlags.IsTopRoot) &&
      !(flags & ArrangeItemFlags.IsPopupRoot) &&
      !(flags & ArrangeItemFlags.IsListPageMainRoot));


  const highlightedPath = store.find.highlightedPath.get();
  const isHighlighted = highlightedPath !== null && highlightedPath === pageWithChildrenVePath;
  const isSelectionHighlighted = arrangedItemIsInOverlaySelection(
    store, VeFns.veidFromItems(displayItem_pageWithChildren, actualLinkItemMaybe_pageWithChildren), linkItemMaybe_pageWithChildren);

  const pageSpec: VisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    actualLinkItemMaybe: actualLinkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
      getCommonVisualElementFlags(flags) |
      (flags & ArrangeItemFlags.IsPopupRoot && store.history.getFocusItem().id == pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
      (isEmbeddedInteractive ? VisualElementFlags.EmbeddedInteractiveRoot : VisualElementFlags.None) |
      (isHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None) |
      (isSelectionHighlighted ? VisualElementFlags.SelectionHighlighted : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: geometry.viewportBoundsPx!,
    hitboxes: geometry.hitboxes,
    childAreaBoundsPx,
    parentPath,
  };

  const pageRelationships: VisualElementRelationships = {};

  const childrenPaths: Array<VisualElementPath> = [];

  for (let i = 0; i < items.length; ++i) {
    const childItem = items[i];
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;
    const cellBoundsPx = {
      x: layout.boxes[i].left,
      y: layout.boxes[i].top,
      w: layout.boxes[i].width,
      h: layout.boxes[i].height
    };

    const childItemIsEmbeddedInteractive = isPage(childItem) && pageUsesEmbeddedInteractiveMode(asPageItem(childItem));
    const renderChildrenAsFull = !(flags & ArrangeItemFlags.IsPreview) && (isEmbeddedInteractive || arrangeFlagIsRoot(flags));

    const cellGeometry = ItemFns.calcGeometry_InCell(childItem, cellBoundsPx, false, !!(flags & ArrangeItemFlags.IsPopupRoot), false, false, false, false, true, false, store.smallScreenMode());
    setNaturalAttachmentBlockSizePx(store, childItem, cellGeometry, attachmentBlockSizePx, true);
    addAttachCompositeHitboxMaybe(store, childItem, cellGeometry);
    addLinkTriangleHitboxMaybe(cellGeometry, actualLinkItemMaybe);

    childrenPaths.push(arrangeItemPath(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Justified, childItem, actualLinkItemMaybe, cellGeometry,
      (renderChildrenAsFull ? ArrangeItemFlags.RenderChildrenAsFull : ArrangeItemFlags.None) |
      (childItemIsEmbeddedInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
      (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None)));
  }

  if (movingItemInThisPage) {
    childrenPaths.push(...arrangeMovingPile(
      store, pageWithChildrenVePath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren,
      geometry, childAreaBoundsPx, movingItemsInThisPage, movingItemInThisPage, flags,
      pageContentScale(store, displayItem_pageWithChildren, parentPath, geometry, isEmbeddedInteractive, flags)));
  }

  pageRelationships.childrenPaths = childrenPaths;

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageRelationships.popupPath = shouldArrangeSourceAnchoredPopup(store)
        ? arrangeSourceAnchoredPopupPath(store, displayItem_pageWithChildren, pageWithChildrenVePath, ArrangeAlgorithm.Justified, childAreaBoundsPx, geometry.viewportBoundsPx)
        : arrangeCellPopupPath(store);
    }
  }

  return { spec: pageSpec, relationships: pageRelationships };
}


export function createJustifyOptions(widthPx: number, rowAspect: number) {
  const targetRowHeight = calcJustifiedTargetRowHeightPx(widthPx, rowAspect);
  const options: JustifiedLayoutOptions = {
    containerWidth: widthPx,
    containerPadding: calcJustifiedPagePaddingPx(widthPx, rowAspect),
    boxSpacing: calcJustifiedBoxSpacingPx(widthPx, rowAspect),
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
