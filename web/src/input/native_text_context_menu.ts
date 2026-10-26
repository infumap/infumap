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

import type { StoreContextModel } from "../store/StoreProvider";
import { textEditElementId } from "./text_edit_session";

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password"]);

/**
 * Shift+right-click inside the active text editor belongs to the browser (spelling, paste); any other right click
 * means Back. Giving every unmodified right click to the browser inside the editor meant having to think about
 * where the pointer was before going back. A long hold can't select instead: Linux and macOS browsers fire
 * contextmenu on mousedown, so whether to prevent it is decided before the hold length is known, and the native
 * menu can't be opened later from script. Ctrl is avoided because Ctrl+click is itself a right click on macOS.
 */
export function shouldOpenNativeTextContextMenu(store: StoreContextModel, ev: MouseEvent): boolean {
  if (!ev.shiftKey) { return false; }
  const target = ev.target;
  if (!(target instanceof Node)) { return false; }
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || !activeElement.contains(target)) { return false; }

  if (activeElement instanceof HTMLTextAreaElement) {
    return !activeElement.disabled && !activeElement.readOnly;
  }
  if (activeElement instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(activeElement.type) && !activeElement.disabled && !activeElement.readOnly;
  }
  if (!activeElement.isContentEditable) { return false; }

  const editInfo = store.overlay.textEditInfo();
  if (editInfo != null && document.getElementById(textEditElementId(editInfo)) === activeElement) {
    return true;
  }
  return /^toolbarTitleDiv-\d+$/.test(activeElement.id);
}
