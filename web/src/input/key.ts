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

import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../items/page-item";
import { fullArrange } from "../layout/arrange";
import { findClosest, findDirectionFromKeyCode } from "../layout/find";
import { switchToPage } from "../layout/navigation";
import { EMPTY_VEID, VeFns } from "../layout/visual-element";
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
import { UMBRELLA_PAGE_UID } from "../util/uid";


const recognizedKeys = [
  "Slash", "Backslash", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "Enter",
  "KeyN", "KeyP", "KeyT", "KeyR", "KeyW", "KeyL", "KeyE", "KeyF",
];

export function keyDownHandler(store: StoreContextModel, ev: KeyboardEvent): void {
  if (document.activeElement!.id.includes('toolbarTitleDiv')) {
    const titleText = (document.activeElement! as HTMLElement).innerText;
    if (ev.code == "Enter") {
      (document.activeElement! as HTMLElement).blur();
      let selection = window.getSelection();
      if (selection != null) { selection.removeAllRanges(); }
      asPageItem(store.history.getFocusItem()).title = titleText;
      fullArrange(store);
      serverOrRemote.updateItem(store.history.getFocusItem(), store.general.networkStatus);
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

    const focusItem = store.history.getFocusItem();
    let handleListPageChange = isPage(focusItem) && asPageItem(focusItem).arrangeAlgorithm == ArrangeAlgorithm.List;
    const focusPath = store.history.getFocusPath();
    const focusVe = VesCache.get(focusPath)!.get();
    const focusVeid = VeFns.veidFromVe(focusVe);
    for (let i=1; i<store.topTitledPages.get().length; ++i) {
      const ttp = VeFns.veidFromPath(store.topTitledPages.get()[i]);
      if (ttp.itemId == focusVeid.itemId && ttp.linkIdMaybe == focusVeid.linkIdMaybe) {
        handleListPageChange = true;
        break;
      }
    }

    if (handleListPageChange) {
      if (ev.code == "ArrowUp" || ev.code == "ArrowDown") {
        const focusPagePath = store.history.getFocusPath();
        const focusPageVe = VesCache.get(focusPagePath)!.get();
        const focusPageVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
        const selectedVeid = store.perItem.getSelectedListPageItem(focusPageVeid);
        if (selectedVeid == EMPTY_VEID) {
          PageFns.setDefaultListPageSelectedItemMaybe(store, focusPageVeid);
          fullArrange(store);
          return;
        }
        const selectedItemPath = VeFns.addVeidToPath(selectedVeid, focusPagePath);
        const direction = findDirectionFromKeyCode(ev.code);
        const closest = findClosest(selectedItemPath, direction, true, false);
        if (closest != null) {
          const closestVeid = VeFns.veidFromPath(closest);
          store.perItem.setSelectedListPageItem(focusPageVeid, closestVeid);
          fullArrange(store);
        }
      } else if (ev.code == "ArrowLeft") {
        const focusPagePath = store.history.getFocusPath();
        const newFocusPagePath = VeFns.parentPath(focusPagePath);
        if (newFocusPagePath == UMBRELLA_PAGE_UID) {
          return;
        }
        store.history.setFocus(newFocusPagePath);
        fullArrange(store);
      } else if (ev.code == "ArrowRight") {
        const focusPagePath = store.history.getFocusPath();
        const focusPageVe = VesCache.get(focusPagePath)!.get();
        const focusPageVeid = VeFns.veidFromVe(focusPageVe);
        const focusPageActualVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
        const selectedVeid = store.perItem.getSelectedListPageItem(focusPageActualVeid);
        if (!isPage(itemState.get(selectedVeid.itemId))) {
          return;
        }
        const selectedPage = asPageItem(itemState.get(selectedVeid.itemId)!);
        if (selectedPage.arrangeAlgorithm != ArrangeAlgorithm.List) {
          // return;
        }
        const ttpVePaths = store.topTitledPages.get();
        const ttpVeids = [];
        for (let i=0; i<ttpVePaths.length; ++i) { ttpVeids.push(VeFns.veidFromPath(ttpVePaths[i])); }
        for (let i=0; i<ttpVeids.length; ++i) {
          const veid = ttpVeids[i];
          if (veid.itemId == focusPageVeid.itemId &&
              veid.linkIdMaybe == focusPageVeid.linkIdMaybe) {
            const nextIdx = i+1;
            if (nextIdx < ttpVeids.length) {
              const nextFocusVeid = ttpVeids[nextIdx];
              const nextFocusPath = VeFns.addVeidToPath(nextFocusVeid, focusPagePath);
              store.history.setFocus(nextFocusPath);

              {
                const focusPagePath = store.history.getFocusPath();
                const focusPageVe = VesCache.get(focusPagePath)!.get();
                const focusPageActualVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
                const selectedVeid = store.perItem.getSelectedListPageItem(focusPageActualVeid);
                if (selectedVeid == EMPTY_VEID) {
                  PageFns.setDefaultListPageSelectedItemMaybe(store, focusPageActualVeid);
                }
              }

              fullArrange(store);
            }
          }
        }
      }

    } else {

      if (!store.history.currentPopupSpec()) {
        const parentVeid = store.history.peekPrevPageVeid()!;
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

  else if (ev.code == "KeyF") {
    ev.preventDefault();
    newItemInContext(store, "flipcard", hitInfo, CursorEventState.getLatestDesktopPx(store));
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
