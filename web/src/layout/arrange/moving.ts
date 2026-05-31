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

import { CursorEventState, MouseActionState } from "../../input/state";
import { StoreContextModel } from "../../store/StoreProvider";
import { BoundingBox, Dimensions } from "../../util/geometry";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElementPath } from "../visual-element";
import { ArrangeItemFlags } from "./item";


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
