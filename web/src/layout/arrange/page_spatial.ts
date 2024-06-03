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

import { GRID_SIZE } from "../../constants";
import { PageFlags } from "../../items/base/flags-item";
import { ItemType } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkFns, LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { newOrdering } from "../../util/ordering";
import { POPUP_LINK_UID } from "../../util/uid";
import { ItemGeometry } from "../item-geometry";
import { RelationshipToParent } from "../relationship-to-parent";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItem, arrangeItemNoChildren } from "./item";
import { arrangeCellPopup } from "./popup";
import { getVePropertiesForItem } from "./util";


export function arrange_spatial_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    actualLinkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSpec {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const parentIsPopup = !!(flags & ArrangeItemFlags.IsPopupRoot);

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
           (isEmbeddedInteractive ? VisualElementFlags.EmbededInteractiveRoot : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsDockRoot ? VisualElementFlags.DockItem : VisualElementFlags.None),
    arrangeFlags: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: geometry.viewportBoundsPx!,
    hitboxes: geometry.hitboxes,
    childAreaBoundsPx,
    parentPath,
  };

  const childrenVes = [];
  for (let i=0; i<displayItem_pageWithChildren.computed_children.length; ++i) {
    const childId = displayItem_pageWithChildren.computed_children[i];
    const childItem = itemState.get(childId)!;
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;
    const emitHitboxes = true;
    const childItemIsPopup = false; // never the case.
    const childItemIsEmbededInteractive = isPage(childItem) && asPageItem(childItem).flags & PageFlags.EmbeddedInteractive;
    const hasPendingChanges = false; // it may do, but only matters for popups.
    const parentPageInnerDimensionsBl = PageFns.calcInnerSpatialDimensionsBl(displayItem_pageWithChildren);
    const itemGeometry = ItemFns.calcGeometry_Spatial(
      childItem,
      zeroBoundingBoxTopLeft(pageWithChildrenVisualElementSpec.childAreaBoundsPx!),
      parentPageInnerDimensionsBl,
      parentIsPopup,
      emitHitboxes,
      childItemIsPopup,
      hasPendingChanges);
    if (arrangeFlagIsRoot(flags) || displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) {
      const ves = arrangeItem(
        store, pageWithChildrenVePath, ArrangeAlgorithm.SpatialStretch, childItem, actualLinkItemMaybe, itemGeometry,
        ArrangeItemFlags.RenderChildrenAsFull |
        (childItemIsEmbededInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
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
  pageWithChildrenVisualElementSpec.childrenVes = childrenVes;

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      if (itemState.get(currentPopupSpec.actualVeid.itemId)!.itemType == ItemType.Page) {
        // Position of page popup in spatial pages is user defined.
        const popupVeid = currentPopupSpec.actualVeid;
        const popupLinkToPageId = popupVeid.itemId;
        const actualLinkItemMaybe = popupVeid.linkIdMaybe == null ? null : asLinkItem(itemState.get(popupVeid.linkIdMaybe)!);
        const li = LinkFns.create(displayItem_pageWithChildren.ownerId, displayItem_pageWithChildren.id, RelationshipToParent.Child, newOrdering(), popupLinkToPageId!);
        li.id = POPUP_LINK_UID;
        const widthGr = PageFns.getPopupWidthGr(displayItem_pageWithChildren);
        const heightGr = Math.round((widthGr / displayItem_pageWithChildren.naturalAspect / GRID_SIZE)/ 2.0) * 2.0 * GRID_SIZE;
        li.spatialWidthGr = widthGr;
        // assume center positioning.
        li.spatialPositionGr = {
          x: PageFns.getPopupPositionGr(displayItem_pageWithChildren).x - widthGr / 2.0,
          y: PageFns.getPopupPositionGr(displayItem_pageWithChildren).y - heightGr / 2.0
        };

        const itemGeometry = ItemFns.calcGeometry_Spatial(li,
          zeroBoundingBoxTopLeft(pageWithChildrenVisualElementSpec.childAreaBoundsPx!),
          PageFns.calcInnerSpatialDimensionsBl(displayItem_pageWithChildren),
          false, true, true,
          PageFns.popupPositioningHasChanged(displayItem_pageWithChildren));

        pageWithChildrenVisualElementSpec.popupVes = arrangeItem(
          store, pageWithChildrenVePath, ArrangeAlgorithm.SpatialStretch, li, actualLinkItemMaybe, itemGeometry,
          ArrangeItemFlags.RenderChildrenAsFull | ArrangeItemFlags.IsPopupRoot);

      } else {
        pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store);
      }
    }
  }

  return pageWithChildrenVisualElementSpec;
}
