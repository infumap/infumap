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

import { Item } from "../../items/base/item";
import { ArrangeAlgorithm, asPageItem, isPage, PageItem } from "../../items/page-item";
import { VeFns, VisualElement, VisualElementPath } from "../../layout/visual-element";
import { VesCache } from "../../layout/ves-cache";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { SOLO_ITEM_HOLDER_PAGE_UID } from "../../util/uid";


function soloItemHolderPageFromFocus(store: StoreContextModel): PageItem | null {
  const focusItem = store.history.getFocusItem();
  if (!isPage(focusItem)) { return null; }

  const pageItem = asPageItem(focusItem);
  if (pageItem.id != SOLO_ITEM_HOLDER_PAGE_UID ||
    pageItem.arrangeAlgorithm != ArrangeAlgorithm.SingleCell) {
    return null;
  }

  return pageItem;
}

function soloItemHolderChildVeMaybe(store: StoreContextModel): VisualElement | null {
  if (soloItemHolderPageFromFocus(store) == null) { return null; }

  const currentPagePath = store.history.currentPagePath();
  if (currentPagePath == null) { return null; }

  const children = VesCache.current.readStructuralChildren(currentPagePath);
  return children.length == 1 ? children[0] : null;
}

export function getToolbarFocusItem(store: StoreContextModel): Item {
  store.touchToolbarDependency();

  const pageItem = soloItemHolderPageFromFocus(store);
  if (pageItem == null) { return store.history.getFocusItem(); }

  const childVe = soloItemHolderChildVeMaybe(store);
  if (childVe != null) { return childVe.displayItem; }

  const childId = pageItem.computed_children[0];
  return itemState.get(childId) ?? store.history.getFocusItem();
}

export function getToolbarFocusPathMaybe(store: StoreContextModel): VisualElementPath | null {
  store.touchToolbarDependency();

  if (soloItemHolderPageFromFocus(store) == null) {
    return store.history.getFocusPathMaybe();
  }

  const childVe = soloItemHolderChildVeMaybe(store);
  return childVe == null ? store.history.getFocusPathMaybe() : VeFns.veToPath(childVe);
}
