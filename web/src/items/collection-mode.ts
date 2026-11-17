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

import { createSignal } from "solid-js";
import { requestArrange } from "../layout/arrange";
import type { CollectionSummary } from "../server";
import type { StoreContextModel } from "../store/StoreProvider";
import type { Uid } from "../util/uid";
import { queryCollections } from "./query-scope";

/**
 * Collection mode: the collection being curated, while the user moves about Infumap. It is application interaction
 * state, kept here rather than on a page or link, and is not persisted, so a reload leaves the mode.
 *
 * The summary is as it was when the mode was entered. The collection list is fetched again whenever a picker opens,
 * and `collectionModeSummary` prefers that newer entry.
 */
const [collectionModeEntry, setCollectionModeEntry] = createSignal<CollectionSummary | null>(null);

export function collectionModeCollectionId(): Uid | null {
  return collectionModeEntry()?.id ?? null;
}

export function collectionModeActive(): boolean {
  return collectionModeEntry() != null;
}

/** The collection being curated, as most recently listed. Null outside the mode. */
export function collectionModeSummary(): CollectionSummary | null {
  const entry = collectionModeEntry();
  if (entry == null) { return null; }
  return queryCollections()?.find(collection => collection.id == entry.id) ?? entry;
}

/** False once a fetched collection list no longer has it: deleted, trashed or made an ordinary page meanwhile. */
export function collectionModeCollectionListed(): boolean {
  const entry = collectionModeEntry();
  const list = queryCollections();
  return entry == null || list == null || list.some(collection => collection.id == entry.id);
}

/** Enters the mode for the collection, or switches to it. The user stays where they are. */
export function enterCollectionMode(store: StoreContextModel, collection: CollectionSummary): void {
  const wasActive = collectionModeActive();
  setCollectionModeEntry(collection);
  // The bar under the toolbar takes height from the desktop.
  if (!wasActive) { requestArrange(store, "collection-mode-enter"); }
}

export function exitCollectionMode(store: StoreContextModel): void {
  if (!collectionModeActive()) { return; }
  setCollectionModeEntry(null);
  requestArrange(store, "collection-mode-exit");
}

/** On logout or account change, without arranging: the store is being cleared. */
export function clearCollectionMode(): void {
  setCollectionModeEntry(null);
}
