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

import { batch } from "solid-js";
import { GRID_SIZE } from "../../constants";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkFns, LinkItem, asLinkItem } from "../../items/link-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "../../items/page-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { BoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { newOrdering } from "../../util/ordering";
import { VisualElementSignal } from "../../util/signals";
import { ItemGeometry } from "../item-geometry";
import { RelationshipToParent } from "../relationship-to-parent";
import { VeFns, VisualElementFlags } from "../visual-element";
import { ArrangeItemFlags, arrangeItem } from "./item";
import { POPUP_LINK_UID, UMBRELLA_PAGE_UID } from "../../util/uid";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../../items/base/y-sizeable-item";
import { VesCache } from "../ves-cache";
import { ImageFns, asImageItem, isImage } from "../../items/image-item";


/**
 * Represents the calculated geometry for a popup, including whether it should be rendered as fixed.
 */
export interface PopupGeometryResult {
  geometry: ItemGeometry;
  renderAsFixed: boolean;
  linkItem: LinkItem;
  actualLinkItemMaybe: LinkItem | null;
}


/**
 * Creates the popup link item with proper sizing from the popup spec.
 */
function createPopupLinkItem(currentPage: PageItem, popupVeid: { itemId: string, linkIdMaybe: string | null }): LinkItem {
  const popupLinkToId = popupVeid.itemId;
  const li = LinkFns.create(currentPage.ownerId, currentPage.id, RelationshipToParent.Child, popupLinkToId!, newOrdering());
  li.id = POPUP_LINK_UID;

  if (popupVeid.linkIdMaybe) {
    const linkItem = itemState.get(popupVeid.linkIdMaybe)!;
    if (isXSizableItem(linkItem)) {
      li.spatialWidthGr = asXSizableItem(linkItem).spatialWidthGr;
    }
    if (isYSizableItem(linkItem)) {
      li.spatialHeightGr = asYSizableItem(linkItem).spatialHeightGr;
    }
  } else {
    const item = itemState.get(popupVeid.itemId)!;
    if (isXSizableItem(item)) {
      li.spatialWidthGr = asXSizableItem(item).spatialWidthGr;
    }
    if (isYSizableItem(item)) {
      li.spatialHeightGr = asYSizableItem(item).spatialHeightGr;
    }
  }
  li.spatialPositionGr = { x: 0, y: 0 };

  return li;
}


/**
 * Calculates the geometry for a cell-based popup (Grid, Justified, Calendar pages).
 * This is the single source of truth for cell popup geometry calculation.
 * Supports both page and image popups.
 */
function calcCellPopupGeometry(
  store: StoreContextModel,
  currentPage: PageItem,
  popupVeid: { itemId: string, linkIdMaybe: string | null }
): PopupGeometryResult {
  const li = createPopupLinkItem(currentPage, popupVeid);
  const actualLinkItemMaybe = popupVeid.linkIdMaybe == null ? null : asLinkItem(itemState.get(popupVeid.linkIdMaybe)!);
  const desktopBoundsPx = store.desktopMainAreaBoundsPx();

  const popupItem = itemState.get(popupVeid.itemId);
  const popupPage = popupItem && isPage(popupItem) ? asPageItem(popupItem) : null;
  const popupImage = popupItem && isImage(popupItem) ? asImageItem(popupItem) : null;

  if (popupItem && isPage(popupItem) && asPageItem(popupItem).arrangeAlgorithm === ArrangeAlgorithm.Calendar) {
    li.aspectOverride = desktopBoundsPx.w / desktopBoundsPx.h;
  }

  // Determine position and width based on item type
  let positionNorm;
  let widthNorm;
  let hasChildChanges: boolean;
  let hasDefaultChanges: boolean;

  if (popupPage) {
    positionNorm = PageFns.getCellPopupPositionNormForParent(currentPage, popupPage);
    widthNorm = PageFns.getCellPopupWidthNormForParent(currentPage, popupPage);
    hasChildChanges = PageFns.childCellPopupPositioningHasChanged(currentPage, popupPage);
    hasDefaultChanges = PageFns.defaultCellPopupPositioningHasChanged(currentPage, popupPage);
  } else if (popupImage) {
    positionNorm = ImageFns.getCellPopupPositionNormForParent(popupImage);
    widthNorm = ImageFns.getCellPopupWidthNormForParent(popupImage, desktopBoundsPx);
    hasChildChanges = ImageFns.childCellPopupPositioningHasChanged(currentPage, popupImage);
    hasDefaultChanges = ImageFns.hasStoredCellPopupPositioning(popupImage);
  } else {
    positionNorm = currentPage.defaultCellPopupPositionNorm;
    widthNorm = currentPage.defaultCellPopupWidthNorm;
    hasChildChanges = false;
    hasDefaultChanges = false;
  }

  const popupWidthPx = desktopBoundsPx.w * widthNorm;
  let popupAspect: number;
  if (popupPage) {
    popupAspect = popupPage.naturalAspect;
  } else if (popupImage) {
    popupAspect = popupImage.imageSizePx.w / popupImage.imageSizePx.h;
  } else {
    popupAspect = li.aspectOverride ?? 2.0;
  }
  const popupHeightPx = popupWidthPx / popupAspect;

  const cellBoundsPx = {
    x: desktopBoundsPx.w * positionNorm.x - popupWidthPx / 2.0,
    y: desktopBoundsPx.h * positionNorm.y - popupHeightPx / 2.0,
    w: popupWidthPx,
    h: popupHeightPx,
  };

  const geometry = ItemFns.calcGeometry_InCell(li, cellBoundsPx, false, false, false, true, hasChildChanges, hasDefaultChanges, true, false, store.smallScreenMode());

  const renderAsFixed = (currentPage.arrangeAlgorithm == ArrangeAlgorithm.Grid ||
    currentPage.arrangeAlgorithm == ArrangeAlgorithm.Justified ||
    currentPage.arrangeAlgorithm == ArrangeAlgorithm.Calendar);

  if (renderAsFixed) {
    geometry.boundsPx.x += store.getCurrentDockWidthPx();
    if (geometry.viewportBoundsPx != null) {
      geometry.viewportBoundsPx!.x += store.getCurrentDockWidthPx();
    }
  }

  return { geometry, renderAsFixed, linkItem: li, actualLinkItemMaybe };
}


/**
 * Calculates the geometry for a SpatialStretch popup.
 * This is the single source of truth for spatial popup geometry calculation.
 * Supports both page and image popups.
 */
export function calcSpatialPopupGeometry(
  store: StoreContextModel,
  currentPage: PageItem,
  popupVeid: { itemId: string, linkIdMaybe: string | null },
  childAreaBoundsPx: BoundingBox
): PopupGeometryResult {
  const li = createPopupLinkItem(currentPage, popupVeid);
  const actualLinkItemMaybe = popupVeid.linkIdMaybe == null ? null : asLinkItem(itemState.get(popupVeid.linkIdMaybe)!);

  const popupItem = itemState.get(popupVeid.itemId)!;
  const popupPage = isPage(popupItem) ? asPageItem(popupItem) : null;
  const popupImage = isImage(popupItem) ? asImageItem(popupItem) : null;

  let widthGr: number;
  let targetAspect: number;
  let popupCenter;
  let hasChildChanges: boolean;
  let hasDefaultChanges: boolean;

  if (popupPage) {
    widthGr = PageFns.getPopupWidthGrForParent(currentPage, popupPage);
    const popupIsCalendar = popupPage.arrangeAlgorithm === ArrangeAlgorithm.Calendar;
    targetAspect = popupIsCalendar
      ? store.desktopMainAreaBoundsPx().w / store.desktopMainAreaBoundsPx().h
      : currentPage.naturalAspect;

    if (popupIsCalendar) {
      li.aspectOverride = targetAspect;
    }

    popupCenter = PageFns.getPopupPositionGrForParent(currentPage, popupPage);
    hasChildChanges = PageFns.childPopupPositioningHasChanged(currentPage, popupPage);
    hasDefaultChanges = PageFns.defaultPopupPositioningHasChanged(currentPage, popupPage);
  } else if (popupImage) {
    widthGr = ImageFns.getPopupWidthGrForParent(currentPage, popupImage);
    targetAspect = popupImage.imageSizePx.w / popupImage.imageSizePx.h;
    popupCenter = ImageFns.getPopupPositionGrForParent(currentPage, popupImage);
    hasChildChanges = ImageFns.childPopupPositioningHasChanged(currentPage, popupImage);
    hasDefaultChanges = ImageFns.hasStoredPopupPositioning(popupImage);
  } else {
    widthGr = currentPage.defaultPopupWidthGr;
    targetAspect = currentPage.naturalAspect;
    popupCenter = currentPage.defaultPopupPositionGr;
    hasChildChanges = false;
    hasDefaultChanges = false;
  }

  const heightGr = Math.round((widthGr / targetAspect / GRID_SIZE) / 2.0) * 2.0 * GRID_SIZE;
  li.spatialWidthGr = widthGr;

  // Center positioning
  li.spatialPositionGr = {
    x: popupCenter.x - widthGr / 2.0,
    y: popupCenter.y - heightGr / 2.0
  };

  const geometry = ItemFns.calcGeometry_Spatial(
    li,
    zeroBoundingBoxTopLeft(childAreaBoundsPx),
    PageFns.calcInnerSpatialDimensionsBl(currentPage),
    false, true, true,
    hasChildChanges,
    hasDefaultChanges,
    false,
    store.smallScreenMode()
  );

  return { geometry, renderAsFixed: false, linkItem: li, actualLinkItemMaybe };
}


/**
 * Arranges a cell-based popup (Grid, Justified, Calendar pages).
 */
export function arrangeCellPopup(store: StoreContextModel): VisualElementSignal {
  const currentPage = asPageItem(itemState.get(store.history.currentPageVeid()!.itemId)!);
  const currentPageVeid = store.history.currentPageVeid()!;
  const currentPath = VeFns.addVeidToPath(currentPageVeid, UMBRELLA_PAGE_UID);
  const currentPopupSpec = store.history.currentPopupSpec()!;

  const { geometry, renderAsFixed, linkItem, actualLinkItemMaybe } = calcCellPopupGeometry(
    store, currentPage, currentPopupSpec.actualVeid
  );

  let ves: VisualElementSignal;
  batch(() => {
    ves = arrangeItem(store, currentPath, currentPage.arrangeAlgorithm, linkItem, actualLinkItemMaybe, geometry, ArrangeItemFlags.IsPopupRoot | ArrangeItemFlags.RenderChildrenAsFull);
    let ve = ves.get();
    ve.flags |= (renderAsFixed ? VisualElementFlags.Fixed : VisualElementFlags.None);
    ves.set(ve);
  });
  return ves!;
}


/**
 * Efficiently updates only the popup position without a full re-arrange.
 * This works for both cell-based popups (Grid, Justified, Calendar) and 
 * spatial stretch popups. Only the popup's position is updated - size remains unchanged.
 * 
 * @returns true if the optimization was applied, false if a full arrange is needed.
 */
export function rearrangePopupPositionOnly(store: StoreContextModel): boolean {
  if (VesCache.isCurrentlyInFullArrange()) { return false; }

  const currentPopupSpec = store.history.currentPopupSpec();
  if (currentPopupSpec == null) { return false; }

  const currentPage = asPageItem(itemState.get(store.history.currentPageVeid()!.itemId)!);
  const isSpatialStretch = currentPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch;

  // Get the current page VE to find the popup VE signal
  const currentPageVeid = store.history.currentPageVeid()!;
  const currentPagePath = VeFns.addVeidToPath(currentPageVeid, UMBRELLA_PAGE_UID);
  const currentPageVes = VesCache.get(currentPagePath);
  if (!currentPageVes) { return false; }

  const currentPageVe = currentPageVes.get();
  if (!currentPageVe.popupVes) { return false; }

  const popupVes = currentPageVe.popupVes;
  const popupVe = popupVes.get();

  // Handle both page and image popups
  if (!isPage(popupVe.displayItem) && !isImage(popupVe.displayItem)) { return false; }

  // Calculate the new geometry using the SAME logic as full arrange
  const { geometry } = isSpatialStretch
    ? calcSpatialPopupGeometry(store, currentPage, currentPopupSpec.actualVeid, currentPageVe.childAreaBoundsPx!)
    : calcCellPopupGeometry(store, currentPage, currentPopupSpec.actualVeid);

  // Use VesCache's updateVisualElement for a clean partial update
  // Only update position - width and height remain unchanged from the existing VE
  return VesCache.updateVisualElement(popupVes, (ve) => {
    ve.boundsPx = {
      x: geometry.boundsPx.x,
      y: geometry.boundsPx.y,
      w: ve.boundsPx.w,  // Preserve existing width
      h: ve.boundsPx.h,  // Preserve existing height
    };
    if (ve.viewportBoundsPx && geometry.viewportBoundsPx) {
      ve.viewportBoundsPx = {
        x: geometry.viewportBoundsPx.x,
        y: geometry.viewportBoundsPx.y,
        w: ve.viewportBoundsPx.w,  // Preserve existing width
        h: ve.viewportBoundsPx.h,  // Preserve existing height
      };
    }
    // Update hitboxes since the set of hitboxes may change when hasChildChanges becomes true
    // (adding anchor/home buttons after the first move)
    ve.hitboxes = geometry.hitboxes;
  });
}
