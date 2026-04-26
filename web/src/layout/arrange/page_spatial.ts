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
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItem, arrangeItemNoChildrenPath, arrangeItemPath, getCommonVisualElementFlags } from "./item";
import { arrangeCellPopupPath, calcSpatialPopupGeometry } from "./popup";
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
    VesCache.titles.pushTopTitledPage(pageWithChildrenVePath);
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
      getCommonVisualElementFlags(flags) |
      (flags & ArrangeItemFlags.IsPopupRoot && store.history.getFocusItem().id == pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
      (isEmbeddedInteractive ? VisualElementFlags.EmbeddedInteractiveRoot : VisualElementFlags.None) |
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
  const pageChildAreaBoundsPx = pageSpec.childAreaBoundsPx!;

  const scrollableChildAreaBoundsPx: BoundingBox = {
    x: 0,
    y: 0,
    w: pageChildAreaBoundsPx.w,
    h: pageChildAreaBoundsPx.h,
  };

  const keepGeometryInsideScrollableArea = (itemGeometry: ItemGeometry): { geometry: ItemGeometry, wasAutoMoved: boolean } => {
    const nextBoundsPx = cloneBoundingBox(itemGeometry.boundsPx)!;
    const minX = scrollableChildAreaBoundsPx.x;
    const minY = scrollableChildAreaBoundsPx.y;
    const maxX = scrollableChildAreaBoundsPx.x + Math.max(0, scrollableChildAreaBoundsPx.w - nextBoundsPx.w);
    const maxY = scrollableChildAreaBoundsPx.y + Math.max(0, scrollableChildAreaBoundsPx.h - nextBoundsPx.h);
    const clampedX = Math.min(Math.max(nextBoundsPx.x, minX), maxX);
    const clampedY = Math.min(Math.max(nextBoundsPx.y, minY), maxY);
    const dx = clampedX - nextBoundsPx.x;
    const dy = clampedY - nextBoundsPx.y;
    if (dx === 0 && dy === 0) {
      return { geometry: itemGeometry, wasAutoMoved: false };
    }

    nextBoundsPx.x += dx;
    nextBoundsPx.y += dy;

    return {
      geometry: {
        ...itemGeometry,
        boundsPx: nextBoundsPx,
        viewportBoundsPx: itemGeometry.viewportBoundsPx == null
          ? null
          : {
            ...itemGeometry.viewportBoundsPx,
            x: itemGeometry.viewportBoundsPx.x + dx,
            y: itemGeometry.viewportBoundsPx.y + dy,
          },
      },
      wasAutoMoved: true,
    };
  };

  const childrenPaths: Array<VisualElementPath> = [];
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
      false,
      store.smallScreenMode());
    const { geometry: visibleItemGeometry, wasAutoMoved } = keepGeometryInsideScrollableArea(itemGeometry);
    let childPath: VisualElementPath;
    if (arrangeFlagIsRoot(flags) || displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) {
      childPath = arrangeItemPath(
        store, pageWithChildrenVePath, ArrangeAlgorithm.SpatialStretch, childItem, actualLinkItemMaybe, visibleItemGeometry,
        ArrangeItemFlags.RenderChildrenAsFull |
        (childItemIsEmbeddedInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
        (childItemIsPopup ? ArrangeItemFlags.IsPopupRoot : ArrangeItemFlags.None) |
        (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));
    } else {
      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);
      childPath = arrangeItemNoChildrenPath(
        store, pageWithChildrenVePath, displayItem, linkItemMaybe, actualLinkItemMaybe, visibleItemGeometry,
        (childItemIsPopup ? ArrangeItemFlags.IsPopupRoot : ArrangeItemFlags.None) |
        (flags & ArrangeItemFlags.IsMoving ? ArrangeItemFlags.IsMoving : ArrangeItemFlags.None) |
        ArrangeItemFlags.RenderAsOutline);
    }
    store.perVe.setAutoMovedIntoView(childPath, wasAutoMoved);
    childrenPaths.push(childPath);
  }
  pageRelationships.childrenPaths = childrenPaths;

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      const popupItemType = itemState.get(currentPopupSpec.actualVeid.itemId)!.itemType;
      const isFromAttachment = currentPopupSpec.isFromAttachment ?? false;
      const isSourceTopLeftAnchored = currentPopupSpec.sourceTopLeftGr != null &&
        popupItemType != ItemType.Page &&
        popupItemType != ItemType.Image;
      if (popupItemType == ItemType.Page || popupItemType == ItemType.Image || isFromAttachment || isSourceTopLeftAnchored) {
        // Position of page/image popup in spatial pages is user defined.
        // Use the shared geometry calculation from popup.ts
        const { geometry, linkItem, actualLinkItemMaybe, wasAutoAdjusted } = calcSpatialPopupGeometry(
          store,
          displayItem_pageWithChildren,
          currentPopupSpec.actualVeid,
          pageSpec.childAreaBoundsPx!
        );

        const popupVes = arrangeItem(
          store, pageWithChildrenVePath, ArrangeAlgorithm.SpatialStretch, linkItem, actualLinkItemMaybe, geometry,
          ArrangeItemFlags.RenderChildrenAsFull | ArrangeItemFlags.IsPopupRoot);
        pageRelationships.popupPath = VeFns.veToPath(popupVes.get());
        store.perVe.setAutoMovedIntoView(pageRelationships.popupPath, wasAutoAdjusted);

      } else {
        pageRelationships.popupPath = arrangeCellPopupPath(store);
      }
    }
  }

  return { spec: pageSpec, relationships: pageRelationships };
}
