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

import { StoreContextModel } from "../store/StoreProvider";
import { HitInfoFns } from "./hit";
import { MOUSE_LEFT } from "./mouse_down";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { DoubleClickState, CursorEventState } from "./state";


export function mouseDoubleClickHandler(store: StoreContextModel, ev: MouseEvent) {
  if (!DoubleClickState.canDoubleClick()) { return; }
  if (store.history.currentPageVeid() == null) { return; }
  if (store.overlay.contextMenuInfo.get() != null) { return; }
  if (store.overlay.textEditInfo() != null) { return; }
  if (ev.button != MOUSE_LEFT) { return; }

  const hitInfo = HitInfoFns.hit(store, CursorEventState.getLatestDesktopPx(store), [], false);

  store.overlay.contextMenuInfo.set({ posPx: CursorEventState.getLatestDesktopPx(store), hitInfo });
  mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
}
