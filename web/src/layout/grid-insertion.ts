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

import { asPageItem } from "../items/page-item";
import { StoreContextModel } from "../store/StoreProvider";
import { Vector } from "../util/geometry";
import { calcJustifiedPagePaddingPx } from "./arrange/justified_metrics";
import { VeFns, VisualElement } from "./visual-element";


/**
 * The index of the cell of grid page pageVe under desktop position desktopPx, among its numChildren displayed
 * children. Past the last child, numChildren.
 */
export function gridInsertionIndexFromDesktopPx(
  store: StoreContextModel,
  pageVe: VisualElement,
  numChildren: number,
  desktopPx: Vector,
): number {
  const page = asPageItem(pageVe.displayItem);
  const viewportBoundsPx = VeFns.veViewportBoundsRelativeToDesktopPx(store, pageVe);
  const xOffsetPx = desktopPx.x - viewportBoundsPx.x;
  const yOffsetPx = desktopPx.y - viewportBoundsPx.y;
  const veid = VeFns.actualVeidFromVe(pageVe);
  const scrollYPx = store.perItem.getPageScrollYProp(veid)
    * Math.max(0, pageVe.childAreaBoundsPx!.h - pageVe.viewportBoundsPx!.h);
  const scrollXPx = store.perItem.getPageScrollXProp(veid)
    * Math.max(0, pageVe.childAreaBoundsPx!.w - pageVe.viewportBoundsPx!.w);
  const pagePaddingPx = calcJustifiedPagePaddingPx(pageVe.childAreaBoundsPx!.w, page.justifiedRowAspect);
  const rawCellX = Math.floor((xOffsetPx + scrollXPx - pagePaddingPx) / pageVe.cellSizePx!.w);
  const rawCellY = Math.floor((yOffsetPx + scrollYPx - pagePaddingPx) / pageVe.cellSizePx!.h);
  const cellX = Math.max(0, Math.min(page.gridNumberOfColumns, rawCellX));
  const cellY = Math.max(0, rawCellY);
  const index = cellY * page.gridNumberOfColumns + cellX;
  return Math.max(0, Math.min(index, numChildren));
}
