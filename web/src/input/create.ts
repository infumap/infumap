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

import { GRID_SIZE, LINE_HEIGHT_PX, CALENDAR_DAY_ROW_HEIGHT_BL } from "../constants";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { ItemType } from "../items/base/item";
import { PositionalItem } from "../items/base/positional-item";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { ExpressionFns } from "../items/expression-item";
import { asFlipCardItem, FlipCardFns, isFlipCard } from "../items/flipcard-item";
import { LinkFns, asLinkItem, isLink } from "../items/link-item";
import { NoteFns } from "../items/note-item";
import { PageFns, asPageItem, isPage, ArrangeAlgorithm } from "../items/page-item";
import { PasswordFns } from "../items/password-item";
import { PlaceholderFns, isPlaceholder } from "../items/placeholder-item";
import { RatingFns } from "../items/rating-item";
import { TableFns, asTableItem, isTable } from "../items/table-item";
import { fullArrange } from "../layout/arrange";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VeFns, VisualElementFlags } from "../layout/visual-element";
import { server, serverOrRemote } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { Vector, cloneBoundingBox, isInside } from "../util/geometry";
import { panic } from "../util/lang";
import { Uid } from "../util/uid";
import { HitInfo, HitInfoFns } from "./hit";


function createNewItem(store: StoreContextModel, type: string, parentId: Uid, ordering: Uint8Array, relationship: string): PositionalItem {
  let newItem = null;
  if (type == "rating") {
    newItem = RatingFns.create(store.user.getUser().userId, parentId, relationship, 3, ordering)
  } else if (type == "table") {
    newItem = TableFns.create(store.user.getUser().userId, parentId, relationship, "", ordering);
  } else if (type == "note") {
    newItem = NoteFns.create(store.user.getUser().userId, parentId, relationship, "", ordering);
  } else if (type == "page") {
    newItem = PageFns.create(store.user.getUser().userId, parentId, relationship, "", ordering);
  } else if (type == "link")  {
    newItem = LinkFns.create(store.user.getUser().userId, parentId, relationship, "", ordering);
  } else if (type == "password")  {
    newItem = PasswordFns.create(store.user.getUser().userId, parentId, relationship, "", ordering);
  } else if (type == "expression") {
    newItem = ExpressionFns.create(store.user.getUser().userId, parentId, relationship, "", ordering);
  } else if (type == "flipcard") {
    newItem = FlipCardFns.create(store.user.getUser().userId, parentId, relationship, ordering);
  } else {
    panic("AddItem.createNewItem: unexpected item type.");
  }
  return newItem;
}

export function maybeAddNewChildItems(store: StoreContextModel, item: PositionalItem) {
  if (isFlipCard(item)) {
    const fcItem = asFlipCardItem(item);
    const parentId = item.id;

    const frontSidePageItem = PageFns.create(store.user.getUser().userId, parentId, RelationshipToParent.Child, "", itemState.newOrderingAtEndOfChildren(parentId));
    itemState.add(frontSidePageItem);
    frontSidePageItem.innerSpatialWidthGr = Math.round(fcItem.spatialWidthGr / fcItem.scale / GRID_SIZE) * GRID_SIZE;
    frontSidePageItem.naturalAspect = fcItem.naturalAspect;
    server.addItem(frontSidePageItem, null, store.general.networkStatus);

    const backSidePageItem = PageFns.create(store.user.getUser().userId, parentId, RelationshipToParent.Child, "", itemState.newOrderingAtEndOfChildren(parentId));
    itemState.add(backSidePageItem);
    backSidePageItem.innerSpatialWidthGr = Math.round(fcItem.spatialWidthGr / fcItem.scale / GRID_SIZE) * GRID_SIZE;
    backSidePageItem.naturalAspect = fcItem.naturalAspect;
    server.addItem(backSidePageItem, null, store.general.networkStatus);
  }
}

