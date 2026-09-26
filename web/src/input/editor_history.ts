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

import { createSignal } from "solid-js";
import { ItemFns } from "../items/base/item-polymorphism";
import { ItemType, type Item } from "../items/base/item";
import { itemCanEdit, itemCanMove } from "../items/base/capabilities-item";
import { asContainerItem, isContainer } from "../items/base/container-item";
import { itemState } from "../store/ItemState";
import type { StoreContextModel } from "../store/StoreProvider";
import { TransientMessageType, type TextEditInfo } from "../store/StoreProvider_Overlay";
import { VesCache } from "../layout/ves-cache";
import { arrangeNow } from "../layout/arrange";
import { server, serverOrRemote } from "../server";
import { EditElementType, editPathInfoToDomId, getEditPathInfoForNode, getTextOffsetWithinElement, resolveTextRangePosition, type EditPathInfo } from "../util/caret";

// History is deliberately bounded and page-local. Assets and arbitrary item
// deletion are not history operations; only notes/composites may be recreated.
const MAX_ENTRIES = 100;
const MAX_BYTES = 8 * 1024 * 1024;
const GROUP_DELAY_MS = 900;
const GROUP_DURATION_MS = 5000;
type Data = Record<string, any>;
type Snapshot = { data: Data, origin: string | null, children: string[] | null, attachments: string[] | null };
type Endpoint = { path: EditPathInfo, offset: number };
export type EditorSelection = { info: TextEditInfo | null, anchor: Endpoint | null, focus: Endpoint | null, focusPath: string | null };
export type HistoryToken = {
  before: Map<string, Snapshot | null>, selection: EditorSelection, label: string,
  group?: string, epoch: number, started: number,
};
type Change = { id: string, before: Snapshot | null, after: Snapshot | null, fields: string[] };
type Entry = { changes: Change[], before: EditorSelection, after: EditorSelection, label: string, group?: string, started: number, ended: number };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const dataKeys = (data: Data) => Object.keys(data).filter(key => key !== "lastModifiedDate");

function snapshot(id: string): Snapshot | null {
  const item = itemState.get(id);
  if (item == null) { return null; }
  return {
    data: clone(ItemFns.toObject(item)) as Data, origin: item.origin,
    children: isContainer(item) ? [...asContainerItem(item).computed_children] : null,
    attachments: "computed_attachments" in item ? [...(item as any).computed_attachments] : null,
  };
}

export function captureEditorSelection(store: StoreContextModel): EditorSelection {
  const selection = window.getSelection();
  const endpoint = (node: Node | null | undefined, offset: number): Endpoint | null => {
    if (!node) { return null; }
    const path = getEditPathInfoForNode(node);
    if (!path) { return null; }
    const element = document.getElementById(editPathInfoToDomId(path));
    return element ? { path, offset: getTextOffsetWithinElement(element, node, offset) } : null;
  };
  const info = store.overlay.textEditInfo();
  let anchor = endpoint(selection?.anchorNode, selection?.anchorOffset ?? 0);
  let focus = endpoint(selection?.focusNode, selection?.focusOffset ?? 0);
  // Toolbar controls can take the DOM selection; the overlay keeps the note range.
  const noteSelection = store.overlay.noteTextSelectionInfo.get();
  if ((!anchor || !focus) && info?.colNum == null && noteSelection?.itemPath == info?.itemPath && noteSelection) {
    const path: EditPathInfo = { path: noteSelection.itemPath, type: EditElementType.Title, colNumMaybe: null };
    anchor = { path, offset: noteSelection.start };
    focus = { path, offset: noteSelection.end };
  }
  return {
    info: info ? { ...info } : null,
    anchor, focus,
    focusPath: store.history.getFocusPathMaybe(),
  };
}

export function historyOwnsTextEdit(info: TextEditInfo | null): boolean {
  return info != null && info.colNum == null && (info.itemType == ItemType.Note || info.itemType == ItemType.Page);
}

