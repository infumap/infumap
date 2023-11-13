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
import { arrange } from "../layout/arrange";
import { findClosest, findDirectionFromKeyCode } from "../layout/find";
import { switchToPage } from "../layout/navigation";
import { VeFns } from "../layout/visual-element";
import { DesktopStoreContextModel, PopupType } from "../store/DesktopStoreProvider";
import { itemState } from "../store/ItemState";
import { UserStoreContextModel } from "../store/UserStoreProvider";
import { panic } from "../util/lang";
import { getHitInfo } from "./hit";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { CursorEventState } from "./state";


const recognizedKeys = ["Slash", "Backslash", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "Enter"];

export function keyHandler(desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel, ev: KeyboardEvent): void {
  if (desktopStore.editDialogInfo.get() != null || desktopStore.contextMenuInfo.get() != null || desktopStore.noteEditOverlayInfo.get() != null) {
    return;
  }

  if (!recognizedKeys.find(a => a == ev.code)) {
    return;
  }

  const hitInfo = getHitInfo(desktopStore, CursorEventState.getLatestDesktopPx(), [], false);

  if (ev.code == "Slash") {
    ev.preventDefault();
    desktopStore.contextMenuInfo.set({ posPx: CursorEventState.getLatestDesktopPx(), hitInfo });
    mouseMove_handleNoButtonDown(desktopStore, userStore.getUserMaybe() != null);
  }

  else if (ev.code == "Backslash") {
    ev.preventDefault();
    desktopStore.editDialogInfo.set({
      desktopBoundsPx: initialEditDialogBounds(desktopStore),
      item: (() => {
        const overVe = hitInfo.overElementVes.get();
        if (overVe.linkItemMaybe != null) {
          const poppedUp = desktopStore.currentPopupSpec();
          if (poppedUp && overVe.displayItem.id == VeFns.veidFromPath(poppedUp!.vePath).itemId) {
            return overVe.displayItem;
          }
          const selected = desktopStore.getSelectedListPageItem(desktopStore.currentPage()!);
          if (selected && overVe.displayItem.id == VeFns.veidFromPath(selected).itemId) {
            return overVe.displayItem;
          }
          return overVe.linkItemMaybe!;
        }
        return overVe.displayItem;
      })()
    });
    mouseMove_handleNoButtonDown(desktopStore, userStore.getUserMaybe() != null);
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
    const currentPage = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
    if (currentPage.arrangeAlgorithm == ArrangeAlgorithm.List) {
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
        const closestVeid = VeFns.veidFromPath(closest);
        const closestItem = itemState.get(closestVeid.itemId);
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
      switchToPage(desktopStore, userStore, VeFns.veidFromPath(desktopStore.currentPopupSpec()!.vePath), true, false);
    }
  }

  else {
    panic(`Unexpected key code: ${ev.code}`);
  }
}
