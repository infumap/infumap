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

import { batch } from "solid-js";
import { ArrangeAlgorithm, PageFns } from "../../items/page-item";
import { mouseMove_handleNoButtonDown } from "../../input/mouse_move";
import { StoreContextModel } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { getPanickedMessage } from "../../util/lang";
import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElementFlags, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { renderDockMaybe } from "./dock";
import { ArrangeItemFlags, arrangeItem } from "./item";
import { ItemGeometry } from "../item-geometry";
import { NATURAL_BLOCK_SIZE_PX } from "../../constants";
import { asLinkItem } from "../../items/link-item";
import { createVisualElementSignal } from "../../util/signals";

let arrangeRequestPending = false;
let arrangeRequestGeneration = 0;
let pendingArrangeStore: StoreContextModel | null = null;
let pendingArrangeReason: string | null = null;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Coalesce multiple "please re-layout" requests into a single arrange at the
 * end of the current task. This keeps the explicit arrange model, but reduces
 * the number of places that need to eagerly force layout immediately.
 *
 * Callers that need geometry synchronously should continue using `arrangeNow`.
 */
export function requestArrange(store: StoreContextModel, reason: string): void {
  pendingArrangeStore = store;
  pendingArrangeReason = reason;
  if (arrangeRequestPending) { return; }

  arrangeRequestPending = true;
  const generation = ++arrangeRequestGeneration;
  queueMicrotask(() => {
    if (!arrangeRequestPending || generation !== arrangeRequestGeneration) { return; }

    const storeToArrange = pendingArrangeStore;
    const reasonToArrange = pendingArrangeReason;
    arrangeRequestPending = false;
    pendingArrangeStore = null;
    pendingArrangeReason = null;

    if (storeToArrange) {
      try {
        fullArrange(storeToArrange);
      } catch (e: any) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(`Deferred arrange failed (${reasonToArrange ?? "unspecified"}): ${message}`);
      }
    }
  });
}

/**
 * Preferred entry point for synchronous current-page arrange at call sites.
 * This preserves the existing behavior while making "needs fresh layout now"
 * explicit in the code that depends on it.
 */
export function arrangeNow(store: StoreContextModel, _reason: string): void {
  fullArrange(store);
}

/**
 * Preferred entry point for synchronous virtual arrange at call sites that need
 * parent-context navigation or other non-current-page layout snapshots.
 */
export function arrangeVirtual(store: StoreContextModel, virtualPageVeid: Veid, _reason: string): void {
  fullArrange(store, virtualPageVeid);
}

/**
 * Preferred entry point for "partial logic failed, fall back to a real full
 * arrange" recovery paths.
 */
export function recoverWithFullArrange(store: StoreContextModel, _reason: string): void {
  fullArrange(store);
}

/**
 * Create a visual element tree for the current page, or if virtualPageVeid is specified, that page instead. A
 * visual element tree for other than the current page is required for keyboard navigation where that requires
 * knowledge of the layout of the parent page.
 *
 * Design note: Initially, this was implemented such that the visual element state was a function of the item
 * state (arrange was never called imperatively). The arrange function in that implementation did produce (nested)
 * visual element signals though, which had dependencies on the relevant part of the item state. In that
 * implementation, all the items were solidjs signals (whereas in the current approach they are not). The functional
 * approach was simpler from the point of view that the visual element tree did not need to be explicitly updated /
 * managed. However, it turned out to be a dead end:
 * 1. The visual element tree state is required for mouse interaction as well as rendering, and it was messy to
 *    create a cached version of this as a side effect of the functional arrange method. And there were associated
 *    bugs, which were not trivial to track down.
 * 2. It was effectively impossible to perfectly optimize it in the case of resizing page items (and probably other
 *    scenarios) because the set of children were a function of page size. By comparison, as a general comment, the
 *    stateful approach makes it easy(er) to make precisely the optimal updates at precisely the required times.
 * 3. The functional representation was not straightforward (compared to the current approach) to reason about -
 *    you need to be very cognizant of functional dependencies, what is being captured etc. Even though the direct
 *    approach is more ad-hoc / less "automated", the code is simpler to work on due to this.
 *
 * @param virtualPageVeid the page to create the visual element tree for, if not the current page.
 */
