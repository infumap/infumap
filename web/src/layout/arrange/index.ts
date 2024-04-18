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

import { ArrangeAlgorithm, PageFns } from "../../items/page-item";
import { mouseMove_handleNoButtonDown } from "../../input/mouse_move";
import { StoreContextModel } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { getPanickedMessage } from "../../util/lang";
import { evaluateExpressions } from "../../expression/evaluate";
import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElementFlags, VisualElementSpec } from "../visual-element";
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
 * 3. The functional represenation was not straightforward (compared to the current approach) to reason about -
 *    you need to be very congisant of functional dependencies, what is being captured etc. Even though the direct
 *    approach is more ad-hoc / less "automated", the code is simpler to work on due to this.
 *
 * @param virtualPageVeid the page to create the visual element tree for, if not the current page.
 */
export const fullArrange = (store: StoreContextModel, virtualPageVeid?: Veid): void => {
  if (store.history.currentPage() == null) { return; }

  if (getPanickedMessage() != null) {
    store.overlay.isPanicked.set(true);
    return;
  }

  VesCache.initFullArrange();

  let currentPageVeid = virtualPageVeid ? virtualPageVeid : store.history.currentPage()!;

  const currentPage = itemState.get(currentPageVeid.itemId)!;
  const actualLinkItemMaybe = currentPageVeid.linkIdMaybe
    ? asLinkItem(itemState.get(currentPageVeid.linkIdMaybe!)!)
    : null;
  const umbrellaPageItem = PageFns.umbrellaPage();
  const umbrellaPath = umbrellaPageItem.id;

  const umbrellaVeSpec: VisualElementSpec = {
    displayItem: umbrellaPageItem,
    linkItemMaybe: null,
    actualLinkItemMaybe: null,
    flags: VisualElementFlags.UmbrellaPage,
    boundsPx: store.desktopBoundsPx(),
    childAreaBoundsPx: store.desktopBoundsPx(),
    viewportBoundsPx: store.desktopBoundsPx(),
  };

  const dockVesMaybe = renderDockMaybe(store, umbrellaPath);
  if (dockVesMaybe) {
    umbrellaVeSpec.dockVes = dockVesMaybe;
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
  const pageVes = arrangeItem(store, umbrellaPath, parentArrangeAlgorithm, currentPage, actualLinkItemMaybe, itemGeometry, flags);
  childrenVes.push(pageVes);
  umbrellaVeSpec.childrenVes = childrenVes;

  if (virtualPageVeid) {
    const umbrellaVes = createVisualElementSignal(VeFns.create(umbrellaVeSpec));
    VesCache.finalizeFullArrange(store, umbrellaVeSpec, umbrellaPath, umbrellaVes);
    evaluateExpressions(true);
  } else {
    VesCache.finalizeFullArrange(store, umbrellaVeSpec, umbrellaPath);
    evaluateExpressions(false);
  }

  const hasUser = store.user.getUserMaybe() != null;
  mouseMove_handleNoButtonDown(store, hasUser);
}
