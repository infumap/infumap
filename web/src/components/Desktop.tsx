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
import { useDesktopStore } from "../store/DesktopStoreProvider";
import { MAIN_TOOLBAR_WIDTH_PX } from "../constants";
import { ContextMenu } from "./overlay/ContextMenu";
import { useUserStore } from "../store/UserStoreProvider";
import { mouseMoveHandler } from "../input/mouse_move";
import { handleUpload } from "../upload";
import { HitboxFlags } from "../layout/hitbox";
import { asPageItem, isPage } from "../items/page-item";
import { EditDialog } from "./overlay/edit/EditDialog";
import { Page_Desktop } from "./items/Page";
import { VisualElementProps } from "./VisualElement";
import { getHitInfo } from "../input/hit";
import { TextEditOverlay } from "./overlay/TextEditOverlay";
import { mouseUpHandler } from "../input/mouse_up";
import { MOUSE_RIGHT, mouseDownHandler } from "../input/mouse_down";
import { mouseDoubleClickHandler } from "../input/mouse_doubleClick";
import { CursorEventState } from "../input/state";
import { arrange } from "../layout/arrange";
import { SearchOverlay } from "./overlay/SearchOverlay";
import { EditUserSettings } from "./overlay/UserSettings";
import { Panic } from "./overlay/Panic";
import { keyHandler } from "../input/key";
import { setTopLevelPageScrollPositions } from "../layout/navigation";
import { PageSettingsOverlay } from "./overlay/PageSettingsOverlay";


export const Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();

  let desktopDiv: HTMLDivElement | undefined;

  const keyListener = (ev: KeyboardEvent) => {
    keyHandler(desktopStore, userStore, ev);
  };

  const mouseDoubleClickListener = (ev: MouseEvent) => {
    ev.preventDefault();
    mouseDoubleClickHandler(desktopStore, userStore, ev);
  };

  const mouseDownListener = async (ev: MouseEvent) => {
    ev.preventDefault();
    await mouseDownHandler(desktopStore, userStore, ev.button);
  };

  const touchListener = async (ev: TouchEvent) => {
    if (ev.touches.length > 1) {
      CursorEventState.setFromTouchEvent(ev);
      ev.preventDefault();
      await mouseDownHandler(desktopStore, userStore, MOUSE_RIGHT);
    }
  }

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    mouseMoveHandler(desktopStore, userStore);
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.preventDefault();
    mouseUpHandler(desktopStore, userStore);
  };

  const windowResizeListener = () => {
    desktopStore.resetDesktopSizePx();
    arrange(desktopStore);
    setTopLevelPageScrollPositions(desktopStore);
  };

  const windowPopStateListener = () => {
    desktopStore.setContextMenuInfo(null);
    desktopStore.setEditDialogInfo(null);
    desktopStore.setEditUserSettingsInfo(null);
    desktopStore.popPage();
    arrange(desktopStore);
    setTopLevelPageScrollPositions(desktopStore);
  };

  const contextMenuListener = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
  };

  const dropListener = async (ev: DragEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.dataTransfer) {
      let hi = getHitInfo(desktopStore, CursorEventState.getLastestDesktopPx(), [], false);
      if (hi.hitboxType != HitboxFlags.None) {
        console.log("must upload on background.");
        return;
      }
      let item = hi.overElementVes.get().displayItem;
      if (!isPage(item)) {
        console.log("must upload on page.");
        return;
      }
      await handleUpload(desktopStore, ev.dataTransfer, CursorEventState.getLastestDesktopPx(), asPageItem(item));
    }
  };

  const dragoverListener = (ev: DragEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.dataTransfer) { ev.dataTransfer.dropEffect = "copy"; }
  };

  onMount(() => {
    // TODO (MEDIUM): attach to desktopDiv?. need tab index.
    document.addEventListener('keydown', keyListener);
    desktopDiv!.addEventListener('contextmenu', contextMenuListener);
    desktopDiv!.addEventListener('dragover', dragoverListener);
    desktopDiv!.addEventListener('drop', dropListener);
    window.addEventListener('resize', windowResizeListener);
    window.addEventListener('popstate', windowPopStateListener);
  });

  onCleanup(() => {
    document.removeEventListener('keydown', keyListener);
    desktopDiv!.removeEventListener('contextmenu', contextMenuListener);
    desktopDiv!.removeEventListener('dragover', dragoverListener);
    desktopDiv!.removeEventListener('drop', dropListener);
    window.removeEventListener('resize', windowResizeListener);
  });

  return (
    <div id="desktop"
         ref={desktopDiv}
         class="absolute top-0 bottom-0 right-0 select-none outline-none"
         style={`left: ${MAIN_TOOLBAR_WIDTH_PX}px;`}
         ontouchstart={touchListener}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         ondblclick={mouseDoubleClickListener}
         onmouseup={mouseUpListener}>

      <Page_Desktop visualElement={props.visualElement} />

      <Show when={desktopStore.editDialogInfo() != null}>
        <EditDialog />
      </Show>
      <Show when={desktopStore.editUserSettingsInfo() != null}>
        <EditUserSettings />
      </Show>
      <Show when={desktopStore.contextMenuInfo() != null}>
        <ContextMenu />
      </Show>
      <Show when={desktopStore.textEditOverlayInfo() != null}>
        <TextEditOverlay />
      </Show>
      <Show when={desktopStore.pageSettingsOverlayInfo() != null}>
        <PageSettingsOverlay />
      </Show>
      <Show when={desktopStore.searchOverlayVisible()}>
        <SearchOverlay />
      </Show>
      <Show when={desktopStore.getPanicked()}>
        <Panic />
      </Show>

    </div>
  );
}
