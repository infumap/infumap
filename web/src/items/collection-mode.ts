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
import { CollectionAddResponse, CollectionRemoveResponse, CollectionSummary, ItemCoverage, server } from "../server";
import { itemState } from "../store/ItemState";
import type { StoreContextModel } from "../store/StoreProvider";
import { TransientMessageType } from "../store/StoreProvider_Overlay";
import type { Uid } from "../util/uid";
import { collectionMark, resetCollectionMarks, settleCollectionMarks, showUnsavedCollectionMarks } from "./collection-marks";
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
export function enterCollectionMode(collection: CollectionSummary): void {
  if (collection.id != collectionModeCollectionId()) { resetCollectionMarks(collection.id); }
  setCollectionModeEntry(collection);
}

export function exitCollectionMode(): void {
  if (!collectionModeActive()) { return; }
  setCollectionModeEntry(null);
  resetCollectionMarks(null);
}

/** On logout or account change. */
export function clearCollectionMode(): void {
  exitCollectionMode();
}


// ---- Adding and removing ----
//
// In the mode, the selection gestures change membership instead of selecting (see applyCollectionClick and the
// marquee's mouse up): having to select, then press Add or Remove, made curating twice the work. Each change saves at
// once. Marks change at the click and go back if the save fails. There is no Undo: a click is undone by clicking
// again, and a sweep by sweeping again.

export type MembershipChange = "add" | "remove";

/** The server limit on one add or remove. */
const MAX_IDS_PER_CHANGE = 1000;

/**
 * Says something the marks can't, in the toolbar's passing message: what was skipped and why, an item still included
 * through a member above it, a failed save. The marks themselves show what was added or removed. A failed save puts
 * its marks back, so clicking again is the retry.
 */
function say(store: StoreContextModel, text: string, type: TransientMessageType = TransientMessageType.Info): void {
  const message = { text, type };
  store.overlay.toolbarTransientMessage.set(message);
  // By identity, so the timer of an earlier message doesn't cut a later one short.
  setTimeout(() => {
    if (store.overlay.toolbarTransientMessage.get() === message) { store.overlay.toolbarTransientMessage.set(null); }
  }, type == TransientMessageType.Error ? 6000 : 4000);
}

function itemsLabel(count: number): string {
  return `${count} item${count == 1 ? "" : "s"}`;
}

function quoted(title: string | null): string {
  return title == null || title.trim() == "" ? "An item" : `\u201c${title.trim()}\u201d`;
}

/** What a notice calls the items a change was made to: one by its title, more by their number. */
function itemsDescription(itemIds: Array<Uid>): string {
  if (itemIds.length != 1) { return itemsLabel(itemIds.length); }
  // A composite or other untitled item has only a stand-in such as "[composite]", which reads oddly in quotes.
  const title = (itemState.get(itemIds[0]) as { title?: unknown } | undefined)?.title;
  return typeof title == "string" && title.trim() != "" ? quoted(title) : "1 item";
}

/** Flips the item's own membership: a direct member is removed, anything else becomes one. Returns the change. */
export function toggleCollectionMember(store: StoreContextModel, itemId: Uid): MembershipChange {
  const change: MembershipChange = collectionMark(itemId)?.kind == "direct" ? "remove" : "add";
  changeCollectionMembers(store, change, [itemId]);
  return change;
}

/**
 * For a sweep over many items: adds them, unless every one is a direct member already, when it removes them. So a
 * second sweep over the same items undoes the first.
 */
export function sweepCollectionMembers(store: StoreContextModel, itemIds: Array<Uid>): void {
  const unique = [...new Set(itemIds)];
  if (unique.length == 0) { return; }
  const allMembers = unique.every(id => collectionMark(id)?.kind == "direct");
  changeCollectionMembers(store, allMembers ? "remove" : "add", unique);
}

