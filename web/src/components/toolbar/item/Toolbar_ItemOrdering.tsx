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

import { Component, Show } from "solid-js";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../../items/page-item";
import { VisualElementFlags } from "../../../layout/visual-element";
import { VesCache } from "../../../layout/ves-cache";
import { RelationshipToParent } from "../../../layout/relationship-to-parent";
import { requestArrange } from "../../../layout/arrange";
import { serverOrRemote } from "../../../server";
import { itemState } from "../../../store/ItemState";
import { useStore } from "../../../store/StoreProvider";
import { InfuIconButton } from "../../library/InfuIconButton";

export const Toolbar_ItemOrdering: Component = () => {
  const store = useStore();

  const shouldShow = () => {
    store.touchToolbarDependency();

    const focusPath = store.history.getFocusPathMaybe();
    if (focusPath == null) {
      return false;
    }

    const focusVe = VesCache.render.getNode(focusPath)?.get();
    if (focusVe == null) {
      return false;
    }
    if (focusVe.flags & VisualElementFlags.Popup || focusVe.flags & VisualElementFlags.LineItem) {
      return false;
    }

    const focusItem = store.history.getFocusItem();
    if (focusItem.parentId == null || focusItem.relationshipToParent != RelationshipToParent.Child) {
      return false;
    }

    const parentItem = itemState.get(focusItem.parentId);
    if (parentItem == null || !isPage(parentItem)) {
      return false;
    }

    return asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch &&
      parentItem.computed_children.length > 1;
  };

  const moveFocusedItemToTop = () => {
    const focusItem = store.history.getFocusItem();
    const parentId = focusItem.parentId;
    if (parentId == null) {
      return;
    }

    focusItem.ordering = itemState.newOrderingAtEndOfChildren(parentId);
    itemState.sortChildren(parentId);
    requestArrange(store, "toolbar-item-ordering-top");
    serverOrRemote.updateItem(focusItem, store.general.networkStatus);
    store.touchToolbar();
  };

  const moveFocusedItemToBottom = () => {
    const focusItem = store.history.getFocusItem();
    const parentId = focusItem.parentId;
    if (parentId == null) {
      return;
    }

    focusItem.ordering = itemState.newOrderingAtBeginningOfChildren(parentId);
    itemState.sortChildren(parentId);
    requestArrange(store, "toolbar-item-ordering-bottom");
    serverOrRemote.updateItem(focusItem, store.general.networkStatus);
    store.touchToolbar();
  };

  return (
    <Show when={shouldShow()}>
      <div class="inline-block ml-[4px] mr-[4px]">
        <div class="inline-block align-middle border-r border-slate-300 mr-[7px]"
          style="height: 25px;" />
        <div class="inline-block align-middle">
          <InfuIconButton icon="bi-layer-forward" highlighted={false} clickHandler={moveFocusedItemToTop} />
          <InfuIconButton icon="bi-layer-backward" highlighted={false} clickHandler={moveFocusedItemToBottom} />
        </div>
      </div>
    </Show>
  );
}