function calculateCalendarDateTime(store: StoreContextModel, desktopPosPx: Vector, pageVe: any): number {
  const childAreaBounds = pageVe.childAreaBoundsPx!;
  const viewportBounds = pageVe.viewportBoundsPx!;
  const columnWidth = (childAreaBounds.w - 11 * 5 - 10) / 12;
  const titleHeight = 40;
  const monthTitleHeight = 30;
  const dayRowHeight = asPageItem(pageVe.displayItem).calendarDayRowHeightBl * LINE_HEIGHT_PX;

  const veid = VeFns.veidFromVe(pageVe);
  const scrollYPx = store.perItem.getPageScrollYProp(veid) * (childAreaBounds.h - viewportBounds.h);
  const scrollXPx = store.perItem.getPageScrollXProp(veid) * (childAreaBounds.w - viewportBounds.w);

  const xOffsetPx = desktopPosPx.x - viewportBounds.x + scrollXPx;
  const yOffsetPx = desktopPosPx.y - viewportBounds.y + scrollYPx;

  const month = Math.max(1, Math.min(12, Math.floor((xOffsetPx - 5) / (columnWidth + 5)) + 1));
  const dayAreaTopPx = titleHeight + 20 + monthTitleHeight;
  const day = Math.max(1, Math.min(31, Math.floor((yOffsetPx - dayAreaTopPx) / dayRowHeight) + 1));

  const currentYear = new Date().getFullYear();
  const currentTime = new Date();
  const targetDate = new Date(currentYear, month - 1, day, currentTime.getHours(), currentTime.getMinutes(), currentTime.getSeconds());

  return Math.floor(targetDate.getTime() / 1000);
}

