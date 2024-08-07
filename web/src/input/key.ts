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

import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { fullArrange } from "../layout/arrange";
import { findClosest, findDirectionFromKeyCode } from "../layout/find";
import { switchToPage } from "../layout/navigation";
import { VeFns } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { panic } from "../util/lang";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { CursorEventState } from "./state";
import { newItemInContext } from "./create";
import { isLink } from "../items/link-item";
import { VesCache } from "../layout/ves-cache";
import { serverOrRemote } from "../server";
import { ItemType } from "../items/base/item";
import { HitInfoFns } from "./hit";


const recognizedKeys = [
  "Slash", "Backslash", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "Enter",
  "KeyN", "KeyP", "KeyT", "KeyR", "KeyW", "KeyL", "KeyE"
];

export function keyDownHandler(store: StoreContextModel, ev: KeyboardEvent): void {
  if (document.activeElement == document.getElementById("toolbarTitleDiv")!) {
    if (ev.code == "Enter") {
      (document.activeElement! as HTMLElement).blur();
      let selection = window.getSelection();
      if (selection != null) { selection.removeAllRanges(); }
      const newTitleText = document.getElementById("toolbarTitleDiv")!.innerText;
      asPageItem(store.history.getFocusItem()).title = newTitleText;
      fullArrange(store);
      serverOrRemote.updateItem(store.history.getFocusItem());
      ev.preventDefault();
    }
    return;
  }

  if (store.overlay.textEditInfo() && !store.overlay.toolbarPopupInfoMaybe.get()) {
    // TODO (HIGH)
    // event is fired before content is updated.
    return;
  }

  // input box is in toolbar.
  if (isLink(store.history.getFocusItem())) { return; }

  if (store.overlay.anOverlayIsVisible()) { return; }
  if (!recognizedKeys.find(a => a == ev.code)) { return; }

  const hitInfo = HitInfoFns.hit(store, CursorEventState.getLatestDesktopPx(store), [], false);

  if (ev.code == "Slash") {
    ev.preventDefault();
    store.overlay.contextMenuInfo.set({ posPx: CursorEventState.getLatestDesktopPx(store), hitInfo });
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
  }

  else if (ev.code == "Escape") {
    ev.preventDefault();
    if (store.history.currentPopupSpec()) {
      store.history.popAllPopups();
      const topRootVes = store.umbrellaVisualElement.get().childrenVes[0];
      topRootVes.get().popupVes = null;
      topRootVes.set(topRootVes.get());
    }
  }

  else if (ev.code == "ArrowLeft" || ev.code == "ArrowRight" || ev.code == "ArrowUp" || ev.code == "ArrowDown") {
    ev.preventDefault(); // TODO (MEDIUM): allow default in some circumstances where it is appropriate for a table to scroll.
    const currentPage = asPageItem(itemState.get(store.history.currentPageVeid()!.itemId)!);
    if (currentPage.arrangeAlgorithm == ArrangeAlgorithm.List) {
      if (ev.code == "ArrowUp" || ev.code == "ArrowDown") {
        const selectedVeid = store.perItem.getSelectedListPageItem(store.history.currentPageVeid()!);
        const direction = findDirectionFromKeyCode(ev.code);
        const umbrellaPath = store.umbrellaVisualElement.get().displayItem.id;
        const currentPagePath = VeFns.addVeidToPath(store.history.currentPageVeid()!, umbrellaPath);
        const selectedItemPath = VeFns.addVeidToPath(selectedVeid, currentPagePath);
        const closest = findClosest(selectedItemPath, direction, true, false);
        if (closest != null) {
          const closestVeid = VeFns.veidFromPath(closest);
          store.perItem.setSelectedListPageItem(store.history.currentPageVeid()!, closestVeid);
          fullArrange(store);
        }
      }
    } else {
      if (!store.history.currentPopupSpec()) {
        const parentVeid = store.history.parentPageVeid()!;
        if (parentVeid) {
          fullArrange(store, parentVeid);
          const direction = findDirectionFromKeyCode(ev.code);
          const closest = findClosest(store.history.getParentPageFocusPath()!, direction, false, true)!;
          if (closest) {
            const closestVe = VesCache.getVirtual(closest)!;
            if (isPage(closestVe.get().displayItem)) {
              store.history.changeParentPageFocusPath(closest);
              switchToPage(store, VeFns.veidFromPath(closest), true, false, true);
            }
          }
        }
        return;
      }

      const path = store.history.currentPopupSpec()!.vePath;
      if (path == null) { return; }
      const direction = findDirectionFromKeyCode(ev.code);
      const closest = findClosest(path, direction, false, false)!;
      if (closest != null) {
        const closestVeid = VeFns.veidFromPath(closest);
        const closestItem = itemState.get(closestVeid.itemId);
        store.history.replacePopup({
          vePath: closest,
          actualVeid: closestVeid,
        });
        fullArrange(store);
      }
    }
  }

  else if (ev.code == "Enter") {
    if (ev.metaKey) {
      if (!store.dockVisible.get() && !store.topToolbarVisible.get()) {
        store.dockVisible.set(true);
        store.topToolbarVisible.set(true);
      } else {
        store.dockVisible.set(false);
        store.topToolbarVisible.set(false);
      }
      fullArrange(store);
      return;
    }
    const spec = store.history.currentPopupSpec();
    if (spec && itemState.get(spec.actualVeid.itemId)!.itemType == ItemType.Page) {
      switchToPage(store, store.history.currentPopupSpec()!.actualVeid, true, false, false);
    }
  }

  else if (ev.code == "KeyN") {
    ev.preventDefault();
    newItemInContext(store, "note", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyP") {
    ev.preventDefault();
    newItemInContext(store, "page", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyT") {
    ev.preventDefault();
    newItemInContext(store, "table", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyR") {
    ev.preventDefault();
    newItemInContext(store, "rating", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyW") {
    ev.preventDefault();
    newItemInContext(store, "password", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyL") {
    ev.preventDefault();
    newItemInContext(store, "link", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyE") {
    ev.preventDefault();
    newItemInContext(store, "expression", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else {
    panic(`Unexpected key code: ${ev.code}`);
  }
}

export function isArrowKey(key: string) {
  if (key == "ArrowDown") { return true; }
  if (key == "ArrowUp") { return true; }
  if (key == "ArrowLeft") { return true; }
  if (key == "ArrowRight") { return true; }
  return false;
}
