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

import { NATURAL_BLOCK_SIZE_PX, COMPOSITE_ITEM_GAP_BL, PAGE_DOCUMENT_LEFT_MARGIN_BL, PAGE_DOCUMENT_RIGHT_MARGIN_BL, PAGE_DOCUMENT_TOP_MARGIN_PX } from "../../constants";
import { CursorEventState, MouseAction, MouseActionState } from "../../input/state";
import { PageFlags } from "../../items/base/flags-item";
import { Item } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItem, arrangeItemPath, getCommonVisualElementFlags } from "./item";
import { addContiguousStackedGapHitboxes, addContiguousStackedRowMarginHitboxes, getVePropertiesForItem } from "./util";


export function arrange_document_page(
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

  let movingItemInThisPage = null;
  if (!MouseActionState.empty() && MouseActionState.isAction(MouseAction.Moving)) {
    movingItemInThisPage = VeFns.treeItemFromPath(MouseActionState.getActiveElementPath()!);
    if (movingItemInThisPage!.parentId != displayItem_pageWithChildren.id) {
      movingItemInThisPage = null;
    }
  }

  const totalMarginBl = PAGE_DOCUMENT_LEFT_MARGIN_BL + PAGE_DOCUMENT_RIGHT_MARGIN_BL;
  const totalWidthBl = displayItem_pageWithChildren.docWidthBl + totalMarginBl;
  const requiredWidthPx = totalWidthBl * NATURAL_BLOCK_SIZE_PX.w;
  let scale = geometry.boundsPx.w / requiredWidthPx;
  if (scale > 1.0) { scale = 1.0; }
  const blockSizePx = { w: NATURAL_BLOCK_SIZE_PX.w * scale, h: NATURAL_BLOCK_SIZE_PX.h * scale };
  const documentWidthPx = totalWidthBl * blockSizePx.w;

  const childrenPaths: Array<VisualElementPath> = [];
  const childArrangeData: Array<{
    childItem: Item,
    actualLinkItemMaybe: LinkItem | null,
    geometry: ItemGeometry,
    childItemIsEmbeddedInteractive: boolean,
  }> = [];

  let topPx = PAGE_DOCUMENT_TOP_MARGIN_PX * scale;
  if (PageFns.showDocumentTitleInDocument(displayItem_pageWithChildren)) {
    topPx += PageFns.calcDocumentTitleHeightBl(displayItem_pageWithChildren) * blockSizePx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;
  }
  let displayIdx = 0;
  for (let idx = 0; idx < displayItem_pageWithChildren.computed_children.length; ++idx) {
    const childId = displayItem_pageWithChildren.computed_children[idx];
    const childItem = itemState.get(childId)!;
    if (movingItemInThisPage && childItem.id == movingItemInThisPage.id) {
      continue;
    }
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;

    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);

    const geometry = ItemFns.calcGeometry_InComposite(
      linkItemMaybe_childItem ? linkItemMaybe_childItem : displayItem_childItem,
      blockSizePx,
      totalWidthBl - totalMarginBl,
      PAGE_DOCUMENT_LEFT_MARGIN_BL,
      topPx,
      store.smallScreenMode());
    const documentChildGeometry: ItemGeometry = {
      ...geometry,
      row: displayIdx,
      col: 0,
    };
    displayIdx += 1;

    const childItemIsEmbeddedInteractive = !!(isPage(childItem) && (asPageItem(childItem).flags & PageFlags.EmbeddedInteractive));
    childArrangeData.push({
      childItem,
      actualLinkItemMaybe,
      geometry: documentChildGeometry,
      childItemIsEmbeddedInteractive,
    });

    topPx += geometry.boundsPx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;
  }

  addContiguousStackedRowMarginHitboxes(childArrangeData.map(child => child.geometry), documentWidthPx, false);
  addContiguousStackedGapHitboxes(childArrangeData.map(child => child.geometry), documentWidthPx, false);

  const renderChildrenAsFull = flags & ArrangeItemFlags.IsPopupRoot || arrangeFlagIsRoot(flags);
  for (const child of childArrangeData) {
    childrenPaths.push(arrangeItemPath(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Document, child.childItem, child.actualLinkItemMaybe, child.geometry,
      (renderChildrenAsFull ? ArrangeItemFlags.RenderChildrenAsFull : ArrangeItemFlags.None) |
      ArrangeItemFlags.InsideCompositeOrDoc |
      (child.childItemIsEmbeddedInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
      (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None)));
  }

  const movingItemReservedHeightPx = movingItemInThisPage == null
    ? 0
    : ItemFns.calcSpatialDimensionsBl(movingItemInThisPage).h * blockSizePx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;
  const childAreaBoundsPx = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.boundsPx)!);
  childAreaBoundsPx.w = documentWidthPx;
  childAreaBoundsPx.h = topPx + movingItemReservedHeightPx;

  if (movingItemInThisPage) {
    const movingVes = arrangeMovingItemInDocument(
      store,
      movingItemInThisPage,
      displayItem_pageWithChildren,
      linkItemMaybe_pageWithChildren,
      pageWithChildrenVePath,
      geometry,
      childAreaBoundsPx,
      blockSizePx,
      flags,
      parentIsPopup,
    );
    childrenPaths.push(VeFns.veToPath(movingVes.get()));
  }

  const isEmbeddedInteractive =
    !!(displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) &&
    (VeFns.pathDepth(parentPath) >= 2) &&
    !(flags & ArrangeItemFlags.IsTopRoot) &&
    !(flags & ArrangeItemFlags.IsPopupRoot) &&
    !(flags & ArrangeItemFlags.IsListPageMainRoot);

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
  };

  const pageRelationships: VisualElementRelationships = {
    childrenPaths,
  };

  return { spec: pageSpec, relationships: pageRelationships };
}

