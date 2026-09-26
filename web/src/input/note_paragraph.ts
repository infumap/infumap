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

import { NoteFns, splitNoteInlineMarks, splitNoteUrls, type NoteItem } from "../items/note-item";

/** Describe a paragraph split before mutating the model or changing edit focus.
 * Both document/composite and spatial note editors use the same selection rules.
 */
export function planNoteParagraphSplit(note: NoteItem, start: number, end: number) {
  if (start < 0 || start > end || end > note.title.length) { return null; }
  return {
    note,
    beforeText: note.title.substring(0, start),
    afterText: note.title.substring(end),
    beforeInlineMarks: splitNoteInlineMarks(note.inlineMarks, note.title, start)[0],
    afterInlineMarks: splitNoteInlineMarks(note.inlineMarks, note.title, end)[1],
    beforeUrls: splitNoteUrls(note.urls, note.title, start)[0],
    afterUrls: splitNoteUrls(note.urls, note.title, end)[1],
    continuationFlags: NoteFns.listContinuationFlagsForEnter(note),
  };
}
