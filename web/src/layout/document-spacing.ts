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

import { NATURAL_BLOCK_SIZE_PX } from "../constants";
import { NoteFlags, noteHasListStyle, noteIndentLevelFromFlags } from "../items/base/flags-item";
import { Item, ItemType } from "../items/base/item";
import { isDivider } from "../items/divider-item";
import { asNoteItem, isNote } from "../items/note-item";
import { isTable } from "../items/table-item";


const pxToBl = (px: number): number => px / NATURAL_BLOCK_SIZE_PX.h;

const DOCUMENT_GAP_4PX_BL = pxToBl(4);
const DOCUMENT_GAP_8PX_BL = pxToBl(8);
const DOCUMENT_GAP_12PX_BL = pxToBl(12);
export const DOCUMENT_GAP_16PX_BL = pxToBl(16);
const DOCUMENT_GAP_24PX_BL = pxToBl(24);
const DOCUMENT_GAP_32PX_BL = pxToBl(32);
export const DOCUMENT_PAGE_TITLE_GAP_BL = DOCUMENT_GAP_24PX_BL;

export function noteHeadingLevel(item: Item): number | null {
  if (!isNote(item)) { return null; }
  const flags = asNoteItem(item).flags;
  if (flags & NoteFlags.Heading1) { return 1; }
  if (flags & NoteFlags.Heading2) { return 2; }
  if (flags & NoteFlags.Heading3) { return 3; }
  if (flags & NoteFlags.Heading4) { return 4; }
  return null;
}

function noteIsListItem(item: Item): boolean {
  return isNote(item) && noteHasListStyle(asNoteItem(item).flags);
}

function noteIsCode(item: Item): boolean {
  return isNote(item) && !!(asNoteItem(item).flags & NoteFlags.Code);
}

function sameListRun(prev: Item, next: Item): boolean {
  if (!noteIsListItem(prev) || !noteIsListItem(next)) { return false; }
  return noteIndentLevelFromFlags(asNoteItem(prev).flags) == noteIndentLevelFromFlags(asNoteItem(next).flags);
}

function gapBeforeHeadingBl(level: number): number {
  if (level == 1) { return DOCUMENT_GAP_32PX_BL; }
  if (level == 2) { return DOCUMENT_GAP_24PX_BL; }
  if (level == 3) { return DOCUMENT_GAP_16PX_BL; }
  return DOCUMENT_GAP_12PX_BL;
}

function gapAfterHeadingBl(level: number, next: Item): number {
  if (isTable(next)) { return DOCUMENT_GAP_12PX_BL; }
  return level <= 2 ? DOCUMENT_GAP_12PX_BL : DOCUMENT_GAP_8PX_BL;
}

function itemIsLargeDocumentObject(item: Item): boolean {
  return item.itemType == ItemType.Image ||
    item.itemType == ItemType.Page ||
    item.itemType == ItemType.Composite;
}

function itemIsCompactDocumentRow(item: Item): boolean {
  return item.itemType == ItemType.File ||
    item.itemType == ItemType.Text ||
    item.itemType == ItemType.Password ||
    item.itemType == ItemType.Rating ||
    item.itemType == ItemType.Search;
}

// Shared by document pages and composites using document typography.
// Callers pass display items so linked notes retain their heading/list spacing.
export function documentGapBetweenBl(prev: Item, next: Item): number {
  const nextHeadingLevel = noteHeadingLevel(next);
  if (nextHeadingLevel != null) { return gapBeforeHeadingBl(nextHeadingLevel); }

  const prevHeadingLevel = noteHeadingLevel(prev);
  if (prevHeadingLevel != null) { return gapAfterHeadingBl(prevHeadingLevel, next); }

  if (sameListRun(prev, next)) { return DOCUMENT_GAP_4PX_BL; }
  if (noteIsListItem(prev) && noteIsListItem(next)) { return DOCUMENT_GAP_8PX_BL; }
  if (noteIsListItem(prev) || noteIsListItem(next)) { return DOCUMENT_GAP_16PX_BL; }

  if (noteIsCode(prev) || noteIsCode(next)) { return DOCUMENT_GAP_16PX_BL; }
  if (isTable(prev) || isTable(next)) { return DOCUMENT_GAP_24PX_BL; }
  if (isDivider(prev) || isDivider(next)) { return DOCUMENT_GAP_16PX_BL; }
  if (itemIsLargeDocumentObject(prev) || itemIsLargeDocumentObject(next)) { return DOCUMENT_GAP_24PX_BL; }
  if (itemIsCompactDocumentRow(prev) || itemIsCompactDocumentRow(next)) { return DOCUMENT_GAP_12PX_BL; }

  return DOCUMENT_GAP_16PX_BL;
}
