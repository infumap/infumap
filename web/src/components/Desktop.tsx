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
import { PopupType, useDesktopStore } from "../store/DesktopStoreProvider";
import { MAIN_TOOLBAR_WIDTH_PX } from "../constants";
import { ContextMenu } from "./context/ContextMenu";
import { desktopPxFromMouseEvent } from "../util/geometry";
import { useUserStore } from "../store/UserStoreProvider";
import { mouseDoubleClickHandler, mouseDownHandler, mouseMoveHandler, mouseMoveNoButtonDownHandler } from "../mouse/mouse";
import { handleUpload } from "../upload";
import { HitboxType } from "../layout/hitbox";
import { asPageItem, isPage } from "../items/page-item";
import { EditDialog, initialEditDialogBounds } from "./edit/EditDialog";
import { Page_Desktop } from "./items/Page";
import { VisualElementProps } from "./VisualElement";
import { VisualElement, veidFromPath } from "../layout/visual-element";
import { ARRANGE_ALGO_LIST, arrange } from "../layout/arrange";
import { getHitInfo } from "../mouse/hitInfo";
import { panic } from "../util/lang";
import { mouseMoveState } from "../store/MouseMoveState";
import { findClosest, findDirectionFromKeyCode } from "../layout/find";
import { itemState } from "../store/ItemState";
import { switchToPage } from "../layout/navigation";
import { TextEditOverlay } from "./TextEditOverlay";
import { mouseUpHandler } from "../mouse/mouse_up";


