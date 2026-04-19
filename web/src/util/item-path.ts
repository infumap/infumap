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

import { Item, ItemType } from "../items/base/item";
import { LinkFns, asLinkItem, isLink } from "../items/link-item";
import { itemState } from "../store/ItemState";
import { EMPTY_UID, Uid } from "./uid";

export interface ItemPathSegment {
  id: Uid,
  itemType: string,
  title: string,
}


function fallbackTitleForItem(item: Item): string {
  switch (item.itemType) {
    case ItemType.Page: return "[page]";
    case ItemType.Table: return "[table]";
    case ItemType.Composite: return "[composite]";
    case ItemType.Note: return "[note]";
    case ItemType.File: return "[file]";
    case ItemType.Password: return "[password]";
    case ItemType.Image: return "[image]";
    case ItemType.Rating: return "[rating]";
    case ItemType.Link: return "[link]";
    case ItemType.Search: return "[search]";
    default: return `[${item.itemType}]`;
  }
}

export function pathTitleForItem(item: Item): string {
  const titleMaybe = (item as any).title;
  if (typeof titleMaybe == "string" && titleMaybe.trim() != "") {
    return titleMaybe;
  }
  return fallbackTitleForItem(item);
}

export function resolvedPathTargetIdForItem(item: Item): Uid {
  if (!isLink(item)) {
    return item.id;
  }
  const linkToId = LinkFns.getLinkToId(asLinkItem(item));
  if (linkToId == "" || linkToId == EMPTY_UID) {
    return item.id;
  }
  return linkToId;
}

export function resolvedPathTargetItemForItem(item: Item): Item | null {
  const resolvedId = resolvedPathTargetIdForItem(item);
  return itemState.get(resolvedId) ?? item;
}

export function itemPathSegmentsFromId(itemId: Uid): Array<ItemPathSegment> {
  if (itemId == "" || itemId == EMPTY_UID) {
    return [];
  }

  const segments: Array<ItemPathSegment> = [];
  const seen = new Set<Uid>();
  let currentId: Uid | null = itemId;

  while (currentId != null && currentId != "" && currentId != EMPTY_UID && !seen.has(currentId)) {
    seen.add(currentId);
    const current = itemState.get(currentId);
    if (current == null) {
      break;
    }
    segments.unshift({
      id: current.id,
      itemType: current.itemType,
      title: pathTitleForItem(current),
    });
    if (!current.parentId || current.parentId == current.id) {
      break;
    }
    currentId = current.parentId;
  }

  return segments;
}

export function itemPathSegmentsFromItem(item: Item): Array<ItemPathSegment> {
  if (isLink(item)) {
    const catalogPathOverride = asLinkItem(item).catalogPathOverride;
    if (catalogPathOverride && catalogPathOverride.length > 0) {
      return catalogPathOverride;
    }
  }
  return itemPathSegmentsFromId(resolvedPathTargetIdForItem(item));
}

export function itemPathTextFromItem(item: Item): string {
  return itemPathSegmentsFromItem(item).map(segment => segment.title).join(" / ");
}
