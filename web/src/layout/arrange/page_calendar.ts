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
import { PageItem } from "../../items/page-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { ItemGeometry } from "../item-geometry";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
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
import { MouseActionState, MouseAction } from "../../input/state";
import { CursorEventState } from "../../input/state";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";


export function arrange_calendar_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    actualLinkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSpec {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

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
    const topPadding = 10;
    const bottomMargin = 5;
    const headerHeight = topPadding + titleHeight + 20 + monthTitleHeight + bottomMargin;
    const naturalCalendarHeightPx = headerHeight + (31 * displayItem_pageWithChildren.calendarDayRowHeightBl * LINE_HEIGHT_PX);
    
    const viewportHeight = geometry.viewportBoundsPx!.h;

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
      } else if (naturalHeightRatio < (1.0 / 1.3)) {
        // Content is much shorter than viewport - scale up (maximum 1.3x)
        result.h = Math.round(viewportHeight * 1.3);
      } else {
        // Content fits naturally or with acceptable scaling
        result.h = naturalCalendarHeightPx;
      }
    }

    return result;
  })();

  const highlightedPath = store.find.highlightedPath.get();
  const isHighlighted = highlightedPath !== null && highlightedPath === pageWithChildrenVePath;

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
           (isHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: geometry.viewportBoundsPx!,
    hitboxes: geometry.hitboxes,
    childAreaBoundsPx,
    parentPath,
  };

  // Arrange child items in calendar grid layout (6 blocks wide)
  let calendarVeChildren: Array<VisualElementSignal> = [];

  // Sort children by dateTime, but exclude moving item if it's in this page
  const childrenWithDateTime = displayItem_pageWithChildren.computed_children
    .map(childId => itemState.get(childId)!)
    .filter(child => child != null && (!movingItemInThisPage || child.id !== movingItemInThisPage.id))
    .sort((a, b) => a.dateTime - b.dateTime);

  // Calendar layout dimensions (using scaled childAreaBoundsPx)
  const childAreaBounds = childAreaBoundsPx;
  const columnWidth = (childAreaBounds.w - 11 * 5 - 10) / 12; // 11 gaps of 5px between 12 columns + 5px left/right margins
  const titleHeight = 40;
  const monthTitleHeight = 30;
  const topPadding = 10;
  const bottomMargin = 5;
  const availableHeightForDays = childAreaBounds.h - topPadding - titleHeight - 20 - monthTitleHeight - bottomMargin;
  const dayRowHeight = displayItem_pageWithChildren.calendarDayRowHeightBl * LINE_HEIGHT_PX;

  // Item dimensions - icon + text layout like other line items
  const blockSizePx = NATURAL_BLOCK_SIZE_PX;
  const itemHeight = blockSizePx.h; // Standard block height for readability
  
  // Calculate how many blocks can fit in the column width (accounting for day label space)
  const availableWidthForItems = columnWidth - CALENDAR_DAY_LABEL_LEFT_MARGIN_PX;
  const maxBlocksInColumn = Math.floor(availableWidthForItems / blockSizePx.w);
  const widthBl = Math.max(1, maxBlocksInColumn); // At least 1 block for icon
  const itemWidth = blockSizePx.w * widthBl;

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

  // Arrange items by date
  itemsByDate.forEach((itemsForDate, dateKey) => {
    const firstItem = itemsForDate[0];
    const itemDate = new Date(firstItem.dateTime * 1000);
    const month = itemDate.getMonth() + 1; // 1-12
    const day = itemDate.getDate(); // 1-31

    // Calculate base position for this date
    const monthLeftPos = 5 + (month - 1) * (columnWidth + 5);
    const dayTopPos = titleHeight + 20 + monthTitleHeight + (day - 1) * dayRowHeight;

    itemsForDate.forEach((childItem, stackIndex) => {
      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

      if (isComposite(displayItem)) {
        initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
      }

             // Stack items vertically within the day
       const boundsPx = {
         x: monthLeftPos + CALENDAR_DAY_LABEL_LEFT_MARGIN_PX,
         y: dayTopPos + stackIndex * itemHeight,
         w: itemWidth,
         h: itemHeight
       };

       const innerBoundsPx = {
         x: 0,
         y: 0,
         w: itemWidth,
         h: itemHeight
       };

       // Line item hitbox layout: icon area + text area
       const clickAreaBoundsPx = widthBl > 1 ? {
         x: blockSizePx.w, // Start after icon block
         y: 0,
         w: blockSizePx.w * (widthBl - 1), // Text area width
         h: itemHeight
       } : {
         x: 0, // If only icon fits, click anywhere
         y: 0,
         w: itemWidth,
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
         hitboxes: [
           HitboxFns.create(HitboxFlags.Click, clickAreaBoundsPx),
           HitboxFns.create(HitboxFlags.OpenPopup, popupClickAreaBoundsPx),
           HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
         ]
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
    const calendarItemHeight = blockSizePx.h; // Items in calendar use standard block height for icon+text

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
    const movingClickAreaBoundsPx = widthBl > 1 ? {
      x: blockSizePx.w, // Start after icon block
      y: 0,
      w: blockSizePx.w * (widthBl - 1), // Text area width
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
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, movingClickAreaBoundsPx),
        HitboxFns.create(HitboxFlags.OpenPopup, movingPopupClickAreaBoundsPx),
        HitboxFns.create(HitboxFlags.Move, {
          x: 0,
          y: 0,
          w: movingItemBoundsPx.w,
          h: movingItemBoundsPx.h
        }),
      ]
    };

    const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(movingItemInThisPage, actualMovingItemLinkItemMaybe), pageWithChildrenVePath);
    const isChildHighlighted = highlightedPath !== null && highlightedPath === childPath;

    const movingItemVeSpec: VisualElementSpec = {
      displayItem: movingItemInThisPage,
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
