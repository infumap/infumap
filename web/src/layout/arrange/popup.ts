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
import { ImageFns, asImageItem, isImage } from "../../items/image-item";
import { asNoteItem, isNote } from "../../items/note-item";
import { NoteFlags } from "../../items/base/flags-item";


/**
 * Represents the calculated geometry for a popup, including whether it should be rendered as fixed.
 */
export interface PopupGeometryResult {
  geometry: ItemGeometry;
  renderAsFixed: boolean;
  linkItem: LinkItem;
  actualLinkItemMaybe: LinkItem | null;
  widthGr?: number;
  heightGr?: number;
}


/**
 * Creates the popup link item with proper sizing from the popup spec.
 */
function createPopupLinkItem(currentPage: PageItem, popupVeid: { itemId: string, linkIdMaybe: string | null }): LinkItem {
  const popupLinkToId = popupVeid.itemId;
  const li = LinkFns.create(currentPage.ownerId, currentPage.id, RelationshipToParent.Child, popupLinkToId!, newOrdering());
  li.id = POPUP_LINK_UID;

  if (popupVeid.linkIdMaybe) {
    const linkItem = asLinkItem(itemState.get(popupVeid.linkIdMaybe)!);
    li.spatialWidthGr = linkItem.spatialWidthGr;
    li.spatialHeightGr = linkItem.spatialHeightGr;
  } else {
    const item = itemState.get(popupVeid.itemId)!;
    if (isXSizableItem(item)) {
      li.spatialWidthGr = asXSizableItem(item).spatialWidthGr;
    }
    if (isNote(item) && (asNoteItem(item).flags & NoteFlags.ExplicitHeight)) {
      li.spatialHeightGr = asNoteItem(item).spatialHeightGr;
    } else if (isYSizableItem(item)) {
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
 * Supports both page and image popups, as well as attachment popups.
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

  // Check if this popup is from an attachment
  const currentPopupSpec = store.history.currentPopupSpec();
  const isFromAttachment = currentPopupSpec?.isFromAttachment ?? false;

  let widthGr: number;
  let targetAspect: number;
  let popupCenter: { x: number, y: number };
  let hasChildChanges: boolean;
  let hasDefaultChanges: boolean;

  if (isFromAttachment) {
    // Attachment popup: use PopupSpec position and calculate width to match parent block size
    // Calculate width so that one block in popup = one block in parent page
    const popupItemDimensionsBl = ItemFns.calcSpatialDimensionsBl(popupItem);
    const parentInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(currentPage);

    // The popup width in Gr should make the popup's inner width in blocks equal to the popup item's width
    // For 1:1 block scaling: popupWidthGr / popupInnerWidthGr = parentInnerWidthGr / parentSpatialWidthGr
    // This means: popupWidthGr = popupItemDimensionsBl.w * (currentPage.innerSpatialWidthGr / parentInnerSizeBl.w)
    widthGr = popupItemDimensionsBl.w * GRID_SIZE;

    targetAspect = popupItemDimensionsBl.w / popupItemDimensionsBl.h;

    // Use pending position if popup has been moved, otherwise use source position (attachment center)
    if (currentPopupSpec?.pendingPositionGr) {
      popupCenter = currentPopupSpec.pendingPositionGr;
    } else if (currentPopupSpec?.sourcePositionGr) {
      // Initial open: center on the attachment, then clamp to screen bounds
      popupCenter = clampPopupPositionToScreen(
        currentPopupSpec.sourcePositionGr,
        widthGr,
        widthGr / targetAspect,
        currentPage,
        childAreaBoundsPx
      );
    } else {
      // Fallback to parent page default
      popupCenter = currentPage.defaultPopupPositionGr;
    }

    // Attachment popups don't persist their position, so no "changes" indicators
    hasChildChanges = false;
    hasDefaultChanges = false;
  } else if (popupPage) {
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

  let heightGr: number;
  if (popupImage) {
    heightGr = ((widthGr / GRID_SIZE) * popupImage.imageSizePx.h / popupImage.imageSizePx.w) * GRID_SIZE;
  } else {
    heightGr = widthGr / targetAspect;
  }
  li.spatialWidthGr = widthGr;

  // Center positioning, snapped to half-blocks
  li.spatialPositionGr = {
    x: Math.round((popupCenter.x - widthGr / 2.0) / (GRID_SIZE / 2.0)) * (GRID_SIZE / 2.0),
    y: Math.round((popupCenter.y - heightGr / 2.0) / (GRID_SIZE / 2.0)) * (GRID_SIZE / 2.0)
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

  return { geometry, renderAsFixed: false, linkItem: li, actualLinkItemMaybe, widthGr, heightGr };
}


/**
 * Clamps a popup position to ensure it stays within the screen bounds.
 * If the popup would go off-screen, adjusts the position to keep it visible.
 */
function clampPopupPositionToScreen(
  centerGr: { x: number, y: number },
  widthGr: number,
  heightGr: number,
  currentPage: PageItem,
  childAreaBoundsPx: BoundingBox
): { x: number, y: number } {
  const parentInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(currentPage);
  const pageWidthGr = parentInnerSizeBl.w * GRID_SIZE;
  const pageHeightGr = parentInnerSizeBl.h * GRID_SIZE;

  const halfWidth = widthGr / 2.0;
  const halfHeight = heightGr / 2.0;

  // Calculate the popup bounds centered at centerGr
  let left = centerGr.x - halfWidth;
  let right = centerGr.x + halfWidth;
  let top = centerGr.y - halfHeight;
  let bottom = centerGr.y + halfHeight;

  // Clamp to page bounds (with a small margin)
  const margin = GRID_SIZE; // 1 block margin

  if (left < margin) {
    centerGr = { x: halfWidth + margin, y: centerGr.y };
  } else if (right > pageWidthGr - margin) {
    centerGr = { x: pageWidthGr - halfWidth - margin, y: centerGr.y };
  }

  if (top < margin) {
    centerGr = { ...centerGr, y: halfHeight + margin };
  } else if (bottom > pageHeightGr - margin) {
    centerGr = { ...centerGr, y: pageHeightGr - halfHeight - margin };
  }

  return centerGr;
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
