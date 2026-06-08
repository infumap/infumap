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
import { ToolbarPopupType, TransientMessageType } from "../../../store/StoreProvider_Overlay";
import { asCompositeItem } from "../../../items/composite-item";
import { ClickState } from "../../../input/state";
import { Toolbar_ItemOrdering } from "./Toolbar_ItemOrdering";
import { getToolbarFocusItem } from "../toolbarFocus";
import { CompositeFlags } from "../../../items/base/flags-item";
import { ItemType } from "../../../items/base/item";
import { requestArrange } from "../../../layout/arrange";
import { serverOrRemote } from "../../../server";
import { itemCanEdit } from "../../../items/base/capabilities-item";


export const Toolbar_Composite: Component = () => {
  const store = useStore();

  let qrDiv: HTMLDivElement | undefined;

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

  const handleQr = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.QrLink) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: qrDiv!.getBoundingClientRect().x, y: qrDiv!.getBoundingClientRect().y + 38 }, type: ToolbarPopupType.QrLink });
  };
  const handleQrDown = () => {
    ClickState.setButtonClickBoundsPx(qrDiv!.getBoundingClientRect());
  };

  const handleCopyId = () => {
    navigator.clipboard.writeText(compositeItem().id);
    store.overlay.toolbarTransientMessage.set({ text: "composite id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  };

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <Show when={canEdit()}>
          <InfuIconButton icon="bi-type" highlighted={showTitle()} clickHandler={handleToggleTitle} title="Show composite title" />
        </Show>
        <Toolbar_ItemOrdering />

        <div ref={qrDiv} class="inline-block pl-[5px]" onMouseDown={handleQrDown}>
          <InfuIconButton icon="bi-info-circle-fill" highlighted={false} clickHandler={handleQr} />
        </div>
        <div class="inline-block">
          <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleCopyId} />
        </div>
      </div>
    </div>
  );
}
