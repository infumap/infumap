/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
  Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { LINE_HEIGHT_PX, MIN_NON_ROOT_LIST_PAGE_SCALE, TABLE_COL_HEADER_HEIGHT_BL } from "../../constants";
import { PageFlags } from "../../items/base/flags-item";
import { Item } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem } from "../../items/page-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { BoundingBox, Dimensions, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { VisualElementSignal } from "../../util/signals";
import { ItemGeometry } from "../item-geometry";
import { tabularColumnHitboxes } from "../tabular";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec, isVeTranslucentPage } from "../visual-element";
import { ArrangeItemFlags, arrangeItem, getCommonVisualElementFlags } from "./item";
import { arrangeCellPopupPath, arrangeSourceAnchoredPopupPath, shouldArrangeSourceAnchoredPopup } from "./popup";
import { movingItemCellBoundsInPagePx } from "./moving";
import { arrangeTabularChildren } from "./table";
import { getMovingTreeItemInParentMaybe } from "./util";

export function arrange_table_page(
  store: StoreContextModel,
  parentPath: VisualElementPath,
  page: PageItem,
  linkItemMaybe: LinkItem | null,
  actualLinkItemMaybe: LinkItem | null,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags,
): { spec: VisualElementSpec; relationships: VisualElementRelationships; renderRows: Array<number> } {
  const pageVeid = VeFns.veidFromItems(page, linkItemMaybe);
  const pagePath = VeFns.addVeidToPath(pageVeid, parentPath);
  const contentViewportPx = geometry.viewportBoundsPx!;
  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  const insidePopup = !!(flags & (ArrangeItemFlags.IsPopupRoot | ArrangeItemFlags.ParentIsPopup));
  const scale = isFull || insidePopup
    ? 1
    : Math.max(MIN_NON_ROOT_LIST_PAGE_SCALE, contentViewportPx.w / store.desktopMainAreaBoundsPx().w);
  const rowBlockSizePx = { w: LINE_HEIGHT_PX * scale, h: LINE_HEIGHT_PX * scale };

  if (isFull) { VesCache.titles.pushTopTitledPage(pagePath); }

  const showColumnHeader = !!(page.flags & PageFlags.ShowTableColHeader);
  const columnHeaderHeightPx = showColumnHeader
    ? Math.min(TABLE_COL_HEADER_HEIGHT_BL * rowBlockSizePx.h, contentViewportPx.h)
    : 0;
  const bodyViewportPx = cloneBoundingBox(contentViewportPx)!;
  bodyViewportPx.y += columnHeaderHeightPx;
  bodyViewportPx.h = Math.max(0, bodyViewportPx.h - columnHeaderHeightPx);

  const columnHitboxes = tabularColumnHitboxes(
    page,
    contentViewportPx.w,
    geometry.boundsPx.h,
    rowBlockSizePx,
    contentViewportPx.y - geometry.boundsPx.y,
    columnHeaderHeightPx,
    showColumnHeader,
  );

  const tableGeometry: ItemGeometry = {
    boundsPx: contentViewportPx,
    viewportBoundsPx: bodyViewportPx,
    blockSizePx: rowBlockSizePx,
    hitboxes: [],
  };
  const sizeBl = {
    w: contentViewportPx.w / rowBlockSizePx.w,
    h: contentViewportPx.h / rowBlockSizePx.h,
  };
  const [windowState, numRows] = arrangeTabularChildren(
    store, page, linkItemMaybe, tableGeometry, pagePath, flags,
    sizeBl, rowBlockSizePx, columnHeaderHeightPx / rowBlockSizePx.h,
  );

  const childAreaBoundsPx = zeroBoundingBoxTopLeft(bodyViewportPx);
  childAreaBoundsPx.h = numRows * rowBlockSizePx.h;
  const highlightedPath = store.find.highlightedPath.get();
  const selectedVeids = store.overlay.selectedVeids.get();
  const actualVeid = VeFns.veidFromItems(page, actualLinkItemMaybe);
  const isSelectionHighlighted = !!selectedVeids?.some(veid => VeFns.compareVeids(veid, actualVeid) == 0);
  const isEmbeddedInteractive =
    !!(flags & ArrangeItemFlags.IsDockRoot) ||
    (!!(page.flags & PageFlags.EmbeddedInteractive) &&
      VeFns.pathDepth(parentPath) >= 2 &&
      !(flags & (ArrangeItemFlags.IsTopRoot | ArrangeItemFlags.IsPopupRoot | ArrangeItemFlags.IsListPageMainRoot)));

  const visualFlags = VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
    getCommonVisualElementFlags(flags) |
    (isEmbeddedInteractive ? VisualElementFlags.EmbeddedInteractiveRoot : VisualElementFlags.None) |
    (flags & ArrangeItemFlags.IsPopupRoot && store.history.getFocusItem().id == pageVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
    (highlightedPath === pagePath ? VisualElementFlags.FindHighlighted : VisualElementFlags.None) |
    (isSelectionHighlighted ? VisualElementFlags.SelectionHighlighted : VisualElementFlags.None);
  const isTranslucent = isVeTranslucentPage({ displayItem: page, flags: visualFlags });

  const spec: VisualElementSpec = {
    displayItem: page,
    linkItemMaybe,
    actualLinkItemMaybe,
    flags: visualFlags,
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: contentViewportPx,
    tableBodyViewportBoundsPx: bodyViewportPx,
    tableRowBlockSizePx: rowBlockSizePx,
    childAreaBoundsPx,
    blockSizePx: rowBlockSizePx,
    // Column editing and resizing are available only when the page is interactive.
    hitboxes: isTranslucent
      ? geometry.hitboxes
      : [...geometry.hitboxes, ...columnHitboxes.resize, ...columnHitboxes.header],
    parentPath,
  };
  const relationships: VisualElementRelationships = {
    childrenVes: windowState.childrenVes,
  };

  // The item has no row until it is dropped (see walkTabularRows), so show it under the cursor.
  const movingItem = getMovingTreeItemInParentMaybe(page.id);
  if (movingItem != null) {
    relationships.childrenVes!.push(arrangeMovingItem(
      store, pagePath, geometry, contentViewportPx, rowBlockSizePx, movingItem, flags));
  }

  if (flags & ArrangeItemFlags.IsTopRoot && store.history.currentPopupSpec() != null) {
    relationships.popupPath = shouldArrangeSourceAnchoredPopup(store)
      ? arrangeSourceAnchoredPopupPath(store, page, pagePath, ArrangeAlgorithm.Table, contentViewportPx)
      : arrangeCellPopupPath(store);
  }

  return { spec, relationships, renderRows: windowState.rowSlots };
}

/**
 * Arrange the moving item as it would be rendered spatially (with its attachments), under the cursor
 * and relative to the page viewport (not the scrolled table body). It is not part of the row window.
 */
function arrangeMovingItem(
  store: StoreContextModel,
  pagePath: VisualElementPath,
  pageGeometry: ItemGeometry,
  contentViewportPx: BoundingBox,
  blockSizePx: Dimensions,
  movingItem: Item,
  flags: ArrangeItemFlags,
): VisualElementSignal {
  const parentIsPopup = !!(flags & ArrangeItemFlags.ParentIsPopup);
  const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItem);
  const cellBoundsPx = movingItemCellBoundsInPagePx(
    store,
    pagePath,
    pageGeometry,
    zeroBoundingBoxTopLeft(contentViewportPx),
    VeFns.veidFromPath(pagePath),
    { w: dimensionsBl.w * blockSizePx.w, h: dimensionsBl.h * blockSizePx.h },
    flags,
  );
  const cellGeometry = ItemFns.calcGeometry_InCell(
    movingItem, cellBoundsPx, false, parentIsPopup, false, false, false, false, false, false, store.smallScreenMode());
  return arrangeItem(
    store,
    pagePath,
    ArrangeAlgorithm.Grid,
    movingItem,
    isLink(movingItem) ? asLinkItem(movingItem) : null,
    cellGeometry,
    ArrangeItemFlags.RenderChildrenAsFull | (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None),
  );
}
