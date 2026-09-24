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
import { VeFns, VisualElementPath } from "../layout/visual-element";
import { VesCache } from "../layout/ves-cache";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { EMPTY_UID, SOLO_ITEM_HOLDER_PAGE_UID, UMBRELLA_PAGE_UID } from "../util/uid";
import { itemCanEdit } from "./base/capabilities-item";
import { PageFlags, TableFlags } from "./base/flags-item";
import { PermissionFlags } from "./base/permission-flags-item";
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
  | "public-page"
  | "not-page-child";

export type PageTableConversionEligibility =
  | { allowed: true; source: PageTableConvertibleItem; parent: PageItem; targetType: "page" | "table" }
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
    // A table item cannot carry a page's independent public-access permission.
    if (asPageItem(source).permissionFlags & PermissionFlags.Public) {
      return { allowed: false, reason: "public-page" };
    }
  }

  if (source.relationshipToParent != RelationshipToParent.Child ||
    source.parentId == null || source.parentId == EMPTY_UID) {
    return { allowed: false, reason: "not-page-child" };
  }
  const parent = itemState.get(source.parentId);
  if (parent == null || !isPage(parent)) {
    return { allowed: false, reason: "not-page-child" };
  }
  if (parent.id == user.trashPageId || parent.id == user.dockPageId || parent.id == user.queriesPageId) {
    return { allowed: false, reason: "special-page" };
  }
  if (parent.clientOnly) { return { allowed: false, reason: "client-only" }; }
  if (parent.origin != null) { return { allowed: false, reason: "remote-item" }; }
  if (parent.ownerId != user.userId) { return { allowed: false, reason: "not-owned" }; }
  if (!itemCanEdit(parent)) { return { allowed: false, reason: "read-only" }; }

  return {
    allowed: true,
    source,
    parent: asPageItem(parent),
    targetType: isPage(source) ? "table" : "page",
  };
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
