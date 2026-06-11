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

import { requestArrange } from "../layout/arrange";
import { VeFns } from "../layout/visual-element";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { base64ArrayBuffer } from "../util/base64ArrayBuffer";
import { setCaretPosition } from "../util/caret";
import { currentUnixTimeSeconds } from "../util/lang";
import { EMPTY_CONTENT_EDITABLE_PLACEHOLDER, trimNewline } from "../util/string";
import { asTextItem, isClipboardTextCreateItem, TextItem } from "../items/text-item";

export const MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function clipboardBytesIfAllowed(text: string): Uint8Array | null {
  if (text.length == 0) {
    return null;
  }
  const bytes = encoder.encode(text);
  if (bytes.byteLength > MAX_CLIPBOARD_TEXT_BYTES) {
    return null;
  }
  return bytes;
}

function titleElementId(itemPath: string): string {
  return itemPath + ":title";
}

function focusTitleForClipboardText(itemPath: string): void {
  requestAnimationFrame(() => {
    const el = document.getElementById(titleElementId(itemPath));
    if (!(el instanceof HTMLElement)) { return; }
    el.focus();
    setCaretPosition(el, 0);
  });
}

function clearPlaceholderTitleElement(itemPath: string): void {
  const el = document.getElementById(titleElementId(itemPath));
  if (!(el instanceof HTMLElement)) { return; }
  el.textContent = EMPTY_CONTENT_EDITABLE_PLACEHOLDER;
  el.classList.remove("italic", "text-slate-500");
  setCaretPosition(el, 0);
}

export function acceptClipboardTextForPendingTextItem(
  store: StoreContextModel,
  itemPath: string,
  text: string,
): boolean {
  const item = itemState.get(VeFns.veidFromPath(itemPath).itemId);
  if (!isClipboardTextCreateItem(item)) {
    return false;
  }
  const textItem = asTextItem(item);
  if (textItem.clipboardTextCreateState != "awaiting-paste") {
    return false;
  }

  const bytes = clipboardBytesIfAllowed(text);
  if (bytes == null) {
    return true;
  }

  const now = currentUnixTimeSeconds();
  textItem.clipboardTextContent = text;
  textItem.clipboardTextCreateState = "editing-title";
  textItem.title = "";
  textItem.originalCreationDate = now;
  textItem.lastModifiedDate = now;
  textItem.mimeType = "text/plain";
  textItem.fileSizeBytes = bytes.byteLength;

  clearPlaceholderTitleElement(itemPath);
  requestArrange(store, "clipboard-text-accepted");
  focusTitleForClipboardText(itemPath);
  return true;
}

export function finishPendingClipboardTextItem(
  store: StoreContextModel,
  itemPath: string,
  titleText: string,
): boolean {
  const item = itemState.get(VeFns.veidFromPath(itemPath).itemId);
  if (!isClipboardTextCreateItem(item)) {
    return false;
  }

  const textItem = asTextItem(item);
  if (textItem.clipboardTextCreateState == "persisting") {
    return true;
  }

  if (textItem.clipboardTextCreateState == "awaiting-paste" || textItem.clipboardTextContent == null) {
    itemState.delete(textItem.id);
    requestArrange(store, "clipboard-text-discard");
    return true;
  }

  const bytes = encoder.encode(textItem.clipboardTextContent);
  textItem.title = trimNewline(titleText);
  textItem.fileSizeBytes = bytes.byteLength;
  textItem.mimeType = "text/plain";
  textItem.lastModifiedDate = currentUnixTimeSeconds();
  textItem.clipboardTextCreateState = "persisting";

  const base64Data = base64ArrayBuffer(exactArrayBuffer(bytes));
  void server.addItem(textItem, base64Data, store.general.networkStatus)
    .then(returnedItem => {
      itemState.upsertItemFromServerObject(returnedItem, null);
      requestArrange(store, "clipboard-text-persisted");
    })
    .catch(error => {
      console.warn("Failed to create text item from clipboard:", error);
      textItem.clipboardTextCreateState = "editing-title";
      requestArrange(store, "clipboard-text-persist-failed");
    });

  return true;
}

export function finishActivePendingClipboardTextItem(store: StoreContextModel): boolean {
  const textEditInfo = store.overlay.textEditInfo();
  if (textEditInfo == null) {
    return false;
  }

  const editingDomId = textEditInfo.colNum != null
    ? textEditInfo.itemPath + ":col" + textEditInfo.colNum
    : titleElementId(textEditInfo.itemPath);
  const editingDomEl = document.getElementById(editingDomId);
  const titleText = editingDomEl instanceof HTMLInputElement
    ? editingDomEl.value
    : editingDomEl instanceof HTMLElement
      ? editingDomEl.innerText
      : "";
  return finishPendingClipboardTextItem(store, textEditInfo.itemPath, titleText);
}

export function prepareNewTextItemForClipboardCreate(textItem: TextItem): void {
  textItem.clientOnly = true;
  textItem.clipboardTextCreateState = "awaiting-paste";
  textItem.clipboardTextContent = null;
}
