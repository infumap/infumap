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

import { RelationshipToParent } from '../../layout/relationship-to-parent';
import { EMPTY_UID, Uid, newUid } from '../../util/uid';


export const ItemType = {
  Empty: "empty",
  Page: "page",
  Table: "table",
  Composite: "composite",
  Note: "note",
  File: "file",
  Text: "text",
  Password: "password",
  Image: "image",
  Rating: "rating",
  Link: "link",
  Query: "query",
  Search: "query",
  Divider: "divider",
  Placeholder: "placeholder",
};

export const LEGACY_SEARCH_ITEM_TYPE = "search";

export type ItemType = typeof ItemType[keyof typeof ItemType];

export const ITEM_CAPABILITY_KEYS = ["edit", "move", "copy", "resize"] as const;

export type ItemCapability = typeof ITEM_CAPABILITY_KEYS[number];

/**
 * Response-only metadata describing what the current caller may do with an item.
 * This must not be sent back in mutation payloads.
 */
export type ItemCapabilities = Partial<Record<ItemCapability, boolean>>;

export const ClientOnlyItemKind = {
  QueryChatPage: "query-chat-page",
  QuerySearchResultsPage: "query-search-results-page",
  QuerySearchResultLink: "query-search-result-link",
} as const;

export type ClientOnlyItemKind = typeof ClientOnlyItemKind[keyof typeof ClientOnlyItemKind];


export interface ItemTypeMixin {
  itemType: string,
}

export interface Measurable extends ItemTypeMixin { }

export interface Item extends ItemTypeMixin {
  origin: string | null,
  clientOnly?: boolean,
  clientOnlyKind?: ClientOnlyItemKind,
  capabilities?: ItemCapabilities | null,
  ownerId: Uid,
  id: Uid,
  parentId: Uid,
  relationshipToParent: string,
  groupId: Uid | null,
  creationDate: number,
  lastModifiedDate: number,
  dateTime: number,
  ordering: Uint8Array,
}

export const EMPTY_ITEM = () => ({
  origin: null,
  capabilities: null,
  itemType: ItemType.Empty,
  ownerId: EMPTY_UID,
  id: EMPTY_UID,
  parentId: EMPTY_UID,
  relationshipToParent: RelationshipToParent.Child,
  groupId: null,
  creationDate: 0,
  lastModifiedDate: 0,
  dateTime: 0,
  ordering: Uint8Array.from([]),
});

export const uniqueEmptyItem = () => ({
  origin: null,
  capabilities: null,
  itemType: ItemType.Empty,
  ownerId: EMPTY_UID,
  id: newUid(),
  parentId: EMPTY_UID,
  relationshipToParent: RelationshipToParent.Child,
  groupId: null,
  creationDate: 0,
  lastModifiedDate: 0,
  dateTime: 0,
  ordering: Uint8Array.from([]),
});

export function isEmptyItem(item: ItemTypeMixin | null): boolean {
  if (item == null) { return true; }
  return item.itemType == ItemType.Empty;
}
