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
import { itemCanEdit } from "../../../items/base/capabilities-item";
import { asDividerItem, DividerDirection } from "../../../items/divider-item";
import { requestArrange } from "../../../layout/arrange";
import { VesCache } from "../../../layout/ves-cache";
import { serverOrRemote } from "../../../server";
import { useStore } from "../../../store/StoreProvider";
import { InfuIconButton } from "../../library/InfuIconButton";
import { getToolbarFocusItem, getToolbarFocusLinkItemMaybe, getToolbarFocusPathMaybe } from "../toolbarFocus";
import { itemOrderingIsShown, Toolbar_ItemOrdering } from "./Toolbar_ItemOrdering";
import { dividerIsAlwaysHorizontal } from "../../items/helper";
import { Toolbar_InfoAndId } from "./Toolbar_InfoAndId";
import { TOOLBAR_INFO_DIVIDER_RIGHT_PX } from "../toolbarDividers";


function swapSize(item: { spatialWidthGr: number, spatialHeightGr: number }) {
  const oldWidthGr = item.spatialWidthGr;
  item.spatialWidthGr = item.spatialHeightGr;
  item.spatialHeightGr = oldWidthGr;
}

export const Toolbar_Divider: Component = () => {
  const store = useStore();


  const dividerItem = () => asDividerItem(getToolbarFocusItem(store));
  const canEdit = () => itemCanEdit(dividerItem());
  const focusVe = () => {
    const focusPath = getToolbarFocusPathMaybe(store);
    return focusPath == null ? null : VesCache.render.getNode(focusPath)?.get() ?? null;
  };
  const showDirection = () => {
    const ve = focusVe();
    return canEdit() && (ve == null || !dividerIsAlwaysHorizontal(ve));
  };

  // With no options, only the info and id buttons are shown, as for a search item.
  const hasOptions = () => showDirection() || itemOrderingIsShown(store);

  const setDirection = (direction: DividerDirection) => {
    const item = dividerItem();
    if (item.dividerDirection == direction) { return; }
    item.dividerDirection = direction;
    swapSize(item);
    // the direction is the divider's, but a link draws it at the link's own size, which must turn with it. Other
    // links to the divider keep their size until resized.
    const link = getToolbarFocusLinkItemMaybe(store);
    if (link != null) { swapSize(link); }
    requestArrange(store, "toolbar-divider-direction");
    serverOrRemote.updateItem(item);
    if (link != null) { serverOrRemote.updateItem(link); }
  };

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <Show when={showDirection()}>
          <div class="inline-block ml-[10px] mr-[4px] align-middle">
            <InfuIconButton
              icon="bi-arrows"
              highlighted={dividerItem().dividerDirection == "horizontal"}
              title="Horizontal divider"
              clickHandler={() => setDirection("horizontal")} />
            <InfuIconButton
              icon="bi-arrows-vertical"
              highlighted={dividerItem().dividerDirection == "vertical"}
              title="Vertical divider"
              clickHandler={() => setDirection("vertical")} />
          </div>
        </Show>

        <Toolbar_ItemOrdering />

        <Show when={hasOptions()}>
          <div class="fixed border-r border-chrome-line" style={`height: 25px; right: ${TOOLBAR_INFO_DIVIDER_RIGHT_PX}px; top: 7px;`}></div>
        </Show>

        <Toolbar_InfoAndId infoClass={hasOptions() ? undefined : "inline-block pl-[2px]"} />
      </div>
    </div>
  );
}
