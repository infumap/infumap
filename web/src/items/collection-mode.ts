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
import { CollectionAddResponse, CollectionRemoveResponse, CollectionSummary, server } from "../server";
import type { StoreContextModel } from "../store/StoreProvider";
import type { Uid } from "../util/uid";
import { refreshCollectionMarks, resetCollectionMarks } from "./collection-marks";
import { queryCollections, refreshQueryCollections } from "./query-scope";

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

/**
 * The collection being curated, its title and path as most recently listed. The member count is the mode's own, which
 * each Add and Remove updates from the server's answer; the list is only fetched again when a picker opens.
 */
export function collectionModeSummary(): CollectionSummary | null {
  const entry = collectionModeEntry();
  if (entry == null) { return null; }
  const listed = queryCollections()?.find(collection => collection.id == entry.id) ?? entry;
  return { ...listed, memberCount: entry.memberCount };
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
  if (collection.id != collectionModeCollectionId()) {
    resetCollectionMarks(collection.id);
    setNotice(null);
    setFailure(null);
  }
  setCollectionModeEntry(collection);
  // The bar under the toolbar takes height from the desktop.
  if (!wasActive) { requestArrange(store, "collection-mode-enter"); }
}

export function exitCollectionMode(store: StoreContextModel): void {
  if (!collectionModeActive()) { return; }
  clearChangeState();
  setCollectionModeEntry(null);
  resetCollectionMarks(null);
  requestArrange(store, "collection-mode-exit");
}

/** On logout or account change, without arranging: the store is being cleared. */
export function clearCollectionMode(): void {
  clearChangeState();
  setCollectionModeEntry(null);
  resetCollectionMarks(null);
}


// ---- Adding and removing ----
//
// Each Add or Remove saves at once. Marks change only when the server's answer arrives (they are fetched again then),
// so a change is never shown as saved before it is, and a failed one leaves nothing to revert. Saves run in order
// through the command queue; switching collection lets outstanding ones finish.

/** Saves in flight, for "Saving…". */
const [savingCount, setSavingCount] = createSignal(0);
/** The last result worth saying, such as what was skipped and why. Replaced by the next. */
const [notice, setNotice] = createSignal<string | null>(null);
/** A failed save, with the means to try it again. */
const [failure, setFailure] = createSignal<{ message: string, retry: () => void } | null>(null);

export function collectionModeSaving(): boolean { return savingCount() > 0; }
export function collectionModeNotice(): string | null { return notice(); }
export function collectionModeFailure(): { message: string, retry: () => void } | null { return failure(); }

function clearChangeState(): void {
  setNotice(null);
  setFailure(null);
}

function itemsLabel(count: number): string {
  return `${count} item${count == 1 ? "" : "s"}`;
}

function quoted(title: string | null): string {
  return title == null || title.trim() == "" ? "An item" : `\u201c${title.trim()}\u201d`;
}

async function save<T>(
  store: StoreContextModel,
  collectionId: Uid,
  failureText: string,
  request: () => Promise<T>,
  done: (response: T) => string | null,
): Promise<void> {
  setNotice(null);
  setFailure(null);
  setSavingCount(savingCount() + 1);
  try {
    const response = await request();
    // A switch to another collection meanwhile keeps the save, but its result is about the earlier one.
    if (collectionModeCollectionId() != collectionId) { return; }
    setNotice(done(response));
    refreshCollectionMarks(0);
  } catch (e) {
    console.error(`${failureText}:`, e);
    if (collectionModeCollectionId() != collectionId) { return; }
    // The server's reason does not reach the client. The commonest one, a collection deleted or unflagged meanwhile,
    // shows in the bar once the list is fetched again.
    void refreshQueryCollections(store);
    setFailure({
      message: `${failureText}.`,
      retry: () => { void save(store, collectionId, failureText, request, done); },
    });
  } finally {
    setSavingCount(savingCount() - 1);
  }
}

function setMemberCount(collectionId: Uid, memberCount: number): void {
  const entry = collectionModeEntry();
  if (entry != null && entry.id == collectionId) { setCollectionModeEntry({ ...entry, memberCount }); }
}

/** Makes each item a direct member, a link as its target. The selection is left as it is. */
export function addToCollection(store: StoreContextModel, itemIds: Array<Uid>): void {
  const collectionId = collectionModeCollectionId();
  if (collectionId == null || itemIds.length == 0) { return; }
  void save(store, collectionId, `Could not add ${itemsLabel(itemIds.length)}`,
    () => server.collectionAdd(collectionId, itemIds),
    (response: CollectionAddResponse) => {
      setMemberCount(collectionId, response.memberCount);
      const parts: Array<string> = [];
      if (response.added.length > 0) { parts.push(`Added ${itemsLabel(response.added.length)}.`); }
      if (response.alreadyMembers.length > 0) {
        parts.push(`${response.alreadyMembers.length} ${response.alreadyMembers.length == 1 ? "was" : "were"} already a member.`);
      }
      if (response.skipped.length == 1) {
        parts.push(`${quoted(response.skipped[0].title)} was skipped: ${response.skipped[0].reason}`);
      } else if (response.skipped.length > 1) {
        parts.push(`${response.skipped.length} were skipped: ` +
          response.skipped.map(skip => `${quoted(skip.title)}: ${skip.reason}`).join(" "));
      }
      return parts.length == 0 ? null : parts.join(" ");
    });
}

/** Removes each item that is a direct member. Items covered only through a member above them stay covered. */
export function removeFromCollection(store: StoreContextModel, itemIds: Array<Uid>): void {
  const collectionId = collectionModeCollectionId();
  if (collectionId == null || itemIds.length == 0) { return; }
  void save(store, collectionId, `Could not remove ${itemsLabel(itemIds.length)}`,
    () => server.collectionRemove(collectionId, itemIds),
    (response: CollectionRemoveResponse) => {
      setMemberCount(collectionId, response.memberCount);
      const parts: Array<string> = [];
      if (response.removed.length > 0) { parts.push(`Removed ${itemsLabel(response.removed.length)}.`); }
      const vias = [...new Set(response.inherited.map(item => item.viaTitle ?? "an untitled page"))];
      if (response.inherited.length > 0) {
        const count = response.inherited.length;
        const subject = `${count} ${count == 1 ? "is" : "are"} still included`;
        parts.push(vias.length == 1 ? `${subject} via ${vias[0]}.` : `${subject} through other members.`);
      }
      return parts.length == 0 ? null : parts.join(" ");
    });
}
