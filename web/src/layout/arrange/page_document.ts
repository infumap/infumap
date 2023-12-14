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

import { BLOCK_SIZE_PX, COMPOSITE_ITEM_GAP_BL, PAGE_DOCUMENT_LEFT_MARGIN_PX, PAGE_DOCUMENT_TOP_MARGIN_PX } from "../../constants";
import { PageFlags } from "../../items/base/flags-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem } from "../../items/link-item";
import { PageItem } from "../../items/page-item";
import { isTable } from "../../items/table-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { cloneBoundingBox } from "../../util/geometry";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags } from "./item";
import { getVePropertiesForItem } from "./util";


export function arrange_document_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    _realParentVeid: Veid | null,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSpec {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const outerBoundsPx = geometry.boundsPx;
  const hitboxes = geometry.hitboxes;

  const parentIsPopup = flags & ArrangeItemFlags.IsPopupRoot;

  const totalWidthBl = displayItem_pageWithChildren.docWidthBl + 4; // 4 == total margin.
  const requiredWidthPx = totalWidthBl * BLOCK_SIZE_PX.w;
  let scale = geometry.boundsPx.w / requiredWidthPx;
  if (scale > 1.0) { scale = 1.0; }
  const blockSizePx = { w: BLOCK_SIZE_PX.w * scale, h: BLOCK_SIZE_PX.h * scale };

  const childrenVes = [];

  let topPx = PAGE_DOCUMENT_TOP_MARGIN_PX * scale;
  for (let idx=0; idx<displayItem_pageWithChildren.computed_children.length; ++idx) {
    const childId = displayItem_pageWithChildren.computed_children[idx];
    const childItem = itemState.get(childId)!;

    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);
    if (isTable(displayItem_childItem)) { continue; }

    const geometry = ItemFns.calcGeometry_InComposite(
      linkItemMaybe_childItem ? linkItemMaybe_childItem : displayItem_childItem,
      blockSizePx,
      displayItem_pageWithChildren.docWidthBl,
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
      parentPath: pageWithChildrenVePath,
      col: 0,
      row: idx,
      blockSizePx: blockSizePx,
    };

    const childVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), pageWithChildrenVePath);
    const childVeSignal = VesCache.createOrRecycleVisualElementSignal(childVeSpec, childVePath);
    childrenVes.push(childVeSignal);

    topPx += geometry.boundsPx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;
  }

  const childAreaBoundsPx = cloneBoundingBox(geometry.boundsPx)!;
  childAreaBoundsPx.h = topPx;

  const isEmbeddedInteractive = (displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) && VeFns.pathDepth(parentPath) == 2;

  pageWithChildrenVisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
          (flags & ArrangeItemFlags.IsPopupRoot ? VisualElementFlags.PopupRoot : VisualElementFlags.None) |
          (flags & ArrangeItemFlags.IsPopupRoot && store.getToolbarFocus()!.itemId ==  pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
          (flags & ArrangeItemFlags.IsRoot || isEmbeddedInteractive ? VisualElementFlags.Root : VisualElementFlags.None) |
          (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
          (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None) |
          (isEmbeddedInteractive ? VisualElementFlags.EmbededInteractiveRoot : VisualElementFlags.None),
    boundsPx: outerBoundsPx,
    childAreaBoundsPx,
    hitboxes,
    parentPath,
  };

  pageWithChildrenVisualElementSpec.childrenVes = childrenVes;

  return pageWithChildrenVisualElementSpec;
}