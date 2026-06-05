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

import {
  getNoteIndentLevel,
  NOTE_INDENT_MAX_LEVEL,
  noteHasBulletStyle,
  noteHasNumberedStyle,
} from "../items/base/flags-item";
import { Item } from "../items/base/item";
import { asNoteItem, isNote } from "../items/note-item";
import { ItemGeometry } from "./item-geometry";

type FlowListKind = "bullet" | "numbered";

export function assignFlowListItemNumbers(items: Array<{ displayItem: Item, geometry: ItemGeometry }>): void {
  const counters = Array(NOTE_INDENT_MAX_LEVEL + 1).fill(0) as Array<number>;
  const activeKinds = Array(NOTE_INDENT_MAX_LEVEL + 1).fill(null) as Array<FlowListKind | null>;

  const resetFromLevel = (level: number): void => {
    for (let i = level; i <= NOTE_INDENT_MAX_LEVEL; ++i) {
      counters[i] = 0;
      activeKinds[i] = null;
    }
  };

  for (const item of items) {
    item.geometry.listItemNumber = null;
    if (!isNote(item.displayItem)) {
      resetFromLevel(0);
      continue;
    }

    const note = asNoteItem(item.displayItem);
    const level = getNoteIndentLevel(note);
    const kind: FlowListKind | null = noteHasNumberedStyle(note.flags)
      ? "numbered"
      : noteHasBulletStyle(note.flags)
        ? "bullet"
        : null;

    if (kind == null) {
      resetFromLevel(0);
      continue;
    }

    resetFromLevel(level + 1);

    if (kind == "bullet") {
      counters[level] = 0;
      activeKinds[level] = "bullet";
      continue;
    }

    if (activeKinds[level] != "numbered") {
      counters[level] = 0;
    }
    counters[level] += 1;
    activeKinds[level] = "numbered";
    item.geometry.listItemNumber = counters[level];
  }
}