function arrangeMovingItemInDocument(
  store: StoreContextModel,
  movingItem: Item,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  pageWithChildrenVePath: VisualElementPath,
  geometry: ItemGeometry,
  childAreaBoundsPx: BoundingBox,
  blockSizePx: { w: number, h: number },
  flags: ArrangeItemFlags,
  parentIsPopup: number,
) {
  const actualMovingItemLinkItemMaybe = isLink(movingItem) ? asLinkItem(movingItem) : null;

  const pageVeid = flags & ArrangeItemFlags.IsPopupRoot
    ? store.history.currentPopupSpec()!.actualVeid
    : VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const scrollPropY = store.perItem.getPageScrollYProp(pageVeid);
  const scrollPropX = store.perItem.getPageScrollXProp(pageVeid);

  const umbrellaVisualElement = store.umbrellaVisualElement.get();
  const umbrellaBoundsPx = umbrellaVisualElement.childAreaBoundsPx!;
  const desktopSizePx = store.desktopBoundsPx();
  const pageYScrollProp = store.perItem.getPageScrollYProp(store.history.currentPageVeid()!);
  const pageYScrollPx = pageYScrollProp * (umbrellaBoundsPx.h - desktopSizePx.h);

  const yOffsetPx = scrollPropY * Math.max(0, childAreaBoundsPx.h - geometry.boundsPx.h);
  const xOffsetPx = scrollPropX * Math.max(0, childAreaBoundsPx.w - geometry.boundsPx.w);
  const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItem);
  const mouseDesktopPosPx = CursorEventState.getLatestDesktopPx(store);
  const popupTitleHeightMaybePx = geometry.boundsPx.h - geometry.viewportBoundsPx!.h;
  const adjX = flags & ArrangeItemFlags.IsTopRoot ? 0 : store.getCurrentDockWidthPx();
  const documentContentLeftPx = Math.max((geometry.viewportBoundsPx!.w - childAreaBoundsPx.w) / 2, 0);
  const cellBoundsPx = {
    x: mouseDesktopPosPx.x - geometry.boundsPx.x - adjX + xOffsetPx - documentContentLeftPx,
    y: mouseDesktopPosPx.y - geometry.boundsPx.y - popupTitleHeightMaybePx + yOffsetPx + pageYScrollPx,
    w: dimensionsBl.w * blockSizePx.w,
    h: dimensionsBl.h * blockSizePx.h,
  };

  const clickOffsetProp = MouseActionState.getClickOffsetProp()!;
  cellBoundsPx.x -= clickOffsetProp.x * cellBoundsPx.w;
  cellBoundsPx.y -= clickOffsetProp.y * cellBoundsPx.h;

  const cellGeometry = ItemFns.calcGeometry_InCell(
    movingItem,
    cellBoundsPx,
    false,
    !!(flags & ArrangeItemFlags.ParentIsPopup),
    false,
    false,
    false,
    false,
    false,
    false,
    store.smallScreenMode(),
  );

  return arrangeItem(
    store,
    pageWithChildrenVePath,
    ArrangeAlgorithm.Grid,
    movingItem,
    actualMovingItemLinkItemMaybe,
    cellGeometry,
    ArrangeItemFlags.RenderChildrenAsFull | (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None),
  );
}
