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

import { requestArrange } from "../layout/arrange";
import { VisualElementPath } from "../layout/visual-element";
import { VesCache } from "../layout/ves-cache";
import { serverOrRemote } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { SOLO_ITEM_HOLDER_PAGE_UID, UMBRELLA_PAGE_UID } from "../util/uid";
import { itemCanEdit } from "./base/capabilities-item";
import { Item } from "./base/item";
import { PageFlags } from "./base/flags-item";
import { PageItem, asPageItem, isPage } from "./page-item";


/**
 * A collection is a page with the Collection flag: its direct link children are its members. The flag, not the
 * title or location, identifies it.
 */
export function isCollectionPage(item: Item | null | undefined): boolean {
  return item != null && isPage(item) && (asPageItem(item).flags & PageFlags.Collection) != 0;
}

/**
 * The page at the focus path whose Collection flag the user may set or clear, or null.
 *
 * Unlike the page/table and page/composite conversions, embedded pages and pages shown through a link qualify:
 * the flag changes how the page's own children are read, not the item's type or where it sits. A link's target is
 * the page that changes, as with any other page property set through a link.
 */
export function collectionTogglePageMaybe(store: StoreContextModel, focusPath: VisualElementPath | null): PageItem | null {
  if (focusPath == null) { return null; }
  const page = VesCache.current.readNode(focusPath)?.displayItem;
  if (page == null || !isPage(page)) { return null; }
  // Collections are resolved by the user's own server, so a page from another host or one made for display only
  // cannot be one.
  if (page.clientOnly || page.origin != null) { return null; }
  const user = store.user.getUserMaybe();
  if (user == null || page.ownerId != user.userId || !itemCanEdit(page)) { return null; }
  // System pages. Making Home a collection would turn its links into members of a scope; the others hold
  // nothing a collection is for.
  if (page.id == user.homePageId || page.id == user.trashPageId || page.id == user.dockPageId ||
    page.id == user.queriesPageId || page.id == user.promptsPageId ||
    page.id == user.searchAttentionPageId || page.id == user.searchProcessingPageId ||
    page.id == UMBRELLA_PAGE_UID || page.id == SOLO_ITEM_HOLDER_PAGE_UID) {
    return null;
  }
  return asPageItem(page);
}

export function collectionToggleLabel(page: PageItem): string {
  return isCollectionPage(page) ? "Make ordinary page" : "Make collection";
}

/** Sets or clears the Collection flag. Existing link children become, or stop being, members as they are. */
export function toggleCollectionFlag(store: StoreContextModel, page: PageItem): void {
  page.flags ^= PageFlags.Collection;
  requestArrange(store, "toolbar-page-collection-flag");
  serverOrRemote.updateItem(page);
  store.touchToolbar();
}
