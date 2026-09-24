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

import { RelationshipToParent } from "../layout/relationship-to-parent";
import { GRID_SIZE } from "../constants";
import { VeFns, VisualElementPath } from "../layout/visual-element";
import { VesCache } from "../layout/ves-cache";
import { requestArrange } from "../layout/arrange";
import { initiateLoadChildItemsMaybe, initiateLoadItemMaybe } from "../layout/load";
import { switchToPage } from "../layout/navigation";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { EMPTY_UID, SOLO_ITEM_HOLDER_PAGE_UID, UMBRELLA_PAGE_UID, Uid } from "../util/uid";
import { itemCanEdit } from "./base/capabilities-item";
import { SavedPageSettings, SavedTableSettings } from "./base/conversion-settings";
import { PageFlags, TableFlags } from "./base/flags-item";
import { ArrangeAlgorithm, PageItem, asPageItem, isPage } from "./page-item";
import { TableItem, asTableItem, isTable } from "./table-item";

export type PageTableConvertibleItem = PageItem | TableItem;

export type PageTableConversionRejection =
  | "missing-view"
  | "linked-view"
  | "wrong-item-type"
  | "not-table-page"
  | "client-only"
  | "remote-item"
  | "read-only"
  | "not-owned"
  | "special-page"
  | "not-page-child";

export type PageTableConversionEligibility =
  // Direct links can load the source before its parent; the action resolves the parent before mutating.
  | { allowed: true; source: PageTableConvertibleItem; parent: PageItem | null; parentId: Uid; targetType: "page" | "table" }
  | { allowed: false; reason: PageTableConversionRejection };

/** Eligibility for the original item, as displayed in the current toolbar view. */
export function pageTableConversionEligibility(
  store: StoreContextModel,
  focusPath: VisualElementPath | null,
): PageTableConversionEligibility {
  if (focusPath == null) { return { allowed: false, reason: "missing-view" }; }

  const focusedVe = VesCache.current.readNode(focusPath);
  if (focusedVe == null) { return { allowed: false, reason: "missing-view" }; }

  let path = focusPath;
  while (path != "") {
    const ve = VesCache.current.readNode(path);
    if (ve == null) { return { allowed: false, reason: "missing-view" }; }
    if (ve.displayItem.id == SOLO_ITEM_HOLDER_PAGE_UID) {
      return { allowed: false, reason: "special-page" };
    }
    if (ve.linkItemMaybe != null || ve.actualLinkItemMaybe != null) {
      return { allowed: false, reason: "linked-view" };
    }
    path = VeFns.parentPath(path);
  }

  const displayed = focusedVe.displayItem;
  if (!isPage(displayed) && !isTable(displayed)) {
    return { allowed: false, reason: "wrong-item-type" };
  }
  const source = isPage(displayed) ? asPageItem(displayed) : asTableItem(displayed);
  if (isPage(source) && asPageItem(source).arrangeAlgorithm != ArrangeAlgorithm.Table) {
    return { allowed: false, reason: "not-table-page" };
  }
  if (source.clientOnly) { return { allowed: false, reason: "client-only" }; }
  if (source.origin != null) { return { allowed: false, reason: "remote-item" }; }

  const user = store.user.getUserMaybe();
  if (user == null || source.ownerId != user.userId) {
    return { allowed: false, reason: "not-owned" };
  }
  if (!itemCanEdit(source)) { return { allowed: false, reason: "read-only" }; }

  if (isPage(source)) {
    if (source.id == user.homePageId || source.id == user.trashPageId ||
      source.id == user.dockPageId || source.id == user.queriesPageId ||
      source.id == UMBRELLA_PAGE_UID || source.id == SOLO_ITEM_HOLDER_PAGE_UID) {
      return { allowed: false, reason: "special-page" };
    }
  }

  if (source.relationshipToParent != RelationshipToParent.Child ||
    source.parentId == null || source.parentId == EMPTY_UID) {
    return { allowed: false, reason: "not-page-child" };
  }
  if (source.parentId == user.trashPageId || source.parentId == user.dockPageId ||
    source.parentId == user.queriesPageId) {
    return { allowed: false, reason: "special-page" };
  }
  const parent = itemState.get(source.parentId);
  if (parent != null) {
    if (!isPage(parent)) { return { allowed: false, reason: "not-page-child" }; }
    if (parent.clientOnly) { return { allowed: false, reason: "client-only" }; }
    if (parent.origin != null) { return { allowed: false, reason: "remote-item" }; }
    if (parent.ownerId != user.userId) { return { allowed: false, reason: "not-owned" }; }
    if (!itemCanEdit(parent)) { return { allowed: false, reason: "read-only" }; }
  }

  return {
    allowed: true,
    source,
    parent: parent == null ? null : asPageItem(parent),
    parentId: source.parentId,
    targetType: isPage(source) ? "table" : "page",
  };
}

