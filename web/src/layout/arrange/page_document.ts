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

import { NATURAL_BLOCK_SIZE_PX, COMPOSITE_ITEM_GAP_BL, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, GRID_SIZE, PAGE_DOCUMENT_LEFT_MARGIN_BL, PAGE_DOCUMENT_RIGHT_MARGIN_BL, PAGE_DOCUMENT_TOP_MARGIN_PX } from "../../constants";
import { PageFlags } from "../../items/base/flags-item";
import { Item, Measurable } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { DividerFns, isDivider } from "../../items/divider-item";
import { LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "../../items/page-item";
import { asTableItem, isTable } from "../../items/table-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { compositeMoveOutHitboxBoundsPx } from "../composite-move-out";
import { HitboxFlags, HitboxFns } from "../hitbox";
import { ItemGeometry } from "../item-geometry";
import { assignFlowListItemNumbers } from "../list-numbering";
import { initiateLoadChildItemsMaybe } from "../load";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItem, arrangeItemPath, getCommonVisualElementFlags } from "./item";
import { movingItemCellBoundsInPagePx } from "./moving";
import { arrangeCellPopupPath } from "./popup";
import { arrangeTable } from "./table";
import { addContiguousStackedGapHitboxes, addContiguousStackedRowMarginHitboxes, getMovingTreeItemInParentMaybe, getVePropertiesForItem } from "./util";


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

  const movingItemInThisPage = getMovingTreeItemInParentMaybe(displayItem_pageWithChildren.id);

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
    displayItem: Item,
    actualLinkItemMaybe: LinkItem | null,
    geometry: ItemGeometry,
    displayWidthBl: number,
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

    const documentContentWidthBl = totalWidthBl - totalMarginBl;
    const displayWidthBl = documentChildDisplayWidthBl(displayItem_childItem, linkItemMaybe_childItem, documentContentWidthBl);
    const geometry = ItemFns.calcGeometry_InComposite(
      documentChildMeasurableForGeometry(displayItem_childItem, linkItemMaybe_childItem, displayWidthBl),
      blockSizePx,
      displayWidthBl,
      PAGE_DOCUMENT_LEFT_MARGIN_BL,
      topPx,
      store.smallScreenMode());
    if (isPage(displayItem_childItem)) {
      geometry.hitboxes.push(HitboxFns.create(HitboxFlags.Move, zeroBoundingBoxTopLeft(geometry.boundsPx)));
    }
    if (isDivider(displayItem_childItem)) {
      geometry.hitboxes = geometry.hitboxes.filter(hitbox => !(hitbox.type & HitboxFlags.Resize));
      geometry.hitboxes.push(HitboxFns.create(HitboxFlags.Move, zeroBoundingBoxTopLeft(geometry.boundsPx)));
    }
    if (isTable(displayItem_childItem)) {
      alignTableDocumentMoveOutHitbox(geometry, blockSizePx, documentContentWidthBl);
    }
    const documentChildGeometry: ItemGeometry = {
      ...geometry,
      row: displayIdx,
      col: 0,
    };
    displayIdx += 1;

    const childItemIsEmbeddedInteractive = !!(isPage(childItem) && (asPageItem(childItem).flags & PageFlags.EmbeddedInteractive));
    childArrangeData.push({
      childItem,
      displayItem: displayItem_childItem,
      actualLinkItemMaybe,
      geometry: documentChildGeometry,
      displayWidthBl,
      childItemIsEmbeddedInteractive,
    });

    topPx += geometry.boundsPx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;
  }

  assignFlowListItemNumbers(childArrangeData.map(child => ({
    displayItem: child.displayItem,
    geometry: child.geometry,
  })));
  addContiguousStackedRowMarginHitboxes(childArrangeData.map(child => child.geometry), documentWidthPx, false);
  addContiguousStackedGapHitboxes(childArrangeData.map(child => child.geometry), documentWidthPx, false);

  const renderChildrenAsFull = flags & ArrangeItemFlags.IsPopupRoot || arrangeFlagIsRoot(flags);
  for (const child of childArrangeData) {
    childrenPaths.push(arrangeDocumentChildItemPath(
      store,
      pageWithChildrenVePath,
      child.childItem,
      child.actualLinkItemMaybe,
      child.geometry,
      child.displayWidthBl,
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

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageRelationships.popupPath = arrangeCellPopupPath(store);
    }
  }

  return { spec: pageSpec, relationships: pageRelationships };
}

