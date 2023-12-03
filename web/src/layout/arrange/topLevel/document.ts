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

import { asPageItem } from "../../../items/page-item";
import { StoreContextModel } from "../../../store/StoreProvider";
import { itemState } from "../../../store/ItemState";
import { VesCache } from "../../ves-cache";
import { VeFns, VisualElementFlags, VisualElementSpec } from "../../visual-element";
import { renderDockMaybe } from ".";
import { BLOCK_SIZE_PX, COMPOSITE_ITEM_GAP_BL, PAGE_DOCUMENT_LEFT_MARGIN_PX, PAGE_DOCUMENT_TOP_MARGIN_PX } from "../../../constants";
import { getVePropertiesForItem } from "../util";
import { isTable } from "../../../items/table-item";
import { ItemFns } from "../../../items/base/item-polymorphism";


export const arrange_document = (store: StoreContextModel): void => {
  VesCache.initFullArrange();

  const currentPage = asPageItem(itemState.get(store.history.currentPage()!.itemId)!);
  const currentPath = currentPage.id;

  const pageBoundsPx = store.desktopMainAreaBoundsPx();
  const totalWidthBl = currentPage.docWidthBl + 3.5; // 3.5 == total margin.
  const requiredWidthPx = totalWidthBl * BLOCK_SIZE_PX.w;
  let scale = pageBoundsPx.w / requiredWidthPx;
  if (scale > 1.0) { scale = 1.0; }
  const blockSizePx = { w: BLOCK_SIZE_PX.w * scale, h: BLOCK_SIZE_PX.h * scale };

  const childrenVes = [];

  let topPx = PAGE_DOCUMENT_TOP_MARGIN_PX * scale;
  for (let idx=0; idx<currentPage.computed_children.length; ++idx) {
    const childId = currentPage.computed_children[idx];
    const childItem = itemState.get(childId)!;

    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);
    if (isTable(displayItem_childItem)) { continue; }

    const geometry = ItemFns.calcGeometry_InComposite(
      linkItemMaybe_childItem ? linkItemMaybe_childItem : displayItem_childItem,
      blockSizePx,
      currentPage.docWidthBl,
      topPx);

    const childVeSpec: VisualElementSpec = {
      displayItem: displayItem_childItem,
      linkItemMaybe: linkItemMaybe_childItem,
      flags: VisualElementFlags.InsideCompositeOrDoc | VisualElementFlags.Detailed,
      boundsPx: {
        x: geometry.boundsPx.x + PAGE_DOCUMENT_LEFT_MARGIN_PX * scale,
        y: geometry.boundsPx.y,
        w: geometry.boundsPx.w,
        h: geometry.boundsPx.h,
      },
      hitboxes: geometry.hitboxes,
      parentPath: currentPath,
      col: 0,
      row: idx,
      blockSizePx,
    };

    const childVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), currentPath);
    const childVeSignal = VesCache.createOrRecycleVisualElementSignal(childVeSpec, childVePath);
    childrenVes.push(childVeSignal);

    topPx += geometry.boundsPx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;
  }

  const childAreaBoundsPx = store.desktopMainAreaBoundsPx();
  childAreaBoundsPx.h = topPx + PAGE_DOCUMENT_TOP_MARGIN_PX;

  const topLevelVisualElementSpec: VisualElementSpec = {
    displayItem: currentPage,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren,
    boundsPx: store.desktopMainAreaBoundsPx(),
    childAreaBoundsPx,
  };

  const dockVesMaybe = renderDockMaybe(store, currentPath);
  if (dockVesMaybe) {
    topLevelVisualElementSpec.dockVes = dockVesMaybe;
  }

  topLevelVisualElementSpec.childrenVes = childrenVes;

  VesCache.finalizeFullArrange(topLevelVisualElementSpec, currentPath, store);
}