export function fullArrange(store: StoreContextModel, virtualPageVeid?: Veid): void {
  if (store.history.currentPageVeid() == null) { return; }

  if (virtualPageVeid == null) {
    arrangeRequestPending = false;
    arrangeRequestGeneration += 1;
    pendingArrangeStore = null;
    pendingArrangeReason = null;
  }

  if (getPanickedMessage() != null) {
    store.overlay.isPanicked.set(true);
    return;
  }

  const totalStartMs = nowMs();
  let arrangeItemMs = 0;
  let finalizeMs = 0;
  VesCache.debug_beginFullArrange(virtualPageVeid != null);
  VesCache.full_initArrange();

  let currentPageVeid = virtualPageVeid ? virtualPageVeid : store.history.currentPageVeid()!;

  const currentPage = itemState.get(currentPageVeid.itemId)!;
  const actualLinkItemMaybe = currentPageVeid.linkIdMaybe
    ? asLinkItem(itemState.get(currentPageVeid.linkIdMaybe!)!)
    : null;
  const umbrellaPageItem = PageFns.umbrellaPage();
  const umbrellaPath = umbrellaPageItem.id;

  const umbrellaSpec: VisualElementSpec = {
    displayItem: umbrellaPageItem,
    linkItemMaybe: null,
    actualLinkItemMaybe: null,
    flags: VisualElementFlags.UmbrellaPage,
    boundsPx: store.desktopBoundsPx(),
    childAreaBoundsPx: store.desktopBoundsPx(),
    viewportBoundsPx: store.desktopBoundsPx(),
  };

  const umbrellaRelationships: VisualElementRelationships = {};

  const dockPathMaybe = renderDockMaybe(store, umbrellaPath);
  if (dockPathMaybe) {
    umbrellaRelationships.dockPath = dockPathMaybe;
  }
  const itemGeometry: ItemGeometry = {
    boundsPx: store.desktopMainAreaBoundsPx(),
    blockSizePx: NATURAL_BLOCK_SIZE_PX,
    viewportBoundsPx: store.desktopMainAreaBoundsPx(),
    hitboxes: []
  };

  const parentArrangeAlgorithm = ArrangeAlgorithm.None;
  const flags = ArrangeItemFlags.RenderChildrenAsFull | ArrangeItemFlags.IsTopRoot;

  // Use SolidJS batch() to defer all reactive signal updates during arrange.
  // Without batching, each signal.set() call triggers immediate reactivity,
  // causing ~2.5 second freezes when ~1000 items need position updates.
  const arrangeItemStartMs = nowMs();
  batch(() => {
    arrangeItem(
      store, umbrellaPath, parentArrangeAlgorithm,
      actualLinkItemMaybe ? actualLinkItemMaybe : currentPage,
      actualLinkItemMaybe, itemGeometry, flags);
  });
  arrangeItemMs = nowMs() - arrangeItemStartMs;

  umbrellaRelationships.childrenPaths = [VeFns.addVeidToPath(currentPageVeid, umbrellaPath)];

  if (virtualPageVeid) {
    const finalizeStartMs = nowMs();
    const umbrellaVes = createVisualElementSignal(VeFns.create(umbrellaSpec));
    VesCache.full_finalizeArrange(store, umbrellaSpec, umbrellaRelationships, umbrellaPath, umbrellaVes);
    finalizeMs = nowMs() - finalizeStartMs;
  } else {
    const finalizeStartMs = nowMs();
    VesCache.full_finalizeArrange(store, umbrellaSpec, umbrellaRelationships, umbrellaPath);
    finalizeMs = nowMs() - finalizeStartMs;
    VesCache.addWatchContainerUid(currentPage.id, currentPage.origin);
  }

  const hasUser = store.user.getUserMaybe() != null;
  mouseMove_handleNoButtonDown(store, hasUser);
  VesCache.debug_completeFullArrange({
    totalMs: nowMs() - totalStartMs,
    arrangeItemMs,
    finalizeMs,
  });
}
