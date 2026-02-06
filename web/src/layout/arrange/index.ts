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
import { evaluateExpressions } from "../../expression/evaluate";
import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElementFlags, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { renderDockMaybe } from "./dock";
import { ArrangeItemFlags, arrangeItem } from "./item";
import { ItemGeometry } from "../item-geometry";
import { NATURAL_BLOCK_SIZE_PX } from "../../constants";
import { asLinkItem } from "../../items/link-item";
import { createVisualElementSignal } from "../../util/signals";

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
  // console.time("fullArrange-total");

  if (store.history.currentPageVeid() == null) { return; }

  if (getPanickedMessage() != null) {
    store.overlay.isPanicked.set(true);
    return;
  }

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

  const dockVesMaybe = renderDockMaybe(store, umbrellaPath);
  if (dockVesMaybe) {
    umbrellaRelationships.dockVes = dockVesMaybe;
  }

  const childrenVes = [];
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
  // console.time("fullArrange-arrangeItem");
  let pageVes: ReturnType<typeof arrangeItem>;
  batch(() => {
    pageVes = arrangeItem(
      store, umbrellaPath, parentArrangeAlgorithm,
      actualLinkItemMaybe ? actualLinkItemMaybe : currentPage,
      actualLinkItemMaybe, itemGeometry, flags);
  });
  // console.timeEnd("fullArrange-arrangeItem");

  childrenVes.push(pageVes!);
  umbrellaRelationships.childrenVes = childrenVes;

  if (virtualPageVeid) {
    const umbrellaVeSpec = { ...umbrellaSpec, ...umbrellaRelationships };
    const umbrellaVes = createVisualElementSignal(VeFns.create(umbrellaVeSpec));
    VesCache.full_finalizeArrange(store, umbrellaSpec, umbrellaRelationships, umbrellaPath, umbrellaVes);
    evaluateExpressions(true);
  } else {
    // console.time("fullArrange-finalizeArrange");
    VesCache.full_finalizeArrange(store, umbrellaSpec, umbrellaRelationships, umbrellaPath);
    // console.timeEnd("fullArrange-finalizeArrange");
    VesCache.addWatchContainerUid(currentPage.id, currentPage.origin);
    evaluateExpressions(false);
  }

  const hasUser = store.user.getUserMaybe() != null;
  mouseMove_handleNoButtonDown(store, hasUser);
  // console.timeEnd("fullArrange-total");
}
