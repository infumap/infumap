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
import { groupMoveStackWindow } from "../../input/move_group";
import { CursorEventState, MouseActionState } from "../../input/state";
import { Item } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem } from "../../items/page-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { BoundingBox, Dimensions } from "../../util/geometry";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElementPath } from "../visual-element";
import { setNaturalAttachmentBlockSizePx } from "./attachments";
import { ArrangeItemFlags, arrangeItemPath } from "./item";


function fallbackPageViewportBoundsRelativeToDesktopPx(
  store: StoreContextModel,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags,
): BoundingBox {
  const popupTitleHeightMaybePx = geometry.boundsPx.h - geometry.viewportBoundsPx!.h;
  const umbrellaVisualElement = store.umbrellaVisualElement.get();
  const umbrellaBoundsPx = umbrellaVisualElement.childAreaBoundsPx!;
  const desktopSizePx = store.desktopBoundsPx();
  const currentPageVeid = store.history.currentPageVeid();
  const pageYScrollProp = currentPageVeid == null
    ? 0
    : store.perItem.getPageScrollYProp(currentPageVeid);
  const pageYScrollPx = pageYScrollProp * Math.max(0, umbrellaBoundsPx.h - desktopSizePx.h);
  const adjX = flags & ArrangeItemFlags.IsTopRoot ? 0 : store.getCurrentDockWidthPx();

  return {
    x: geometry.boundsPx.x + adjX,
    y: geometry.boundsPx.y + popupTitleHeightMaybePx - pageYScrollPx,
    w: geometry.viewportBoundsPx!.w,
    h: geometry.viewportBoundsPx!.h,
  };
}

export function movingItemCellBoundsInPagePx(
  store: StoreContextModel,
  pageWithChildrenVePath: VisualElementPath,
  geometry: ItemGeometry,
  childAreaBoundsPx: BoundingBox,
  scrollVeid: Veid,
  sizePx: Dimensions,
  flags: ArrangeItemFlags,
  contentLeftPx: number = 0,
): BoundingBox {
  const currentPageVe = VesCache.current.readNode(pageWithChildrenVePath);
  const viewportBoundsPx = currentPageVe == null
    ? fallbackPageViewportBoundsRelativeToDesktopPx(store, geometry, flags)
    : VeFns.veViewportBoundsRelativeToDesktopPx(store, currentPageVe);
  const viewportSizePx = geometry.viewportBoundsPx!;
  const effectiveScrollVeid = (flags & ArrangeItemFlags.IsPopupRoot) || currentPageVe == null
    ? scrollVeid
    : VeFns.actualVeidFromVe(currentPageVe);
  const scrollXPx = Math.max(0, childAreaBoundsPx.w - viewportSizePx.w) *
    store.perItem.getPageScrollXProp(effectiveScrollVeid);
  const scrollYPx = Math.max(0, childAreaBoundsPx.h - viewportSizePx.h) *
    store.perItem.getPageScrollYProp(effectiveScrollVeid);
  const mouseDesktopPosPx = CursorEventState.getLatestDesktopPx(store);

  const cellBoundsPx = {
    x: mouseDesktopPosPx.x - viewportBoundsPx.x + scrollXPx - contentLeftPx,
    y: mouseDesktopPosPx.y - viewportBoundsPx.y + scrollYPx,
    w: sizePx.w,
    h: sizePx.h,
  };

  const clickOffsetProp = MouseActionState.getClickOffsetProp() ?? { x: 0, y: 0 };
  cellBoundsPx.x -= clickOffsetProp.x * cellBoundsPx.w;
  cellBoundsPx.y -= clickOffsetProp.y * cellBoundsPx.h;

  return cellBoundsPx;
}

const MOVING_PILE_OFFSET_PX = 8;

/**
 * Arrange the items moving in grid, justified, catalog or document page pagePath (orderedItems, from
 * orderedGroupMoveItems) as a pile: activeItem on top under the cursor, where it was grabbed, and the others behind it, each further down and to
 * the right. They aren't stacked in a column as in a list page, because they are drawn at their spatial size, and
 * images in particular are often large enough that a column would run off the screen. At most
 * GROUP_MOVE_STACK_MAX_ITEMS are drawn, and MovingItemsOverlay badges the pile with the count of the rest. The result
 * is back to front. They are drawn at scale, relative to natural size (see pageContentScale).
 */
export function arrangeMovingPile(
  store: StoreContextModel,
  pagePath: VisualElementPath,
  page: PageItem,
  pageLinkItemMaybe: LinkItem | null,
  geometry: ItemGeometry,
  childAreaBoundsPx: BoundingBox,
  orderedItems: Array<Item>,
  activeItem: Item,
  flags: ArrangeItemFlags,
  scale: number,
  contentLeftPx: number = 0,
): Array<VisualElementPath> {
  const sizePx = (item: Item): Dimensions => {
    const dimensionsBl = ItemFns.calcSpatialDimensionsBl(item);
    return { w: dimensionsBl.w * LINE_HEIGHT_PX * scale, h: dimensionsBl.h * LINE_HEIGHT_PX * scale };
  };
  const scrollVeid = flags & ArrangeItemFlags.IsPopupRoot
    ? store.history.currentPopupSpec()!.actualVeid
    : VeFns.veidFromItems(page, pageLinkItemMaybe);
  const activeCellBoundsPx = movingItemCellBoundsInPagePx(
    store, pagePath, geometry, childAreaBoundsPx, scrollVeid, sizePx(activeItem), flags, contentLeftPx);
  const attachmentBlockSizePx = LINE_HEIGHT_PX * scale;

  const pile = [
    ...groupMoveStackWindow(orderedItems, activeItem.id).items.filter(item => item.id != activeItem.id),
    activeItem,
  ];
  return pile.map((item, i) => {
    const offsetPx = (pile.length - 1 - i) * MOVING_PILE_OFFSET_PX * scale;
    const cellBoundsPx = { x: activeCellBoundsPx.x + offsetPx, y: activeCellBoundsPx.y + offsetPx, ...sizePx(item) };
    const cellGeometry = ItemFns.calcGeometry_InCell(
      item, cellBoundsPx, false, !!(flags & ArrangeItemFlags.ParentIsPopup),
      false, false, false, false, false, false, store.smallScreenMode());
    setNaturalAttachmentBlockSizePx(store, item, cellGeometry, attachmentBlockSizePx, false);
    return arrangeItemPath(
      store, pagePath, ArrangeAlgorithm.Grid, item, isLink(item) ? asLinkItem(item) : null, cellGeometry,
      ArrangeItemFlags.RenderChildrenAsFull |
      (flags & ArrangeItemFlags.IsPopupRoot ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));
  });
}
