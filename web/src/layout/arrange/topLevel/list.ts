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

import { LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL } from "../../../constants";
import { ItemFns } from "../../../items/base/item-polymorphism";
import { asXSizableItem, isXSizableItem } from "../../../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../../../items/base/y-sizeable-item";
import { LinkFns } from "../../../items/link-item";
import { ArrangeAlgorithm, PageFns, asPageItem } from "../../../items/page-item";
import { DesktopStoreContextModel } from "../../../store/DesktopStoreProvider";
import { itemState } from "../../../store/ItemState";
import { BoundingBox } from "../../../util/geometry";
import { newOrdering } from "../../../util/ordering";
import { VisualElementSignal } from "../../../util/signals";
import { newUid } from "../../../util/uid";
import { RelationshipToParent } from "../../relationship-to-parent";
import { VesCache } from "../../ves-cache";
import { EMPTY_VEID, VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../../visual-element";
import { arrangeItem } from "../item";
import { getVePropertiesForItem } from "../util";


const LIST_FOCUS_ID = newUid();

export const arrange_list = (desktopStore: DesktopStoreContextModel) => {
  VesCache.initFullArrange();

  const currentPage = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  const currentPath = currentPage.id;

  const selectedVeid = VeFns.veidFromPath(desktopStore.getSelectedListPageItem(desktopStore.currentPage()!));
  const topLevelPageBoundsPx  = desktopStore.desktopBoundsPx();
  const topLevelVisualElementSpec: VisualElementSpec = {
    displayItem: currentPage,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren,
    boundsPx: topLevelPageBoundsPx,
    childAreaBoundsPx: topLevelPageBoundsPx,
  };

  const widthBl = LIST_PAGE_LIST_WIDTH_BL;

  let listVeChildren: Array<VisualElementSignal> = [];
  for (let idx=0; idx<currentPage.computed_children.length; ++idx) {
    const childItem = itemState.get(currentPage.computed_children[idx])!;
    const { displayItem, linkItemMaybe } = getVePropertiesForItem(desktopStore, childItem);

    const blockSizePx = { w: LINE_HEIGHT_PX, h: LINE_HEIGHT_PX };

    const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx+1, 0, widthBl);

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
      oneBlockWidthPx: LINE_HEIGHT_PX,
    };
    const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), currentPath);
    const listItemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(listItemVeSpec, childPath);
    listVeChildren.push(listItemVisualElementSignal);
  }
  topLevelVisualElementSpec.children = listVeChildren;

  if (selectedVeid != EMPTY_VEID) {
    const boundsPx = {
      x: (LIST_PAGE_LIST_WIDTH_BL+1) * LINE_HEIGHT_PX,
      y: LINE_HEIGHT_PX,
      w: desktopStore.desktopBoundsPx().w - ((LIST_PAGE_LIST_WIDTH_BL+2) * LINE_HEIGHT_PX),
      h: desktopStore.desktopBoundsPx().h - (2 * LINE_HEIGHT_PX)
    };
    topLevelVisualElementSpec.children.push(
      arrangeSelectedListItem(desktopStore, selectedVeid, boundsPx, currentPath));
  }

  VesCache.finalizeFullArrange(topLevelVisualElementSpec, currentPath, desktopStore);
}


function arrangeSelectedListItem(desktopStore: DesktopStoreContextModel, veid: Veid, boundsPx: BoundingBox, currentPath: VisualElementPath): VisualElementSignal {
  const item = itemState.get(veid.itemId)!;

  let li = LinkFns.create(item.ownerId, item.parentId, RelationshipToParent.Child, newOrdering(), veid.itemId);
  li.id = LIST_FOCUS_ID;
  if (isXSizableItem(item)) { li.spatialWidthGr = asXSizableItem(item).spatialWidthGr; }
  if (isYSizableItem(item)) { li.spatialHeightGr = asYSizableItem(item).spatialHeightGr; }
  li.spatialPositionGr = { x: 0.0, y: 0.0 };

  const expandable = true;
  const geometry = ItemFns.calcGeometry_InCell(li, boundsPx, expandable);

  return arrangeItem(desktopStore, currentPath, ArrangeAlgorithm.List, li, geometry, true, false, true);
}