export const Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();

  let desktopDiv: HTMLDivElement | undefined;

  const recognizedKeys = ["Slash", "Backslash", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "Enter"];
  const keyListener = (ev: KeyboardEvent) => {
    if (desktopStore.editDialogInfo() != null || desktopStore.contextMenuInfo() != null || desktopStore.textEditOverlayInfo() != null) {
      return;
    }

    if (!recognizedKeys.find(a => a == ev.code)) {
      console.debug("unhandled key:", ev.code);
      return;
    }

    let hitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(mouseMoveState.lastMouseMoveEvent()), [], false);

    if (ev.code == "Slash") {
      ev.preventDefault();
      desktopStore.setContextMenuInfo({ posPx: desktopPxFromMouseEvent(mouseMoveState.lastMouseMoveEvent()), hitInfo });
      mouseMoveNoButtonDownHandler(desktopStore);
    }

    else if (ev.code == "Backslash") {
      ev.preventDefault();
      desktopStore.setEditDialogInfo({
        desktopBoundsPx: initialEditDialogBounds(desktopStore),
        item: (() => {
          const overVe = hitInfo.overElementVes.get();
          if (overVe.linkItemMaybe != null) {
            const poppedUp = desktopStore.currentPopupSpec();
            if (poppedUp && overVe.displayItem.id == veidFromPath(poppedUp!.vePath).itemId) {
              return overVe.displayItem;
            }
            const selected = desktopStore.getSelectedListPageItem(desktopStore.currentPage()!);
            if (selected && overVe.displayItem.id == veidFromPath(selected).itemId) {
              return overVe.displayItem;
            }
            return overVe.linkItemMaybe!;
          }
          return overVe.displayItem;
        })()
      });
      mouseMoveNoButtonDownHandler(desktopStore);
    }

    else if (ev.code == "Escape") {
      ev.preventDefault();
      if (desktopStore.currentPopupSpec()) {
        desktopStore.popAllPopups();
        arrange(desktopStore);
      }
    }

    else if (ev.code == "ArrowLeft" || ev.code == "ArrowRight" || ev.code == "ArrowUp" || ev.code == "ArrowDown") {
      ev.preventDefault(); // TODO (MEDIUM): allow default in some circumstances where it is appropriate for a table to scroll.
      let currentPage = asPageItem(itemState.getItem(desktopStore.currentPage()!.itemId)!);
      if (currentPage.arrangeAlgorithm == ARRANGE_ALGO_LIST) {
        if (ev.code == "ArrowUp" || ev.code == "ArrowDown") {
          const selectedItem = desktopStore.getSelectedListPageItem(desktopStore.currentPage()!);
          const direction = findDirectionFromKeyCode(ev.code);
          const closest = findClosest(selectedItem, direction, true)!;
          if (closest != null) {
            desktopStore.setSelectedListPageItem(desktopStore.currentPage()!, closest);
            arrange(desktopStore);
          }
        }
      } else {
        if (desktopStore.currentPopupSpec() == null) {
          return;
        }
        const direction = findDirectionFromKeyCode(ev.code);
        const closest = findClosest(desktopStore.currentPopupSpec()!.vePath, direction, false)!;
        if (closest != null) {
          const closestVeid = veidFromPath(closest);
          const closestItem = itemState.getItem(closestVeid.itemId);
          desktopStore.replacePopup({
            type: isPage(closestItem) ? PopupType.Page : PopupType.Image,
            vePath: closest
          });
          arrange(desktopStore);
        }
      }
    }

    else if (ev.code == "Enter") {
      const spec = desktopStore.currentPopupSpec();
      if (spec && spec.type == PopupType.Page) {
        switchToPage(desktopStore, userStore, veidFromPath(desktopStore.currentPopupSpec()!.vePath), true);
      }
    }

    else {
      panic();
    }
  };

  const mouseDoubleClickListener = (ev: MouseEvent) => {
    ev.preventDefault();
    mouseDoubleClickHandler(desktopStore, ev);
  };

  const mouseDownListener = (ev: MouseEvent) => {
    ev.preventDefault();
    mouseDownHandler(desktopStore, userStore, ev);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    mouseMoveState.setLastMouseMoveEvent(ev);
    mouseMoveHandler(desktopStore);
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.preventDefault();
    mouseUpHandler(desktopStore, userStore);
  };

  const windowResizeListener = () => {
    desktopStore.resetDesktopSizePx();
    arrange(desktopStore);
  };

  const windowPopStateListener = () => {
    desktopStore.setContextMenuInfo(null);
    desktopStore.setEditDialogInfo(null);
    desktopStore.popPage();
    arrange(desktopStore);
  };

  const contextMenuListener = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
  };

  const dropListener = async (ev: DragEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.dataTransfer) {
      let hi = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [], false);
      if (hi.hitboxType != HitboxType.None) {
        console.log("must upload on background.");
        return;
      }
      let item = hi.overElementVes.get().displayItem;
      if (!isPage(item)) {
        console.log("must upload on page.");
        return;
      }
      await handleUpload(desktopStore, ev.dataTransfer, desktopPxFromMouseEvent(ev), asPageItem(item));
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

  const scrollHandler = (_ev: Event) => {
    if (!desktopDiv) { return; }

    const pageBoundsPx = desktopStore.topLevelVisualElementSignal().get().boundsPx;
    const desktopSizePx = desktopStore.desktopBoundsPx();

    if (desktopSizePx.w < pageBoundsPx.w) {
      const scrollXProp = desktopDiv!.scrollLeft / (pageBoundsPx.w - desktopSizePx.w);
      desktopStore.setPageScrollXProp(desktopStore.currentPage()!, scrollXProp);
    }

    if (desktopSizePx.h < pageBoundsPx.h) {
      const scrollYProp = desktopDiv!.scrollTop / (pageBoundsPx.h - desktopSizePx.h);
      desktopStore.setPageScrollYProp(desktopStore.currentPage()!, scrollYProp);
    }
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
         ondblclick={mouseDoubleClickListener}
         onmouseup={mouseUpListener}
         onscroll={scrollHandler}>
      <Page_Desktop visualElement={props.visualElement} />
      <ContextMenu />
      <EditDialog />
      <Show when={desktopStore.textEditOverlayInfo() != null}>
        <TextEditOverlay />
      </Show>
    </div>
  );
}