export function historyCaret(info: TextEditInfo, offset: number): EditorSelection {
  const path = getEditPathInfoForNode(document.getElementById(info.itemPath + ":title")!);
  // Structural commands can refer to a new note before it has rendered.
  const endpoint: Endpoint = { path: path ?? { path: info.itemPath, type: EditElementType.Title, colNumMaybe: null }, offset };
  return { info: { ...info }, anchor: endpoint, focus: endpoint, focusPath: info.itemPath };
}

function restoreSelection(store: StoreContextModel, saved: EditorSelection): void {
  arrangeNow(store, "editor-history");
  if (saved.info && VesCache.current.readNode(saved.info.itemPath)) {
    store.overlay.setTextEditInfo(store.history, saved.info);
    const element = document.getElementById(saved.info.itemPath + (saved.info.colNum == null ? ":title" : ":col" + saved.info.colNum));
    element?.focus({ preventScroll: true });
  } else if (saved.focusPath && VesCache.current.readNode(saved.focusPath)) {
    store.history.setFocus(saved.focusPath);
  }
  if (saved.anchor && saved.focus) {
    const anchorEl = document.getElementById(editPathInfoToDomId(saved.anchor.path));
    const focusEl = document.getElementById(editPathInfoToDomId(saved.focus.path));
    if (anchorEl && focusEl) {
      const anchor = resolveTextRangePosition(anchorEl, saved.anchor.offset);
      const focus = resolveTextRangePosition(focusEl, saved.focus.offset);
      window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    }
  }
  store.touchToolbar();
}

/** Toolbar formatting shares the keyboard command path: flush input, record the change, save through the queue. */
export function applyEditorFormatCommand(store: StoreContextModel, items: Item[], label: string, mutate: () => void, group?: string): void {
  if (store.editorHistory.busy()) { return; }
  store.textEdit.flushActive();
  const selection = captureEditorSelection(store);
  const token = store.editorHistory.begin(items.map(item => item.id), label, selection,
    group ? `${group}:${items.map(item => item.id).join(",")}` : undefined);
  mutate();
  for (const item of items) { store.textEdit.saveItem(item, true); }
  store.editorHistory.commit(token, selection);
  store.touchToolbar();
}

