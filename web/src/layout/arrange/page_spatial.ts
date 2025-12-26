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

import { PageFlags } from "../../items/base/flags-item";
import { ItemType } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItem, arrangeItemNoChildren } from "./item";
import { arrangeCellPopup, calcSpatialPopupGeometry } from "./popup";
import { getVePropertiesForItem } from "./util";


export function arrange_spatial_page(
  store: StoreContextModel,
  parentPath: VisualElementPath,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  actualLinkItemMaybe_pageWithChildren: LinkItem | null,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags): { spec: VisualElementSpec, relationships: VisualElementRelationships } {

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : actualLinkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const parentIsPopup = !!(flags & ArrangeItemFlags.IsPopupRoot);

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  if (isFull) {
    VesCache.pushTopTitledPage(pageWithChildrenVePath);
  }

  const childAreaBoundsPx = (() => {
    const aspect = geometry.viewportBoundsPx!.w / geometry.viewportBoundsPx!.h;
    const pageAspect = displayItem_pageWithChildren.naturalAspect;
    let result = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.viewportBoundsPx)!);
    // TODO (MEDIUM): make these cutoff aspect ratios configurable in user settings.
    if (pageAspect / aspect > 1.3) {
      // page to scroll horizontally.
      result.w = Math.round(result.h * pageAspect);
    } else if (pageAspect / aspect < 0.7) {
      // page needs to scroll vertically.
      result.h = Math.round(result.w / pageAspect);
    }
    return result;
  })();

  const isEmbeddedInteractive =
    !!(displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) &&
    (VeFns.pathDepth(parentPath) >= 2) &&
    !(flags & ArrangeItemFlags.IsTopRoot) &&
    !(flags & ArrangeItemFlags.IsPopupRoot) &&
    !(flags & ArrangeItemFlags.IsListPageMainRoot);

  const highlightedPath = store.find.highlightedPath.get();
  const isHighlighted = highlightedPath !== null && highlightedPath === pageWithChildrenVePath;
  const isSelectionHighlighted = (() => {
    const sel = store.overlay.selectedVeids.get();
    if (!sel || sel.length === 0) { return false; }
    const veid = VeFns.veidFromItems(displayItem_pageWithChildren, actualLinkItemMaybe_pageWithChildren);
    for (let i = 0; i < sel.length; ++i) {
      if (sel[i].itemId === veid.itemId && sel[i].linkIdMaybe === veid.linkIdMaybe) { return true; }
    }
    return false;
  })();

  const pageSpec: VisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    actualLinkItemMaybe: actualLinkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
      (flags & ArrangeItemFlags.IsPopupRoot ? VisualElementFlags.Popup : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsTopRoot ? VisualElementFlags.TopLevelRoot : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsPopupRoot && store.history.getFocusItem().id == pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
      (isEmbeddedInteractive ? VisualElementFlags.EmbeddedInteractiveRoot : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsDockRoot ? VisualElementFlags.DockItem : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.InsideCompositeOrDoc ? VisualElementFlags.InsideCompositeOrDoc : VisualElementFlags.None) |
      (isHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None) |
      (isSelectionHighlighted ? VisualElementFlags.SelectionHighlighted : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: geometry.viewportBoundsPx!,
    hitboxes: geometry.hitboxes,
    childAreaBoundsPx,
    parentPath,
  };

  const pageRelationships: VisualElementRelationships = {};

  const childrenVes = [];
  for (let i = 0; i < displayItem_pageWithChildren.computed_children.length; ++i) {
    const childId = displayItem_pageWithChildren.computed_children[i];
    const childItem = itemState.get(childId)!;
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;
    const emitHitboxes = true;
    const childItemIsPopup = false; // never the case.
    const childItemIsEmbeddedInteractive = isPage(childItem) && asPageItem(childItem).flags & PageFlags.EmbeddedInteractive;
    const hasChildChanges = false; // it may do, but only matters for popups.
    const hasDefaultChanges = false;
    const parentPageInnerDimensionsBl = PageFns.calcInnerSpatialDimensionsBl(displayItem_pageWithChildren);
    const itemGeometry = ItemFns.calcGeometry_Spatial(
      childItem,
      zeroBoundingBoxTopLeft(pageSpec.childAreaBoundsPx!),
      parentPageInnerDimensionsBl,
      parentIsPopup,
      emitHitboxes,
      childItemIsPopup,
      hasChildChanges,
      hasDefaultChanges,
      store.perVe.getFlipCardIsEditing(VeFns.addVeidToPath(VeFns.veidFromItems(childItem, actualLinkItemMaybe), pageWithChildrenVePath)),
      store.smallScreenMode());
    if (arrangeFlagIsRoot(flags) || displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) {
      const ves = arrangeItem(
        store, pageWithChildrenVePath, ArrangeAlgorithm.SpatialStretch, childItem, actualLinkItemMaybe, itemGeometry,
        ArrangeItemFlags.RenderChildrenAsFull |
        (childItemIsEmbeddedInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
        (childItemIsPopup ? ArrangeItemFlags.IsPopupRoot : ArrangeItemFlags.None) |
        (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));
      childrenVes.push(ves);
    } else {
      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);
      const ves = arrangeItemNoChildren(
        store, pageWithChildrenVePath, displayItem, linkItemMaybe, actualLinkItemMaybe, itemGeometry,
        (childItemIsPopup ? ArrangeItemFlags.IsPopupRoot : ArrangeItemFlags.None) |
        (flags & ArrangeItemFlags.IsMoving ? ArrangeItemFlags.IsMoving : ArrangeItemFlags.None) |
        ArrangeItemFlags.RenderAsOutline)
      childrenVes.push(ves);
    }
  }
  pageRelationships.childrenVes = childrenVes;

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      const popupItemType = itemState.get(currentPopupSpec.actualVeid.itemId)!.itemType;
      const isFromAttachment = currentPopupSpec.isFromAttachment ?? false;
      if (popupItemType == ItemType.Page || popupItemType == ItemType.Image || isFromAttachment) {
        // Position of page/image popup in spatial pages is user defined.
        // Use the shared geometry calculation from popup.ts
        const { geometry, linkItem, actualLinkItemMaybe } = calcSpatialPopupGeometry(
          store,
          displayItem_pageWithChildren,
          currentPopupSpec.actualVeid,
          pageSpec.childAreaBoundsPx!
        );

        pageRelationships.popupVes = arrangeItem(
          store, pageWithChildrenVePath, ArrangeAlgorithm.SpatialStretch, linkItem, actualLinkItemMaybe, geometry,
          ArrangeItemFlags.RenderChildrenAsFull | ArrangeItemFlags.IsPopupRoot);

      } else {
        pageRelationships.popupVes = arrangeCellPopup(store);
      }
    }
  }

  return { spec: pageSpec, relationships: pageRelationships };
}

