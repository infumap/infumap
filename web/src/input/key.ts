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

import { initialEditDialogBounds } from "../components/overlay/edit/EditDialog";
import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { fullArrange } from "../layout/arrange";
import { findClosest, findDirectionFromKeyCode } from "../layout/find";
import { switchToPage } from "../layout/navigation";
import { VeFns } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { panic } from "../util/lang";
import { getHitInfo } from "./hit";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { CursorEventState } from "./state";
import { PopupType } from "../store/StoreProvider_History";
import { newItemInContext } from "./create";
import { noteEditOverlay_keyDownListener } from "../components/overlay/NoteEditOverlay";
import { pageEditOverlay_keyDownListener } from "../components/overlay/PageEditOverlay";
import { isLink } from "../items/link-item";
import { VesCache } from "../layout/ves-cache";


const recognizedKeys = [
  "Slash", "Backslash", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "Enter",
  "KeyN", "KeyP", "KeyT", "KeyR", "KeyW", "KeyL", "KeyE"
];

export function keyHandler(store: StoreContextModel, ev: KeyboardEvent): void {

  if (store.overlay.noteEditOverlayInfo() && !store.overlay.toolbarOverlayInfoMaybe.get()) {
    noteEditOverlay_keyDownListener(store, ev);
  }

  if (store.overlay.pageEditOverlayInfo() && !store.overlay.toolbarOverlayInfoMaybe.get()) {
    pageEditOverlay_keyDownListener(store, ev);
  }

  // input box is in toolbar.
  if (isLink(store.history.getFocusItem())) { return; }

  if (store.overlay.anOverlayIsVisible()) { return; }
  if (!recognizedKeys.find(a => a == ev.code)) { return; }

  const hitInfo = getHitInfo(store, CursorEventState.getLatestDesktopPx(store), [], false, false);

  if (ev.code == "Slash") {
    ev.preventDefault();
    store.overlay.contextMenuInfo.set({ posPx: CursorEventState.getLatestDesktopPx(store), hitInfo });
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
  }

  else if (ev.code == "Backslash") {
    ev.preventDefault();
    store.overlay.editDialogInfo.set({
      desktopBoundsPx: initialEditDialogBounds(store),
      item: (() => {
        const overVe = hitInfo.overElementVes.get();
        if (overVe.linkItemMaybe != null) {
          const poppedUp = store.history.currentPopupSpec();
          if (poppedUp && overVe.displayItem.id == poppedUp!.actualVeid.itemId) {
            return overVe.displayItem;
          }
          const selected = store.perItem.getSelectedListPageItem(store.history.currentPage()!);
          if (selected && overVe.displayItem.id == selected.itemId) {
            return overVe.displayItem;
          }
          return overVe.linkItemMaybe!;
        }
        return overVe.displayItem;
      })()
    });
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
    const currentPage = asPageItem(itemState.get(store.history.currentPage()!.itemId)!);
    if (currentPage.arrangeAlgorithm == ArrangeAlgorithm.List) {
      if (ev.code == "ArrowUp" || ev.code == "ArrowDown") {
        const selectedItem = store.perItem.getSelectedListPageItem(store.history.currentPage()!);
        const direction = findDirectionFromKeyCode(ev.code);
        console.log("TODO: make this work again.");
        // const closest = findClosest(selectedItem, direction, true)!;
        // if (closest != null) {
        //   store.perItem.setSelectedListPageItem(store.history.currentPage()!, closest);
        //   arrange(store);
        // }
      }
    } else {
      if (!store.history.currentPopupSpec()) {
        const parentVeid = store.history.parentPage()!;
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
          type: isPage(closestItem) ? PopupType.Page : PopupType.Image,
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
    if (spec && spec.type == PopupType.Page) {
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
    // TODO: expressions..
    // newItemInContext(store, "expression", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else {
    panic(`Unexpected key code: ${ev.code}`);
  }
}
