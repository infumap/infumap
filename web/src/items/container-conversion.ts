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
import { requestArrange } from "../layout/arrange";
import { initiateLoadChildItemsMaybe } from "../layout/load";
import { switchToPage } from "../layout/navigation";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { EMPTY_UID, SOLO_ITEM_HOLDER_PAGE_UID, UMBRELLA_PAGE_UID, Uid } from "../util/uid";
import { Item } from "./base/item";
import { itemCanEdit } from "./base/capabilities-item";
import { PageItem, asPageItem, isPage } from "./page-item";

/** Reasons any conversion of an item between container types is unavailable. */
export type ContainerConversionRejection =
  | "missing-view"
  | "linked-view"
  | "wrong-item-type"
  | "client-only"
  | "remote-item"
  | "read-only"
  | "not-owned"
  | "special-page"
  | "not-page-child";

/** A conversion refused because of the item's content. The message is for the user. */
export class ContainerConversionRefused extends Error { }

export type ContainerConversionSource =
  // Direct links can load the source before its parent; the action resolves the parent before mutating.
  | { allowed: true; source: Item; parent: PageItem | null; parentId: Uid }
  | { allowed: false; reason: ContainerConversionRejection };

/**
 * The original item displayed at focusPath, if it is of a convertible type and an owned, editable child of an owned,
 * editable page. Type-specific conditions are left to the caller.
 */
export function containerConversionSource(
  store: StoreContextModel,
  focusPath: VisualElementPath | null,
  isConvertibleType: (item: Item) => boolean,
): ContainerConversionSource {
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
    // List detail panes and popups use synthetic layout links. Only an actual
    // user link on the item or an ancestor makes this a linked view.
    if (ve.actualLinkItemMaybe != null) {
      return { allowed: false, reason: "linked-view" };
    }
    path = VeFns.parentPath(path);
  }

  const source = focusedVe.displayItem;
  if (!isConvertibleType(source)) {
    return { allowed: false, reason: "wrong-item-type" };
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

  return { allowed: true, source, parent: parent == null ? null : asPageItem(parent), parentId: source.parentId };
}

/** Check the server's converted item is the source with its new type, in the same place. */
export function validateConvertedObject(source: Item, parent: PageItem, targetType: string, convertedObject: object): void {
  const returned = convertedObject as { id?: unknown, itemType?: unknown, parentId?: unknown, ownerId?: unknown };
  if (returned.id != source.id || returned.itemType != targetType ||
    returned.parentId != parent.id || returned.ownerId != source.ownerId) {
    throw new Error(`Conversion of item '${source.id}' returned an unexpected item.`);
  }
}

/** Reconcile the authoritative converted item into the current view. */
export async function applyConvertedItem(
  store: StoreContextModel,
  source: Item,
  parent: PageItem,
  convertedObject: object,
): Promise<Item> {
  // Only a page can be the root of a page view or a page popup.
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
        requestArrange(store, "container-conversion-focus");
      }
    }
  } else {
    requestArrange(store, "container-conversion");
  }
  store.touchToolbar();

  return converted;
}
