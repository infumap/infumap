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

import { orderedGroupMoveItems } from "../../input/move_group";
import { Item } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem, asPageItem, isPage, pageUsesEmbeddedInteractiveMode } from "../../items/page-item";
import { PageFlags } from "../../items/base/flags-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { ItemGeometry } from "../item-geometry";
import { HitboxFlags, HitboxFns } from "../hitbox";
import { addContiguousStackedGapHitboxes, addContiguousStackedRowMarginHitboxes, childIdsSizingPageDuringMove, getMovingTreeItemInParentMaybe, getVePropertiesForItem, scaleGeometry } from "./util";
import { addLinkTriangleHitboxMaybe } from "../link-triangle";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeItemPath, arrangePreviewChildPath, arrangedItemIsInOverlaySelection, getCommonVisualElementFlags, pageContentScale, pageIsPreview } from "./item";
import { calcCatalogLayout } from "../catalog";
import { catalogResultControlsTopInsetPx, catalogResultFooterHeightPx, hasCatalogResultContext } from "../catalog-display";
import { arrangeMovingPile } from "./moving";
import { arrangeCellPopupPath, arrangeSourceAnchoredPopupPath, shouldArrangeSourceAnchoredPopup } from "./popup";
import { setNaturalAttachmentBlockSizePx } from "./attachments";
import { LINE_HEIGHT_PX, NATURAL_BLOCK_SIZE_PX } from "../../constants";


