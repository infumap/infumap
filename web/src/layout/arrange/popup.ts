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

import { GRID_SIZE, ITEM_BORDER_WIDTH_PX, NATURAL_BLOCK_SIZE_PX } from "../../constants";
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
import { VeFns, VisualElementPath } from "../visual-element";
import { ArrangeItemFlags, arrangeItem } from "./item";
import { POPUP_LINK_UID, UMBRELLA_PAGE_UID } from "../../util/uid";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../../items/base/y-sizeable-item";
import { Item } from "../../items/base/item";
import { ImageFns, asImageItem, isImage } from "../../items/image-item";
import { asNoteItem, isNote, NoteFns } from "../../items/note-item";
import { NoteFlags } from "../../items/base/flags-item";


const CALENDAR_NOTE_POPUP_EXTRA_HEIGHT_BL = 1.0;


/**
 * Represents the calculated geometry for a popup, including whether it should be rendered as fixed.
 */
export interface PopupGeometryResult {
  geometry: ItemGeometry;
  renderAsFixed: boolean;
  linkItem: LinkItem;
  actualLinkItemMaybe: LinkItem | null;
  wasAutoAdjusted: boolean;
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

interface GeometryInsets {
  leftPx: number;
  topPx: number;
  rightPx: number;
  bottomPx: number;
}

function geometryInsetsFromVisibleContent(geometry: ItemGeometry): GeometryInsets {
  let leftPx = 0;
  let topPx = 0;
  let rightPx = 0;
  let bottomPx = 0;

  for (const hitbox of geometry.hitboxes) {
    leftPx = Math.max(leftPx, Math.max(0, -hitbox.boundsPx.x));
    topPx = Math.max(topPx, Math.max(0, -hitbox.boundsPx.y));
    rightPx = Math.max(rightPx, Math.max(0, hitbox.boundsPx.x + hitbox.boundsPx.w - geometry.boundsPx.w));
    bottomPx = Math.max(bottomPx, Math.max(0, hitbox.boundsPx.y + hitbox.boundsPx.h - geometry.boundsPx.h));
  }

  return { leftPx, topPx, rightPx, bottomPx };
}

function geometryCanFitVisibleBounds(geometry: ItemGeometry, visibleBoundsPx: BoundingBox): boolean {
  const insets = geometryInsetsFromVisibleContent(geometry);
  return geometry.boundsPx.w + insets.leftPx + insets.rightPx <= visibleBoundsPx.w &&
    geometry.boundsPx.h + insets.topPx + insets.bottomPx <= visibleBoundsPx.h;
}

function geometryTranslationIntoVisibleBounds(geometry: ItemGeometry, visibleBoundsPx: BoundingBox): { dxPx: number, dyPx: number } {
  const insets = geometryInsetsFromVisibleContent(geometry);
  const minX = visibleBoundsPx.x + insets.leftPx;
  const maxX = visibleBoundsPx.x + visibleBoundsPx.w - geometry.boundsPx.w - insets.rightPx;
  const minY = visibleBoundsPx.y + insets.topPx;
  const maxY = visibleBoundsPx.y + visibleBoundsPx.h - geometry.boundsPx.h - insets.bottomPx;
  const clampedX = Math.min(Math.max(geometry.boundsPx.x, minX), Math.max(minX, maxX));
  const clampedY = Math.min(Math.max(geometry.boundsPx.y, minY), Math.max(minY, maxY));
  return {
    dxPx: clampedX - geometry.boundsPx.x,
    dyPx: clampedY - geometry.boundsPx.y,
  };
}

function offsetGeometry(geometry: ItemGeometry, dxPx: number, dyPx: number): ItemGeometry {
  if (dxPx === 0 && dyPx === 0) {
    return geometry;
  }

  return {
    ...geometry,
    boundsPx: {
      ...geometry.boundsPx,
      x: geometry.boundsPx.x + dxPx,
      y: geometry.boundsPx.y + dyPx,
    },
    viewportBoundsPx: geometry.viewportBoundsPx == null
      ? null
      : {
        ...geometry.viewportBoundsPx,
        x: geometry.viewportBoundsPx.x + dxPx,
        y: geometry.viewportBoundsPx.y + dyPx,
      },
  };
}

function calcCalendarNaturalPopupSizeBl(li: LinkItem, popupItem: Item | null): { w: number, h: number } {
  const sizeBl = ItemFns.calcSpatialDimensionsBl(li);
  if (popupItem && isNote(popupItem)) {
    return {
      w: sizeBl.w,
      h: Math.max(sizeBl.h + CALENDAR_NOTE_POPUP_EXTRA_HEIGHT_BL, 2.0),
    };
  }
  return sizeBl;
}

function expandGeometryToNaturalPopupBounds(geometry: ItemGeometry, widthPx: number, heightPx: number, sizeBl: { w: number, h: number }): ItemGeometry {
  const nextBoundsPx = {
    ...geometry.boundsPx,
    w: widthPx + ITEM_BORDER_WIDTH_PX,
    h: heightPx + ITEM_BORDER_WIDTH_PX,
  };
  const xScale = geometry.boundsPx.w == 0 ? 1.0 : nextBoundsPx.w / geometry.boundsPx.w;
  const yScale = geometry.boundsPx.h == 0 ? 1.0 : nextBoundsPx.h / geometry.boundsPx.h;

  return {
    ...geometry,
    boundsPx: nextBoundsPx,
    blockSizePx: {
      w: nextBoundsPx.w / sizeBl.w,
      h: nextBoundsPx.h / sizeBl.h,
    },
    hitboxes: geometry.hitboxes.map(hitbox => ({
      ...hitbox,
      boundsPx: {
        x: hitbox.boundsPx.x * xScale,
        y: hitbox.boundsPx.y * yScale,
        w: hitbox.boundsPx.w * xScale,
        h: hitbox.boundsPx.h * yScale,
      },
    })),
  };
}

function shrinkPopupSizeUntilItFits(
  buildGeometry: (sizeValue: number) => ItemGeometry,
  currentSizeValue: number,
  visibleBoundsPx: BoundingBox
): { sizeValue: number, geometry: ItemGeometry, wasShrunk: boolean } {
  const currentGeometry = buildGeometry(currentSizeValue);
  if (geometryCanFitVisibleBounds(currentGeometry, visibleBoundsPx)) {
    return { sizeValue: currentSizeValue, geometry: currentGeometry, wasShrunk: false };
  }

  let low = Math.max(currentSizeValue / 4096.0, 0.0001);
  let lowGeometry = buildGeometry(low);
  if (!geometryCanFitVisibleBounds(lowGeometry, visibleBoundsPx)) {
    return { sizeValue: low, geometry: lowGeometry, wasShrunk: low !== currentSizeValue };
  }

  let high = currentSizeValue;
  for (let i = 0; i < 24; ++i) {
    const mid = (low + high) / 2.0;
    const midGeometry = buildGeometry(mid);
    if (geometryCanFitVisibleBounds(midGeometry, visibleBoundsPx)) {
      low = mid;
      lowGeometry = midGeometry;
    } else {
      high = mid;
    }
  }

  return { sizeValue: low, geometry: lowGeometry, wasShrunk: true };
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
  const desktopLocalBoundsPx = zeroBoundingBoxTopLeft(desktopBoundsPx);

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

  let popupAspect: number;
  if (popupPage) {
    popupAspect = popupPage.naturalAspect;
  } else if (popupImage) {
    popupAspect = popupImage.imageSizePx.w / popupImage.imageSizePx.h;
  } else {
    popupAspect = li.aspectOverride ?? 2.0;
  }

  const renderAsFixed = (currentPage.arrangeAlgorithm == ArrangeAlgorithm.Grid ||
    currentPage.arrangeAlgorithm == ArrangeAlgorithm.Catalog ||
    currentPage.arrangeAlgorithm == ArrangeAlgorithm.Justified ||
    currentPage.arrangeAlgorithm == ArrangeAlgorithm.Calendar);
  const useNaturalBlocks = currentPage.arrangeAlgorithm == ArrangeAlgorithm.Calendar && !popupPage && !popupImage;
  let debugMeasuredNoteSizeBl: { w: number, h: number } | null = null;
  if (useNaturalBlocks && popupItem && isNote(popupItem)) {
    const popupNoteMeasurable = NoteFns.asNoteMeasurable(ItemFns.cloneMeasurableFields(popupItem));
    popupNoteMeasurable.spatialWidthGr = li.spatialWidthGr;
    debugMeasuredNoteSizeBl = NoteFns.calcSpatialDimensionsBl(popupNoteMeasurable, true);
    li.spatialHeightGr = debugMeasuredNoteSizeBl.h * GRID_SIZE;
  }

  const visibleBoundsPx = renderAsFixed ? desktopBoundsPx : desktopLocalBoundsPx;
  const buildGeometry = (nextPositionNorm: typeof positionNorm, nextWidthNorm: number): ItemGeometry => {
    const popupWidthPx = desktopLocalBoundsPx.w * nextWidthNorm;
    if (useNaturalBlocks) {
      const sizeBl = calcCalendarNaturalPopupSizeBl(li, popupItem);
      const naturalWidthPx = sizeBl.w * NATURAL_BLOCK_SIZE_PX.w;
      const naturalHeightPx = sizeBl.h * NATURAL_BLOCK_SIZE_PX.h;
      const scale = naturalWidthPx > popupWidthPx ? popupWidthPx / naturalWidthPx : 1.0;
      const widthPx = naturalWidthPx * scale;
      const heightPx = naturalHeightPx * scale;
      let geometry = ItemFns.calcGeometry_Spatial(
        li,
        {
          x: desktopLocalBoundsPx.w * nextPositionNorm.x - widthPx / 2.0,
          y: desktopLocalBoundsPx.h * nextPositionNorm.y - heightPx / 2.0,
          w: widthPx,
          h: heightPx,
        },
        sizeBl,
        false,
        true,
        true,
        hasChildChanges,
        hasDefaultChanges,
        true,
        store.smallScreenMode()
      );
      if (popupItem && isNote(popupItem)) {
        geometry = expandGeometryToNaturalPopupBounds(geometry, widthPx, heightPx, sizeBl);
      }
      if (renderAsFixed) {
        geometry = offsetGeometry(geometry, store.getCurrentDockWidthPx(), 0);
      }
      return geometry;
    }

    const popupHeightPx = popupWidthPx / popupAspect;
    const cellBoundsPx = {
      x: desktopLocalBoundsPx.w * nextPositionNorm.x - popupWidthPx / 2.0,
      y: desktopLocalBoundsPx.h * nextPositionNorm.y - popupHeightPx / 2.0,
      w: popupWidthPx,
      h: popupHeightPx,
    };
    let geometry = ItemFns.calcGeometry_InCell(
      li,
      cellBoundsPx,
      false,
      false,
      false,
      true,
      hasChildChanges,
      hasDefaultChanges,
      true,
      false,
      store.smallScreenMode()
    );
    if (renderAsFixed) {
      geometry = offsetGeometry(geometry, store.getCurrentDockWidthPx(), 0);
    }
    return geometry;
  };

  let wasAutoAdjusted = false;
  let adjustedPositionNorm = positionNorm;
  const sizeFit = shrinkPopupSizeUntilItFits(
    (nextWidthNorm) => buildGeometry(adjustedPositionNorm, nextWidthNorm),
    widthNorm,
    visibleBoundsPx
  );
  const adjustedWidthNorm = sizeFit.sizeValue;
  let geometry = sizeFit.geometry;
  wasAutoAdjusted = sizeFit.wasShrunk;

  const translateIntoView = geometryTranslationIntoVisibleBounds(geometry, visibleBoundsPx);
  if (translateIntoView.dxPx !== 0 || translateIntoView.dyPx !== 0) {
    adjustedPositionNorm = {
      x: adjustedPositionNorm.x + (translateIntoView.dxPx / desktopLocalBoundsPx.w),
      y: adjustedPositionNorm.y + (translateIntoView.dyPx / desktopLocalBoundsPx.h),
    };
    geometry = buildGeometry(adjustedPositionNorm, adjustedWidthNorm);
    wasAutoAdjusted = true;
  }

  const residualTranslate = geometryTranslationIntoVisibleBounds(geometry, visibleBoundsPx);
  geometry = offsetGeometry(geometry, residualTranslate.dxPx, residualTranslate.dyPx);
  if (residualTranslate.dxPx !== 0 || residualTranslate.dyPx !== 0) {
    wasAutoAdjusted = true;
  }

  if (currentPage.arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
    console.log("[calendar-popup-debug] cell-result", {
      popupVeid,
      popupItemType: popupItem?.itemType,
      isNote: popupItem != null && isNote(popupItem),
      useNaturalBlocks,
      renderAsFixed,
      measuredNoteSizeBl: debugMeasuredNoteSizeBl,
      popupNaturalSizeBl: useNaturalBlocks ? calcCalendarNaturalPopupSizeBl(li, popupItem) : null,
      linkSizeGr: {
        w: li.spatialWidthGr,
        h: li.spatialHeightGr,
      },
      widthNorm,
      adjustedWidthNorm,
      positionNorm,
      adjustedPositionNorm,
      boundsPx: geometry.boundsPx,
      blockSizePx: geometry.blockSizePx,
      hitboxes: geometry.hitboxes.map(hitbox => ({
        type: hitbox.type,
        boundsPx: hitbox.boundsPx,
      })),
      wasAutoAdjusted,
    });
  }

  return { geometry, renderAsFixed, linkItem: li, actualLinkItemMaybe, wasAutoAdjusted };
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
  const desktopLocalBoundsPx = zeroBoundingBoxTopLeft(store.desktopMainAreaBoundsPx());

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
    // Use the popup link dimensions (not the linked item) so link-backed popups resize from the link.
    const popupItemDimensionsBl = ItemFns.calcSpatialDimensionsBl(li);

    // Use measured popup width directly in Gr so popup size tracks the link/item dimensions.
    widthGr = popupItemDimensionsBl.w * GRID_SIZE;

    targetAspect = popupItemDimensionsBl.w / popupItemDimensionsBl.h;

    // Use pending position if popup has been moved, otherwise use the initial anchor.
    if (currentPopupSpec?.pendingPositionGr) {
      popupCenter = currentPopupSpec.pendingPositionGr;
    } else if (currentPopupSpec?.sourceTopLeftGr && !popupPage && !popupImage) {
      // Non-page attachment-style popups anchor from the item's top-left with a fixed offset.
      popupCenter = clampPopupPositionToScreen(
        {
          x: currentPopupSpec.sourceTopLeftGr.x + widthGr / 2.0,
          y: currentPopupSpec.sourceTopLeftGr.y + (widthGr / targetAspect) / 2.0,
        },
        widthGr,
        widthGr / targetAspect,
        currentPage,
        childAreaBoundsPx
      );
    } else if (currentPopupSpec?.sourcePositionGr) {
      // Page/image attachment popups still anchor from the attachment center.
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
    const popupItemDimensionsBl = ItemFns.calcSpatialDimensionsBl(li);
    widthGr = popupItemDimensionsBl.w * GRID_SIZE;
    targetAspect = popupItemDimensionsBl.h > 0 ? popupItemDimensionsBl.w / popupItemDimensionsBl.h : currentPage.naturalAspect;
    popupCenter = currentPage.defaultPopupPositionGr;
    hasChildChanges = false;
    hasDefaultChanges = false;
  }

  const buildGeometry = (nextCenterGr: typeof popupCenter, nextWidthGr: number): { geometry: ItemGeometry, heightGr: number } => {
    const heightGr = popupImage
      ? ((nextWidthGr / GRID_SIZE) * popupImage.imageSizePx.h / popupImage.imageSizePx.w) * GRID_SIZE
      : nextWidthGr / targetAspect;
    li.spatialWidthGr = nextWidthGr;
    li.spatialPositionGr = {
      x: Math.round((nextCenterGr.x - nextWidthGr / 2.0) / (GRID_SIZE / 2.0)) * (GRID_SIZE / 2.0),
      y: Math.round((nextCenterGr.y - heightGr / 2.0) / (GRID_SIZE / 2.0)) * (GRID_SIZE / 2.0)
    };

    return {
      geometry: ItemFns.calcGeometry_Spatial(
        li,
        zeroBoundingBoxTopLeft(childAreaBoundsPx),
        PageFns.calcInnerSpatialDimensionsBl(currentPage),
        false, true, true,
        hasChildChanges,
        hasDefaultChanges,
        false,
        store.smallScreenMode()
      ),
      heightGr,
    };
  };

  let wasAutoAdjusted = false;
  let adjustedPopupCenter = popupCenter;
  const sizeFit = shrinkPopupSizeUntilItFits(
    (nextWidthGr) => buildGeometry(adjustedPopupCenter, nextWidthGr).geometry,
    widthGr,
    desktopLocalBoundsPx
  );
  widthGr = sizeFit.sizeValue;
  let geometry = sizeFit.geometry;
  wasAutoAdjusted = sizeFit.wasShrunk;
  let heightGr = buildGeometry(adjustedPopupCenter, widthGr).heightGr;

  const translateIntoView = geometryTranslationIntoVisibleBounds(geometry, desktopLocalBoundsPx);
  if (translateIntoView.dxPx !== 0 || translateIntoView.dyPx !== 0) {
    adjustedPopupCenter = {
      x: adjustedPopupCenter.x + (translateIntoView.dxPx * GRID_SIZE / geometry.blockSizePx.w),
      y: adjustedPopupCenter.y + (translateIntoView.dyPx * GRID_SIZE / geometry.blockSizePx.h),
    };
    const rebuilt = buildGeometry(adjustedPopupCenter, widthGr);
    geometry = rebuilt.geometry;
    heightGr = rebuilt.heightGr;
    wasAutoAdjusted = true;
  }

  const residualTranslate = geometryTranslationIntoVisibleBounds(geometry, desktopLocalBoundsPx);
  geometry = offsetGeometry(geometry, residualTranslate.dxPx, residualTranslate.dyPx);
  if (residualTranslate.dxPx !== 0 || residualTranslate.dyPx !== 0) {
    wasAutoAdjusted = true;
  }

  if (currentPage.arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
    console.log("[calendar-popup-debug] spatial-result", {
      popupVeid,
      popupItemType: popupItem.itemType,
      isFromAttachment,
      popupPage: popupPage != null,
      popupImage: popupImage != null,
      widthGr,
      heightGr,
      adjustedPopupCenter,
      linkSizeGr: {
        w: li.spatialWidthGr,
        h: li.spatialHeightGr,
      },
      boundsPx: geometry.boundsPx,
      blockSizePx: geometry.blockSizePx,
      wasAutoAdjusted,
    });
  }

  return { geometry, renderAsFixed: false, linkItem: li, actualLinkItemMaybe, wasAutoAdjusted, widthGr, heightGr };
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

  const { geometry, renderAsFixed, linkItem, actualLinkItemMaybe, wasAutoAdjusted } = calcCellPopupGeometry(
    store, currentPage, currentPopupSpec.actualVeid
  );
  const popupVes = arrangeItem(
    store,
    currentPath,
    currentPage.arrangeAlgorithm,
    linkItem,
    actualLinkItemMaybe,
    geometry,
    ArrangeItemFlags.IsPopupRoot |
    ArrangeItemFlags.RenderChildrenAsFull |
    (renderAsFixed ? ArrangeItemFlags.IsFixed : ArrangeItemFlags.None)
  );
  store.perVe.setAutoMovedIntoView(VeFns.veToPath(popupVes.get()), wasAutoAdjusted);
  return popupVes;
}

export function arrangeCellPopupPath(store: StoreContextModel): VisualElementPath {
  return VeFns.veToPath(arrangeCellPopup(store).get());
}
