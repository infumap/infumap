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
import { ItemGeometry } from "../item-geometry";
import { HitboxFlags, HitboxFns } from "../hitbox";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItemPath, arrangedItemIsInOverlaySelection, getCommonVisualElementFlags, pageContentScale } from "./item";
import { catalogResultControlsTopInsetPx, catalogResultFooterHeightPx, hasCatalogResultContext } from "../catalog-display";
import { calcJustifiedPagePaddingPx } from "./justified_metrics";
import { arrangeMovingPile } from "./moving";
import { arrangeCellPopupPath, arrangeSourceAnchoredPopupPath, shouldArrangeSourceAnchoredPopup } from "./popup";
import { childIdsSizingPageDuringMove, getMovingTreeItemInParentMaybe } from "./util";
import { addLinkTriangleHitboxMaybe } from "../link-triangle";
import { addAttachCompositeHitboxMaybe, setNaturalAttachmentBlockSizePx } from "./attachments";


export function arrange_grid_page(
  store: StoreContextModel,
  parentPath: VisualElementPath,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  actualLinkItemMaybe_pageWithChildren: LinkItem | null,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags): { spec: VisualElementSpec, relationships: VisualElementRelationships } {

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : actualLinkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const parentIsPopup = flags & ArrangeItemFlags.IsPopupRoot;

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  if (isFull) {
    VesCache.titles.pushTopTitledPage(pageWithChildrenVePath);
  }

  const movingItemInThisPage = getMovingTreeItemInParentMaybe(displayItem_pageWithChildren.id);
  const movingItemsInThisPage = movingItemInThisPage ? orderedGroupMoveItems(movingItemInThisPage) : [];
  const movingIds = new Set(movingItemsInThisPage.map(item => item.id));

  const attachmentBlockSizePx = LINE_HEIGHT_PX * geometry.boundsPx.w / store.desktopMainAreaBoundsPx().w;

  const pageItem = asPageItem(displayItem_pageWithChildren);
  const numCols = pageItem.gridNumberOfColumns;
  const hasCatalogResults = hasCatalogResultContext(displayItem_pageWithChildren);
  const catalogFooterHeightPx = catalogResultFooterHeightPx(store, displayItem_pageWithChildren);

  const numRows = Math.ceil(childIdsSizingPageDuringMove(pageItem, movingIds).length / numCols);
  const pageSidePaddingPx = calcJustifiedPagePaddingPx(geometry.boundsPx.w, pageItem.justifiedRowAspect);
  const pageTopPaddingPx = catalogResultControlsTopInsetPx(displayItem_pageWithChildren) ?? pageSidePaddingPx;
  const gridContentWidthPx = Math.max(0, geometry.boundsPx.w - pageSidePaddingPx * 2.0);
  const cellWPx = gridContentWidthPx / numCols;
  const cellHPx = cellWPx * (1.0 / pageItem.gridCellAspect);
  const marginPx = cellWPx * 0.01;
  const pageHeightPx = pageTopPaddingPx + numRows * cellHPx + pageSidePaddingPx + catalogFooterHeightPx;
  const childAreaBoundsPx = (() => {
    const result = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.viewportBoundsPx)!);
    result.h = pageHeightPx;
    return result;
  })();

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
    cellSizePx: { w: cellWPx, h: cellHPx },
    numRows,
  };

  const pageRelationships: VisualElementRelationships = {};

  const childrenPaths: Array<VisualElementPath> = [];
  let idx = 0;
  for (let i = 0; i < pageItem.computed_children.length; ++i) {
    const childItem = itemState.get(pageItem.computed_children[i])!;
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;
    if (movingIds.has(childItem.id)) {
      continue;
    }
    const col = idx % numCols;
    const row = Math.floor(idx / numCols);
    idx += 1;
    const cellBoundsPx = {
      x: pageSidePaddingPx + col * cellWPx + marginPx,
      y: pageTopPaddingPx + row * cellHPx + marginPx,
      w: cellWPx - marginPx * 2.0,
      h: cellHPx - marginPx * 2.0
    };

    const childItemIsEmbeddedInteractive = isPage(childItem) && pageUsesEmbeddedInteractiveMode(asPageItem(childItem));
    const renderChildrenAsFull = !(flags & ArrangeItemFlags.IsPreview) &&
      (isEmbeddedInteractive || !!(flags & ArrangeItemFlags.RenderChildrenAsFull |
        flags & ArrangeItemFlags.IsTopRoot |
        flags & ArrangeItemFlags.IsPopupRoot |
        flags & ArrangeItemFlags.IsListPageMainRoot |
        flags & ArrangeItemFlags.IsEmbeddedInteractiveRoot |
        flags & ArrangeItemFlags.IsDockRoot));

    const cellGeometry = ItemFns.calcGeometry_InCell(childItem, cellBoundsPx, false, !!(flags & ArrangeItemFlags.IsPopupRoot), false, false, false, false, false, false, store.smallScreenMode());
    cellGeometry.row = row;
    cellGeometry.col = col;
    setNaturalAttachmentBlockSizePx(store, childItem, cellGeometry, attachmentBlockSizePx, !hasCatalogResults);
    if (!hasCatalogResults) { addAttachCompositeHitboxMaybe(store, childItem, cellGeometry); }
    addLinkTriangleHitboxMaybe(cellGeometry, actualLinkItemMaybe);
    const cellIndex = row * numCols + col;
    if (hasCatalogResults) {
      // A click anywhere in the cell, these padding hitboxes included, goes to the result's location: see
      // navigateToSearchGridResultClickMaybe in mouse_up.ts. They keep a click in the padding on the result rather
      // than the results page.
      const hitboxMeta = {
        focusOnly: true,
        allowOutsideBounds: true,
        searchGridCellIndex: cellIndex,
      };
      const cellLocalLeftPx = pageSidePaddingPx + col * cellWPx - cellGeometry.boundsPx.x;
      const cellLocalTopPx = pageTopPaddingPx + row * cellHPx - cellGeometry.boundsPx.y;
      const itemLocalLeftPx = 0;
      const itemLocalTopPx = 0;
      const itemLocalRightPx = cellGeometry.boundsPx.w;
      const itemLocalBottomPx = cellGeometry.boundsPx.h;

      const topHeightPx = itemLocalTopPx - cellLocalTopPx;
      if (topHeightPx > 0) {
        cellGeometry.hitboxes.push(HitboxFns.create(HitboxFlags.Click, {
          x: cellLocalLeftPx,
          y: cellLocalTopPx,
          w: cellWPx,
          h: topHeightPx,
        }, hitboxMeta));
      }

      const bottomTopPx = itemLocalBottomPx;
      const bottomHeightPx = cellLocalTopPx + cellHPx - bottomTopPx;
      if (bottomHeightPx > 0) {
        cellGeometry.hitboxes.push(HitboxFns.create(HitboxFlags.Click, {
          x: cellLocalLeftPx,
          y: bottomTopPx,
          w: cellWPx,
          h: bottomHeightPx,
        }, hitboxMeta));
      }

      const leftWidthPx = itemLocalLeftPx - cellLocalLeftPx;
      if (leftWidthPx > 0) {
        cellGeometry.hitboxes.push(HitboxFns.create(HitboxFlags.Click, {
          x: cellLocalLeftPx,
          y: Math.max(cellLocalTopPx, itemLocalTopPx),
          w: leftWidthPx,
          h: Math.min(cellLocalTopPx + cellHPx, itemLocalBottomPx) - Math.max(cellLocalTopPx, itemLocalTopPx),
        }, hitboxMeta));
      }

      const rightLeftPx = itemLocalRightPx;
      const rightWidthPx = cellLocalLeftPx + cellWPx - rightLeftPx;
      if (rightWidthPx > 0) {
        cellGeometry.hitboxes.push(HitboxFns.create(HitboxFlags.Click, {
          x: rightLeftPx,
          y: Math.max(cellLocalTopPx, itemLocalTopPx),
          w: rightWidthPx,
          h: Math.min(cellLocalTopPx + cellHPx, itemLocalBottomPx) - Math.max(cellLocalTopPx, itemLocalTopPx),
        }, hitboxMeta));
      }

      for (const hitbox of cellGeometry.hitboxes) {
        if (!(hitbox.type & HitboxFlags.Click)) { continue; }
        hitbox.meta = { ...(hitbox.meta ?? {}), searchGridCellIndex: cellIndex };
      }
    }

    childrenPaths.push(arrangeItemPath(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Grid, childItem, actualLinkItemMaybe, cellGeometry,
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
        ? arrangeSourceAnchoredPopupPath(store, displayItem_pageWithChildren, pageWithChildrenVePath, ArrangeAlgorithm.Grid, childAreaBoundsPx, geometry.viewportBoundsPx)
        : arrangeCellPopupPath(store);
    }
  }

  return { spec: pageSpec, relationships: pageRelationships };
}
