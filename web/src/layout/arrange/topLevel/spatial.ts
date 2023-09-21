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

import { GRID_SIZE } from "../../../constants";
import { LinkFns } from "../../../items/link-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem } from "../../../items/page-item";
import { DesktopStoreContextModel, PopupType } from "../../../store/DesktopStoreProvider";
import { itemState } from "../../../store/ItemState";
import { panic } from "../../../util/lang";
import { newOrdering } from "../../../util/ordering";
import { RelationshipToParent } from "../../relationship-to-parent";
import { VesCache } from "../../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../../visual-element";
import { arrangeCellPopup } from "../popup";
import { newUid } from "../../../util/uid";
import { Item } from "../../../items/base/item";
import { BoundingBox, zeroBoundingBoxTopLeft } from "../../../util/geometry";
import { VisualElementSignal } from "../../../util/signals";
import { ItemFns } from "../../../items/base/item-polymorphism";
import { arrangeItem } from "../item";


const SPATIAL_POPUP_LINK_ID = newUid();

export const arrange_spatialStretch = (desktopStore: DesktopStoreContextModel) => {
  const pageItem = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  const desktopAspect = desktopStore.desktopBoundsPx().w / desktopStore.desktopBoundsPx().h;
  const pageAspect = pageItem.naturalAspect;
  const pageBoundsPx = (() => {
    let result = desktopStore.desktopBoundsPx();
    // TODO (MEDIUM): make these cutoff aspect ratios configurable in user settings.
    if (pageAspect / desktopAspect > 1.18) {
      // page to scroll horizontally.
      result.w = Math.round(result.h * pageAspect);
    } else if (pageAspect / desktopAspect < 0.82) {
      // page needs to scroll vertically.
      result.h = Math.round(result.w / pageAspect);
    }
    return result;
  })();

  VesCache.initFullArrange();

  const currentPath = pageItem.id;

  const visualElementSpec: VisualElementSpec = {
    displayItem: pageItem,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren,
    boundsPx: pageBoundsPx,
    childAreaBoundsPx: pageBoundsPx,
  };

  const children = pageItem.computed_children
    .map(childId => arrangeItem_Spatial(
      desktopStore,
      currentPath,
      itemState.get(childId)!,
      pageItem, // parent item
      pageBoundsPx,
      true, // render children as full
      false, // parent is popup
      false // is popup
    ));

  const currentPopupSpec = desktopStore.currentPopupSpec();
  if (currentPopupSpec != null) {
    if (currentPopupSpec.type == PopupType.Page) {
      // Position of page popup in spatial pages is user defined.
      const popupLinkToPageId = VeFns.veidFromPath(currentPopupSpec.vePath).itemId;
      const li = LinkFns.create(pageItem.ownerId, pageItem.id, RelationshipToParent.Child, newOrdering(), popupLinkToPageId!);
      li.id = SPATIAL_POPUP_LINK_ID;
      const widthGr = PageFns.getPopupWidthGr(pageItem);
      const heightGr = Math.round((widthGr / pageItem.naturalAspect / GRID_SIZE)/ 2.0) * GRID_SIZE;
      li.spatialWidthGr = widthGr;
      // assume center positioning.
      li.spatialPositionGr = {
        x: PageFns.getPopupPositionGr(pageItem).x - widthGr / 2.0,
        y: PageFns.getPopupPositionGr(pageItem).y - heightGr / 2.0
      };
      children.push(
        arrangeItem_Spatial(
          desktopStore,
          currentPath,
          li,
          pageItem, // parent item
          pageBoundsPx,
          true, // render children as full
          false, // parent is popup
          true // is popup
        ));
    } else if (currentPopupSpec.type == PopupType.Attachment) {
      // Ves are created inline.
    } else if (currentPopupSpec.type == PopupType.Image) {
      children.push(arrangeCellPopup(desktopStore));
    } else {
      panic();
    }
  }

  visualElementSpec.children = children;

  VesCache.finalizeFullArrange(visualElementSpec, currentPath, desktopStore);
}


const arrangeItem_Spatial = (
    desktopStore: DesktopStoreContextModel,
    parentPath: VisualElementPath,
    item: Item,
    parentPage: PageItem,
    parentPageBoundsPx: BoundingBox,
    renderChildrenAsFull: boolean,
    parentIsPopup: boolean,
    isPopup: boolean): VisualElementSignal => {
  const itemGeometry = ItemFns.calcGeometry_Spatial(item, zeroBoundingBoxTopLeft(parentPageBoundsPx), PageFns.calcInnerSpatialDimensionsBl(parentPage), parentIsPopup, true);
  return arrangeItem(desktopStore, parentPath, ArrangeAlgorithm.SpatialStretch, item, itemGeometry, renderChildrenAsFull, isPopup, false);
}