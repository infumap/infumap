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
import { edit_replaceNoteSelection, edit_structuralClipboardGuard } from "./edit";
import { clipboardTextForSingleLine, normalizeClipboardLineEndings } from "../util/editable_text";
import { textEditElementId } from "./text_edit_session";
import { parsePastedLines, pasteLinesIntoContainer, pasteLinesTargetMaybe, showPasteMessage } from "./paste_lines";
import { pasteBlocksIntoNote, pasteParagraphsIntoNote } from "./paste_markdown";
import { parsePastedHtmlBlocks } from "./paste_html";
import { pasteFilesMaybe } from "../upload";


/**
 * Ctrl/Cmd+Shift+V is the browser's paste as plain text. Its paste event can't be told from an ordinary paste's, so the
 * key down is noted here, and the paste that follows within PLAIN_PASTE_WINDOW_MS takes it. The window is short so that
 * the shortcut pressed with nothing to paste doesn't apply to a later Ctrl+V.
 */
let plainPasteKeyDownMs: number | null = null;
const PLAIN_PASTE_WINDOW_MS = 1000;

/** Called on every key down, before any handler can stop it. */
export function pasteKeyDownListener(ev: KeyboardEvent): void {
  if (ev.code == "KeyV" && (ev.ctrlKey || ev.metaKey) && ev.shiftKey) { plainPasteKeyDownMs = performance.now(); }
}

function takePlainPasteRequest(): boolean {
  const requested = plainPasteKeyDownMs != null && performance.now() - plainPasteKeyDownMs < PLAIN_PASTE_WINDOW_MS;
  plainPasteKeyDownMs = null;
  return requested;
}

export function pasteHandler(store: StoreContextModel, ev: ClipboardEvent) {
  const plain = takePlainPasteRequest();
  if (ev.defaultPrevented) { return; }
  const target = ev.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
      !(target instanceof HTMLElement)) {
    return;
  }
  if (!target.isContentEditable) {
    // Rows first: a copy from a spreadsheet can have an image of the cells as well as their text.
    pasteLinesMaybe(store, ev);
    if (!ev.defaultPrevented) { pasteFilesMaybe(store, ev); }
    return;
  }
  if (edit_structuralClipboardGuard(store, ev)) { return; }

  const clipboardData = ev.clipboardData;
  if (clipboardData == null) { return; }
  // Do not let HTML-only or image clipboard contents replace selected text.
  // Native inputs/textareas above continue to own their clipboard behaviour.
  ev.preventDefault();
  if (!clipboardData.types.includes("text/plain")) {
    if (clipboardData.files.length > 0) { showPasteMessage(store, "To paste a file or image, first stop editing (Esc)"); }
    return;
  }
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
    // A copy from a web page, Google Docs etc. has html too, with the structure its plain text has lost.
    const htmlBlocks = plain || !clipboardData.types.includes("text/html")
      ? null
      : parsePastedHtmlBlocks(clipboardData.getData("text/html"));
    if (htmlBlocks != null && pasteBlocksIntoNote(store, editingElement, htmlBlocks)) { return; }
    if (pasteParagraphsIntoNote(store, editingElement, normalizeClipboardLineEndings(clipboardText), !plain)) { return; }
  }

  if (edit_replaceNoteSelection(store, ev, normalizeClipboardLineEndings(clipboardText), "Paste")) { return; }
  document.execCommand("insertText", false, clipboardTextForSingleLine(clipboardText));
}

/**
 * Outside a text editor, plain text pasted into a focused table becomes one row per line. Anything else, including
 * clipboard contents with no plain text, is left alone and the event is not prevented.
 */
function pasteLinesMaybe(store: StoreContextModel, ev: ClipboardEvent): void {
  const clipboardData = ev.clipboardData;
  if (clipboardData == null || !clipboardData.types.includes("text/plain")) { return; }
  const target = pasteLinesTargetMaybe(store);
  if (target == null) { return; }
  const lines = parsePastedLines(clipboardData.getData("text/plain"));
  if (lines.length == 0) { return; }
  ev.preventDefault();
  pasteLinesIntoContainer(store, target, lines);
}
