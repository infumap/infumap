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
import { asNoteItem, isNote, NoteFns } from "../items/note-item";
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
 * blank row behind. Other page types position notes spatially, where an empty note is a deliberate placement.
 */
export function isEmptyNoteCleanupContext(ve: VisualElement): boolean {
  if (ve.flags & VisualElementFlags.InsideTable) { return true; }
  const parentVe = ve.parentPath ? VesCache.current.readNode(ve.parentPath) : null;
  if (parentVe == null || !isPage(parentVe.displayItem)) { return false; }
  const arrangeAlgorithm = parentVe.linkItemMaybe?.overrideArrangeAlgorithm ?? asPageItem(parentVe.displayItem).arrangeAlgorithm;
  return arrangeAlgorithm == ArrangeAlgorithm.Calendar;
}

/** Called after the edit target has changed, so reactive readers no longer depend on the removed note. */
export function deleteEmptyNoteMaybe(store: StoreContextModel, ve: VisualElement, selection: EditorSelection): boolean {
  const path = VeFns.veToPath(ve);
  const item = itemState.get(ve.displayItem.id);
  if (item == null || !isNote(item) || !isEmptyNoteCleanupContext(ve) || ve.linkItemMaybe != null ||
      item.origin != null || item.clientOnly || item.ownerId != store.user.getUserMaybe()?.userId ||
      item.parentId != ve.displayItem.parentId || item.relationshipToParent != ve.displayItem.relationshipToParent ||
      !itemCanEdit(item) || !itemCanMove(item) || store.editorHistory.busy() ||
      store.textEdit.activeSession()?.itemId == item.id) { return false; }

  const note = asNoteItem(item);
  // An empty title alone doesn't make a note invisible: icons, list markers, and attachments still carry meaning.
  if (note.title.trim() != "" || note.computed_attachments.length != 0 || note.groupId != null ||
      NoteFns.showsIcon(note, NoteFns.iconRenderContextFromVisualElement(ve)) ||
      noteHasListStyle(note.flags) || (note.flags & NoteFlags.ShowCopyIcon)) { return false; }

  const parent = itemState.get(note.parentId);
  if (parent == null || parent.origin != null || parent.clientOnly || !itemCanEdit(parent)) { return false; }
  let placeholder = null;
  if (note.relationshipToParent == RelationshipToParent.Attachment) {
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

  const snapshot = ItemFns.fromObject(ItemFns.toObject(note), note.origin);
  const token = store.editorHistory.begin([parent.id, note.id, ...(placeholder ? [placeholder.id] : [])], "Remove empty note", selection);
  if (store.history.getFocusPathMaybe() == path) {
    store.history.setFocus(ve.parentPath ?? store.history.currentPagePath()!);
  }
  itemState.delete(note.id);
  if (placeholder != null) { itemState.add(placeholder); }
  store.editorHistory.commit(token);
  requestArrange(store, "remove-empty-note");

  const persist = async () => {
    let placeholderAdded = false;
    try {
      if (placeholder != null) {
        await server.addItem(placeholder, null);
        placeholderAdded = true;
      }
      await server.deleteItem(note.id);
    } catch (error) {
      if (placeholder != null) {
        if (placeholderAdded) {
          await server.deleteItem(placeholder.id).catch(rollbackError => console.warn("Could not remove empty-cell placeholder:", rollbackError));
        }
        if (itemState.get(placeholder.id) != null) { itemState.delete(placeholder.id); }
      }
      if (itemState.get(note.id) == null && itemState.get(parent.id) != null) { itemState.add(snapshot); }
      requestArrange(store, "restore-empty-note");
      store.editorHistory.message("The empty note could not be removed.");
      throw error;
    }
  };
  void store.editorHistory.track(persist()).catch(() => {});
  return true;
}
