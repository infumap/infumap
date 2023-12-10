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
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkFns, LinkItem } from "../../items/link-item";
import { ArrangeAlgorithm, PageFns, PageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { PopupType } from "../../store/StoreProvider_History";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { panic } from "../../util/lang";
import { newOrdering } from "../../util/ordering";
import { POPUP_LINK_UID } from "../../util/uid";
import { ItemGeometry } from "../item-geometry";
import { RelationshipToParent } from "../relationship-to-parent";
import { VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeItem, arrangeItemNoChildren } from "./item";
import { arrangeCellPopup } from "./popup";
import { getVePropertiesForItem } from "./util";


export function arrange_spatial_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    realParentVeid: Veid | null,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSpec {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const outerBoundsPx = geometry.boundsPx;
  const hitboxes = geometry.hitboxes;

  const parentIsPopup = !!(flags & ArrangeItemFlags.IsPopup);

  const aspect = outerBoundsPx.w / outerBoundsPx.h;
  const pageAspect = displayItem_pageWithChildren.naturalAspect;
  const pageBoundsPx = (() => {
    let result = cloneBoundingBox(outerBoundsPx)!;
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

  const isEmbeddedInteractive = (displayItem_pageWithChildren.flags & PageFlags.Interactive) && VeFns.pathDepth(parentPath) == 2;

  pageWithChildrenVisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
            (flags & ArrangeItemFlags.IsPopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
            (flags & ArrangeItemFlags.IsPopup && store.getToolbarFocus()!.itemId ==  pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
            (flags & ArrangeItemFlags.IsRoot || isEmbeddedInteractive ? VisualElementFlags.Root : VisualElementFlags.None) |
            (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
            (flags & ArrangeItemFlags.IsListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None) |
            (isEmbeddedInteractive ? VisualElementFlags.EmbededInteractive : VisualElementFlags.None),
    boundsPx: outerBoundsPx,
    childAreaBoundsPx: pageBoundsPx,
    hitboxes,
    parentPath,
  };

  const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);

  const childrenVes = [];
  for (let i=0; i<displayItem_pageWithChildren.computed_children.length; ++i) {
    const childId = displayItem_pageWithChildren.computed_children[i];
    const childItem = itemState.get(childId)!;
    const emitHitboxes = true;
    const childItemIsPopup = false; // never the case.
    const hasPendingChanges = false; // it may do, but only matters for popups.
    if (flags & ArrangeItemFlags.IsPopup || flags & ArrangeItemFlags.IsRoot || displayItem_pageWithChildren.flags & PageFlags.Interactive) {
      const itemGeometry = ItemFns.calcGeometry_Spatial(
        childItem,
        zeroBoundingBoxTopLeft(pageWithChildrenVisualElementSpec.childAreaBoundsPx!),
        PageFns.calcInnerSpatialDimensionsBl(displayItem_pageWithChildren),
        parentIsPopup,
        emitHitboxes,
        childItemIsPopup,
        hasPendingChanges);
      const ves = arrangeItem(
        store, pageWithChildrenVePath, pageWithChildrenVeid, ArrangeAlgorithm.SpatialStretch, childItem, itemGeometry,
        ArrangeItemFlags.RenderChildrenAsFull |
        (childItemIsPopup ? ArrangeItemFlags.IsPopup : ArrangeItemFlags.None) |
        (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));
      childrenVes.push(ves);
    } else {
      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);
      const parentPageInnerDimensionsBl = PageFns.calcInnerSpatialDimensionsBl(displayItem_pageWithChildren);
      const itemGeometry = ItemFns.calcGeometry_Spatial(
        childItem,
        innerBoundsPx,
        parentPageInnerDimensionsBl,
        parentIsPopup,
        emitHitboxes,
        childItemIsPopup,
        hasPendingChanges);
      childrenVes.push(arrangeItemNoChildren(
        store, pageWithChildrenVePath, displayItem, linkItemMaybe, itemGeometry,
        (childItemIsPopup ? ArrangeItemFlags.IsPopup : ArrangeItemFlags.None) |
        (flags & ArrangeItemFlags.IsMoving ? ArrangeItemFlags.IsMoving : ArrangeItemFlags.None) |
        ArrangeItemFlags.RenderAsOutline));
    }
  }
  pageWithChildrenVisualElementSpec.childrenVes = childrenVes;

  if (flags & ArrangeItemFlags.IsRoot && !(flags & ArrangeItemFlags.IsPopup)) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      if (currentPopupSpec.type == PopupType.Page) {
        // Position of page popup in spatial pages is user defined.
        const popupLinkToPageId = VeFns.veidFromPath(currentPopupSpec.vePath).itemId;
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
          store, pageWithChildrenVePath, pageWithChildrenVeid, ArrangeAlgorithm.SpatialStretch, li, itemGeometry,
          ArrangeItemFlags.RenderChildrenAsFull | ArrangeItemFlags.IsPopup);

      } else if (currentPopupSpec.type == PopupType.Attachment) {
        // Ves are created inline.
      } else if (currentPopupSpec.type == PopupType.Image) {
        pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store, realParentVeid);
      } else {
        panic(`arrange_spatialStretch: unknown popup type: ${currentPopupSpec.type}.`);
      }
    }
  }

  return pageWithChildrenVisualElementSpec;
}