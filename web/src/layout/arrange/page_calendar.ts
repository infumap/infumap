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

import { LinkItem, isLink, asLinkItem } from "../../items/link-item";
import { isRating } from "../../items/rating-item";
import { ArrangeAlgorithm, PageItem, asPageItem, isPage } from "../../items/page-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { StoreContextModel } from "../../store/StoreProvider";
import { ItemGeometry } from "../item-geometry";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { arrangeItem, ArrangeItemFlags, getCommonVisualElementFlags } from "./item";
import { VesCache } from "../ves-cache";
import { arrangeCellPopupPath, calcSpatialPopupGeometry } from "./popup";
import { itemState } from "../../store/ItemState";
import { getVePropertiesForItem } from "./util";
import { NATURAL_BLOCK_SIZE_PX, CALENDAR_DAY_ROW_HEIGHT_BL, LINE_HEIGHT_PX, CALENDAR_DAY_LABEL_LEFT_MARGIN_PX, MIN_NON_ROOT_LIST_PAGE_SCALE } from "../../constants";
import { isComposite } from "../../items/composite-item";
import { initiateLoadChildItemsMaybe } from "../load";
import { HitboxFns, HitboxFlags } from "../hitbox";
import { compareOrderings } from "../../util/ordering";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import {
  calculateCalendarWindowForPage,
  calculateCalendarDimensions,
  calculateCalendarMiniDayLayouts,
  calculateCalendarMonthLayouts,
  calculateCalendarVerticalLayout,
  calendarMiniTitleHeightPx,
  calendarMiniTitleTopPx,
  calendarDateKey,
  CALENDAR_LAYOUT_CONSTANTS,
  getCalendarDayMetrics,
  getCalendarMiniRowHeightPx,
  getCalendarDividerCenterPx,
  getCalendarMonthLeftPx,
  getCalendarMonthWidthPx,
  isCalendarMonthVisible,
} from "../../util/calendar-layout";
import { Item, ItemType } from "../../items/base/item";
import { getMovingTreeItemInParentMaybe } from "./util";
import { movingItemCellBoundsInPagePx } from "./moving";

function miniCalendarHostScale(
  store: StoreContextModel,
  parentPath: VisualElementPath,
  geometry: ItemGeometry,
): number {
  const parentItem = itemState.get(VeFns.veidFromPath(parentPath).itemId);
  if (parentItem != null &&
    isPage(parentItem) &&
    asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
    const proportionalListScale = geometry.viewportBoundsPx!.w / store.desktopMainAreaBoundsPx().w;
    return Math.max(MIN_NON_ROOT_LIST_PAGE_SCALE, proportionalListScale);
  }
  const geometryScale = geometry.blockSizePx?.h
    ? geometry.blockSizePx.h / NATURAL_BLOCK_SIZE_PX.h
    : 1.0;
  return Math.max(0.001, geometryScale);
}

