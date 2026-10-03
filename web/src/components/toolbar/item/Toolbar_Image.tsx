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
import { useStore } from "../../../store/StoreProvider";
import { InfuIconButton } from "../../library/InfuIconButton";
import { asImageItem } from "../../../items/image-item";
import { ImageFlags } from "../../../items/base/flags-item";
import { serverOrRemote } from "../../../server";
import { requestArrange } from "../../../layout/arrange";
import { Toolbar_ItemOrdering } from "./Toolbar_ItemOrdering";
import { Toolbar_InfoAndId } from "./Toolbar_InfoAndId";
import { getToolbarFocusItem } from "../toolbarFocus";


export const Toolbar_Image: Component = () => {
  const store = useStore();

  const imageItem = () => asImageItem(getToolbarFocusItem(store));
  const canEdit = () => itemCanEdit(imageItem());


  const borderButtonHandler = () => {
    const item = imageItem();
    if (item.flags & ImageFlags.HideBorder) {
      item.flags &= ~ImageFlags.HideBorder;
    } else {
      item.flags |= ImageFlags.HideBorder;
    }
    requestArrange(store, "toolbar-image-border");
    store.touchToolbar();
    serverOrRemote.updateItem(item, store.general.networkStatus);
  }

  const borderVisible = () => {
    return (imageItem().flags & ImageFlags.HideBorder) ? false : true;
  }

  const cropHandler = () => {
    const item = imageItem();
    if (item.flags & ImageFlags.NoCrop) {
      item.flags &= ~ImageFlags.NoCrop;
    } else {
      item.flags |= ImageFlags.NoCrop;
    }
    requestArrange(store, "toolbar-image-crop");
    store.touchToolbar();
    serverOrRemote.updateItem(item, store.general.networkStatus);
  }

  const shouldCropImage = () => {
    return (imageItem().flags & ImageFlags.NoCrop) ? false : true;
  }

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <Show when={canEdit()}>
          <div class="pl-[4px] inline-block">
            <InfuIconButton icon="bi-crop" highlighted={shouldCropImage()} clickHandler={cropHandler} />
          </div>
          <div class="inline-block">
            <InfuIconButton icon="fa fa-square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
          </div>
        </Show>

        <Toolbar_ItemOrdering />

        {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
        <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

        <Toolbar_InfoAndId />

      </div>
    </div>
  );
}
