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

  // Double clicking is no longer used for anything.
}
