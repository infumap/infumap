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

import { createSignal, type Accessor } from "solid-js";
import { itemCanEdit } from "../items/base/capabilities-item";
import { type Item, ItemType } from "../items/base/item";
import { ItemFns } from "../items/base/item-polymorphism";
import { asTitledItem } from "../items/base/titled-item";
import { asPageItem } from "../items/page-item";
import { asTableItem } from "../items/table-item";
import { asPasswordItem } from "../items/password-item";
import { isClipboardTextCreateItem } from "../items/text-item";
import { asNoteItem, NoteFns, updateNoteInlineMarksForTextChange, updateNoteUrlsForTextChange } from "../items/note-item";
import { getQueryText, setQueryText } from "../items/query-item";
import { VeFns } from "../layout/visual-element";
import { serverOrRemote } from "../server";
import { itemState } from "../store/ItemState";
import type { StoreContextModel } from "../store/StoreProvider";
import type { TextEditInfo } from "../store/StoreProvider_Overlay";
import { getTextOffsetWithinElement } from "../util/caret";
import { trimNewline } from "../util/string";
import { finishPendingClipboardTextItem } from "./text_clipboard_create";

const SAVE_DELAY_MS = 500;

type TextEditField = "title" | "text" | `column:${number}`;

export interface TextEditSession {
  info: TextEditInfo,
  itemId: string,
  field: TextEditField,
  selection: { anchor: number, focus: number } | null,
  lastText: string,
  typingFlags: number,
  inputRevision: number,
  isComposing: boolean,
}

interface PendingSave {
  item: Item,
  fields: Set<TextEditField>,
  revision: number,
  timer: ReturnType<typeof setTimeout> | null,
  inFlight: Promise<void> | null,
  failed: boolean,
}

export interface TextEditStore {
  activeSession: () => TextEditSession | null,
  changeTarget: (info: TextEditInfo | null) => void,
  captureInput: (element: HTMLElement, typingFlags: number) => TextEditSession | null,
  beginComposition: (element: HTMLElement, typingFlags: number) => void,
  endComposition: (element: HTMLElement) => TextEditSession | null,
  flushActive: () => void,
  saveItem: (item: Item, immediately?: boolean) => void,
  preserveUnsavedFields: (item: Item) => void,
  flush: () => Promise<boolean>,
  unsavedCount: Accessor<number>,
  failedSaveCount: Accessor<number>,
  clear: () => void,
}

export function textEditElementId(info: TextEditInfo): string {
  return info.itemPath + (info.colNum == null ? ":title" : ":col" + info.colNum);
}

export function setNoteTitleFromEditedText(note: ReturnType<typeof asNoteItem>, nextTitle: string, typingFlags: number): void {
  const oldTitle = note.title;
  if (oldTitle != nextTitle) {
    note.inlineMarks = updateNoteInlineMarksForTextChange(note.inlineMarks, oldTitle, nextTitle, typingFlags);
    note.urls = updateNoteUrlsForTextChange(note.urls, oldTitle, nextTitle);
  }
  note.title = nextTitle;
  NoteFns.ensureTitleUrl(note);
}

function modelText(store: StoreContextModel, item: Item, info: TextEditInfo): string {
  if (info.itemType == ItemType.Search) { return getQueryText(store, item.id); }
  if (info.colNum != null) {
    const columns = info.itemType == ItemType.Page ? asPageItem(item).tableColumns : asTableItem(item).tableColumns;
    return columns[info.colNum]?.name ?? "";
  }
  return info.itemType == ItemType.Password ? asPasswordItem(item).text : asTitledItem(item).title;
}

