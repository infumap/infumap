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

import { itemCanEdit, itemCanMove } from "../items/base/capabilities-item";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { NoteFlags, noteHasListStyle } from "../items/base/flags-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { ItemIconRenderContext } from "../items/base/icon-item";
import type { Item } from "../items/base/item";
import { asContainerItem, isContainer } from "../items/base/container-item";
import { isNote, NoteFns, type NoteItem } from "../items/note-item";
import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { PlaceholderFns } from "../items/placeholder-item";
import { requestArrange } from "../layout/arrange";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VeFns, VisualElementFlags, type VisualElement } from "../layout/visual-element";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import type { StoreContextModel } from "../store/StoreProvider";
import type { EditorSelection } from "./editor_history";

/**
 * Tables and calendars place a new note in a cell or day before it has any text, so leaving it empty would leave a
 * blank row behind. Document pages append a note on Enter or a click below the text, so leaving it empty would leave
 * trailing blank paragraphs. Other page types position notes spatially, where an empty note is a deliberate placement.
 *
 * The note is created up front and removed afterwards, rather than created on the first keystroke: the text edit
 * session, editor history and structural editing (Enter, Backspace joins) all work on persisted items.
 */
export function isEmptyNoteCleanupContext(ve: VisualElement): boolean {
  if (ve.flags & VisualElementFlags.InsideTable) { return true; }
  const arrangeAlgorithm = parentPageArrangeAlgorithm(ve);
  return arrangeAlgorithm == ArrangeAlgorithm.Calendar || arrangeAlgorithm == ArrangeAlgorithm.Document;
}

function parentPageArrangeAlgorithm(ve: VisualElement): ArrangeAlgorithm | null {
  const parentVe = ve.parentPath ? VesCache.current.readNode(ve.parentPath) : null;
  if (parentVe == null || !isPage(parentVe.displayItem)) { return null; }
  return parentVe.linkItemMaybe?.overrideArrangeAlgorithm ?? asPageItem(parentVe.displayItem).arrangeAlgorithm;
}

/** An empty title alone doesn't make a note invisible: icons, list markers, and attachments still carry meaning. */
function isBlankNote(note: NoteItem, iconContext: ItemIconRenderContext): boolean {
  return note.title.trim() == "" && note.computed_attachments.length == 0 && note.groupId == null &&
    !NoteFns.showsIcon(note, iconContext) && !noteHasListStyle(note.flags) && !(note.flags & NoteFlags.ShowCopyIcon);
}

function isRemovableNote(store: StoreContextModel, item: Item | null | undefined): item is NoteItem {
  return item != null && isNote(item) && item.origin == null && !item.clientOnly &&
    item.ownerId == store.user.getUserMaybe()?.userId && itemCanEdit(item) && itemCanMove(item) &&
    store.textEdit.activeSession()?.itemId != item.id;
}

/**
 * Blank paragraphs in the middle of a document are spacing the author chose, so only the run at the end is removed,
 * and only when the finished note is the last item. That run includes earlier blank notes, which Enter pressed more
 * than once at the end leaves behind: each was left for the next before it was trailing.
 */
function trailingBlankDocumentNotes(store: StoreContextModel, note: NoteItem, parent: Item, iconContext: ItemIconRenderContext): Array<NoteItem> | null {
  if (note.relationshipToParent != RelationshipToParent.Child || !isContainer(parent)) { return null; }
  const children = asContainerItem(parent).computed_children;
  if (children[children.length - 1] != note.id) { return null; }
  const result = [note];
  for (let i = children.length - 2; i >= 0; --i) {
    const sibling = itemState.get(children[i]);
    if (!isRemovableNote(store, sibling) || !isBlankNote(sibling, iconContext)) { break; }
    result.push(sibling);
  }
  return result;
}

/** Called after the edit target has changed, so reactive readers no longer depend on the removed note. */
export function deleteEmptyNoteMaybe(store: StoreContextModel, ve: VisualElement, selection: EditorSelection): boolean {
  const path = VeFns.veToPath(ve);
  const item = itemState.get(ve.displayItem.id);
  if (!isRemovableNote(store, item) || !isEmptyNoteCleanupContext(ve) || ve.linkItemMaybe != null ||
      item.parentId != ve.displayItem.parentId || item.relationshipToParent != ve.displayItem.relationshipToParent ||
      store.editorHistory.busy()) { return false; }

  const note = item;
  const iconContext = NoteFns.iconRenderContextFromVisualElement(ve);
  if (!isBlankNote(note, iconContext)) { return false; }

  const parent = itemState.get(note.parentId);
  if (parent == null || parent.origin != null || parent.clientOnly || !itemCanEdit(parent)) { return false; }
  let notes = [note];
  let placeholder = null;
  if (!(ve.flags & VisualElementFlags.InsideTable) && parentPageArrangeAlgorithm(ve) == ArrangeAlgorithm.Document) {
    const trailing = trailingBlankDocumentNotes(store, note, parent, iconContext);
    if (trailing == null) { return false; }
    notes = trailing;
  } else if (note.relationshipToParent == RelationshipToParent.Attachment) {
    if (!isAttachmentsItem(parent)) { return false; }
    const attachments = asAttachmentsItem(parent).computed_attachments;
    const index = attachments.indexOf(note.id);
    if (index < 0) { return false; }
    // Removing an interior cell outright would move every following attachment into the previous column.
    if (index < attachments.length - 1) {
      placeholder = PlaceholderFns.create(note.ownerId, note.parentId, RelationshipToParent.Attachment, note.ordering);
    }
  } else if (note.relationshipToParent != RelationshipToParent.Child) {
    return false;
  }

  const snapshots = notes.map(n => ItemFns.fromObject(ItemFns.toObject(n), n.origin));
  const label = notes.length == 1 ? "Remove empty note" : "Remove empty notes";
  const token = store.editorHistory.begin([parent.id, ...notes.map(n => n.id), ...(placeholder ? [placeholder.id] : [])], label, selection);
  const focusPath = store.history.getFocusPathMaybe();
  if (focusPath == path || notes.some(n => focusPath != null && VeFns.veidFromPath(focusPath).itemId == n.id)) {
    store.history.setFocus(ve.parentPath ?? store.history.currentPagePath()!);
  }
  for (const n of notes) { itemState.delete(n.id); }
  if (placeholder != null) { itemState.add(placeholder); }
  store.editorHistory.commit(token);
  requestArrange(store, "remove-empty-note");

  const persist = async () => {
    let placeholderAdded = false;
    const deleted = new Set<string>();
    try {
      if (placeholder != null) {
        await server.addItem(placeholder, null);
        placeholderAdded = true;
      }
      for (const n of notes) {
        await server.deleteItem(n.id);
        deleted.add(n.id);
      }
    } catch (error) {
      if (placeholder != null) {
        if (placeholderAdded) {
          await server.deleteItem(placeholder.id).catch(rollbackError => console.warn("Could not remove empty-cell placeholder:", rollbackError));
        }
        if (itemState.get(placeholder.id) != null) { itemState.delete(placeholder.id); }
      }
      for (const snapshot of snapshots) {
        if (!deleted.has(snapshot.id) && itemState.get(snapshot.id) == null && itemState.get(parent.id) != null) {
          itemState.add(snapshot);
        }
      }
      requestArrange(store, "restore-empty-note");
      store.editorHistory.message(notes.length == 1 ? "The empty note could not be removed." : "The empty notes could not all be removed.");
      throw error;
    }
  };
  void store.editorHistory.track(persist()).catch(() => {});
  return true;
}
