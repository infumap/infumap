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

import { Component, Show, onCleanup, onMount } from "solid-js";
import { useStore } from "../store/StoreProvider";
import { ContextMenu } from "./overlay/ContextMenu";
import { handleUpload } from "../upload";
import { HitboxFlags } from "../layout/hitbox";
import { asPageItem, isPage } from "../items/page-item";
import { Page_Desktop } from "./items/Page";
import { VisualElementProps } from "./VisualElement";
import { HitInfoFns } from "../input/hit";
import { CursorEventState } from "../input/state";
import { EditUserSettings } from "./overlay/UserSettings";
import { Panic } from "./overlay/Panic";
import { TableColumnContextMenu } from "./overlay/TableColumnContextMenu";


export const Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  let desktopDiv: HTMLDivElement | undefined;

  const dropListener = async (ev: DragEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.dataTransfer) {
      let hitInfo = HitInfoFns.hit(store, CursorEventState.getLatestDesktopPx(store), [], false);
      if (hitInfo.hitboxType != HitboxFlags.None) {
        store.overlay.toolbarTransientMessage.set("Must upload on background");
        setTimeout(() => {
          store.overlay.toolbarTransientMessage.set(null);
        }, 3000);
        return;
      }
      let item = HitInfoFns.getHitVe(hitInfo).displayItem;
      if (!isPage(item)) {
        store.overlay.toolbarTransientMessage.set("Must upload on page");
        setTimeout(() => {
          store.overlay.toolbarTransientMessage.set(null);
        }, 3000);
        return;
      }
      await handleUpload(store, ev.dataTransfer, CursorEventState.getLatestDesktopPx(store), asPageItem(item));
    }
  };

  const dragoverListener = (ev: DragEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.dataTransfer) {
      ev.dataTransfer.dropEffect = "copy";
    }
  };

  onMount(() => {
    desktopDiv!.addEventListener('dragover', dragoverListener);
    desktopDiv!.addEventListener('drop', dropListener);
  });

  onCleanup(() => {
    desktopDiv!.removeEventListener('dragover', dragoverListener);
    desktopDiv!.removeEventListener('drop', dropListener);
  });

  return (
    <div id="desktop"
         ref={desktopDiv}
         class="absolute left-0 bottom-0 right-0"
         style={`top: ${store.topToolbarHeightPx()}px; `}>

      <Page_Desktop visualElement={props.visualElement} />

      {/* desktop overlays */}
      <Show when={store.overlay.editUserSettingsInfo.get() != null}>
        <EditUserSettings />
      </Show>
      <Show when={store.overlay.contextMenuInfo.get() != null}>
        <ContextMenu />
      </Show>
      <Show when={store.overlay.tableColumnContextMenuInfo.get() != null}>
        <TableColumnContextMenu />
      </Show>
      <Show when={store.overlay.isPanicked.get()}>
        <Panic />
      </Show>

    </div>
  );
}