/** Convert the original item, then reconcile its authoritative replacement into the current view. */
export async function convertPageTableAtPath(
  store: StoreContextModel,
  focusPath: VisualElementPath,
): Promise<PageTableConvertibleItem> {
  const eligibility = pageTableConversionEligibility(store, focusPath);
  if (!eligibility.allowed) {
    throw new Error(`Page/table conversion is unavailable: ${eligibility.reason}.`);
  }

  const { source, targetType } = eligibility;
  let parent = eligibility.parent;
  if (parent == null) {
    await initiateLoadItemMaybe(store, eligibility.parentId);
    const rechecked = pageTableConversionEligibility(store, focusPath);
    if (!rechecked.allowed || rechecked.parent == null) {
      throw new Error(`Cannot load an editable parent page for item '${source.id}'.`);
    }
    parent = rechecked.parent;
  }
  const convertedObject = await server.convertPageTable(
    source.id, isPage(source) ? "page" : "table", targetType, store.general.networkStatus,
  );
  const returned = convertedObject as { id?: unknown, itemType?: unknown, parentId?: unknown, ownerId?: unknown };
  if (returned.id != source.id || returned.itemType != targetType ||
    returned.parentId != parent.id || returned.ownerId != source.ownerId) {
    throw new Error(`Conversion of item '${source.id}' returned an unexpected item.`);
  }

  // A table item cannot remain the root of a page view or a page popup.
  if (store.history.currentPopupSpecVeid()?.itemId == source.id) {
    store.history.popAllPopups();
  }
  const converted = itemState.upsertItemFromServerObject(convertedObject, null);

  if (isPage(source) && store.history.currentPageVeid()?.itemId == source.id) {
    switchToPage(store, VeFns.veidFromId(parent.id), true, true, false);
    await initiateLoadChildItemsMaybe(store, VeFns.veidFromId(parent.id));
    const parentPath = store.history.currentPagePath();
    if (parentPath != null) {
      const convertedPath = VeFns.addVeidToPath(VeFns.veidFromId(converted.id), parentPath);
      if (VesCache.current.readNode(convertedPath) != null) {
        store.history.setFocus(convertedPath);
        requestArrange(store, "page-table-conversion-focus");
      }
    }
  } else {
    requestArrange(store, "page-table-conversion");
  }
  store.touchToolbar();

  return isPage(converted) ? asPageItem(converted) : asTableItem(converted);
}

/** Fields conversion must carry unchanged. Sizing and last-modified time are handled separately. */
export function pageTableConversionSharedState(source: PageTableConvertibleItem) {
  return {
    ownerId: source.ownerId,
    id: source.id,
    parentId: source.parentId,
    relationshipToParent: source.relationshipToParent,
    groupId: source.groupId,
    creationDate: source.creationDate,
    dateTime: source.dateTime,
    endDateTime: source.endDateTime,
    ordering: new Uint8Array(source.ordering),
    title: source.title,
    spatialPositionGr: { ...source.spatialPositionGr },
    orderChildrenBy: source.orderChildrenBy,
    tableColumns: source.tableColumns.map(column => ({ ...column })),
    numberOfVisibleColumns: source.numberOfVisibleColumns,
    computed_children: [...source.computed_children],
    computed_attachments: [...source.computed_attachments],
    childrenLoaded: source.childrenLoaded,
  };
}

/** Preserve unrelated flags in the destination while translating column-header visibility. */
export function pageTableConvertedHeaderFlags(source: PageTableConvertibleItem, destinationFlags: number): number {
  const sourceIsPage = isPage(source);
  const sourceHeaderFlag = sourceIsPage ? PageFlags.ShowTableColHeader : TableFlags.ShowColHeader;
  const destinationHeaderFlag = sourceIsPage ? TableFlags.ShowColHeader : PageFlags.ShowTableColHeader;
  return source.flags & sourceHeaderFlag
    ? destinationFlags | destinationHeaderFlag
    : destinationFlags & ~destinationHeaderFlag;
}

export function savedPageSettingsFromPage(page: PageItem): SavedPageSettings {
  return {
    spatialWidthGr: page.spatialWidthGr,
    flags: page.flags,
    permissionFlags: page.permissionFlags,
    naturalAspect: page.naturalAspect,
    backgroundColorIndex: page.backgroundColorIndex,
    innerSpatialWidthGr: page.innerSpatialWidthGr,
    listWidthGr: page.listWidthGr,
    defaultPopupPositionGr: { ...page.defaultPopupPositionGr },
    defaultPopupWidthGr: page.defaultPopupWidthGr,
    popupPositionGr: page.popupPositionGr && { ...page.popupPositionGr },
    popupWidthGr: page.popupWidthGr,
    defaultCellPopupPositionNorm: { ...page.defaultCellPopupPositionNorm },
    defaultCellPopupWidthNorm: page.defaultCellPopupWidthNorm,
    cellPopupPositionNorm: page.cellPopupPositionNorm && { ...page.cellPopupPositionNorm },
    cellPopupWidthNorm: page.cellPopupWidthNorm,
    gridNumberOfColumns: page.gridNumberOfColumns,
    gridCellAspect: page.gridCellAspect,
    docWidthBl: page.docWidthBl,
    justifiedRowAspect: page.justifiedRowAspect,
    calendarDayRowHeightBl: page.calendarDayRowHeightBl,
  };
}

export function savedTableSettingsFromTable(table: TableItem): SavedTableSettings {
  return {
    spatialWidthGr: table.spatialWidthGr,
    spatialHeightGr: table.spatialHeightGr,
    flags: table.flags,
  };
}

/** Fit configured columns where possible, without creating a table wider than the parent page. */
export function embeddedTableSizeFromPage(page: PageItem, parent: PageItem): { w: number; h: number } {
  if (page.savedTableSettings != null) {
    return {
      w: page.savedTableSettings.spatialWidthGr,
      h: page.savedTableSettings.spatialHeightGr,
    };
  }

  const visibleCount = Math.max(0, Math.min(page.numberOfVisibleColumns, page.tableColumns.length));
  const columnsWidthGr = page.tableColumns.slice(0, visibleCount)
    .reduce((width, column) => width + column.widthGr, 0);
  const minimumWidthGr = 8 * GRID_SIZE;
  return {
    w: Math.min(Math.max(minimumWidthGr, columnsWidthGr), Math.max(minimumWidthGr, parent.innerSpatialWidthGr)),
    h: 6 * GRID_SIZE,
  };
}

export function pageWidthFromTable(table: TableItem): number {
  return table.savedPageSettings?.spatialWidthGr ?? 4 * GRID_SIZE;
}
