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

// Shared by mouse_down.ts (what a press does) and mouse_move.ts (the cursor that says so), which can't import each other.

import { itemCanEdit } from "../items/base/capabilities-item";
import { isInsideDocumentPageClickContext } from "../items/base/item-common-fns";
import { isNote } from "../items/note-item";
import { HitboxFlags } from "../layout/hitbox";
import { VeFns, VisualElement, VisualElementFlags } from "../layout/visual-element";
import { HitInfoFns } from "./hit";

export function isNoteInsideDocumentArrangedPage(visualElement: VisualElement): boolean {
  if (!isNote(visualElement.displayItem)) {
    return false;
  }

  return isInsideDocumentPageClickContext(visualElement);
}

export function noteBodyClick(hitVe: VisualElement, hitInfo: ReturnType<typeof HitInfoFns.hit>): boolean {
  if (!isNote(hitVe.displayItem)) {
    return false;
  }
  if (hitInfo.overElementMeta?.compositeMoveOut) {
    return false;
  }

  const blockedHitboxes =
    HitboxFlags.Move |
    HitboxFlags.Resize |
    HitboxFlags.WidthResize |
    HitboxFlags.OpenPopup |
    HitboxFlags.OpenAttachment |
    HitboxFlags.TriangleLinkSettings;

  return !!(hitInfo.hitboxType & HitboxFlags.Click) &&
    !(hitInfo.hitboxType & blockedHitboxes);
}

export function documentNoteBodyClick(hitVe: VisualElement, hitInfo: ReturnType<typeof HitInfoFns.hit>): boolean {
  return isNoteInsideDocumentArrangedPage(hitVe) && noteBodyClick(hitVe, hitInfo);
}

/**
 * A press on the body of a note in a read-only document, including its margins and the gaps beside it, which starts
 * a text selection. Not a table row: a press on a table hits the table, and only its cells' text selects (mouse_down.ts).
 */
export function readOnlyDocumentNoteBodyClick(hitVe: VisualElement, hitInfo: ReturnType<typeof HitInfoFns.hit>): boolean {
  return !(hitVe.flags & VisualElementFlags.InsideTable) &&
    !itemCanEdit(VeFns.treeItem(hitVe)) && documentNoteBodyClick(hitVe, hitInfo);
}