/** Owns text-edit lifetime and pending saves independently of the rendered editor. */
export function makeTextEditStore(getStore: () => StoreContextModel): TextEditStore {
  let active: TextEditSession | null = null;
  const pending = new Map<string, PendingSave>();
  const [unsavedCount, setUnsavedCount] = createSignal(0);
  const [failedSaveCount, setFailedSaveCount] = createSignal(0);

  const updateStatus = () => {
    setUnsavedCount(pending.size);
    setFailedSaveCount([...pending.values()].filter(save => save.failed).length);
  };

  const cancelTimer = (save: PendingSave) => {
    if (save.timer != null) { clearTimeout(save.timer); }
    save.timer = null;
  };

  const savePending = (id: string): Promise<void> => {
    const save = pending.get(id);
    if (save == null) { return Promise.resolve(); }
    cancelTimer(save);
    if (save.inFlight != null) { return save.inFlight; }

    const currentItem = itemState.get(id);
    // A structural edit may have removed this item since the debounce started.
    if (currentItem == null) {
      pending.delete(id);
      updateStatus();
      return Promise.resolve();
    }
    save.item = currentItem;
    const revision = save.revision;
    save.failed = false;
    // Freeze nested fields too: queued requests must represent this revision,
    // even when subsequent input changes the live item's column names or marks.
    const snapshot = ItemFns.fromObject(JSON.parse(JSON.stringify(ItemFns.toObject(save.item))), save.item.origin);
    save.inFlight = serverOrRemote.updateItem(snapshot, getStore().general.networkStatus, false)
      .then(() => {
        if (pending.get(id) === save && save.revision == revision) {
          pending.delete(id);
        }
      })
      .catch(error => {
        save.failed = true;
        console.warn("Text edit remains unsaved:", id, error);
      })
      .finally(() => {
        save.inFlight = null;
        if (pending.get(id) === save && !save.failed && save.revision != revision && save.timer == null) {
          void savePending(id);
        }
        updateStatus();
      });
    updateStatus();
    return save.inFlight;
  };

  const markDirty = (item: Item, field: TextEditField = "title") => {
    if (item.clientOnly || !itemCanEdit(item) || item.itemType == ItemType.Search) { return; }
    let save = pending.get(item.id);
    if (save == null) {
      save = { item, fields: new Set(), revision: 0, timer: null, inFlight: null, failed: false };
      pending.set(item.id, save);
    }
    save.item = item;
    save.fields.add(field);
    ++save.revision;
    cancelTimer(save);
    save.timer = setTimeout(() => { void savePending(item.id); }, SAVE_DELAY_MS);
    updateStatus();
  };

  const captureInput = (element: HTMLElement, typingFlags: number): TextEditSession | null => {
    const session = active;
    if (session == null || element.id != textEditElementId(session.info)) { return null; }
    // Candidate text belongs to the IME until compositionend. In particular,
    // do not diff formatting or persist a series of partial candidate strings.
    if (session.isComposing) { return session; }
    const item = itemState.get(session.itemId);
    if (item == null || !itemCanEdit(item)) { return null; }

    const selection = window.getSelection();
    if (selection?.anchorNode && selection.focusNode &&
        element.contains(selection.anchorNode) && element.contains(selection.focusNode)) {
      session.selection = {
        anchor: getTextOffsetWithinElement(element, selection.anchorNode, selection.anchorOffset),
        focus: getTextOffsetWithinElement(element, selection.focusNode, selection.focusOffset),
      };
    }
    session.typingFlags = typingFlags;
    const newText = trimNewline(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerText);
    // Do not overwrite a split/join or toolbar change with unchanged, stale DOM.
    if (newText == session.lastText) { return session; }
    session.lastText = newText;
    if (modelText(getStore(), item, session.info) == newText) {
      markDirty(item, session.field);
      return session;
    }

    const info = session.info;
    if (info.itemType == ItemType.Search) {
      setQueryText(getStore(), item.id, newText.replace(/\u200B/g, ""));
    } else if (info.colNum != null) {
      const columns = info.itemType == ItemType.Page ? asPageItem(item).tableColumns : asTableItem(item).tableColumns;
      if (columns[info.colNum] == null) { return session; }
      columns[info.colNum].name = newText;
    } else if (info.itemType == ItemType.Note) {
      setNoteTitleFromEditedText(asNoteItem(item), newText, typingFlags);
    } else if (info.itemType == ItemType.Password) {
      asPasswordItem(item).text = newText;
    } else {
      asTitledItem(item).title = newText;
    }
    markDirty(item, session.field);
    return session;
  };

  const captureActive = () => {
    if (active == null) { return; }
    const element = document.getElementById(textEditElementId(active.info));
    if (element instanceof HTMLElement) {
      const selectionInfo = getStore().overlay.noteTextSelectionInfo.get();
      captureInput(element, selectionInfo?.itemPath == active.info.itemPath ? selectionInfo.typingFlags : active.typingFlags);
    }
  };

  const flushActive = () => {
    captureActive();
    if (active == null) { return; }
    const item = itemState.get(active.itemId);
    if (item != null) {
      itemState.sortParentChildrenIfTitleOrdered(item);
      void savePending(item.id);
    }
  };

  const changeTarget = (info: TextEditInfo | null) => {
    if (active != null && info?.itemPath == active.info.itemPath && info.colNum == active.info.colNum && info.itemType == active.info.itemType) {
      return;
    }
    // Navigation may end an edit before the browser delivers compositionend.
    // Capture the current DOM once while the old host still exists.
    if (active != null) { active.isComposing = false; }
    flushActive();
    if (active != null) {
      const item = itemState.get(active.itemId);
      if (isClipboardTextCreateItem(item)) {
        finishPendingClipboardTextItem(getStore(), active.info.itemPath, active.lastText);
      }
    }
    active = null;
    if (info == null) { return; }
    const itemId = VeFns.veidFromPath(info.itemPath).itemId;
    const item = itemState.get(itemId);
    if (item == null) { return; }
    active = {
      info: { ...info }, itemId,
      field: info.colNum != null ? `column:${info.colNum}` : info.itemType == ItemType.Password ? "text" : "title",
      selection: null, lastText: modelText(getStore(), item, info), typingFlags: 0, inputRevision: 0, isComposing: false,
    };
  };

  const flush = async (): Promise<boolean> => {
    captureActive();
    await Promise.all([...pending.keys()].map(async id => {
      await savePending(id);
      // Also drain text entered while an earlier revision was in flight.
      while (pending.has(id) && !pending.get(id)!.failed) {
        await savePending(id);
      }
    }));
    return pending.size == 0;
  };

  return {
    activeSession: () => active,
    changeTarget,
    captureInput,
    beginComposition: (element, typingFlags) => {
      if (active == null || element.id != textEditElementId(active.info) || active.isComposing) { return; }
      active.typingFlags = typingFlags;
      active.isComposing = true;
      ++active.inputRevision;
    },
    endComposition: element => {
      if (active == null || element.id != textEditElementId(active.info) || !active.isComposing) { return null; }
      active.isComposing = false;
      return captureInput(element, active.typingFlags);
    },
    flushActive,
    saveItem: (item, immediately = true) => {
      markDirty(item);
      if (immediately) { void savePending(item.id); }
    },
    preserveUnsavedFields: item => {
      const save = pending.get(item.id);
      if (save == null || save.item.itemType != item.itemType || save.item.origin != item.origin) { return; }
      // A page load can refresh items even while periodic container sync is paused.
      // Keep only the locally edited fields; accept unrelated server updates.
      for (const field of save.fields) {
        if (field == "title") {
          asTitledItem(item).title = asTitledItem(save.item).title;
          if (item.itemType == ItemType.Note) {
            asNoteItem(item).inlineMarks = asNoteItem(save.item).inlineMarks.map(mark => ({ ...mark }));
            asNoteItem(item).urls = asNoteItem(save.item).urls.map(url => ({ ...url }));
          }
        } else if (field == "text") {
          asPasswordItem(item).text = asPasswordItem(save.item).text;
        } else if (field.startsWith("column:")) {
          const colNum = Number(field.substring("column:".length));
          const columns = item.itemType == ItemType.Page ? asPageItem(item).tableColumns : asTableItem(item).tableColumns;
          const oldColumns = item.itemType == ItemType.Page ? asPageItem(save.item).tableColumns : asTableItem(save.item).tableColumns;
          if (columns[colNum] && oldColumns[colNum]) { columns[colNum].name = oldColumns[colNum].name; }
        }
      }
      save.item = item;
    },
    flush,
    unsavedCount,
    failedSaveCount,
    clear: () => {
      active = null;
      for (const save of pending.values()) { cancelTimer(save); }
      pending.clear();
      updateStatus();
    },
  };
}
