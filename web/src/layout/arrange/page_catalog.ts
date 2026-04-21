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

import { CursorEventState, MouseAction, MouseActionState } from "../../input/state";
import { Item, ItemType } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkFns, LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem, asPageItem, isPage } from "../../items/page-item";
import { PageFlags } from "../../items/base/flags-item";
import { TEMP_SEARCH_RESULTS_ORIGIN, calcSearchWorkspaceResultsFooterHeightPx } from "../../items/search-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { assert } from "../../util/lang";
import { ItemGeometry } from "../item-geometry";
import { HitboxFlags, HitboxFns } from "../hitbox";
import { addContiguousStackedGapHitboxes, addContiguousStackedRowMarginHitboxes } from "./util";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeItem, arrangeItemPath, getCommonVisualElementFlags } from "./item";
import { calcCatalogPreviewColumnWidthPx, calcCatalogRowHeightPx } from "../catalog";
import { arrangeCellPopupPath } from "./popup";
import { VisualElementSignal } from "../../util/signals";


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

  let movingItem: Item | null = null;
  let movingItemInThisPage: Item | null = null;
  if (!MouseActionState.empty() && MouseActionState.isAction(MouseAction.Moving)) {
    movingItemInThisPage = VeFns.treeItemFromPath(MouseActionState.getActiveElementPath()!);
    movingItem = movingItemInThisPage;
    if (movingItemInThisPage!.parentId != displayItem_pageWithChildren.id) {
      movingItemInThisPage = null;
    }
  }

  const previewColumnWidthPx = calcCatalogPreviewColumnWidthPx(geometry.boundsPx.w);
  const rowHeightPx = calcCatalogRowHeightPx(previewColumnWidthPx, displayItem_pageWithChildren.gridCellAspect);
  const marginPx = Math.max(1, Math.round(previewColumnWidthPx * 0.01));
  const isSearchResultsCatalogPage = displayItem_pageWithChildren.origin == TEMP_SEARCH_RESULTS_ORIGIN;
  const searchResultsFooterHeightPx = isSearchResultsCatalogPage
    ? calcSearchWorkspaceResultsFooterHeightPx(store.perItem.getSearchHasMoreResults(displayItem_pageWithChildren.parentId))
    : 0;
  const movingAdj = movingItemInThisPage ? 1 : 0;
  const numRows = Math.max(displayItem_pageWithChildren.computed_children.length - movingAdj, 0);
  const pageHeightPx = numRows * rowHeightPx + searchResultsFooterHeightPx;
  const childAreaBoundsPx = (() => {
    const result = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.viewportBoundsPx)!);
    result.h = pageHeightPx;
    return result;
  })();

  const highlightedPath = store.find.highlightedPath.get();
  const isHighlighted = highlightedPath !== null && highlightedPath === pageWithChildrenVePath;
  const isSelectionHighlighted = (() => {
    const sel = store.overlay.selectedVeids.get();
    if (!sel || sel.length === 0) { return false; }
    const veid = VeFns.veidFromItems(displayItem_pageWithChildren, actualLinkItemMaybe_pageWithChildren);
    for (let i = 0; i < sel.length; ++i) {
      if (sel[i].itemId === veid.itemId && sel[i].linkIdMaybe === veid.linkIdMaybe) { return true; }
    }
    return false;
  })();

  const pageSpec: VisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    actualLinkItemMaybe: actualLinkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
      getCommonVisualElementFlags(flags) |
      (flags & ArrangeItemFlags.IsPopupRoot && store.history.getFocusItem().id == pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
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
  };

  const pageRelationships: VisualElementRelationships = {};

  const childGeometries: Array<{ childItem: Item, actualLinkItemMaybe: LinkItem | null, geometry: ItemGeometry }> = [];
  let idx = 0;
  for (let i = 0; i < displayItem_pageWithChildren.computed_children.length; ++i) {
    const childItem = itemState.get(displayItem_pageWithChildren.computed_children[i])!;
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;
    if (movingItemInThisPage && childItem.id == movingItemInThisPage.id) {
      continue;
    }

    const cellBoundsPx = {
      x: marginPx,
      y: idx * rowHeightPx + marginPx,
      w: previewColumnWidthPx - marginPx * 2.0,
      h: rowHeightPx - marginPx * 2.0,
    };
    idx += 1;

    const childGeometry = ItemFns.calcGeometry_InCell(childItem, cellBoundsPx, false, !!(flags & ArrangeItemFlags.IsPopupRoot), false, false, false, false, false, false, store.smallScreenMode());
    childGeometry.row = idx - 1;
    childGeometry.col = 0;
    if (isSearchResultsCatalogPage) {
      childGeometry.hitboxes.push(HitboxFns.create(HitboxFlags.Click, {
        x: -childGeometry.boundsPx.x,
        y: childGeometry.row * rowHeightPx - childGeometry.boundsPx.y,
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

  if (isSearchResultsCatalogPage) {
    addContiguousStackedGapHitboxes(childGeometries.map(entry => entry.geometry), childAreaBoundsPx.w);
    addContiguousStackedRowMarginHitboxes(childGeometries.map(entry => entry.geometry), childAreaBoundsPx.w);
  }

  for (const child of childGeometries) {
    const targetItemId = child.actualLinkItemMaybe ? LinkFns.getLinkToId(child.actualLinkItemMaybe) : undefined;
    for (const hitbox of child.geometry.hitboxes) {
      if (!(hitbox.type & HitboxFlags.Click)) { continue; }
      const isRowHitbox = !!hitbox.meta?.focusOnly && !!hitbox.meta?.allowOutsideBounds;
      hitbox.meta = {
        ...(hitbox.meta ?? {}),
        catalogRowNumber: child.geometry.row,
        ...(isSearchResultsCatalogPage && targetItemId && isRowHitbox ? { openContainingPageOfItemId: targetItemId } : {}),
        ...(isSearchResultsCatalogPage && targetItemId && !isRowHitbox ? { openActualItem: true } : {}),
      };
    }
  }

  const childrenPaths: Array<VisualElementPath> = [];
  for (const child of childGeometries) {
    const childItemIsEmbeddedInteractive = isPage(child.childItem) && !!(asPageItem(child.childItem).flags & PageFlags.EmbeddedInteractive);
    const renderChildrenAsFull = !!(flags & ArrangeItemFlags.RenderChildrenAsFull |
      flags & ArrangeItemFlags.IsTopRoot |
      flags & ArrangeItemFlags.IsPopupRoot |
      flags & ArrangeItemFlags.IsListPageMainRoot |
      flags & ArrangeItemFlags.IsEmbeddedInteractiveRoot |
      flags & ArrangeItemFlags.IsDockRoot);
    childrenPaths.push(arrangeItemPath(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Grid, child.childItem, child.actualLinkItemMaybe, child.geometry,
      (renderChildrenAsFull ? ArrangeItemFlags.RenderChildrenAsFull : ArrangeItemFlags.None) |
      (childItemIsEmbeddedInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
      (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None)));
  }

  if (movingItemInThisPage && movingItem) {
    const movingVes = arrangeMovingItemInCatalog(
      store, movingItemInThisPage, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren,
      pageWithChildrenVePath, geometry, childAreaBoundsPx, flags, parentIsPopup);
    childrenPaths.push(VeFns.veToPath(movingVes.get()));
  }

  pageRelationships.childrenPaths = childrenPaths;

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageRelationships.popupPath = arrangeCellPopupPath(store);
    }
  }

  return { spec: pageSpec, relationships: pageRelationships };
}

function arrangeMovingItemInCatalog(
  store: StoreContextModel,
  movingItem: Item,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  pageWithChildrenVePath: VisualElementPath,
  geometry: ItemGeometry,
  childAreaBoundsPx: BoundingBox,
  flags: ArrangeItemFlags,
  parentIsPopup: boolean): VisualElementSignal {

  const actualMovingItemLinkItemMaybe = isLink(movingItem) ? asLinkItem(movingItem) : null;

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
  const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItem);
  const scale = geometry.boundsPx.w / store.desktopBoundsPx().w;
  const mouseDesktopPosPx = CursorEventState.getLatestDesktopPx(store);
  const popupTitleHeightMaybePx = geometry.boundsPx.h - geometry.viewportBoundsPx!.h;
  const adjX = flags & ArrangeItemFlags.IsTopRoot ? 0 : store.getCurrentDockWidthPx();
  const cellBoundsPx = {
    x: mouseDesktopPosPx.x - geometry.boundsPx.x - adjX + xOffsetPx,
    y: mouseDesktopPosPx.y - geometry.boundsPx.y - popupTitleHeightMaybePx + yOffsetPx + pageYScrollPx,
    w: dimensionsBl.w * scale,
    h: dimensionsBl.h * scale,
  };

  const clickOffsetProp = MouseActionState.getClickOffsetProp()!;
  cellBoundsPx.x -= clickOffsetProp.x * cellBoundsPx.w;
  cellBoundsPx.y -= clickOffsetProp.y * cellBoundsPx.h;

  const cellGeometry = ItemFns.calcGeometry_InCell(
    movingItem, cellBoundsPx, false, parentIsPopup,
    false, false, false, false, false, false, store.smallScreenMode());

  return arrangeItem(
    store, pageWithChildrenVePath, ArrangeAlgorithm.Grid, movingItem, actualMovingItemLinkItemMaybe, cellGeometry,
    ArrangeItemFlags.RenderChildrenAsFull | (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));
}
