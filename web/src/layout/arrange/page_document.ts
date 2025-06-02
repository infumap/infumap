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

import { NATURAL_BLOCK_SIZE_PX, COMPOSITE_ITEM_GAP_BL, PAGE_DOCUMENT_LEFT_MARGIN_BL, PAGE_DOCUMENT_RIGHT_MARGIN_BL, PAGE_DOCUMENT_TOP_MARGIN_PX } from "../../constants";
import { PageFlags } from "../../items/base/flags-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem, asPageItem, isPage } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItem } from "./item";
import { getVePropertiesForItem } from "./util";


export function arrange_document_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    actualLinkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSpec {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : actualLinkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const parentIsPopup = flags & ArrangeItemFlags.IsPopupRoot;

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  if (isFull) {
    VesCache.pushTopTitledPage(pageWithChildrenVePath);
  }

  const totalMarginBl = PAGE_DOCUMENT_LEFT_MARGIN_BL + PAGE_DOCUMENT_RIGHT_MARGIN_BL;
  const totalWidthBl = displayItem_pageWithChildren.docWidthBl + totalMarginBl;
  const requiredWidthPx = totalWidthBl * NATURAL_BLOCK_SIZE_PX.w;
  let scale = geometry.boundsPx.w / requiredWidthPx;
  if (scale > 1.0) { scale = 1.0; }
  const blockSizePx = { w: NATURAL_BLOCK_SIZE_PX.w * scale, h: NATURAL_BLOCK_SIZE_PX.h * scale };

  const childrenVes = [];

  let topPx = PAGE_DOCUMENT_TOP_MARGIN_PX * scale;
  for (let idx=0; idx<displayItem_pageWithChildren.computed_children.length; ++idx) {
    const childId = displayItem_pageWithChildren.computed_children[idx];
    const childItem = itemState.get(childId)!;
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;

    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);

    const geometry = ItemFns.calcGeometry_InComposite(
      linkItemMaybe_childItem ? linkItemMaybe_childItem : displayItem_childItem,
      blockSizePx,
      totalWidthBl - totalMarginBl,
      PAGE_DOCUMENT_LEFT_MARGIN_BL,
      topPx,
      store.smallScreenMode());

    const childItemIsEmbeddedInteractive = isPage(childItem) && asPageItem(childItem).flags & PageFlags.EmbeddedInteractive;
    const renderChildrenAsFull = flags & ArrangeItemFlags.IsPopupRoot || arrangeFlagIsRoot(flags);

    const ves = arrangeItem(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Document, childItem, actualLinkItemMaybe, geometry,
      (renderChildrenAsFull ? ArrangeItemFlags.RenderChildrenAsFull : ArrangeItemFlags.None) |
      (childItemIsEmbeddedInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
      (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));

    ves.get().blockSizePx = blockSizePx
    ves.get().row = idx;
    ves.get().col = 0;
    ves.get().flags = ves.get().flags | VisualElementFlags.InsideCompositeOrDoc;
    ves.set(ves.get()); // TODO (MEDIUM): avoid the double set (arrangeItem also sets).

    childrenVes.push(ves);

    topPx += geometry.boundsPx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;
  }

  const childAreaBoundsPx = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.boundsPx)!);
  childAreaBoundsPx.h = topPx;

  const isEmbeddedInteractive =
    !!(displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) &&
    (VeFns.pathDepth(parentPath) >= 2) &&
    !(flags & ArrangeItemFlags.IsTopRoot) &&
    !(flags & ArrangeItemFlags.IsPopupRoot) &&
    !(flags & ArrangeItemFlags.IsListPageMainRoot);

  const highlightedPath = store.find.highlightedPath.get();
  const isHighlighted = highlightedPath !== null && highlightedPath === pageWithChildrenVePath;

  pageWithChildrenVisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    actualLinkItemMaybe: actualLinkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
           (flags & ArrangeItemFlags.IsPopupRoot ? VisualElementFlags.Popup : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsTopRoot ? VisualElementFlags.TopLevelRoot : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsPopupRoot && store.history.getFocusItem().id == pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsDockRoot ? VisualElementFlags.DockItem : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.InsideCompositeOrDoc ? VisualElementFlags.InsideCompositeOrDoc : VisualElementFlags.None) |
           (isHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: geometry.viewportBoundsPx!,
    hitboxes: geometry.hitboxes,
    childAreaBoundsPx,
    parentPath,
  };

  pageWithChildrenVisualElementSpec.childrenVes = childrenVes;

  return pageWithChildrenVisualElementSpec;
}