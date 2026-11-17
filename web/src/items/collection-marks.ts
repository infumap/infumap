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
import { ItemCoverage, onItemsChanged, server } from "../server";
import { Uid, isUid } from "../util/uid";

/**
 * Collection-mode marks: how the collection being curated covers each rendered item. Each rendered item asks for its
 * own mark while it is shown (`retainCollectionMark`); requests are batched, and the server works coverage out from
 * live data, so the client needs none of an item's ancestors loaded. Keyed by the displayed item, which for a link is
 * its target, so every appearance of an item is marked alike.
 */

/** The server limit on one request. */
const MAX_IDS_PER_REQUEST = 2000;
/** Batches the items an arrange renders into one request. */
const FETCH_DELAY_MS = 30;
/** Lets a burst of writes or sync changes settle before checking again. */
const REFRESH_DELAY_MS = 400;

/** Null means checked and not covered. Absent means not checked yet. */
const [marks, setMarks] = createSignal<ReadonlyMap<Uid, ItemCoverage | null>>(new Map());
let collectionId: Uid | null = null;
/** Rendered items wanting a mark, with how many of their appearances are shown. */
const retained = new Map<Uid, number>();
let generation = 0;
let fetchTimer: ReturnType<typeof setTimeout> | null = null;
let refreshAll = false;

/** The mark for an item, null if it is not covered, undefined while not known. */
export function collectionMark(itemId: Uid): ItemCoverage | null | undefined {
  return marks().get(itemId);
}

/** Called while an item is shown in collection mode. Returns the release for when it stops being shown. */
export function retainCollectionMark(itemId: Uid): () => void {
  if (!isUid(itemId)) { return () => { }; }
  retained.set(itemId, (retained.get(itemId) ?? 0) + 1);
  if (!marks().has(itemId)) { scheduleFetch(FETCH_DELAY_MS); }
  return () => {
    const count = (retained.get(itemId) ?? 1) - 1;
    if (count <= 0) { retained.delete(itemId); }
    else { retained.set(itemId, count); }
  };
}

/** Starts over for another collection, or none. Rendered items keep their requests. */
export function resetCollectionMarks(id: Uid | null): void {
  if (id != null && !listeningForChanges) {
    listeningForChanges = true;
    onItemsChanged(() => refreshCollectionMarks());
  }
  collectionId = id;
  generation++;
  refreshAll = false;
  setMarks(new Map());
  if (id != null && retained.size > 0) { scheduleFetch(FETCH_DELAY_MS); }
}

/**
 * Checks every shown item again, keeping the current marks until the answer arrives so nothing flickers. Membership
 * and where items are can both change: a member added or removed, an item moved into or out of a covered page.
 */
export function refreshCollectionMarks(delayMs: number = REFRESH_DELAY_MS): void {
  if (collectionId == null) { return; }
  refreshAll = true;
  scheduleFetch(delayMs);
}

// Registered on first use: at module load, server.ts may not have finished initialising (circular imports).
let listeningForChanges = false;

function scheduleFetch(delayMs: number): void {
  if (collectionId == null) { return; }
  if (fetchTimer != null) { clearTimeout(fetchTimer); }
  fetchTimer = setTimeout(() => { fetchTimer = null; void fetchMarks(); }, delayMs);
}

async function fetchMarks(): Promise<void> {
  const id = collectionId;
  if (id == null) { return; }
  const requestGeneration = generation;
  const known = marks();
  const wanted = [...retained.keys()].filter(itemId => refreshAll || !known.has(itemId));
  refreshAll = false;
  for (let start = 0; start < wanted.length; start += MAX_IDS_PER_REQUEST) {
    const chunk = wanted.slice(start, start + MAX_IDS_PER_REQUEST);
    let response;
    try {
      response = await server.collectionCoverage(id, chunk);
    } catch (e) {
      // Shown in the network status. Items stay unmarked rather than shown as uncovered, and are asked about again
      // on the next change.
      console.error("Could not check collection coverage:", e);
      return;
    }
    if (requestGeneration != generation) { return; }
    const next = new Map(marks());
    for (const itemId of chunk) { next.set(itemId, response.items[itemId] ?? null); }
    setMarks(next);
  }
}
