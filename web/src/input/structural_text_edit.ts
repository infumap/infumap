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
import { asContainerItem, isContainer } from "../items/base/container-item";
import { itemCanAcceptManualChildren } from "../items/base/flags-item";
import type { Item } from "../items/base/item";
import { GroupFns } from "../items/base/group-item";
import { asNoteItem, isNote, type NoteItem } from "../items/note-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VeFns, type VisualElement } from "../layout/visual-element";
import { itemState } from "../store/ItemState";
import type { StoreContextModel } from "../store/StoreProvider";

function locallyEditable(store: StoreContextModel, item: Item | null): item is Item {
  return item != null && item.origin == null && item.clientOnly !== true &&
    item.ownerId == store.user.getUserMaybe()?.userId && itemCanEdit(item);
}

export function structuralTextContainerIsEditable(store: StoreContextModel, containerVe: VisualElement): boolean {
  const container = itemState.get(containerVe.displayItem.id);
  return locallyEditable(store, container) && isContainer(container) &&
    itemCanEdit(containerVe.displayItem) && containerVe.actualLinkItemMaybe == null &&
    itemCanAcceptManualChildren(container);
}

/** Structural text edits may only consume real, owned notes in this container.
 * Editing the text of other items remains independent of this restriction.
 */
export function structuralTextNote(
  store: StoreContextModel,
  noteVe: VisualElement | null | undefined,
  containerVe: VisualElement,
): NoteItem | null {
  if (noteVe == null || !structuralTextContainerIsEditable(store, containerVe)) { return null; }
  const item = itemState.get(noteVe.displayItem.id);
  if (!locallyEditable(store, item) || !isNote(item) || !itemCanMove(item) ||
      !itemCanEdit(noteVe.displayItem) || !itemCanMove(noteVe.displayItem) ||
      noteVe.actualLinkItemMaybe != null || VeFns.treeItem(noteVe).id != item.id ||
      VeFns.parentPath(VeFns.veToPath(noteVe)) != VeFns.veToPath(containerVe) ||
      item.parentId != containerVe.displayItem.id || item.relationshipToParent != RelationshipToParent.Child ||
      GroupFns.effectiveGroupId(item) != null) {
    return null;
  }
  const container = asContainerItem(itemState.get(containerVe.displayItem.id)!);
  const note = asNoteItem(item);
  return container.computed_children.includes(note.id) && note.computed_attachments.length == 0 ? note : null;
}