export function makeEditorHistory(getStore: () => StoreContextModel) {
  let undo: Entry[] = [];
  let redo: Entry[] = [];
  let epoch = 0;
  let groupEpoch = 0;
  let recording = true;
  let failedWrite = false;
  const writes = new Set<Promise<unknown>>();
  const [busy, setBusy] = createSignal(false);
  const [undoLabel, setUndoLabel] = createSignal<string | null>(null);
  const [redoLabel, setRedoLabel] = createSignal<string | null>(null);
  const refresh = () => { setUndoLabel(undo.at(-1)?.label ?? null); setRedoLabel(redo.at(-1)?.label ?? null); };
  const message = (text: string) => {
    const value = { text, type: TransientMessageType.Info };
    getStore().overlay.toolbarTransientMessage.set(value);
    setTimeout(() => { if (getStore().overlay.toolbarTransientMessage.get() === value) { getStore().overlay.toolbarTransientMessage.set(null); } }, 4500);
  };
  const clear = () => { ++epoch; ++groupEpoch; undo = []; redo = []; refresh(); };
  const begin = (ids: string[], label: string, selection?: EditorSelection, group?: string): HistoryToken | null => {
    if (!recording || busy()) { return null; }
    return { before: new Map(ids.map(id => [id, snapshot(id)])), selection: selection ?? captureEditorSelection(getStore()),
      label, group: group ? group + ":" + groupEpoch : undefined, epoch, started: Date.now() };
  };
  const include = (token: HistoryToken | null, id: string) => {
    if (token && !token.before.has(id)) { token.before.set(id, snapshot(id)); }
  };
  const commit = (token: HistoryToken | null, selection?: EditorSelection) => {
    if (!token || token.epoch !== epoch || !recording) { return; }
    const changes: Change[] = [];
    for (const [id, before] of token.before) {
      const after = snapshot(id);
      const fields = before && after ? [...new Set([...dataKeys(before.data), ...dataKeys(after.data)])]
        .filter(key => !equal(before.data[key], after.data[key])) : [];
      if (fields.length || !before || !after || !equal(before.children, after.children) || !equal(before.attachments, after.attachments)) {
        if (before || after) { changes.push({ id, before, after, fields }); }
      }
    }
    if (!changes.length) { return; }
    const entry: Entry = { changes, before: token.selection, after: selection ?? captureEditorSelection(getStore()), label: token.label,
      group: token.group, started: token.started, ended: Date.now() };
    const previous = undo.at(-1);
    // Typing continues only from the caret it left; toolbar drags have no text selection.
    if (previous && entry.group && previous.group === entry.group && changes.length === 1 && previous.changes.length === 1 &&
        previous.changes[0].id === changes[0].id && equal(previous.changes[0].after, changes[0].before) &&
        equal(previous.after.anchor, entry.before.anchor) && equal(previous.after.focus, entry.before.focus) &&
        entry.started - previous.ended < GROUP_DELAY_MS && entry.ended - previous.started < GROUP_DURATION_MS) {
      previous.changes[0].after = changes[0].after;
      previous.changes[0].fields = [...new Set([...previous.changes[0].fields, ...changes[0].fields])];
      previous.after = entry.after;
      previous.ended = entry.ended;
    } else { undo.push(entry); }
    redo = [];
    while (undo.length > MAX_ENTRIES || JSON.stringify(undo).length * 2 > MAX_BYTES) { undo.shift(); }
    refresh();
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    writes.add(promise);
    void promise.catch(error => { failedWrite = true; clear(); console.warn("Editor mutation failed:", error); })
      .finally(() => writes.delete(promise));
    return promise;
  };

  const structural = (entry: Entry) => entry.changes.some(c => !c.before || !c.after ||
    c.fields.some(key => ["parentId", "relationshipToParent", "ordering"].includes(key)) || !equal(c.before.children, c.after.children));
  const matches = (entry: Entry, forward: boolean): boolean => {
    const store = getStore();
    const isStructural = structural(entry);
    for (const c of entry.changes) {
      const expected = forward ? c.before : c.after;
      const target = forward ? c.after : c.before;
      const current = snapshot(c.id);
      if (!expected) { if (current) { return false; } }
      else {
        const item = itemState.get(c.id)!;
        if (!current || !itemCanEdit(item) || current.origin !== expected.origin ||
            current.data.itemType !== expected.data.itemType || current.data.ownerId !== expected.data.ownerId) { return false; }
        if (isStructural && (item.origin != null || item.clientOnly || item.ownerId !== store.user.getUserMaybe()?.userId ||
            (c.fields.includes("parentId") && !itemCanMove(item)))) { return false; }
        const fields = !target ? dataKeys(expected.data) : [...new Set([...c.fields, "parentId", "relationshipToParent"])];
        if (fields.some(key => !equal(current.data[key], expected.data[key]))) { return false; }
        if (isStructural && (!equal(current.children, expected.children) || !equal(current.attachments, expected.attachments))) { return false; }
      }
      if (!expected || !target) {
        const value = expected ?? target;
        if (!value || ![ItemType.Note, ItemType.Composite].includes(value.data.itemType) || value.origin != null ||
            value.data.ownerId !== store.user.getUserMaybe()?.userId || (value.attachments?.length ?? 0) > 0) { return false; }
      }
      if (target && (!expected || c.fields.includes("parentId") || c.fields.includes("relationshipToParent"))) {
        const parentChange = entry.changes.find(other => other.id === target.data.parentId);
        const parent = parentChange ? (forward ? parentChange.after : parentChange.before) : snapshot(target.data.parentId);
        if (!parent || (isStructural && (parent.origin != null || parent.data.ownerId !== store.user.getUserMaybe()?.userId))) { return false; }
        const liveParent = itemState.get(target.data.parentId);
        if (liveParent && !itemCanEdit(liveParent)) { return false; }
      }
    }
    return true;
  };

  const replay = async (forward: boolean): Promise<void> => {
    const store = getStore();
    if (busy() || store.textEdit.activeSession()?.isComposing) { return; }
    store.textEdit.flushActive();
    const entry = (forward ? redo : undo).at(-1);
    if (!entry) { return; }
    if (failedWrite || !matches(entry, forward)) { clear(); message("These items changed outside the editor. Undo history has been cleared."); return; }
    const startedEpoch = epoch;
    const isStructural = structural(entry);
    setBusy(true);
    ++groupEpoch;
    try {
      if (isStructural) {
        // Includes chained composite deletion and any last debounced text save.
        while (writes.size) { await Promise.allSettled([...writes]); }
        if (!await store.textEdit.flush()) { message("Save the pending text changes before undoing a paragraph edit."); return; }
        if (epoch !== startedEpoch || failedWrite) { return; }
        if (!matches(entry, forward)) { clear(); message("These items changed outside the editor. Undo history has been cleared."); return; }
      }
      const additions: Snapshot[] = [];
      const updates: { id: string, data: Data, origin: string | null, fields: string[] }[] = [];
      const removals: Snapshot[] = [];
      for (const change of entry.changes) {
        const from = forward ? change.before : change.after;
        const to = forward ? change.after : change.before;
        if (!from && to) { additions.push(to); }
        else if (from && !to) { removals.push(from); }
        else if (to && change.fields.length) {
          const current = snapshot(change.id)!;
          for (const field of change.fields) { current.data[field] = to.data[field] === undefined ? undefined : clone(to.data[field]); }
          updates.push({ id: change.id, data: current.data, origin: current.origin, fields: change.fields });
        }
      }
      // Parents must exist before their children; containers must be empty before deletion.
      const depth = (s: Snapshot, list: Snapshot[], seen = new Set<string>()): number => {
        if (seen.has(s.data.id)) { throw new Error("Cyclic editor history"); }
        seen.add(s.data.id);
        const parent = list.find(value => value.data.id === s.data.parentId);
        return parent ? 1 + depth(parent, list, seen) : 0;
      };
      additions.sort((a, b) => depth(a, additions) - depth(b, additions));
      removals.sort((a, b) => depth(b, removals) - depth(a, removals));
      if (isStructural) {
        // Persist first. UI mutations are held while the asynchronous operation runs.
        for (const value of additions) { await server.addItem(ItemFns.fromObject(value.data, value.origin), null, store.general.networkStatus); }
        for (const value of updates) { await serverOrRemote.updateItem(ItemFns.fromObject(value.data, value.origin), store.general.networkStatus, false); }
        for (const value of removals) { await server.deleteItem(value.data.id, store.general.networkStatus, false); }
        if (epoch !== startedEpoch) { return; }
      }
      recording = false;
      store.overlay.setTextEditInfo(store.history, null);
      store.history.setFocus(store.history.currentPagePath()!);
      for (const value of additions) {
        const item = ItemFns.fromObject(value.data, value.origin);
        if (isContainer(item)) { asContainerItem(item).childrenLoaded = true; }
        itemState.add(item);
      }
      for (const value of updates) {
        const item = itemState.get(value.id)!;
        const parsed = ItemFns.fromObject(value.data, value.origin);
        if (item.parentId !== parsed.parentId || item.relationshipToParent !== parsed.relationshipToParent) {
          itemState.moveToNewParent(item, parsed.parentId, parsed.relationshipToParent, parsed.ordering);
        }
        for (const field of value.fields) { (item as any)[field] = (parsed as any)[field]; }
        itemState.sortParentChildrenIfTitleOrdered(item);
        if (value.fields.includes("ordering")) { itemState.sortChildren(item.parentId); }
        if (!isStructural) { store.textEdit.saveItem(item, true); }
      }
      for (const value of removals) { itemState.delete(value.data.id); }
      (forward ? redo : undo).pop();
      (forward ? undo : redo).push(entry);
      restoreSelection(store, forward ? entry.after : entry.before);
      refresh();
    } catch (error) {
      failedWrite = true;
      clear();
      message("Undo could not be saved. Reload this page before continuing to edit.");
      console.warn("Editor history replay failed:", error);
    } finally { recording = true; setBusy(false); }
  };

  return { begin, include, commit, track, clear, busy, undoLabel, redoLabel,
    breakGroup: () => { ++groupEpoch; },
    undo: () => replay(false), redo: () => replay(true),
    reset: () => { clear(); failedWrite = false; },
    message,
  };
}
export type EditorHistoryStore = ReturnType<typeof makeEditorHistory>;
