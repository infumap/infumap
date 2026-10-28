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
import { ArrangeItemFlags, arrangeItem, arrangedItemIsInOverlaySelection, getCommonVisualElementFlags, pageIsPreview } from "./item";
import { arrangeCellPopupPath, arrangeSourceAnchoredPopupPath, shouldArrangeSourceAnchoredPopup } from "./popup";
import { movingItemCellBoundsInPagePx } from "./moving";
import { arrangeTabularChildren } from "./table";
import { getMovingTreeItemInParentMaybe } from "./util";
import { MOVING_STACK_GAP_PX } from "./page_list";
import { groupMoveStackWindow, orderedGroupMoveItems } from "../../input/move_group";

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
  // As for list pages, a preview (e.g. translucent) table page is a miniature of the full page, without a minimum scale.
  const proportionalScale = contentViewportPx.w / store.desktopMainAreaBoundsPx().w;
  const scale = isFull || insidePopup
    ? 1
    : pageIsPreview(page, parentPath, flags)
      ? proportionalScale
      : Math.max(MIN_NON_ROOT_LIST_PAGE_SCALE, proportionalScale);
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
  const [windowState, rowsExtent] = arrangeTabularChildren(
    store, page, linkItemMaybe, tableGeometry, pagePath, flags,
    sizeBl, rowBlockSizePx, columnHeaderHeightPx / rowBlockSizePx.h,
  );

  const childAreaBoundsPx = zeroBoundingBoxTopLeft(bodyViewportPx);
  childAreaBoundsPx.h = rowsExtent.heightBl * rowBlockSizePx.h;
  const highlightedPath = store.find.highlightedPath.get();
  const isSelectionHighlighted = arrangedItemIsInOverlaySelection(store, VeFns.veidFromItems(page, actualLinkItemMaybe), linkItemMaybe);
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
    tableWidthBl: sizeBl.w,
    // Column editing and resizing are available only when the page is interactive.
    hitboxes: isTranslucent
      ? geometry.hitboxes
      : [...geometry.hitboxes, ...columnHitboxes.resize, ...columnHitboxes.header],
    parentPath,
  };
  const relationships: VisualElementRelationships = {
    childrenVes: windowState.childrenVes,
  };

  // The moving items have no rows until they are dropped (see walkTabularRows). Arrange them under the cursor, for
  // MovingItemsOverlay.
  const movingItem = getMovingTreeItemInParentMaybe(page.id);
  if (movingItem != null) {
    relationships.childrenVes!.push(...arrangeMovingStack(
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
 * Arrange the moving items as they would be rendered spatially (with their attachments): activeItem under the cursor,
 * where it was grabbed, and the rest of a group moving with it stacked above and below it in the order a drop inserts
 * them, as in a list page (at most GROUP_MOVE_STACK_MAX_ITEMS, badged by MovingItemsOverlay with the count of the
 * rest). They are relative to the page viewport (not the scrolled table body) and not part of the row window.
 */
function arrangeMovingStack(
  store: StoreContextModel,
  pagePath: VisualElementPath,
  pageGeometry: ItemGeometry,
  contentViewportPx: BoundingBox,
  blockSizePx: Dimensions,
  activeItem: Item,
  flags: ArrangeItemFlags,
): Array<VisualElementSignal> {
  const parentIsPopup = !!(flags & ArrangeItemFlags.ParentIsPopup);
  const stack = groupMoveStackWindow(orderedGroupMoveItems(activeItem), activeItem.id);
  const sizesPx = stack.items.map(item => {
    const dimensionsBl = ItemFns.calcSpatialDimensionsBl(item);
    return { w: dimensionsBl.w * blockSizePx.w, h: dimensionsBl.h * blockSizePx.h };
  });
  const activeCellBoundsPx = movingItemCellBoundsInPagePx(
    store,
    pagePath,
    pageGeometry,
    zeroBoundingBoxTopLeft(contentViewportPx),
    VeFns.veidFromPath(pagePath),
    sizesPx[stack.activeIndex],
    flags,
  );
  const gapPx = MOVING_STACK_GAP_PX * blockSizePx.h / LINE_HEIGHT_PX;
  let yPx = activeCellBoundsPx.y -
    sizesPx.slice(0, stack.activeIndex).reduce((heightPx, sizePx) => heightPx + sizePx.h + gapPx, 0);

  const result: Array<VisualElementSignal> = [];
  for (let i = 0; i < stack.items.length; ++i) {
    const item = stack.items[i];
    const cellBoundsPx = { x: activeCellBoundsPx.x, y: yPx, w: sizesPx[i].w, h: sizesPx[i].h };
    yPx += sizesPx[i].h + gapPx;
    const cellGeometry = ItemFns.calcGeometry_InCell(
      item, cellBoundsPx, false, parentIsPopup, false, false, false, false, false, false, store.smallScreenMode());
    result.push(arrangeItem(
      store,
      pagePath,
      ArrangeAlgorithm.Grid,
      item,
      isLink(item) ? asLinkItem(item) : null,
      cellGeometry,
      ArrangeItemFlags.RenderChildrenAsFull | (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None),
    ));
  }
  return result;
}
