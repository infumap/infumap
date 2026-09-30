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

import { LINK_TRIANGLE_SIZE_PX } from "../constants";
import type { LinkItem } from "../items/link-item";
import { isQuerySearchResultLink } from "../items/search-item";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "./arrange/page_list";
import { Hitbox, HitboxFlags, HitboxFns } from "./hitbox";
import { ItemGeometry } from "./item-geometry";


/**
 * Whether an item rendered via the given link shows the link triangle (which opens the link item when clicked).
 * Synthetic links (the list page main item link, search result links) are not user items, so do not.
 */
export function linkHasTriangle(linkItemMaybe: LinkItem | null): linkItemMaybe is LinkItem {
  return linkItemMaybe != null &&
    linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM &&
    !isQuerySearchResultLink(linkItemMaybe);
}

export function linkTriangleHitbox(): Hitbox {
  return HitboxFns.create(HitboxFlags.TriangleLinkSettings, {
    x: 0, y: 0, w: LINK_TRIANGLE_SIZE_PX + 2, h: LINK_TRIANGLE_SIZE_PX + 2,
  });
}

export function addLinkTriangleHitboxMaybe(geometry: ItemGeometry, linkItemMaybe: LinkItem | null): void {
  if (!linkHasTriangle(linkItemMaybe)) { return; }
  geometry.hitboxes.push(linkTriangleHitbox());
}
