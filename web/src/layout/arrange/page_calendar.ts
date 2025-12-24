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

import { LinkItem, isLink, asLinkItem, LinkFns } from "../../items/link-item";
import { isRating } from "../../items/rating-item";
import { PageItem } from "../../items/page-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { ItemGeometry } from "../item-geometry";
import { VeFns, VisualElementCreateParams, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags } from "./item";
import { VesCache } from "../ves-cache";
import { arrangeCellPopup } from "./popup";
import { itemState } from "../../store/ItemState";
import { getVePropertiesForItem } from "./util";
import { NATURAL_BLOCK_SIZE_PX, CALENDAR_DAY_ROW_HEIGHT_BL, LINE_HEIGHT_PX, CALENDAR_DAY_LABEL_LEFT_MARGIN_PX } from "../../constants";
import { isComposite } from "../../items/composite-item";
import { isExpression } from "../../items/expression-item";
import { initiateLoadChildItemsMaybe } from "../load";
import { VisualElementSignal } from "../../util/signals";
import { HitboxFns, HitboxFlags } from "../hitbox";
import { compareOrderings } from "../../util/ordering";
import { MouseActionState, MouseAction } from "../../input/state";
import { CursorEventState } from "../../input/state";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { calculateCalendarDimensions, CALENDAR_LAYOUT_CONSTANTS } from "../../util/calendar-layout";