function arrangeMiniCalendarPage(
  store: StoreContextModel,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  pageWithChildrenVePath: VisualElementPath,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags,
  pageSpec: VisualElementSpec,
  pageRelationships: VisualElementRelationships,
  highlightedPath: VisualElementPath | null,
  movingItemInThisPage: Item | null,
): void {
  const childAreaBoundsPx = pageSpec.childAreaBoundsPx!;
  const hostScale = miniCalendarHostScale(store, pageSpec.parentPath!, geometry);
  const baseRowHeightPx = LINE_HEIGHT_PX * hostScale;
  const blockSizePx = {
    w: NATURAL_BLOCK_SIZE_PX.w * hostScale,
    h: NATURAL_BLOCK_SIZE_PX.h * hostScale,
  };
  const lineItemTextRightPaddingPx = 6;
  const leftRightMarginPx = CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN * hostScale;
  const dayLabelWidthPx = CALENDAR_DAY_LABEL_LEFT_MARGIN_PX * hostScale;
  const itemLeftPaddingPx = 2 * hostScale;
  const columnLeftPx = leftRightMarginPx;
  const columnWidthPx = Math.max(0, childAreaBoundsPx.w - leftRightMarginPx * 2);
  const itemWidthPx = Math.max(0, columnWidthPx - dayLabelWidthPx - itemLeftPaddingPx);
  const titleBoundsPx = {
    x: leftRightMarginPx,
    y: calendarMiniTitleTopPx(baseRowHeightPx),
    w: columnWidthPx,
    h: calendarMiniTitleHeightPx(baseRowHeightPx),
  };
  pageSpec.hitboxes = [
    ...(pageSpec.hitboxes ?? []).filter(hitbox =>
      !(hitbox.type & (
        HitboxFlags.Click |
        HitboxFlags.Move |
        HitboxFlags.OpenPopup |
        HitboxFlags.ShowPointer |
        HitboxFlags.ContentEditable
      ))
    ),
    HitboxFns.create(HitboxFlags.Move, titleBoundsPx),
    HitboxFns.create(HitboxFlags.Click, titleBoundsPx, HitboxFns.createMeta({ openActualItem: true })),
  ];

  const itemsByDate = new Map<string, Array<Item>>();
  for (const childId of displayItem_pageWithChildren.computed_children) {
    const child = itemState.get(childId);
    if (child == null) { continue; }
    if (movingItemInThisPage && child.id === movingItemInThisPage.id) { continue; }

    const itemDate = new Date(child.dateTime * 1000);
    const dateKey = calendarDateKey(itemDate.getFullYear(), itemDate.getMonth() + 1, itemDate.getDate());
    if (!itemsByDate.has(dateKey)) {
      itemsByDate.set(dateKey, []);
    }
    itemsByDate.get(dateKey)!.push(child);
  }

  itemsByDate.forEach((items) => {
    items.sort((a, b) => {
      const cmp = compareOrderings(a.ordering, b.ordering);
      if (cmp !== 0) return cmp;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
  });

  const itemCountsByDate = new Map<string, number>();
  itemsByDate.forEach((items, dateKey) => {
    itemCountsByDate.set(dateKey, items.length);
  });

  const calendarMiniDayLayouts = calculateCalendarMiniDayLayouts(
    childAreaBoundsPx,
    itemCountsByDate,
    baseRowHeightPx,
  );
  const rowHeightPx = getCalendarMiniRowHeightPx(calendarMiniDayLayouts, baseRowHeightPx);
  const visibleDateKeys = new Set(calendarMiniDayLayouts.map(dayLayout => dayLayout.key));
  const calendarChildPaths: Array<VisualElementPath> = [];

  for (const dayLayout of calendarMiniDayLayouts) {
    const itemsForDate = itemsByDate.get(dayLayout.key) ?? [];
    if (!visibleDateKeys.has(dayLayout.key)) { continue; }

    itemsForDate.forEach((childItem, stackIndex) => {
      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

      if (isComposite(displayItem)) {
        initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
      }

      const visibleItemHeight = Math.min(rowHeightPx, blockSizePx.h);
      const itemTopInset = Math.min(hostScale, Math.max(0, visibleItemHeight * 0.2));
      const arrangedItemHeight = Math.max(0, visibleItemHeight - itemTopInset);
      const effectiveItemWidth = Math.max(0, itemWidthPx - 2 * hostScale);
      const boundsPx = {
        x: columnLeftPx + dayLabelWidthPx + itemLeftPaddingPx,
        y: dayLayout.topPx + stackIndex * rowHeightPx + itemTopInset,
        w: effectiveItemWidth,
        h: arrangedItemHeight,
      };
      const innerBoundsPx = {
        x: 0,
        y: 0,
        w: effectiveItemWidth,
        h: arrangedItemHeight,
      };
      const effectiveWidthBl = blockSizePx.w > 0 ? Math.floor(effectiveItemWidth / blockSizePx.w) : 0;
      const clickAreaBoundsPx = effectiveWidthBl > 1 ? {
        x: blockSizePx.w,
        y: 0,
        w: Math.max(0, effectiveItemWidth - blockSizePx.w),
        h: arrangedItemHeight,
      } : {
        x: 0,
        y: 0,
        w: effectiveItemWidth,
        h: arrangedItemHeight,
      };
      const popupClickAreaBoundsPx = {
        x: 0,
        y: 0,
        w: Math.min(blockSizePx.w, effectiveItemWidth),
        h: arrangedItemHeight,
      };

      const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), pageWithChildrenVePath);
      const isChildHighlighted = highlightedPath !== null && highlightedPath === childPath;
      const calendarItemVeSpec: VisualElementSpec = {
        displayItem,
        linkItemMaybe,
        actualLinkItemMaybe: linkItemMaybe,
        flags: VisualElementFlags.LineItem |
          VisualElementFlags.DisableLineItemExpand |
          (isChildHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
        _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
        boundsPx,
        hitboxes: (
          isRating(displayItem)
            ? [
              HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
              HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
            ]
            : [
              HitboxFns.create(HitboxFlags.Click, clickAreaBoundsPx),
              HitboxFns.create(HitboxFlags.OpenPopup, popupClickAreaBoundsPx),
              HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
            ]
        ),
        parentPath: pageWithChildrenVePath,
        col: 0,
        row: dayLayout.rowStart + stackIndex,
        blockSizePx,
        lineItemTextRightPaddingPx,
      };

      VesCache.arrange.writeVisualElement(calendarItemVeSpec, {}, childPath);
      calendarChildPaths.push(childPath);
    });
  }

  pageSpec.calendarMonthLayouts = [];
  pageSpec.calendarMiniDayLayouts = calendarMiniDayLayouts;
  pageSpec.blockSizePx = blockSizePx;

  if (movingItemInThisPage) {
    const movingItemDimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItemInThisPage);
    const scrollVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
    const movingItemBoundsPx = movingItemCellBoundsInPagePx(
      store,
      pageWithChildrenVePath,
      geometry,
      childAreaBoundsPx,
      scrollVeid,
      {
        w: movingItemDimensionsBl.w * blockSizePx.w,
        h: movingItemDimensionsBl.h * blockSizePx.h,
      },
      flags,
    );
    const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, movingItemInThisPage);
    const movingItemPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), pageWithChildrenVePath);
    const movingItemVeSpec: VisualElementSpec = {
      displayItem,
      linkItemMaybe,
      actualLinkItemMaybe: linkItemMaybe,
      flags: VisualElementFlags.Moving,
      _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.IsMoving,
      boundsPx: movingItemBoundsPx,
      hitboxes: [],
      parentPath: pageWithChildrenVePath,
      col: 0,
      row: 0,
      blockSizePx,
      lineItemTextRightPaddingPx,
    };

    VesCache.arrange.writeVisualElement(movingItemVeSpec, {}, movingItemPath);
    calendarChildPaths.push(movingItemPath);
  }

  pageRelationships.childrenPaths = calendarChildPaths;
}


