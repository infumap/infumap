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

import { Component, onCleanup, onMount } from "solid-js";
import { useDesktopStore } from "../store/DesktopStoreProvider";
import { MAIN_TOOLBAR_WIDTH_PX } from "../constants";
import { ContextMenu } from "./context/ContextMenu";
import { desktopPxFromMouseEvent } from "../util/geometry";
import { useUserStore } from "../store/UserStoreProvider";
import { mouseDownHandler, mouseMoveHandler, mouseMoveNoButtonDownHandler, mouseUpHandler } from "../mouse/mouse";
import { handleUpload } from "../upload";
import { HitboxType } from "../layout/hitbox";
import { asPageItem, isPage } from "../items/page-item";
import { EditDialog, initialEditDialogBounds } from "./context/EditDialog";
import { Page_Desktop } from "./items/Page";
import { VisualElementProps_Desktop } from "./VisualElement";
import { VisualElement } from "../layout/visual-element";
import { arrange } from "../layout/arrange";
import { getHitInfo } from "../mouse/hitInfo";
import { panic } from "../util/lang";


export const Desktop: Component<VisualElementProps_Desktop> = (props: VisualElementProps_Desktop) => {
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();

  let desktopDiv: HTMLDivElement | undefined;

  const keyListener = (ev: KeyboardEvent) => {
    if (desktopStore.editDialogInfo() != null || desktopStore.contextMenuInfo() != null) {
      return;
    }
    if (ev.code != "Slash" && ev.code != "Backslash") {
      return;
    }

    // TODO (HIGH): Something better - this doesn't allow slash in data entry in context menu.

    let hitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(desktopStore.lastMouseMoveEvent()), [], false);

    if (ev.code == "Slash") {
      ev.preventDefault();
      desktopStore.setContextMenuInfo({ posPx: desktopPxFromMouseEvent(desktopStore.lastMouseMoveEvent()), hitInfo });
      mouseMoveNoButtonDownHandler(desktopStore);
    }

    else if (ev.code == "Backslash") {
      ev.preventDefault();
      desktopStore.setEditDialogInfo({
        desktopBoundsPx: initialEditDialogBounds(desktopStore),
        item: hitInfo.overElementVes.get().item
      });
      mouseMoveNoButtonDownHandler(desktopStore);
    }

    else {
      panic();
    }
  };

  const mouseDownListener = (ev: MouseEvent) => {
    ev.preventDefault();
    mouseDownHandler(desktopStore, ev);
  }

  const mouseMoveListener = (ev: MouseEvent) => {
    desktopStore.setLastMouseMoveEvent(ev);
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
      let hi = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [], false);
      if (hi.hitboxType != HitboxType.None) {
        console.log("must upload on background.");
        return;
      }
      let item = hi.overElementVes.get().item;
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
         style={`left: ${MAIN_TOOLBAR_WIDTH_PX}px; ${overflowPolicy(props.visualElement)}`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}
         onscroll={scrollHandler}>
      <Page_Desktop visualElement={props.visualElement} />
      <ContextMenu />
      <EditDialog />
    </div>
  );
}
