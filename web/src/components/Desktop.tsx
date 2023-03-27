/*
  Copyright (C) 2022-2023 The Infumap Authors
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

import { Component, onCleanup, onMount, Show } from "solid-js";
import { useDesktopStore } from "../store/desktop/DesktopStoreProvider";
import { useGeneralStore } from "../store/GeneralStoreProvider";
import { TOOLBAR_WIDTH } from "../constants";
import { ContextMenu } from "./context/ContextMenu";
import { desktopPxFromMouseEvent } from "../util/geometry";
import { useUserStore } from "../store/UserStoreProvider";
import { getHitInfo, mouseDownHandler, mouseMoveHandler, mouseUpHandler } from "../mouse";
import { handleUpload } from "../upload";
import { HitboxType } from "../store/desktop/hitbox";
import { asPageItem } from "../store/desktop/items/page-item";
import { EditDialog } from "./context/EditDialog";
import { Page } from "./items/Page";


export const Desktop: Component = () => {
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();
  const generalStore = useGeneralStore();

  let desktopDiv: HTMLDivElement | undefined;

  let lastMouseMoveEvent: MouseEvent | undefined;

  const keyListener = (ev: KeyboardEvent) => {
    // TODO (HIGH): Something better - this doesn't allow slash in data entry in context menu.
    if (ev.code != "Slash" && ev.code != "Backslash") { return; }
    let hbi = getHitInfo(desktopStore, desktopPxFromMouseEvent(lastMouseMoveEvent!), []);
    let item = desktopStore.getItem(hbi.visualElement.itemId)!;
    if (ev.code == "Slash") {
      generalStore.setContextMenuInfo({ posPx: desktopPxFromMouseEvent(lastMouseMoveEvent!), item: item });
    }
    if (ev.code == "Backslash") {
      generalStore.setEditDialogInfo({ posPx: desktopPxFromMouseEvent(lastMouseMoveEvent!), item: item });
    }
  };

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    mouseDownHandler(desktopStore, generalStore, userStore, ev);
  }

  const mouseMoveListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    lastMouseMoveEvent = ev;
    mouseMoveHandler(desktopStore, ev);
  }

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    mouseUpHandler(userStore, desktopStore);
  }

  const windowResizeListener = () => {
    desktopStore.resetDesktopSizePx();
  }

  const contextMenuListener = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
  }

  const dropListener = async (ev: DragEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.dataTransfer) {
      let hi = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), []);
      if (hi.hitboxType != HitboxType.None) {
        console.log("must upload on background.");
        return;
      }
      let item = desktopStore.getItem(hi.visualElement.itemId)!;
      await handleUpload(desktopStore, userStore, ev.dataTransfer, desktopPxFromMouseEvent(ev), asPageItem(item));
    }
  }

  const dragoverListener = (ev: DragEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.dataTransfer) { ev.dataTransfer.dropEffect = "copy"; }
  }

  onMount(() => {
    // TODO (MEDIUM): attach to desktopDiv?. need tab index.
    document.addEventListener('mousedown', mouseDownListener);
    document.addEventListener('mousemove', mouseMoveListener);
    document.addEventListener('mouseup', mouseUpListener);
    document.addEventListener('keypress', keyListener);
    document.addEventListener('contextmenu', contextMenuListener);
    document.addEventListener('dragover', dragoverListener);
    document.addEventListener('drop', dropListener);
    window.addEventListener('resize', windowResizeListener);
  });

  onCleanup(() => {
    document.removeEventListener('mousedown', mouseDownListener);
    document.removeEventListener('mousemove', mouseMoveListener);
    document.removeEventListener('mouseup', mouseUpListener);
    document.removeEventListener('keypress', keyListener);
    document.removeEventListener('contextmenu', contextMenuListener);
    document.removeEventListener('dragover', dragoverListener);
    document.removeEventListener('drop', dropListener);
    window.removeEventListener('resize', windowResizeListener);
  });

  const scrollHandler = (_ev: Event) => {
    let pageItem = asPageItem(desktopStore.getItem(desktopStore.currentPageId()!)!);
    pageItem.scrollYPx.set(desktopDiv!.scrollTop);
    pageItem.scrollXPx.set(desktopDiv!.scrollLeft);
  }

  function overflowPolicy() {
    // Child items may extend outside the bounds of the page, even if the page is the same size as the desktop.
    // If it wasn't for this, overflow policy could always be auto.
    let topLevelVisualElement = desktopStore.getTopLevelVisualElement();
    if (topLevelVisualElement == null) { return ""; }

    let desktopPx = desktopStore.desktopBoundsPx();
    if (topLevelVisualElement.childAreaBoundsPx()!.w == desktopPx.w &&
        topLevelVisualElement.childAreaBoundsPx()!.h == desktopPx.h) {
      return "";
    }
    if (topLevelVisualElement.childAreaBoundsPx()!.w != desktopPx.w &&
        topLevelVisualElement.childAreaBoundsPx()!.h != desktopPx.h) {
      return "overflow: auto;"
    }
    if (topLevelVisualElement.childAreaBoundsPx()!.w != desktopPx.w) {
      return "overflow-x: auto; overflow-y: hidden;"
    }
    return "overflow-y: auto; overflow-x: hidden;";
  }

  return (
    <div id="desktop"
         ref={desktopDiv}
         class="absolute top-0 bottom-0 right-0 select-none outline-none"
         style={`left: ${TOOLBAR_WIDTH}px; ${overflowPolicy()}`}
         onscroll={scrollHandler}>
      <Show when={desktopStore.getTopLevelVisualElement() != null}>
        <Page visualElement={desktopStore.getTopLevelVisualElement()!} />
      </Show>
      <ContextMenu />
      <EditDialog />
    </div>
  );
}
