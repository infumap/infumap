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

import { LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL, RESIZE_BOX_SIZE_PX } from "../../../constants";
import { ItemFns } from "../../../items/base/item-polymorphism";
import { asPageItem } from "../../../items/page-item";
import { StoreContextModel } from "../../../store/StoreProvider";
import { itemState } from "../../../store/ItemState";
import { VisualElementSignal } from "../../../util/signals";
import { VesCache } from "../../ves-cache";
import { EMPTY_VEID, VeFns, VisualElementFlags, VisualElementSpec } from "../../visual-element";
import { arrangeSelectedListItem } from "../item";
import { getVePropertiesForItem } from "../util";
import { renderDockMaybe } from ".";
import { HitboxFlags, HitboxFns } from "../../hitbox";


export const arrange_list = (store: StoreContextModel) => {
  VesCache.initFullArrange();

  const currentPage = asPageItem(itemState.get(store.history.currentPage()!.itemId)!);
  const currentPath = currentPage.id;

  const blockSizePx = { w: LINE_HEIGHT_PX, h: LINE_HEIGHT_PX };

  const selectedVeid = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(store.history.currentPage()!));
  const topLevelPageBoundsPx  = store.desktopMainAreaBoundsPx();

  let resizeBoundsPx = {
    x: LIST_PAGE_LIST_WIDTH_BL * LINE_HEIGHT_PX - RESIZE_BOX_SIZE_PX,
    y: 0,
    w: RESIZE_BOX_SIZE_PX,
    h: store.desktopMainAreaBoundsPx().h
  }

  const topLevelVisualElementSpec: VisualElementSpec = {
    displayItem: currentPage,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren,
    boundsPx: topLevelPageBoundsPx,
    childAreaBoundsPx: topLevelPageBoundsPx,
    hitboxes: [
      HitboxFns.create(HitboxFlags.HorizontalResize, resizeBoundsPx),
    ]
  };

  const widthBl = LIST_PAGE_LIST_WIDTH_BL;

  let listVeChildren: Array<VisualElementSignal> = [];
  for (let idx=0; idx<currentPage.computed_children.length; ++idx) {
    const childItem = itemState.get(currentPage.computed_children[idx])!;
    const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

    const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx, 0, widthBl, false);

    const listItemVeSpec: VisualElementSpec = {
      displayItem,
      linkItemMaybe,
      flags: VisualElementFlags.LineItem |
             (VeFns.compareVeids(selectedVeid, VeFns.veidFromItems(displayItem, linkItemMaybe)) == 0 ? VisualElementFlags.Selected : VisualElementFlags.None),
      boundsPx: geometry.boundsPx,
      hitboxes: geometry.hitboxes,
      parentPath: currentPath,
      col: 0,
      row: idx,
      blockSizePx,
    };
    const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), currentPath);
    const listItemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(listItemVeSpec, childPath);
    listVeChildren.push(listItemVisualElementSignal);
  }
  topLevelVisualElementSpec.childrenVes = listVeChildren;

  if (selectedVeid != EMPTY_VEID) {
    const boundsPx = {
      x: LIST_PAGE_LIST_WIDTH_BL * LINE_HEIGHT_PX,
      y: 0,
      w: store.desktopMainAreaBoundsPx().w - (LIST_PAGE_LIST_WIDTH_BL * LINE_HEIGHT_PX),
      h: store.desktopMainAreaBoundsPx().h
    };
    topLevelVisualElementSpec.selectedVes = arrangeSelectedListItem(store, selectedVeid, boundsPx, currentPath, true, true);
  }

  const dockVesMaybe = renderDockMaybe(store, currentPath);
  if (dockVesMaybe) {
    topLevelVisualElementSpec.dockVes = dockVesMaybe;
  }

  // TODO (HIGH): render popup here.

  VesCache.finalizeFullArrange(topLevelVisualElementSpec, currentPath, store);
}
