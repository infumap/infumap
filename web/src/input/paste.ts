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
import { edit_pasteNoteText, edit_structuralClipboardGuard } from "./edit";
import { clipboardTextForSingleLine, normalizeClipboardLineEndings } from "../util/editable_text";
import { textEditElementId } from "./text_edit_session";


export function pasteHandler(store: StoreContextModel, ev: ClipboardEvent) {
  if (ev.defaultPrevented) { return; }
  const target = ev.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
      !(target instanceof HTMLElement) || !target.isContentEditable) {
    return;
  }
  if (edit_structuralClipboardGuard(store, ev)) { return; }

  const clipboardData = ev.clipboardData;
  if (clipboardData == null) { return; }
  // Do not let HTML-only or image clipboard contents replace selected text.
  // Native inputs/textareas above continue to own their clipboard behaviour.
  ev.preventDefault();
  if (!clipboardData.types.includes("text/plain")) { return; }
  const clipboardText = clipboardData.getData("text/plain");
  if (clipboardText.length == 0) { return; }
  const editInfo = store.overlay.textEditInfo();
  const editingElement = editInfo == null ? null : document.getElementById(textEditElementId(editInfo));
  if (editInfo != null && editingElement != null &&
      (target.contains(editingElement) || editingElement.contains(target))) {
    // A clipboard-created text file receives the original bytes, not note/title normalization.
    if (acceptClipboardTextForPendingTextItem(store, editInfo.itemPath, clipboardText)) {
      return;
    }
  }

  if (edit_pasteNoteText(store, ev, normalizeClipboardLineEndings(clipboardText))) { return; }
  document.execCommand("insertText", false, clipboardTextForSingleLine(clipboardText));
}
