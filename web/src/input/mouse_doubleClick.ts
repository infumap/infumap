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

import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { UserStoreContextModel } from "../store/UserStoreProvider";
import { getHitInfo } from "./hit";
import { MOUSE_LEFT } from "./mouse_down";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { DoubleClickState, CursorEventState } from "./state";


export function mouseDoubleClickHandler(
    desktopStore: DesktopStoreContextModel,
    userStore: UserStoreContextModel,
    ev: MouseEvent) {
  if (!DoubleClickState.canDoubleClick()) { return; }
  if (desktopStore.currentPage() == null) { return; }
  if (desktopStore.contextMenuInfo() != null || desktopStore.editDialogInfo() != null) { return; }
  if (desktopStore.textEditOverlayInfo() != null) { return; }
  if (ev.button != MOUSE_LEFT) { return; }

  const hitInfo = getHitInfo(desktopStore, CursorEventState.getLastestDesktopPx(), [], false);

  desktopStore.setContextMenuInfo({ posPx: CursorEventState.getLastestDesktopPx(), hitInfo });
  mouseMove_handleNoButtonDown(desktopStore, userStore.getUserMaybe() != null);
}
