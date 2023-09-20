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

import { ARRANGE_ALGO_LIST, arrange } from "../../layout/arrange";
import { VesCache } from "../../layout/ves-cache";
import { VisualElement, VisualElementFlags, VeFns } from "../../layout/visual-element";
import { DesktopStoreContextModel } from "../../store/DesktopStoreProvider";
import { asPageItem, isPage } from "../page-item";


export function handleListPageLineItemClickMaybe(visualElement: VisualElement, desktopStore: DesktopStoreContextModel): boolean {
  const parentItem = VesCache.get(visualElement.parentPath!)!.get().displayItem;
  if ((visualElement.flags & VisualElementFlags.LineItem) && isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ARRANGE_ALGO_LIST) {
    desktopStore.setSelectedListPageItem(VeFns.veidFromPath(visualElement.parentPath!), VeFns.veToPath(visualElement));
    arrange(desktopStore);
    return true;
  }
  return false;
}
