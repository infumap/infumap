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
import { acceptClipboardTextForPendingTextItem } from "./text_clipboard_create";


export function pasteHandler(store: StoreContextModel, ev: ClipboardEvent) {
  const clipboardData = ev.clipboardData;
  const editInfo = store.overlay.textEditInfo();
  if (clipboardData != null && editInfo != null) {
    const clipboardText = clipboardData.getData('text/plain');
    if (acceptClipboardTextForPendingTextItem(store, editInfo.itemPath, clipboardText)) {
      ev.preventDefault();
      return;
    }
  }

  if (clipboardData == null) {
    ev.preventDefault();
    return;
  }

  let text = clipboardData.getData('text/plain');
  text = text.replace('\n', ' ');
  text = text.replace('\r', ' ');
  text = text.replace('\t', ' ');
  document.execCommand("insertHTML", false, text);
  ev.preventDefault();
}