/** Makes each item a direct member, or stops it being one. Items already as the change would leave them are skipped. */
export function changeCollectionMembers(store: StoreContextModel, change: MembershipChange, itemIds: Array<Uid>): void {
  const collectionId = collectionModeCollectionId();
  if (collectionId == null) { return; }
  if (!collectionModeCollectionListed()) {
    say(store, "Nothing was changed: it is no longer a collection.", TransientMessageType.Error);
    return;
  }
  const ids = [...new Set(itemIds)].filter(id => (collectionMark(id)?.kind == "direct") == (change == "remove"));
  if (ids.length == 0) {
    if (itemIds.length > 1) { say(store, change == "add" ? "All of them are members already." : "None of them are members."); }
    return;
  }
  if (ids.length > MAX_IDS_PER_CHANGE) {
    say(store, `Nothing was changed: at most ${MAX_IDS_PER_CHANGE} items can be changed at once.`, TransientMessageType.Error);
    return;
  }
  if (change == "add") {
    void save(store, collectionId, `Could not add ${itemsDescription(ids)}`,
      () => showUnsavedCollectionMarks(ids, { kind: "direct" }),
      () => server.collectionAdd(collectionId, ids),
      (response: CollectionAddResponse, seq) => {
        setMemberCount(collectionId, response.memberCount);
        const saved = new Map<Uid, ItemCoverage | null>();
        for (const id of [...response.added, ...response.alreadyMembers]) { saved.set(id, { kind: "direct" }); }
        settleCollectionMarks(seq, saved);
        if (response.skipped.length == 1) {
          say(store, `${quoted(response.skipped[0].title)} was not added: ${response.skipped[0].reason}`);
        } else if (response.skipped.length > 1) {
          say(store, `${response.skipped.length} were not added. ` +
            response.skipped.map(skip => `${quoted(skip.title)}: ${skip.reason}`).join(" "));
        }
      });
  } else {
    void save(store, collectionId, `Could not remove ${itemsDescription(ids)}`,
      () => showUnsavedCollectionMarks(ids, null),
      () => server.collectionRemove(collectionId, ids),
      (response: CollectionRemoveResponse, seq) => {
        setMemberCount(collectionId, response.memberCount);
        // A removed item can still be included through a member above it. The check after this finds that.
        const saved = new Map<Uid, ItemCoverage | null>();
        for (const id of [...response.removed, ...response.notMembers]) { saved.set(id, null); }
        for (const item of response.inherited) {
          saved.set(item.itemId, { kind: "inherited", viaId: item.viaId, viaTitle: item.viaTitle });
        }
        settleCollectionMarks(seq, saved);
        // Only after removing a direct member: one that never was is shown as included, and says so by its mark.
        if (response.inherited.length > 0 && response.removed.length > 0) {
          const count = response.inherited.length;
          const vias = [...new Set(response.inherited.map(item => item.viaTitle ?? "an untitled page"))];
          const subject = count == 1 ? `${itemsDescription(response.inherited.map(item => item.itemId))} is` : `${count} are`;
          say(store, vias.length == 1 ? `${subject} still included via ${vias[0]}.` : `${subject} still included through other members.`);
        }
      });
  }
}

async function save<T>(
  store: StoreContextModel,
  collectionId: Uid,
  failureText: string,
  showUnsaved: () => number,
  request: () => Promise<T>,
  done: (response: T, seq: number) => void,
): Promise<void> {
  const seq = showUnsaved();
  try {
    const response = await request();
    // A switch to another collection meanwhile keeps the save, but its result is about the earlier one, and the
    // switch dropped the unsaved marks.
    if (collectionModeCollectionId() != collectionId) { return; }
    done(response, seq);
  } catch (e) {
    console.error(`${failureText}:`, e);
    if (collectionModeCollectionId() != collectionId) { return; }
    settleCollectionMarks(seq, null);
    // The server's reason does not reach the client. The commonest one, a collection deleted or unflagged meanwhile,
    // shows on the toolbar button once the list is fetched again.
    void refreshQueryCollections(store);
    say(store, `${failureText}. Try again.`, TransientMessageType.Error);
  }
}

function setMemberCount(collectionId: Uid, memberCount: number): void {
  const entry = collectionModeEntry();
  if (entry != null && entry.id == collectionId) { setCollectionModeEntry({ ...entry, memberCount }); }
}
