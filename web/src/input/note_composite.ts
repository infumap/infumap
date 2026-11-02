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

import { ItemType } from "../items/base/item";
import { CompositeFns, CompositeItem } from "../items/composite-item";
import { NoteItem } from "../items/note-item";
import { arrangeNow } from "../layout/arrange";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VeFns, VisualElement, VisualElementFlags, VisualElementPath } from "../layout/visual-element";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { setCaretPosition } from "../util/caret";
import { newOrdering } from "../util/ordering";
import { Uid } from "../util/uid";
import { HistoryToken } from "./editor_history";


/**
 * Put a note that is not in a composite into a new composite that takes its place, as part of the undo step token.
 * The note's text edit must already be finished: its editor is replaced when the note moves.
 */
export function wrapNoteInNewComposite(store: StoreContextModel, note: NoteItem, token: HistoryToken | null): CompositeItem {
  const composite = CompositeFns.create(note.ownerId, note.parentId, note.relationshipToParent, note.ordering);
  // The composite takes the note's place, pin included.
  composite.pinnedTo = note.pinnedTo;
  composite.spatialPositionGr = note.spatialPositionGr;
  composite.spatialWidthGr = note.spatialWidthGr;
  store.editorHistory.include(token, composite.id);
  itemState.add(composite);
  store.editorHistory.track(server.addItem(composite, null));
  itemState.moveToNewParent(note, composite.id, RelationshipToParent.Child, newOrdering());
  return composite;
}

/**
 * After an arrange, edit a note in the composite that wrapNoteInNewComposite made from noteVe, with the caret at
 * caretPosition. A popup showing the wrapped note is redirected to show the composite. Returns the path of the note.
 */
export function editNoteInNewComposite(
  store: StoreContextModel,
  noteVe: VisualElement,
  compositeId: Uid,
  noteId: Uid,
  caretPosition: number,
): VisualElementPath {
  const compositeVeid = { itemId: compositeId, linkIdMaybe: null };
  if (noteVe.flags & VisualElementFlags.Popup) {
    store.history.replacePopup({
      actualVeid: compositeVeid,
      vePath: VeFns.addVeidToPath(compositeVeid, noteVe.parentPath!)
    });
    arrangeNow(store, "new-composite-redirect-popup");
  }

  const veid = { itemId: noteId, linkIdMaybe: null };
  const pagePath = store.history.currentPagePath();
  const attemptToSetEditFocus = (attempt: number = 0) => {
    if (itemState.get(noteId) == null || store.editorHistory.busy() || store.history.currentPagePath() != pagePath) { return; }
    const foundVes = VesCache.render.find(veid);
    if (foundVes.length > 0) {
      store.overlay.setTextEditInfo(store.history, { itemPath: VeFns.veToPath(foundVes[0].get()), itemType: ItemType.Note });
      let editingDomId = store.overlay.textEditInfo()!.itemPath + ":title";
      let textElement = document.getElementById(editingDomId);
      if (textElement) {
        setCaretPosition(textElement, caretPosition);
        textElement.focus();
      }
    } else if (attempt < 3) {
      // Retry with another arrange - needed for popups
      setTimeout(() => {
        arrangeNow(store, "new-composite-retry-find-new-editor");
        attemptToSetEditFocus(attempt + 1);
      }, 10);
    }
  };

  attemptToSetEditFocus();
  const compositePath = VeFns.addVeidToPath(compositeVeid, noteVe.parentPath!);
  return VeFns.addVeidToPath(veid, compositePath);
}
