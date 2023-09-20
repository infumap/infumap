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

import { isNote } from "../items/note-item";
import { HitboxType } from "../layout/hitbox";
import { visualElementToPath } from "../layout/visual-element";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { itemState } from "../store/ItemState";
import { desktopPxFromMouseEvent } from "../util/geometry";
import { getHitInfo } from "./hit";
import { MOUSE_LEFT } from "./mouse_down";


export function mouseDoubleClickHandler(
    desktopStore: DesktopStoreContextModel,
    ev: MouseEvent) {
  if (desktopStore.currentPage() == null) { return; }
  if (desktopStore.contextMenuInfo() != null || desktopStore.editDialogInfo() != null) { return; }
  if (ev.button != MOUSE_LEFT) {
    console.log("double click: unsupported mouse button: " + ev.button + " (ignoring).");
    return;
  }

  const hitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [], false);
  if (hitInfo.hitboxType == HitboxType.None) { return; }

  const activeDisplayItem = itemState.getItem(hitInfo.overElementVes.get().displayItem.id)!;
  if (!isNote(activeDisplayItem)) { return; }

  desktopStore.setTextEditOverlayInfo({ noteItemPath: visualElementToPath(hitInfo.overElementVes.get()) });
}
