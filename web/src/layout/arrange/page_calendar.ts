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

import { LinkItem } from "../../items/link-item";
import { PageItem } from "../../items/page-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { ItemGeometry } from "../item-geometry";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags } from "./item";
import { VesCache } from "../ves-cache";
import { itemState } from "../../store/ItemState";
import { getVePropertiesForItem } from "./util";
import { ItemFns } from "../../items/base/item-polymorphism";
import { NATURAL_BLOCK_SIZE_PX, CHILD_ITEMS_VISIBLE_WIDTH_BL } from "../../constants";
import { isComposite } from "../../items/composite-item";
import { isExpression } from "../../items/expression-item";
import { initiateLoadChildItemsMaybe } from "../load";
import { VisualElementSignal } from "../../util/signals";
import { HitboxFns, HitboxFlags } from "../hitbox";


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

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  if (isFull) {
    VesCache.pushTopTitledPage(pageWithChildrenVePath);
  }

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
    childAreaBoundsPx: geometry.viewportBoundsPx!,
    parentPath,
  };

  // Arrange child items in calendar grid layout (6 blocks wide)
  let calendarVeChildren: Array<VisualElementSignal> = [];

  // Sort children by dateTime
  const childrenWithDateTime = displayItem_pageWithChildren.computed_children
    .map(childId => itemState.get(childId)!)
    .filter(child => child != null)
    .sort((a, b) => a.dateTime - b.dateTime);

  // Calendar layout dimensions (matching Page_Root.tsx renderCalendarPage)
  const viewportBounds = geometry.viewportBoundsPx!;
  const columnWidth = (viewportBounds.w - 11 * 5 - 10) / 12; // 11 gaps of 5px between 12 columns + 5px left/right margins
  const titleHeight = 40;
  const monthTitleHeight = 30;
  const topPadding = 10;
  const bottomMargin = 5;
  const availableHeightForDays = viewportBounds.h - topPadding - titleHeight - 20 - monthTitleHeight - bottomMargin;
  const dayRowHeight = availableHeightForDays / 31; // 31 max days

  // Item dimensions - icon + text layout like other line items
  const blockSizePx = NATURAL_BLOCK_SIZE_PX;
  const itemHeight = blockSizePx.h; // Standard block height for readability
  
  // Calculate how many blocks can fit in the column width
  const maxBlocksInColumn = Math.floor(columnWidth / blockSizePx.w);
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
         x: monthLeftPos,
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

  pageWithChildrenVisualElementSpec.childrenVes = calendarVeChildren;

  return pageWithChildrenVisualElementSpec;
} 