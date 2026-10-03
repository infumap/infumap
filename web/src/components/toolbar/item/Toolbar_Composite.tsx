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
import { useStore } from "../../../store/StoreProvider";
import { InfuIconButton } from "../../library/InfuIconButton";
import { asCompositeItem } from "../../../items/composite-item";
import { Toolbar_ItemOrdering } from "./Toolbar_ItemOrdering";
import { Toolbar_InfoAndId } from "./Toolbar_InfoAndId";
import { getToolbarFocusItem } from "../toolbarFocus";
import { CompositeFlags } from "../../../items/base/flags-item";
import { ItemType } from "../../../items/base/item";
import { requestArrange } from "../../../layout/arrange";
import { serverOrRemote } from "../../../server";
import { itemCanEdit } from "../../../items/base/capabilities-item";


export const Toolbar_Composite: Component = () => {
  const store = useStore();


  const compositeItem = () => asCompositeItem(getToolbarFocusItem(store));
  const canEdit = () => itemCanEdit(compositeItem());

  const showTitle = () => {
    store.touchToolbarDependency();
    return !!(compositeItem().flags & CompositeFlags.ShowTitle);
  };

  const handleToggleTitle = () => {
    if ((compositeItem().flags & CompositeFlags.ShowTitle) &&
      store.overlay.textEditInfo()?.itemType == ItemType.Composite &&
      store.overlay.textEditInfo()?.itemPath == store.history.getFocusPathMaybe()) {
      store.overlay.setTextEditInfo(store.history, null, true);
    }
    if (compositeItem().flags & CompositeFlags.ShowTitle) {
      compositeItem().flags &= ~CompositeFlags.ShowTitle;
    } else {
      compositeItem().flags |= CompositeFlags.ShowTitle;
    }
    requestArrange(store, "toolbar-composite-title-visibility");
    serverOrRemote.updateItem(compositeItem(), store.general.networkStatus);
    store.touchToolbar();
  };

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <Show when={canEdit()}>
          <InfuIconButton icon="bi-type" highlighted={showTitle()} clickHandler={handleToggleTitle} title="Show composite title" />
        </Show>
        <Toolbar_ItemOrdering />

        <Toolbar_InfoAndId infoClass="inline-block pl-[5px]" />
      </div>
    </div>
  );
}
