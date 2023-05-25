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

import { Component, onCleanup, onMount } from "solid-js";
import { useDesktopStore } from "../store/desktop/DesktopStoreProvider";
import { useGeneralStore } from "../store/GeneralStoreProvider";
import { TOOLBAR_WIDTH } from "../constants";
import { ContextMenu } from "./context/ContextMenu";
import { desktopPxFromMouseEvent } from "../util/geometry";
import { useUserStore } from "../store/UserStoreProvider";
import { getHitInfo, mouseDownHandler, mouseMoveHandler, mouseUpHandler } from "../mouse";
import { handleUpload } from "../upload";
import { HitboxType } from "../store/desktop/hitbox";
import { asPageItem, isPage } from "../store/desktop/items/page-item";
import { EditDialog } from "./context/EditDialog";
import { Page } from "./items/Page";
import { VisualElementOnDesktopProps } from "./VisualElementOnDesktop";
import { VisualElement } from "../store/desktop/visual-element";
import { arrange } from "../store/desktop/layout/arrange";


export const Desktop: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();
  const generalStore = useGeneralStore();

  let desktopDiv: HTMLDivElement | undefined;

  const keyListener = (ev: KeyboardEvent) => {
    if (desktopStore.editDialogInfo() != null || desktopStore.contextMenuInfo() != null) {
      return;
    }

    // TODO (HIGH): Something better - this doesn't allow slash in data entry in context menu.
    if (ev.code != "Slash" && ev.code != "Backslash") { return; }
    let hbi = getHitInfo(desktopStore, desktopPxFromMouseEvent(desktopStore.lastMouseMoveEvent()), []);
    let item = hbi.visualElementSignal.get().item;
    if (ev.code == "Slash") {
      ev.preventDefault();
      desktopStore.setContextMenuInfo({ posPx: desktopPxFromMouseEvent(desktopStore.lastMouseMoveEvent()), item });
    }
    if (ev.code == "Backslash") {
      ev.preventDefault();
      desktopStore.setEditDialogInfo({
        desktopBoundsPx: { x: 0, y: 0, w: 0, h: 0 },
        item
      });
    }
  };

  const mouseDownListener = (ev: MouseEvent) => {
    ev.preventDefault();
    mouseDownHandler(desktopStore, ev);
  }

  const mouseMoveListener = (ev: MouseEvent) => {
    desktopStore.setLastMouseMoveEvent(ev);
    ev.preventDefault();
    mouseMoveHandler(desktopStore);
  }

  const mouseUpListener = (ev: MouseEvent) => {
    ev.preventDefault();
    mouseUpHandler(desktopStore, userStore);
  }

  const windowResizeListener = () => {
    desktopStore.resetDesktopSizePx();
    arrange(desktopStore);
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
      let item = hi.visualElementSignal.get().item;
      if (!isPage(item)) {
        console.log("must upload on page.");
        return;
      }
      await handleUpload(desktopStore, ev.dataTransfer, desktopPxFromMouseEvent(ev), asPageItem(item));
    }
  }

  const dragoverListener = (ev: DragEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.dataTransfer) { ev.dataTransfer.dropEffect = "copy"; }
  }

  onMount(() => {
    // TODO (MEDIUM): attach to desktopDiv?. need tab index.
    document.addEventListener('keypress', keyListener);
    desktopDiv!.addEventListener('contextmenu', contextMenuListener);
    desktopDiv!.addEventListener('dragover', dragoverListener);
    desktopDiv!.addEventListener('drop', dropListener);
    window.addEventListener('resize', windowResizeListener);
  });

  onCleanup(() => {
    document.removeEventListener('keypress', keyListener);
    desktopDiv!.removeEventListener('contextmenu', contextMenuListener);
    desktopDiv!.removeEventListener('dragover', dragoverListener);
    desktopDiv!.removeEventListener('drop', dropListener);
    window.removeEventListener('resize', windowResizeListener);
  });

  const scrollHandler = (_ev: Event) => {
    if (!desktopDiv) { return; }
    let pageItem = asPageItem(desktopStore.getItem(desktopStore.topLevelPageId()!)!);
    pageItem.scrollYPx.set(desktopDiv!.scrollTop);
    pageItem.scrollXPx.set(desktopDiv!.scrollLeft);
  }

  function overflowPolicy(topLevelVisualElement: VisualElement) {
    // Child items may extend outside the bounds of the page, even if the page is the same size as the desktop.
    // This means overflow policy can't just be set to auto.

    let desktopPx = desktopStore.desktopBoundsPx();
    if (topLevelVisualElement.childAreaBoundsPx!.w == desktopPx.w &&
        topLevelVisualElement.childAreaBoundsPx!.h == desktopPx.h) {
      return "";
    }
    if (topLevelVisualElement.childAreaBoundsPx!.w != desktopPx.w &&
        topLevelVisualElement.childAreaBoundsPx!.h != desktopPx.h) {
      return "overflow: auto;"
    }
    if (topLevelVisualElement.childAreaBoundsPx!.w != desktopPx.w) {
      return "overflow-x: auto; overflow-y: hidden;"
    }
    return "overflow-y: auto; overflow-x: hidden;";
  }

  return (
    <div id="desktop"
         ref={desktopDiv}
         class="absolute top-0 bottom-0 right-0 select-none outline-none"
         style={`left: ${TOOLBAR_WIDTH}px; ${overflowPolicy(props.visualElement)}`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}
         onscroll={scrollHandler}>
      <Page visualElement={props.visualElement} />
      <ContextMenu />
      <EditDialog />
    </div>
  );
}
