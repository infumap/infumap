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

import { LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX } from "../../constants";
import { fullArrange } from "../../layout/arrange";
import { HitboxFns, HitboxFlags } from "../../layout/hitbox";
import { ItemGeometry } from "../../layout/item-geometry";
import { VesCache } from "../../layout/ves-cache";
import { VisualElement, VisualElementFlags, VeFns } from "../../layout/visual-element";
import { StoreContextModel } from "../../store/StoreProvider";
import { BoundingBox, Dimensions } from "../../util/geometry";
import { ArrangeAlgorithm, asPageItem, isPage } from "../page-item";
import { Measurable } from "./item";


export function handleListPageLineItemClickMaybe(visualElement: VisualElement, store: StoreContextModel): boolean {
  const parentVe = VesCache.get(visualElement.parentPath!)!.get();
  if (parentVe.flags & VisualElementFlags.DockItem) {
    return false;
  }
  const parentItem = parentVe.displayItem;
  if ((visualElement.flags & VisualElementFlags.LineItem) && isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
    const parentVeid = VeFns.actualVeidFromVe(parentVe);
    store.history.setFocus(VeFns.veToPath(parentVe));
    store.perItem.setSelectedListPageItem(parentVeid, VeFns.veidFromVe(visualElement));
    fullArrange(store);
    return true;
  }
  return false;
}

export function calcGeometryOfEmptyItem_ListItem(_empty: Measurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean, _expandable: boolean): ItemGeometry {
  const innerBoundsPx = {
    x: 0.0,
    y: 0.0,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  const boundsPx = {
    x: blockSizePx.w * col,
    y: blockSizePx.h * row + (padTop ? LIST_PAGE_TOP_PADDING_PX : 0),
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  return {
    boundsPx,
    blockSizePx,
    viewportBoundsPx: null,
    hitboxes: [
      HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx)
    ]
  };
}

/**
 * Units of size are arbitrary. Used only for aspect calculations.
 */
export function calcBoundsInCell(size: Dimensions, cellBoundsPx: BoundingBox): BoundingBox {
  const aspect = size.w / size.h;
  let result: BoundingBox;
  if (size.w / cellBoundsPx.w > size.h / cellBoundsPx.h) {
    // constraining dimension is width.
    result = {
      x: cellBoundsPx.x,
      w: cellBoundsPx.w,
      h: Math.round(cellBoundsPx.w / aspect),
      y: Math.round(cellBoundsPx.y + (cellBoundsPx.h - (cellBoundsPx.w / aspect)) / 2.0)
    };
  } else {
    // constraining dimension is height.
    result = {
      y: cellBoundsPx.y,
      h: cellBoundsPx.h,
      w: Math.round(cellBoundsPx.h * aspect),
      x: Math.round(cellBoundsPx.x + (cellBoundsPx.w - (cellBoundsPx.h * aspect)) / 2.0)
    };
  }
  return result;
}

/**
 * Size is bounded by natural block size.
 */
export function calcBoundsInCellFromSizeBl(sizeBl: Dimensions, cellBoundsPx: BoundingBox): BoundingBox {
  const boundsPx = calcBoundsInCell(sizeBl, cellBoundsPx);
  const blockSizePx: Dimensions = {
    w: boundsPx.w / sizeBl.w,
    h: boundsPx.h / sizeBl.h
  };
  let xScale = 1.0;
  if (blockSizePx.w > LINE_HEIGHT_PX) {
    xScale = blockSizePx.w / LINE_HEIGHT_PX;
  }
  let yScale = 1.0;
  if (blockSizePx.h > LINE_HEIGHT_PX) {
    yScale = blockSizePx.h / LINE_HEIGHT_PX;
  }
  let scale = Math.max(xScale, yScale);
  let xSizeDeltaPx = boundsPx.w - boundsPx.w / scale;
  let ySizeDeltaPx = boundsPx.h - boundsPx.h / scale;
  return ({
    x: boundsPx.x + xSizeDeltaPx / 2.0,
    y: boundsPx.y + ySizeDeltaPx / 2.0,
    w: boundsPx.w - xSizeDeltaPx,
    h: boundsPx.h - ySizeDeltaPx,
  });
}
