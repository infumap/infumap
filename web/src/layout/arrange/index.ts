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

import { ArrangeAlgorithm, asPageItem } from "../../items/page-item";
import { mouseMove_handleNoButtonDown } from "../../mouse/mouse_move";
import { DesktopStoreContextModel } from "../../store/DesktopStoreProvider";
import { itemState } from "../../store/ItemState";
import { initiateLoadChildItemsIfNotLoaded } from "../load";
import { arrange_grid } from "./topLevel/grid";
import { arrange_list } from "./topLevel/list";
import { arrange_spatialStretch } from "./topLevel/spatial";


/**
 * Create the visual element tree for the current page.
 * 
 * Design note: Initially, this was implemented such that the visual element state was a function of the item
 * state (arrange was never called imperatively). The arrange function in that implementation did produce (nested)
 * visual element signals though, which had dependencies on the relevant part of the item state. In that
 * implementation, all the items were solidjs signals (whereas in the current approach they are not). The functional
 * approach was simpler from the point of view that the visual element tree did not need to be explicitly updated /
 * managed. However, it turned out to be a dead end:
 * 1. It was effectively impossible to perfectly optimize it in the case of resizing page items (and probably other
 *    scenarios) because the set of children were a function of page size. By comparison, as a general comment, the
 *    stateful approach makes it easy(er) to make precisely the optimal updates at precisely the required times.
 * 2. The visual element tree state is required for mouse interaction as well as rendering, and it was messy to
 *    create a cached version of this as a side effect of the functional arrange method. And there were associated
 *    bugs, which were not trivial to track down.
 * 3. The functional represenation was not straightforward (compared to the current approach) to reason about -
 *    you need to be very congisant of functional dependencies, what is being captured etc. Even though the direct
 *    approach is more ad-hoc / less "automated", I think the code is simpler to work on due to this.
 */
export const arrange = (desktopStore: DesktopStoreContextModel): void => {
  if (desktopStore.currentPage() == null) { return; }
  initiateLoadChildItemsIfNotLoaded(desktopStore, desktopStore.currentPage()!.itemId);
  let currentPage = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  if (currentPage.arrangeAlgorithm == ArrangeAlgorithm.Grid) {
    arrange_grid(desktopStore);
  } else if (currentPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
    arrange_spatialStretch(desktopStore);
  } else if (currentPage.arrangeAlgorithm == ArrangeAlgorithm.List) {
    arrange_list(desktopStore);
  }
  mouseMove_handleNoButtonDown(desktopStore);
}