export function arrange_calendar_page(
  store: StoreContextModel,
  parentPath: VisualElementPath,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  actualLinkItemMaybe_pageWithChildren: LinkItem | null,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags): { spec: VisualElementSpec, relationships: VisualElementRelationships } {

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : actualLinkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const movingItemInThisPage = getMovingTreeItemInParentMaybe(displayItem_pageWithChildren.id);

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  if (isFull) {
    VesCache.titles.pushTopTitledPage(pageWithChildrenVePath);
  }

  const rendersAsTranslucentPage =
    !(flags & (
      ArrangeItemFlags.IsTopRoot |
      ArrangeItemFlags.IsPopupRoot |
      ArrangeItemFlags.IsListPageMainRoot |
      ArrangeItemFlags.IsEmbeddedInteractiveRoot |
      ArrangeItemFlags.IsDockRoot
    ));

  const childAreaBoundsPx = (() => {
    let result = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.viewportBoundsPx!)!);
    if (rendersAsTranslucentPage) {
      result.h = geometry.viewportBoundsPx!.h;
      return result;
    }

    // Calculate natural calendar height
    const titleHeight = 40;
    const monthTitleHeight = 30;
    const topPadding = 7;
    const bottomMargin = 5;
    const headerHeight = topPadding + titleHeight + 14 + monthTitleHeight + bottomMargin;
    const naturalCalendarHeightPx = headerHeight + (31 * CALENDAR_DAY_ROW_HEIGHT_BL * LINE_HEIGHT_PX);

    const viewportHeight = geometry.viewportBoundsPx!.h;

    // For popup, always scale to fit exactly (no scrollbars)
    if (flags & ArrangeItemFlags.IsPopupRoot) {
      result.h = Math.round(viewportHeight);
      return result;
    }

    // Check if shrinking by 0.7x would still make content taller than screen
    const minScaledHeight = naturalCalendarHeightPx * 0.7;
    if (minScaledHeight > viewportHeight) {
      // Even at 0.7x scale, content is too tall - fall back to scroll with 1.0x scale
      result.h = naturalCalendarHeightPx;
    } else {
      // Content can be scaled between 0.7x and 1.3x to fit viewport
      const naturalHeightRatio = naturalCalendarHeightPx / viewportHeight;

      if (naturalHeightRatio > 1.0) {
        // Content is taller than viewport - scale down (minimum 0.7x)
        const scaleDown = Math.max(0.7, 1.0 / naturalHeightRatio);
        result.h = Math.round(naturalCalendarHeightPx * scaleDown);
      } else {
        // Content is shorter than or equal to viewport - scale up to fill space (maximum 1.3x)
        const maxScaledHeight = naturalCalendarHeightPx * 1.3;
        if (maxScaledHeight <= viewportHeight) {
          // Can scale up to 1.3x and still fit
          result.h = Math.round(maxScaledHeight);
        } else {
          // Scale up to exactly fit the viewport
          result.h = Math.round(viewportHeight);
        }
      }
    }

    return result;
  })();

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

  if (rendersAsTranslucentPage) {
    arrangeMiniCalendarPage(
      store,
      displayItem_pageWithChildren,
      linkItemMaybe_pageWithChildren,
      pageWithChildrenVePath,
      geometry,
      flags,
      pageSpec,
      pageRelationships,
      highlightedPath,
      movingItemInThisPage,
    );
    return { spec: pageSpec, relationships: pageRelationships };
  }

  // Arrange child items in calendar grid layout (6 blocks wide)
  let calendarChildPaths: Array<VisualElementPath> = [];
  const calendarWindow = calculateCalendarWindowForPage(store, pageWithChildrenVePath, childAreaBoundsPx.w, displayItem_pageWithChildren);

  // Sort children by dateTime, but exclude moving item if it's in this page
  // Also filter to only show items from the visible calendar window
  const childrenWithDateTime = displayItem_pageWithChildren.computed_children
    .map(childId => itemState.get(childId)!)
    .filter(child => {
      if (child == null) return false;
      if (movingItemInThisPage && child.id === movingItemInThisPage.id) return false;

      const itemDate = new Date(child.dateTime * 1000);
      return isCalendarMonthVisible(calendarWindow, itemDate.getFullYear(), itemDate.getMonth() + 1);
    })
    .sort((a, b) => a.dateTime - b.dateTime);

  // Calendar layout dimensions (using arranged childAreaBoundsPx)
  const childAreaBounds = childAreaBoundsPx;
  const calendarMonthResize = calendarWindow.monthsPerPage == 12
    ? store.perVe.getCalendarMonthResize(pageWithChildrenVePath)
    : null;
  const calendarDimensions = calculateCalendarDimensions(childAreaBounds, calendarMonthResize, calendarWindow);
  const calendarVerticalLayout = calculateCalendarVerticalLayout(
    childAreaBounds,
    !!(flags & ArrangeItemFlags.IsPopupRoot),
  );
  const titleBarHeightPx = geometry.boundsPx.h - geometry.viewportBoundsPx!.h;
  const dividerTopPx = (() => {
    if (flags & ArrangeItemFlags.IsPopupRoot) {
      return calendarVerticalLayout.monthTitleTopPx;
    }
    return CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + CALENDAR_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING;
  })();
  const dividerHitboxes: Array<ReturnType<typeof HitboxFns.create>> = [];
  if ((flags & ArrangeItemFlags.IsTopRoot || flags & ArrangeItemFlags.IsListPageMainRoot) &&
    calendarWindow.monthsPerPage == 12) {
    for (let dividerMonth = 1; dividerMonth < CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT; ++dividerMonth) {
      const dividerCenterPx = getCalendarDividerCenterPx(calendarDimensions, dividerMonth);
      dividerHitboxes.push(HitboxFns.create(
        HitboxFlags.HorizontalResize,
        {
          x: dividerCenterPx - CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING / 2,
          y: dividerTopPx + titleBarHeightPx,
          w: CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING,
          h: childAreaBounds.h - dividerTopPx,
        },
        HitboxFns.createMeta({ calendarDividerMonth: dividerMonth }),
      ));
    }
  }

  // Item dimensions - icon + text layout like other line items
  // For popups, scale blockSizePx to match the calendar scaling
  const blockSizePx = (() => {
    if (flags & ArrangeItemFlags.IsPopupRoot) {
      return {
        w: NATURAL_BLOCK_SIZE_PX.w * calendarVerticalLayout.scale,
        h: NATURAL_BLOCK_SIZE_PX.h * calendarVerticalLayout.scale,
      };
    }
    return NATURAL_BLOCK_SIZE_PX;
  })();
  const itemLeftPadding = 2;

  // Group items by date for stacking
  const itemsByDate = new Map<string, typeof childrenWithDateTime>();
  childrenWithDateTime.forEach(child => {
    const itemDate = new Date(child.dateTime * 1000);
    const dateKey = calendarDateKey(itemDate.getFullYear(), itemDate.getMonth() + 1, itemDate.getDate());
    if (!itemsByDate.has(dateKey)) {
      itemsByDate.set(dateKey, []);
    }
    itemsByDate.get(dateKey)!.push(child);
  });

  // Sort items within each date by ordering
  itemsByDate.forEach((items) => {
    items.sort((a, b) => {
      const cmp = compareOrderings(a.ordering, b.ordering);
      if (cmp !== 0) return cmp;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
  });

  const itemCountsByDate = new Map<string, number>();
  itemsByDate.forEach((items, dateKey) => {
    itemCountsByDate.set(dateKey, items.length);
  });
  const calendarMonthLayouts = calculateCalendarMonthLayouts(
    calendarWindow,
    calendarVerticalLayout.availableHeightForDays,
    calendarVerticalLayout.dayAreaTopPx,
    itemCountsByDate,
  );

  // Arrange items by date
  itemsByDate.forEach((itemsForDate) => {
    const visibleItems = itemsForDate;
    const firstItem = visibleItems[0];
    const itemDate = new Date(firstItem.dateTime * 1000);
    const month = itemDate.getMonth() + 1; // 1-12
    const day = itemDate.getDate(); // 1-31

    // Calculate base position for this date
    const monthLeftPos = getCalendarMonthLeftPx(calendarDimensions, month);
    const monthWidth = getCalendarMonthWidthPx(calendarDimensions, month);
    const dayMetrics = getCalendarDayMetrics(calendarDimensions, calendarMonthLayouts, month, day);
    const dayTopPos = dayMetrics.topPx;
    const rowHeight = dayMetrics.rowHeightPx;
    const visibleItemHeight = Math.min(rowHeight, blockSizePx.h);
    const itemWidth = Math.max(0, monthWidth - CALENDAR_DAY_LABEL_LEFT_MARGIN_PX - itemLeftPadding);

    visibleItems.forEach((childItem, stackIndex) => {
      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

      if (isComposite(displayItem)) {
        initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
      }

      const effectiveItemWidth = Math.max(0, itemWidth - 2);
      const itemStepHeight = rowHeight;
      const itemTopInset = Math.min(1, Math.max(0, visibleItemHeight * 0.2));
      const arrangedItemHeight = Math.max(0, visibleItemHeight - itemTopInset);

      // Stack items vertically within the day
      const boundsPx = {
        x: monthLeftPos + CALENDAR_DAY_LABEL_LEFT_MARGIN_PX + itemLeftPadding,
        y: dayTopPos + stackIndex * itemStepHeight + itemTopInset,
        w: effectiveItemWidth,
        h: arrangedItemHeight
      };

      const innerBoundsPx = {
        x: 0,
        y: 0,
        w: effectiveItemWidth,
        h: arrangedItemHeight
      };

      // Line item hitbox layout: icon area + text area
      const effectiveWidthBl = Math.floor(effectiveItemWidth / blockSizePx.w);
      const clickAreaBoundsPx = effectiveWidthBl > 1 ? {
        x: blockSizePx.w, // Start after icon block
        y: 0,
        w: effectiveItemWidth - blockSizePx.w, // Text area width
        h: arrangedItemHeight
      } : {
        x: 0, // If only icon fits, click anywhere
        y: 0,
        w: effectiveItemWidth,
        h: arrangedItemHeight
      };

      const popupClickAreaBoundsPx = {
        x: 0,
        y: 0,
        w: blockSizePx.w, // Icon area only
        h: arrangedItemHeight
      };

      const calendarItemGeometry = {
        boundsPx,
        blockSizePx,
        viewportBoundsPx: null,
        hitboxes: (
          isRating(displayItem)
            ? [
              HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
              HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
            ]
            : [
              HitboxFns.create(HitboxFlags.Click, clickAreaBoundsPx),
              HitboxFns.create(HitboxFlags.OpenPopup, popupClickAreaBoundsPx),
              HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
            ]
        )
      };

      const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), pageWithChildrenVePath);

      const isChildHighlighted = highlightedPath !== null && highlightedPath === childPath;

      const calendarItemVeSpec: VisualElementSpec = {
        displayItem,
        linkItemMaybe,
        actualLinkItemMaybe: linkItemMaybe,
        flags: VisualElementFlags.LineItem |
          VisualElementFlags.DisableLineItemExpand |
          (isChildHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
        _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
        boundsPx: calendarItemGeometry.boundsPx,
        hitboxes: calendarItemGeometry.hitboxes,
        parentPath: pageWithChildrenVePath,
        col: 0,
        row: dayMetrics.rowStart + stackIndex,
        blockSizePx: blockSizePx,
      };

      const calendarItemRelationships: VisualElementRelationships = {};
      VesCache.arrange.writeVisualElement(calendarItemVeSpec, calendarItemRelationships, childPath);
      calendarChildPaths.push(childPath);
    });
  });

  // Attach page-level hitboxes to the page visual element
  pageSpec.hitboxes = [
    ...(pageSpec.hitboxes || []),
    ...dividerHitboxes,
  ];
  pageSpec.calendarMonthLayouts = calendarMonthLayouts;

  // Add moving item if it exists and belongs to this page
  if (movingItemInThisPage) {
    const movingItemDimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItemInThisPage);
    const scrollVeid = flags & ArrangeItemFlags.IsPopupRoot
      ? store.history.currentPopupSpec()!.actualVeid
      : VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
    const translucentDisplayScale = (() => {
      if (!rendersAsTranslucentPage) { return 1.0; }
      const parentItem = itemState.get(VeFns.veidFromPath(parentPath).itemId);
      return parentItem != null &&
        isPage(parentItem) &&
        asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.List
        ? geometry.viewportBoundsPx!.w / store.desktopMainAreaBoundsPx().w
        : 1.0;
    })();
    const movingBlockSizePx = {
      w: blockSizePx.w * translucentDisplayScale,
      h: blockSizePx.h * translucentDisplayScale,
    };
    const movingItemBoundsPx = movingItemCellBoundsInPagePx(
      store,
      pageWithChildrenVePath,
      geometry,
      childAreaBoundsPx,
      scrollVeid,
      {
        w: movingItemDimensionsBl.w * movingBlockSizePx.w,
        h: movingItemDimensionsBl.h * movingBlockSizePx.h,
      },
      flags,
    );
    const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, movingItemInThisPage);
    const movingItemPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), pageWithChildrenVePath);
    const movingItemVeSpec: VisualElementSpec = {
      displayItem,
      linkItemMaybe,
      actualLinkItemMaybe: linkItemMaybe,
      flags: VisualElementFlags.Moving,
      _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.IsMoving,
      boundsPx: movingItemBoundsPx,
      hitboxes: [],
      parentPath: pageWithChildrenVePath,
      col: 0,
      row: 0,
      blockSizePx: movingBlockSizePx,
    };

    VesCache.arrange.writeVisualElement(movingItemVeSpec, {}, movingItemPath);
    calendarChildPaths.push(movingItemPath);
  }

  pageRelationships.childrenPaths = calendarChildPaths;

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      const popupItemType = itemState.get(currentPopupSpec.actualVeid.itemId)!.itemType;
      const isFromAttachment = currentPopupSpec.isFromAttachment ?? false;
      const isPageOrImagePopup = popupItemType == ItemType.Page || popupItemType == ItemType.Image;
      const isSourceAnchoredPopup = !isPageOrImagePopup &&
        (isFromAttachment || currentPopupSpec.sourceTopLeftGr != null);
      if (isSourceAnchoredPopup) {
        const { geometry, linkItem, actualLinkItemMaybe, wasAutoAdjusted } = calcSpatialPopupGeometry(
          store,
          displayItem_pageWithChildren,
          currentPopupSpec.actualVeid,
          pageSpec.childAreaBoundsPx!
        );

        const popupVes = arrangeItem(
          store, pageWithChildrenVePath, displayItem_pageWithChildren.arrangeAlgorithm, linkItem, actualLinkItemMaybe, geometry,
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
