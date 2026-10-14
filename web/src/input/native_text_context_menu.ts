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

/** A right click inside the active text editor belongs to the browser; elsewhere it means Back. */
export function shouldOpenNativeTextContextMenu(store: StoreContextModel, target: EventTarget | null): boolean {
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