function documentChildDisplayWidthBl(
  displayItem: Item,
  linkItemMaybe: LinkItem | null,
  documentContentWidthBl: number,
): number {
  if (!isTable(displayItem)) {
    return documentContentWidthBl;
  }

  const persistedWidthBl = (linkItemMaybe?.spatialWidthGr ?? asTableItem(displayItem).spatialWidthGr) / GRID_SIZE;
  return Math.max(1, Math.min(persistedWidthBl, documentContentWidthBl));
}

function documentChildMeasurableForGeometry(
  displayItem: Item,
  linkItemMaybe: LinkItem | null,
  displayWidthBl: number,
): Measurable {
  if (isDivider(displayItem)) {
    if (linkItemMaybe != null) {
      const clonedLink: LinkItem = {
        ...linkItemMaybe,
        spatialHeightGr: GRID_SIZE,
      };
      return clonedLink;
    }
    const clonedDivider = DividerFns.asDividerMeasurable(ItemFns.cloneMeasurableFields(displayItem));
    clonedDivider.spatialHeightGr = GRID_SIZE;
    return clonedDivider;
  }

  if (!isTable(displayItem)) {
    return linkItemMaybe ? linkItemMaybe : displayItem;
  }

  const spatialWidthGr = displayWidthBl * GRID_SIZE;
  if (linkItemMaybe != null) {
    const clonedLink: LinkItem = {
      ...linkItemMaybe,
      spatialWidthGr,
    };
    return clonedLink;
  }

  const clonedTable = asTableItem(ItemFns.cloneMeasurableFields(asTableItem(displayItem)));
  clonedTable.spatialWidthGr = spatialWidthGr;
  return clonedTable;
}

function alignTableDocumentMoveOutHitbox(
  geometry: ItemGeometry,
  blockSizePx: { w: number, h: number },
  documentContentWidthBl: number,
): void {
  const moveHitbox = geometry.hitboxes.find(hitbox => hitbox.meta?.compositeMoveOut);
  if (moveHitbox == null) {
    return;
  }

  const moveAreaRightPx = (PAGE_DOCUMENT_LEFT_MARGIN_BL + documentContentWidthBl) * blockSizePx.w;
  const moveAreaBoundsPx = {
    x: moveAreaRightPx
      - geometry.boundsPx.x
      - COMPOSITE_MOVE_OUT_AREA_SIZE_PX
      - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
      - CONTAINER_IN_COMPOSITE_PADDING_PX
      - 2,
    y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
    w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
    h: geometry.boundsPx.h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
  };

  moveHitbox.boundsPx = compositeMoveOutHitboxBoundsPx(moveAreaBoundsPx, Number(PAGE_DOCUMENT_LEFT_MARGIN_BL) == 0 ? 2 : 0);
  moveHitbox.meta = {
    ...(moveHitbox.meta ?? {}),
    compositeMoveOut: true,
    allowOutsideBounds: true,
  };
}

function arrangeDocumentChildItemPath(
  store: StoreContextModel,
  parentPath: VisualElementPath,
  childItem: Item,
  actualLinkItemMaybe: LinkItem | null,
  geometry: ItemGeometry,
  displayWidthBl: number,
  flags: ArrangeItemFlags): VisualElementPath {

  const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);
  const shouldRenderTableChildren =
    childItem.parentId == store.history.currentPageVeid()?.itemId ||
    !!(flags & ArrangeItemFlags.RenderChildrenAsFull);
  if (isTable(displayItem) && shouldRenderTableChildren) {
    initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
    return VeFns.veToPath(arrangeTable(
      store,
      parentPath,
      asTableItem(displayItem),
      linkItemMaybe,
      actualLinkItemMaybe,
      geometry,
      flags,
      displayWidthBl).get());
  }

  return arrangeItemPath(
    store,
    parentPath,
    ArrangeAlgorithm.Document,
    childItem,
    actualLinkItemMaybe,
    geometry,
    flags);
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

  const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItem);
  const documentContentLeftPx = Math.max((geometry.viewportBoundsPx!.w - childAreaBoundsPx.w) / 2, 0);
  const cellBoundsPx = movingItemCellBoundsInPagePx(
    store,
    pageWithChildrenVePath,
    geometry,
    childAreaBoundsPx,
    pageVeid,
    {
      w: dimensionsBl.w * blockSizePx.w,
      h: dimensionsBl.h * blockSizePx.h,
    },
    flags,
    documentContentLeftPx,
  );

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
    ArrangeItemFlags.RenderChildrenAsFull |
    (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None),
  );
}