export const newItemInContext = (store: StoreContextModel, type: string, hitInfo: HitInfo, desktopPosPx: Vector) => {
  const overElementVe = HitInfoFns.getHitVe(hitInfo);
  const overPositionableVe = hitInfo.overPositionableVe;

  let newItem;
  let newItemPath;

  if (isPlaceholder(overElementVe.displayItem)) {
    newItem = createNewItem(
      store,
      type,
      overElementVe.displayItem.parentId,
      overElementVe.displayItem.ordering,
      overElementVe.displayItem.relationshipToParent);

    itemState.delete(overElementVe.displayItem.id);
    server.deleteItem(overElementVe.displayItem.id, store.general.networkStatus);
    itemState.add(newItem);
    server.addItem(newItem, null, store.general.networkStatus);
    maybeAddNewChildItems(store, newItem);

    store.overlay.contextMenuInfo.set(null);
    fullArrange(store);

    newItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: null}, overElementVe.parentPath! );
  }

  else if (isPage(overElementVe.displayItem) && (overElementVe.flags & VisualElementFlags.ShowChildren)) {
    newItem = createNewItem(
      store,
      type,
      overElementVe.displayItem.id,
      itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.id),
      RelationshipToParent.Child);

    const pageItem = asPageItem(overElementVe.displayItem);
    const isCalendarView = pageItem.arrangeAlgorithm === ArrangeAlgorithm.Calendar;

    if (isCalendarView) {
      newItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      newItem.calendarPositionGr = { x: 0.0, y: 0.0 };
      
      newItem.dateTime = calculateCalendarDateTime(store, desktopPosPx, overElementVe);
    } else {
      if (hitInfo.overPositionGr != null) {
        newItem.spatialPositionGr = hitInfo.overPositionGr!;
        newItem.calendarPositionGr = { x: 0.0, y: 0.0 };
        if (isXSizableItem(newItem)) {
          let maxWidthBl = Math.floor((asPageItem(overElementVe.displayItem).innerSpatialWidthGr - newItem.spatialPositionGr.x - GRID_SIZE / 2.0) / GRID_SIZE);
          if (maxWidthBl < 2) { maxWidthBl = 2; }
          if (maxWidthBl * GRID_SIZE < asXSizableItem(newItem).spatialWidthGr) {
            asXSizableItem(newItem).spatialWidthGr = maxWidthBl * GRID_SIZE;
          }
        }
      } else {
        console.warn("hitInfo.overPositionGr is not set");
      }
    }

    const naturalAspect = (store.desktopMainAreaBoundsPx().w / store.desktopMainAreaBoundsPx().h);
    if (isPage(newItem)) {
      const page = asPageItem(newItem);
      asPageItem(newItem).naturalAspect = Math.round(naturalAspect * 1000) / 1000;
      page.popupPositionGr = {
        x: Math.round((page.innerSpatialWidthGr / 2) / GRID_SIZE) * GRID_SIZE,
        y: Math.round((page.innerSpatialWidthGr / page.naturalAspect) * 0.4 / GRID_SIZE) * GRID_SIZE
      };
      const widthCandidate1Gr = Math.floor((page.innerSpatialWidthGr / 2.0) / GRID_SIZE) * GRID_SIZE;
      const parentInnerHeightGr = page.innerSpatialWidthGr / naturalAspect;
      const heightCandidate = Math.floor((parentInnerHeightGr / 2.0) / GRID_SIZE) * GRID_SIZE;
      const widthCandidate2Gr = Math.floor(heightCandidate * page.naturalAspect / GRID_SIZE) * GRID_SIZE;
      asPageItem(newItem).popupWidthGr = Math.min(widthCandidate1Gr, widthCandidate2Gr);
    }

    itemState.add(newItem);
    server.addItem(newItem, null, store.general.networkStatus);
    maybeAddNewChildItems(store, newItem);

    store.overlay.contextMenuInfo.set(null);
    fullArrange(store);

    newItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: null}, VeFns.veToPath(overElementVe));
  }

  else if (isTable(overElementVe.displayItem)) {

    if (TableFns.isInsideViewport(store, overElementVe, desktopPosPx)) {
      const { insertRow, attachmentPos } = TableFns.tableModifiableColRow(store, overElementVe, desktopPosPx);
      const tableItem = asTableItem(overElementVe.displayItem);

      if (attachmentPos == -1 || insertRow >= tableItem.computed_children.length) {
        newItem = createNewItem(
          store,
          type,
          overElementVe.displayItem.id,
          itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.parentId), // must be the case that it is at the end.
          RelationshipToParent.Child);
        server.addItem(newItem, null, store.general.networkStatus);
        itemState.add(newItem);
        store.overlay.contextMenuInfo.set(null);
        fullArrange(store);
        newItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: null}, VeFns.veToPath(overElementVe));

      } else {
        const childId = tableItem.computed_children[insertRow];
        const child = itemState.get(childId)!;
        const targetItem = isLink(child)
          ? itemState.get(LinkFns.getLinkToId(asLinkItem(child)))!
          : child;

        if (!isAttachmentsItem(targetItem)) {
          return;
        }

        const displayedChild = asAttachmentsItem(targetItem);

        const numPlaceholdersToCreate = attachmentPos > displayedChild.computed_attachments.length ? attachmentPos - displayedChild.computed_attachments.length : 0;
        for (let i=0; i<numPlaceholdersToCreate; ++i) {
          const placeholderItem = PlaceholderFns.create(displayedChild.ownerId, displayedChild.id, RelationshipToParent.Attachment, itemState.newOrderingAtEndOfAttachments(displayedChild.id));
          itemState.add(placeholderItem);
          server.addItem(placeholderItem, null, store.general.networkStatus);
        }

        newItem = createNewItem(
          store,
          type,
          displayedChild.id,
          itemState.newOrderingAtEndOfAttachments(displayedChild.id),
          RelationshipToParent.Attachment);

        itemState.add(newItem);
        server.addItem(newItem, null, store.general.networkStatus);
        maybeAddNewChildItems(store, newItem);

        store.overlay.contextMenuInfo.set(null);
        fullArrange(store);

        newItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: null}, VeFns.addVeidToPath(VeFns.veidFromId(childId), VeFns.veToPath(overElementVe)));
      }
    }

    else {
      // not inside child area: create item in the page containing the table.
      const parentVe = VesCache.get(overElementVe.parentPath!)!.get();
      newItem = createNewItem(
        store,
        type,
        parentVe.displayItem.id,
        itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.parentId),
        RelationshipToParent.Child);

      const page = asPageItem(overPositionableVe!.displayItem);
      const isCalendarView = page.arrangeAlgorithm === ArrangeAlgorithm.Calendar;

      if (isCalendarView) {
        newItem.spatialPositionGr = { x: 0.0, y: 0.0 };
        newItem.calendarPositionGr = { x: 0.0, y: 0.0 };
        newItem.dateTime = calculateCalendarDateTime(store, desktopPosPx, overPositionableVe!);
      } else {
        const propX = (desktopPosPx.x - overPositionableVe!.boundsPx.x) / overPositionableVe!.boundsPx.w;
        const propY = (desktopPosPx.y - overPositionableVe!.boundsPx.y) / overPositionableVe!.boundsPx.h;
        newItem.spatialPositionGr = {
          x: Math.floor(page.innerSpatialWidthGr / GRID_SIZE * propX * 2.0) / 2.0 * GRID_SIZE,
          y: Math.floor(page.innerSpatialWidthGr / GRID_SIZE / page.naturalAspect * propY * 2.0) / 2.0 * GRID_SIZE
        };
        newItem.calendarPositionGr = { x: 0.0, y: 0.0 };
      }

      itemState.add(newItem);
      server.addItem(newItem, null, store.general.networkStatus);
      maybeAddNewChildItems(store, newItem);

      store.overlay.contextMenuInfo.set(null);
      fullArrange(store);

      newItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: null}, VeFns.veToPath(parentVe));
    }
  }

  else if (isLink(overElementVe.displayItem)) {
    const link = asLinkItem(overElementVe.displayItem);

    const currentPageId = store.history.currentPageVeid()!.itemId;
    const currentPage = itemState.get(currentPageId)!;
    newItem = createNewItem(
      store,
      type,
      currentPageId,
      itemState.newOrderingAtEndOfChildren(currentPageId),
      RelationshipToParent.Child);

    const isCalendarView = isPage(currentPage) && asPageItem(currentPage).arrangeAlgorithm === ArrangeAlgorithm.Calendar;

    if (isCalendarView) {
      newItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      newItem.calendarPositionGr = { x: 0.0, y: 0.0 };
      // For link creation in calendar view, try to find the page VE to calculate calendar date
      try {
        const currentPageVes = VesCache.findSingle(store.history.currentPageVeid()!);
        if (currentPageVes) {
          newItem.dateTime = calculateCalendarDateTime(store, desktopPosPx, currentPageVes.get());
        }
      } catch (e) {
        // If we can't find the visual element or calculate calendar date, use current time
        console.warn("Could not calculate calendar date for link creation, using current time");
      }
    } else {
      newItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      newItem.calendarPositionGr = { x: 0.0, y: 0.0 };
    }

    itemState.add(newItem);
    server.addItem(newItem, null, store.general.networkStatus);
    maybeAddNewChildItems(store, newItem);

    link.linkTo = newItem.id;
    serverOrRemote.updateItem(link, store.general.networkStatus);

    store.overlay.contextMenuInfo.set(null);
    fullArrange(store);

    newItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: overElementVe.linkItemMaybe!.id}, overElementVe.parentPath!);
  }

  else {
    panic("cannot create item in context here.");
  }

  if (type == ItemType.Page ||
      type == ItemType.Note ||
      type == ItemType.Expression ||
      type == ItemType.Password ||
      type == ItemType.Table) {
    store.overlay.setTextEditInfo(store.history, { itemPath: newItemPath, itemType: type });
    const elId = newItemPath + ":title";
    const el = document.getElementById(elId);
    el!.innerText = "\n";
    el!.focus();
  } else if (type == ItemType.Link) {
    store.history.setFocus(newItemPath);
  } else if (type == ItemType.Rating) {
    // noop.
  } else {
    // noop.
  }
}