export function arrange_catalog_page(
  store: StoreContextModel,
  parentPath: VisualElementPath,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  actualLinkItemMaybe_pageWithChildren: LinkItem | null,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags): { spec: VisualElementSpec, relationships: VisualElementRelationships } {

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : actualLinkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);
  const parentIsPopup = !!(flags & ArrangeItemFlags.IsPopupRoot);

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  if (isFull) {
    VesCache.titles.pushTopTitledPage(pageWithChildrenVePath);
  }

  const movingItemInThisPage = getMovingTreeItemInParentMaybe(displayItem_pageWithChildren.id);
  const movingItemsInThisPage = movingItemInThisPage ? orderedGroupMoveItems(movingItemInThisPage) : [];
  const movingIds = new Set(movingItemsInThisPage.map(item => item.id));

  const isEmbeddedInteractive =
    !!(flags & ArrangeItemFlags.IsDockRoot) ||
    (!!(displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) &&
      (VeFns.pathDepth(parentPath) >= 2) &&
      !(flags & ArrangeItemFlags.IsTopRoot) &&
      !(flags & ArrangeItemFlags.IsPopupRoot) &&
      !(flags & ArrangeItemFlags.IsListPageMainRoot));

  // The children of a preview are drawn as for the children of other preview pages: in detail if large enough for their
  // text to be legible, otherwise as outlines.
  const isPreview = pageIsPreview(displayItem_pageWithChildren, parentPath, flags);
  const catalogScale = pageContentScale(store, displayItem_pageWithChildren, parentPath, geometry, isEmbeddedInteractive, flags);

  const attachmentBlockSizePx = LINE_HEIGHT_PX * geometry.boundsPx.w / store.desktopMainAreaBoundsPx().w;
  const layout = calcCatalogLayout(geometry.viewportBoundsPx!.w, displayItem_pageWithChildren.gridCellAspect, catalogScale);
  const previewColumnWidthPx = layout.previewColumnWidthPx;
  const rowHeightPx = layout.rowHeightPx;
  const marginPx = layout.cellMarginPx;
  const hasCatalogResults = hasCatalogResultContext(displayItem_pageWithChildren);
  const pageTopPaddingPx = catalogResultControlsTopInsetPx(displayItem_pageWithChildren) ?? layout.verticalMarginPx;
  const catalogFooterHeightPx = catalogResultFooterHeightPx(store, displayItem_pageWithChildren);
  const numRows = childIdsSizingPageDuringMove(displayItem_pageWithChildren, movingIds).length;
  const pageHeightPx = pageTopPaddingPx + numRows * rowHeightPx + layout.verticalMarginPx + catalogFooterHeightPx;
  const childAreaBoundsPx = (() => {
    const result = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.viewportBoundsPx)!);
    result.h = pageHeightPx;
    return result;
  })();

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
    cellSizePx: { w: previewColumnWidthPx, h: rowHeightPx },
    numRows,
    catalogScale,
  };

  const pageRelationships: VisualElementRelationships = {};

  const childGeometries: Array<{ childItem: Item, actualLinkItemMaybe: LinkItem | null, geometry: ItemGeometry }> = [];
  let idx = 0;
  for (let i = 0; i < displayItem_pageWithChildren.computed_children.length; ++i) {
    const childItem = itemState.get(displayItem_pageWithChildren.computed_children[i])!;
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;
    if (movingIds.has(childItem.id)) {
      continue;
    }

    const cellBoundsPx = {
      x: layout.horizontalMarginPx + marginPx,
      y: pageTopPaddingPx + idx * rowHeightPx + marginPx,
      w: previewColumnWidthPx - marginPx * 2.0,
      h: rowHeightPx - marginPx * 2.0,
    };
    idx += 1;

    // Items are laid out in their cell at full size, then scaled with the page.
    const fullSizeCellBoundsPx = {
      x: cellBoundsPx.x / catalogScale,
      y: cellBoundsPx.y / catalogScale,
      w: cellBoundsPx.w / catalogScale,
      h: cellBoundsPx.h / catalogScale,
    };
    let childGeometry = ItemFns.calcGeometry_InCell(childItem, fullSizeCellBoundsPx, false, !!(flags & ArrangeItemFlags.IsPopupRoot), false, false, false, false, false, false, store.smallScreenMode());
    if (catalogScale != 1.0) {
      childGeometry = scaleGeometry(childGeometry, { x: 0, y: 0, w: 0, h: 0 }, catalogScale);
    }
    childGeometry.row = idx - 1;
    childGeometry.col = 0;
    setNaturalAttachmentBlockSizePx(store, childItem, childGeometry, attachmentBlockSizePx, !hasCatalogResults);
    addLinkTriangleHitboxMaybe(childGeometry, actualLinkItemMaybe);
    if (hasCatalogResults) {
      // A click anywhere in the row, the item included, goes to the result's location: see
      // navigateToSearchResultClickMaybe in mouse_up.ts. This hitbox keeps a click beside the item on the result rather
      // than the results page.
      childGeometry.hitboxes.push(HitboxFns.create(HitboxFlags.Click, {
        x: -childGeometry.boundsPx.x,
        y: pageTopPaddingPx + childGeometry.row * rowHeightPx - childGeometry.boundsPx.y,
        w: childAreaBoundsPx.w,
        h: rowHeightPx,
      }, {
        focusOnly: true,
        allowOutsideBounds: true,
      }));
    }
    childGeometries.push({
      childItem,
      actualLinkItemMaybe,
      geometry: childGeometry,
    });
  }

  if (hasCatalogResults) {
    addContiguousStackedGapHitboxes(childGeometries.map(entry => entry.geometry), childAreaBoundsPx.w);
    addContiguousStackedRowMarginHitboxes(childGeometries.map(entry => entry.geometry), childAreaBoundsPx.w);
  }

  for (const child of childGeometries) {
    for (const hitbox of child.geometry.hitboxes) {
      if (!(hitbox.type & HitboxFlags.Click)) { continue; }
      hitbox.meta = {
        ...(hitbox.meta ?? {}),
        catalogRowNumber: child.geometry.row,
      };
    }
  }

  const childrenPaths: Array<VisualElementPath> = [];
  for (const child of childGeometries) {
    const childItemIsEmbeddedInteractive = isPage(child.childItem) && pageUsesEmbeddedInteractiveMode(asPageItem(child.childItem));
    const renderChildrenAsFull = !isPreview &&
      (isEmbeddedInteractive || !!(flags & ArrangeItemFlags.RenderChildrenAsFull |
        flags & ArrangeItemFlags.IsTopRoot |
        flags & ArrangeItemFlags.IsPopupRoot |
        flags & ArrangeItemFlags.IsListPageMainRoot |
        flags & ArrangeItemFlags.IsEmbeddedInteractiveRoot |
        flags & ArrangeItemFlags.IsDockRoot));
    if (!renderChildrenAsFull) {
      // Items may be scaled down to fit their cell, so their text is drawn at their own scale.
      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, child.childItem);
      const childScale = child.geometry.blockSizePx.w / NATURAL_BLOCK_SIZE_PX.w;
      childrenPaths.push(arrangePreviewChildPath(
        store, pageWithChildrenVePath, displayItem, linkItemMaybe, child.actualLinkItemMaybe, child.geometry, childScale,
        flags & ArrangeItemFlags.IsMoving ? ArrangeItemFlags.IsMoving : ArrangeItemFlags.None));
      continue;
    }
    childrenPaths.push(arrangeItemPath(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Grid, child.childItem, child.actualLinkItemMaybe, child.geometry,
      ArrangeItemFlags.RenderChildrenAsFull |
      (childItemIsEmbeddedInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
      (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None)));
  }

  if (movingItemInThisPage) {
    childrenPaths.push(...arrangeMovingPile(
      store, pageWithChildrenVePath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren,
      geometry, childAreaBoundsPx, movingItemsInThisPage, movingItemInThisPage, flags, catalogScale));
  }

  pageRelationships.childrenPaths = childrenPaths;

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageRelationships.popupPath = shouldArrangeSourceAnchoredPopup(store)
        ? arrangeSourceAnchoredPopupPath(store, displayItem_pageWithChildren, pageWithChildrenVePath, ArrangeAlgorithm.Catalog, childAreaBoundsPx, geometry.viewportBoundsPx)
        : arrangeCellPopupPath(store);
    }
  }

  return { spec: pageSpec, relationships: pageRelationships };
}