export function arrange_calendar_page(
  store: StoreContextModel,
  parentPath: VisualElementPath,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  actualLinkItemMaybe_pageWithChildren: LinkItem | null,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags): VisualElementCreateParams {

  let pageWithChildrenVisualElementSpec: VisualElementCreateParams;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : actualLinkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  // Check if an item is being moved
  let movingItem = null;
  let movingItemInThisPage = null;
  if (!MouseActionState.empty() && (MouseActionState.get().action == MouseAction.Moving)) {
    movingItemInThisPage = VeFns.treeItemFromPath(MouseActionState.get().activeElementPath);
    movingItem = movingItemInThisPage;
    if (movingItemInThisPage!.parentId != displayItem_pageWithChildren.id) {
      movingItemInThisPage = null;
    }
  }

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  if (isFull) {
    VesCache.pushTopTitledPage(pageWithChildrenVePath);
  }

  const childAreaBoundsPx = (() => {
    let result = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.viewportBoundsPx!)!);

    // Calculate natural calendar height
    const titleHeight = 40;
    const monthTitleHeight = 30;
    const topPadding = 7;
    const bottomMargin = 5;
    const headerHeight = topPadding + titleHeight + 14 + monthTitleHeight + bottomMargin;
    const naturalCalendarHeightPx = headerHeight + (31 * displayItem_pageWithChildren.calendarDayRowHeightBl * LINE_HEIGHT_PX);

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
      (isHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None) |
      (isSelectionHighlighted ? VisualElementFlags.SelectionHighlighted : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: geometry.viewportBoundsPx!,
    hitboxes: geometry.hitboxes,
    childAreaBoundsPx,
    parentPath,
  };

  // Arrange child items in calendar grid layout (6 blocks wide)
  let calendarVeChildren: Array<VisualElementSignal> = [];

  // Get the currently selected calendar year for this page
  const selectedCalendarYear = store.perVe.getCalendarYear(pageWithChildrenVePath);

  // Sort children by dateTime, but exclude moving item if it's in this page
  // Also filter to only show items from the selected calendar year
  const childrenWithDateTime = displayItem_pageWithChildren.computed_children
    .map(childId => itemState.get(childId)!)
    .filter(child => {
      if (child == null) return false;
      if (movingItemInThisPage && child.id === movingItemInThisPage.id) return false;

      // Filter by selected calendar year
      const itemDate = new Date(child.dateTime * 1000);
      return itemDate.getFullYear() === selectedCalendarYear;
    })
    .sort((a, b) => a.dateTime - b.dateTime);

  // Calendar layout dimensions (using arranged childAreaBoundsPx)
  const childAreaBounds = childAreaBoundsPx;
  const calendarDimensions = calculateCalendarDimensions(childAreaBounds);

  const popupTopPadding = 5;
  const popupTitleToMonthSpacing = 8;
  const popupMonthTitleHeight = 26;
  const popupBottomMargin = 3;

  const dayRowHeight = (() => {
    if (flags & ArrangeItemFlags.IsPopupRoot) {
      const baseDayRowPx = displayItem_pageWithChildren.calendarDayRowHeightBl * LINE_HEIGHT_PX;
      const headerTotal = popupTopPadding + CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + popupTitleToMonthSpacing + popupMonthTitleHeight + popupBottomMargin;
      const naturalTotal = headerTotal + CALENDAR_LAYOUT_CONSTANTS.DAYS_COUNT * baseDayRowPx;
      const scale = childAreaBounds.h / naturalTotal;
      return baseDayRowPx * scale;
    }
    return calendarDimensions.dayRowHeight;
  })();

  const dayAreaTopPx = (() => {
    if (flags & ArrangeItemFlags.IsPopupRoot) {
      const baseDayRowPx = displayItem_pageWithChildren.calendarDayRowHeightBl * LINE_HEIGHT_PX;
      const headerTotal = popupTopPadding + CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + popupTitleToMonthSpacing + popupMonthTitleHeight + popupBottomMargin;
      const naturalTotal = headerTotal + CALENDAR_LAYOUT_CONSTANTS.DAYS_COUNT * baseDayRowPx;
      const scale = childAreaBounds.h / naturalTotal;
      return (popupTopPadding + CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + popupTitleToMonthSpacing + popupMonthTitleHeight) * scale;
    }
    return calendarDimensions.dayAreaTopPx;
  })();

  // Item dimensions - icon + text layout like other line items
  // For popups, scale blockSizePx to match the calendar scaling
  const blockSizePx = (() => {
    if (flags & ArrangeItemFlags.IsPopupRoot) {
      const baseDayRowPx = displayItem_pageWithChildren.calendarDayRowHeightBl * LINE_HEIGHT_PX;
      const headerTotal = popupTopPadding + CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + popupTitleToMonthSpacing + popupMonthTitleHeight + popupBottomMargin;
      const naturalTotal = headerTotal + CALENDAR_LAYOUT_CONSTANTS.DAYS_COUNT * baseDayRowPx;
      const scale = childAreaBounds.h / naturalTotal;
      return { w: NATURAL_BLOCK_SIZE_PX.w * scale, h: NATURAL_BLOCK_SIZE_PX.h * scale };
    }
    return NATURAL_BLOCK_SIZE_PX;
  })();
  const itemHeight = Math.min(dayRowHeight, blockSizePx.h);

  // Calculate available width for items (with 2px left padding after day number)
  const itemLeftPadding = 2;
  const availableWidthForItems = calendarDimensions.columnWidth - CALENDAR_DAY_LABEL_LEFT_MARGIN_PX - itemLeftPadding;
  const itemWidth = availableWidthForItems;

  // Cap items per day by how many rows fit in a day
  const rowsPerDay = Math.max(1, Math.floor(dayRowHeight / itemHeight));

  // Group items by date for stacking
  const itemsByDate = new Map<string, typeof childrenWithDateTime>();
  childrenWithDateTime.forEach(child => {
    const itemDate = new Date(child.dateTime * 1000);
    const dateKey = `${itemDate.getFullYear()}-${itemDate.getMonth() + 1}-${itemDate.getDate()}`;
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

  // Prepare an array of page-level hitboxes for overflow indicators
  const overflowHitboxes: Array<ReturnType<typeof HitboxFns.create>> = [];

  // Arrange items by date
  itemsByDate.forEach((itemsForDate, dateKey) => {
    const cappedItems = itemsForDate.slice(0, rowsPerDay);
    const firstItem = cappedItems[0];
    const itemDate = new Date(firstItem.dateTime * 1000);
    const month = itemDate.getMonth() + 1; // 1-12
    const day = itemDate.getDate(); // 1-31

    // Calculate base position for this date
    const monthLeftPos = CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN + (month - 1) * (calendarDimensions.columnWidth + CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING);
    const dayTopPos = dayAreaTopPx + (day - 1) * dayRowHeight;

    // Add a page-level hitbox for overflow count if there are more items than rows
    const overflowCount = Math.max(0, itemsForDate.length - rowsPerDay);
    if (overflowCount > 0) {
      const rightEdge = monthLeftPos + calendarDimensions.columnWidth;
      const baseX = rightEdge - blockSizePx.w;
      const baseY = dayTopPos + (rowsPerDay - 1) * itemHeight + 1;
      // For popups, hitboxes are in boundsPx coordinates (includes title bar),
      // but the calendar positions are in viewportBoundsPx/childAreaBoundsPx coordinates.
      // Add the title bar height offset to convert to boundsPx coordinates.
      const titleBarHeightPx = geometry.boundsPx.h - geometry.viewportBoundsPx!.h;
      const overlayBoundsPx = {
        x: baseX + 2,
        y: baseY + 2 + titleBarHeightPx,
        w: blockSizePx.w - 2,
        h: itemHeight - 4,
      };
      const meta = HitboxFns.createMeta({
        calendarYear: itemDate.getFullYear(),
        calendarMonth: month,
        calendarDay: day,
      });
      overflowHitboxes.push(HitboxFns.create(HitboxFlags.CalendarOverflow, overlayBoundsPx, meta));
      overflowHitboxes.push(HitboxFns.create(HitboxFlags.ShowPointer, overlayBoundsPx, meta));
    }

    cappedItems.forEach((childItem, stackIndex) => {
      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

      if (isComposite(displayItem)) {
        initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
      }

      const isLastRow = stackIndex === rowsPerDay - 1;
      const effectiveItemWidth = (overflowCount > 0 && isLastRow)
        ? itemWidth - blockSizePx.w - 2
        : itemWidth - 2;

      // Stack items vertically within the day
      const boundsPx = {
        x: monthLeftPos + CALENDAR_DAY_LABEL_LEFT_MARGIN_PX + itemLeftPadding,
        y: dayTopPos + stackIndex * itemHeight + 1,
        w: effectiveItemWidth,
        h: itemHeight
      };

      const innerBoundsPx = {
        x: 0,
        y: 0,
        w: effectiveItemWidth,
        h: itemHeight
      };

      // Line item hitbox layout: icon area + text area
      const effectiveWidthBl = Math.floor(effectiveItemWidth / blockSizePx.w);
      const clickAreaBoundsPx = effectiveWidthBl > 1 ? {
        x: blockSizePx.w, // Start after icon block
        y: 0,
        w: effectiveItemWidth - blockSizePx.w, // Text area width
        h: itemHeight
      } : {
        x: 0, // If only icon fits, click anywhere
        y: 0,
        w: effectiveItemWidth,
        h: itemHeight
      };

      const popupClickAreaBoundsPx = {
        x: 0,
        y: 0,
        w: blockSizePx.w, // Icon area only
        h: itemHeight
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
          (isChildHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
        _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
        boundsPx: calendarItemGeometry.boundsPx,
        hitboxes: calendarItemGeometry.hitboxes,
        parentPath: pageWithChildrenVePath,
        col: 0,
        row: stackIndex,
        blockSizePx: blockSizePx,
      };

      const calendarItemVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(calendarItemVeSpec, childPath);
      calendarVeChildren.push(calendarItemVisualElementSignal);

      if (isExpression(childItem)) {
        VesCache.markEvaluationRequired(VeFns.veToPath(calendarItemVisualElementSignal.get()));
      }
    });
  });

  // Attach overflow hitboxes to the page visual element
  pageWithChildrenVisualElementSpec = pageWithChildrenVisualElementSpec || ({} as any);
  pageWithChildrenVisualElementSpec.hitboxes = [
    ...(pageWithChildrenVisualElementSpec.hitboxes || []),
    ...overflowHitboxes,
  ];

  // Add moving item if it exists and belongs to this page
  if (movingItemInThisPage) {
    const actualMovingItemLinkItemMaybe = isLink(movingItemInThisPage) ? asLinkItem(movingItemInThisPage) : null;

    // Get scroll offset calculations matching other page types
    let scrollPropY;
    let scrollPropX;
    if (flags & ArrangeItemFlags.IsPopupRoot) {
      const popupSpec = store.history.currentPopupSpec();
      scrollPropY = store.perItem.getPageScrollYProp(popupSpec!.actualVeid);
      scrollPropX = store.perItem.getPageScrollXProp(popupSpec!.actualVeid);
    } else {
      scrollPropY = store.perItem.getPageScrollYProp(VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren));
      scrollPropX = store.perItem.getPageScrollXProp(VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren));
    }

    const umbrellaVisualElement = store.umbrellaVisualElement.get();
    const umbrellaBoundsPx = umbrellaVisualElement.childAreaBoundsPx!;
    const desktopSizePx = store.desktopBoundsPx();
    const pageYScrollProp = store.perItem.getPageScrollYProp(store.history.currentPageVeid()!);
    const pageYScrollPx = pageYScrollProp * (umbrellaBoundsPx.h - desktopSizePx.h);

    const yOffsetPx = scrollPropY * (childAreaBoundsPx.h - geometry.boundsPx.h);
    const xOffsetPx = scrollPropX * (childAreaBoundsPx.w - geometry.boundsPx.w);
    const mouseDesktopPosPx = CursorEventState.getLatestDesktopPx(store);
    const popupTitleHeightMaybePx = geometry.boundsPx.h - geometry.viewportBoundsPx!.h;
    const adjX = flags & ArrangeItemFlags.IsTopRoot ? 0 : store.getCurrentDockWidthPx();

    // Use calendar-specific item dimensions
    const calendarItemHeight = itemHeight;

    // Adjust Y position by approximately one row height to align with calendar grid
    const calendarYAdjustment = dayRowHeight;

    // Calculate moving item position using the same coordinate system as other page types
    const movingItemBoundsPx = {
      x: mouseDesktopPosPx.x - geometry.boundsPx.x - adjX + xOffsetPx,
      y: mouseDesktopPosPx.y - geometry.boundsPx.y - store.topToolbarHeightPx() - popupTitleHeightMaybePx - pageYScrollPx + yOffsetPx + calendarYAdjustment,
      w: itemWidth,
      h: calendarItemHeight
    };

    // Adjust for click offset
    movingItemBoundsPx.x -= MouseActionState.get().clickOffsetProp!.x * movingItemBoundsPx.w;
    movingItemBoundsPx.y -= MouseActionState.get().clickOffsetProp!.y * movingItemBoundsPx.h;

    // Create hitboxes for moving item matching normal item structure
    const movingWidthBl = Math.floor(itemWidth / blockSizePx.w);
    const movingClickAreaBoundsPx = movingWidthBl > 1 ? {
      x: blockSizePx.w, // Start after icon block
      y: 0,
      w: itemWidth - blockSizePx.w, // Text area width
      h: calendarItemHeight
    } : {
      x: 0, // If only icon fits, click anywhere
      y: 0,
      w: itemWidth,
      h: calendarItemHeight
    };

    const movingPopupClickAreaBoundsPx = {
      x: 0,
      y: 0,
      w: blockSizePx.w, // Icon area only
      h: calendarItemHeight
    };

    const movingItemGeometry = {
      boundsPx: movingItemBoundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: (
        isRating(movingItemInThisPage)
          ? [
            HitboxFns.create(HitboxFlags.Click, { x: 0, y: 0, w: movingItemBoundsPx.w, h: movingItemBoundsPx.h }),
            HitboxFns.create(HitboxFlags.Move, { x: 0, y: 0, w: movingItemBoundsPx.w, h: movingItemBoundsPx.h }),
          ]
          : [
            HitboxFns.create(HitboxFlags.Click, movingClickAreaBoundsPx),
            HitboxFns.create(HitboxFlags.OpenPopup, movingPopupClickAreaBoundsPx),
            HitboxFns.create(HitboxFlags.Move, { x: 0, y: 0, w: movingItemBoundsPx.w, h: movingItemBoundsPx.h }),
          ]
      )
    };

    const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(movingItemInThisPage, actualMovingItemLinkItemMaybe), pageWithChildrenVePath);
    const isChildHighlighted = highlightedPath !== null && highlightedPath === childPath;

    let movingDisplayItem = movingItemInThisPage;
    if (actualMovingItemLinkItemMaybe) {
      const linkToId = LinkFns.getLinkToId(actualMovingItemLinkItemMaybe);
      const linkedItem = itemState.get(linkToId);
      if (linkedItem) {
        movingDisplayItem = linkedItem;
      } else {
        const actionState = MouseActionState.empty() ? null : MouseActionState.get();
        if (actionState && actionState.activeLinkIdMaybe === actualMovingItemLinkItemMaybe.id && actionState.activeLinkedDisplayItemMaybe) {
          movingDisplayItem = actionState.activeLinkedDisplayItemMaybe;
        }
      }
    }

    const movingItemVeSpec: VisualElementSpec = {
      displayItem: movingDisplayItem,
      linkItemMaybe: actualMovingItemLinkItemMaybe,
      actualLinkItemMaybe: actualMovingItemLinkItemMaybe,
      flags: VisualElementFlags.LineItem |
        VisualElementFlags.Moving |
        (isChildHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
      _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.IsMoving,
      boundsPx: movingItemGeometry.boundsPx,
      hitboxes: movingItemGeometry.hitboxes,
      parentPath: pageWithChildrenVePath,
      col: 0,
      row: 0,
      blockSizePx: blockSizePx,
    };

    const movingItemVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(movingItemVeSpec, childPath);
    calendarVeChildren.push(movingItemVisualElementSignal);

    if (isExpression(movingItemInThisPage)) {
      VesCache.markEvaluationRequired(VeFns.veToPath(movingItemVisualElementSignal.get()));
    }
  }

  pageWithChildrenVisualElementSpec.childrenVes = calendarVeChildren;

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store);
    }
  }

  return pageWithChildrenVisualElementSpec;
}
