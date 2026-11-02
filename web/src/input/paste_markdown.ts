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

import { GRID_SIZE } from "../constants";
import { itemCanMove } from "../items/base/capabilities-item";
import { NoteFlags } from "../items/base/flags-item";
import { GroupFns } from "../items/base/group-item";
import { Item, ItemType } from "../items/base/item";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { DividerFns } from "../items/divider-item";
import { parsePastedMarkdownBlocks, type TextDocumentBlock, type TextDocumentInlineText } from "../items/markdown-blocks";
import {
  NoteFns, NoteInlineMark, NoteInlineMarkFlags, NoteItem, NoteUrl, asNoteItem, concatNoteInlineMarks, concatNoteUrls, isNote,
} from "../items/note-item";
import { asPageItem, isPage } from "../items/page-item";
import { arrangeNow } from "../layout/arrange";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VeFns, VisualElement, VisualElementFlags } from "../layout/visual-element";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { Uid } from "../util/uid";
import { parentChainAllowsNewChild } from "./create";
import {
  type LinearEditContext, currentLinearEditContext, focusItemInLinearContainer, prepareNoteParagraphSplit,
  visualAncestorPageIsClientOnly,
} from "./edit";
import { historyCaret } from "./editor_history";
import { editNoteInNewComposite, wrapNoteInNewComposite } from "./note_composite";
import { CONFIRM_LINE_COUNT, MAX_LINE_COUNT, showPasteMessage } from "./paste_lines";
import { locallyEditable, structuralTextNote } from "./structural_text_edit";


/** The note flags a pasted block sets. The others (alignment, border, copy icon) stay the note's own. */
const BLOCK_STYLE_FLAGS = NoteFlags.Heading1 | NoteFlags.Heading2 | NoteFlags.Heading3 | NoteFlags.Heading4 |
  NoteFlags.Bullet1 | NoteFlags.Numbered | NoteFlags.Indent1 | NoteFlags.Indent2 | NoteFlags.Code;

const TABLE_CELL_SEPARATOR = " | ";

type PastedNote = {
  kind: "note",
  title: string,
  inlineMarks: Array<NoteInlineMark>,
  urls: Array<NoteUrl>,
  flags: number,
};

type PastedPiece = PastedNote | { kind: "divider" };

type PasteTarget =
  { kind: "linear", context: LinearEditContext } |
  { kind: "spatial", noteVe: VisualElement };

/**
 * Paste text into the note being edited as a note for each paragraph in it. With parseMarkdown, the paragraphs are the
 * blocks of markdown in the text: headings, list items, code blocks and lines. Without it, they are its lines as they
 * are. The note keeps the text before the caret, followed by the first paragraph. The text after the caret follows the
 * last paragraph, and the caret ends up between them. A note in a composite or document page gets the new items after
 * it. Any other note is first put into a new composite, as Enter does.
 *
 * Returns false, having changed nothing, when the paste is the caller's to make: the text is one paragraph, the note is
 * a code note (pasted code stays together), or the note is somewhere a paragraph can't be split, such as a table, a
 * link, a list page line, a group or an attachment.
 */
export function pasteParagraphsIntoNote(store: StoreContextModel, element: HTMLElement, text: string, parseMarkdown: boolean): boolean {
  const info = store.overlay.textEditInfo();
  if (info?.itemType != ItemType.Note || info.colNum != null) { return false; }
  const noteVe = VesCache.current.readNode(info.itemPath);
  const item = itemState.get(VeFns.veidFromPath(info.itemPath).itemId);
  if (noteVe == null || item == null || !isNote(item)) { return false; }
  const note = asNoteItem(item);
  if (note.flags & NoteFlags.Code) { return false; }

  const pieces = parseMarkdown ? piecesFromBlocks(parsePastedMarkdownBlocks(text)) : piecesFromLines(text);
  if (pieces.length < 2) { return false; }
  const target = pasteTargetMaybe(store, note, noteVe);
  if (target == null) { return false; }
  // Read the selection before a confirm dialog takes the focus.
  const split = prepareNoteParagraphSplit(store, element);
  if (split == null || split.note.id != note.id) { return false; }

  if (pieces.length > MAX_LINE_COUNT) {
    showPasteMessage(store, `Can't paste ${pieces.length} paragraphs: the limit is ${MAX_LINE_COUNT}.`);
    return true;
  }
  if (pieces.length > CONFIRM_LINE_COUNT && !window.confirm(`Add ${pieces.length} paragraphs?`)) { return true; }

  // piecesFromBlocks never starts or ends with a divider.
  const first = pieces[0] as PastedNote;
  const token = store.editorHistory.begin(
    [note.id, target.kind == "linear" ? target.context.containerVe.displayItem.id : note.parentId], "Paste");
  // Finish the old edit before changing the note, or moving it into a new composite.
  store.overlay.setTextEditInfo(store.history, null);
  const parentId = target.kind == "linear"
    ? target.context.containerVe.displayItem.id
    : wrapNoteInNewComposite(store, note, token).id;

  // A heading or list item pasted at the start of a note makes the note one too.
  if (split.beforeText == "" && (first.flags & BLOCK_STYLE_FLAGS) != 0) {
    note.flags = (note.flags & ~BLOCK_STYLE_FLAGS) | first.flags;
  }
  note.inlineMarks = concatNoteInlineMarks(split.beforeInlineMarks, split.beforeText, first.inlineMarks, first.title);
  note.urls = concatNoteUrls(split.beforeUrls, split.beforeText, first.urls, first.title);
  note.title = split.beforeText + first.title;
  NoteFns.ensureTitleUrl(note);
  store.textEdit.saveItem(note, true);

  let previousId = note.id;
  let caretPosition = 0;
  for (let i = 1; i < pieces.length; ++i) {
    const piece = pieces[i];
    const ordering = itemState.newOrderingDirectlyAfterChild(parentId, previousId);
    let newItem: Item;
    if (piece.kind == "divider") {
      const divider = DividerFns.create(note.ownerId, parentId, RelationshipToParent.Child, ordering, "horizontal");
      divider.spatialWidthGr = dividerWidthGr(parentId, divider.spatialWidthGr);
      divider.spatialHeightGr = GRID_SIZE;
      newItem = divider;
    } else {
      const afterText = i == pieces.length - 1 ? split.afterText : "";
      const afterInlineMarks = i == pieces.length - 1 ? split.afterInlineMarks : [];
      const afterUrls = i == pieces.length - 1 ? split.afterUrls : [];
      const newNote = NoteFns.create(note.ownerId, parentId, RelationshipToParent.Child, piece.title + afterText, ordering);
      // A plain line continues the list the note is in, as if typed followed by Enter.
      newNote.flags = (piece.flags & BLOCK_STYLE_FLAGS) != 0 ? piece.flags : split.continuationFlags;
      newNote.inlineMarks = concatNoteInlineMarks(piece.inlineMarks, piece.title, afterInlineMarks, afterText);
      newNote.urls = concatNoteUrls(piece.urls, piece.title, afterUrls, afterText);
      NoteFns.ensureTitleUrl(newNote);
      caretPosition = piece.title.length;
      newItem = newNote;
    }
    store.editorHistory.include(token, newItem.id);
    itemState.add(newItem);
    store.editorHistory.track(server.addItem(newItem, null));
    previousId = newItem.id;
  }

  arrangeNow(store, "paste-markdown-create-items");
  if (target.kind == "linear") {
    focusItemInLinearContainer(store, target.context.containerPath, previousId, caretPosition);
    store.editorHistory.commit(token);
  } else {
    const notePath = editNoteInNewComposite(store, target.noteVe, parentId, previousId, caretPosition);
    store.editorHistory.commit(token, historyCaret({ itemPath: notePath, itemType: ItemType.Note }, caretPosition));
  }
  return true;
}

function pasteTargetMaybe(store: StoreContextModel, note: NoteItem, noteVe: VisualElement): PasteTarget | null {
  if ((noteVe.flags & (VisualElementFlags.LineItem | VisualElementFlags.InsideTable)) || noteVe.actualLinkItemMaybe != null ||
      visualAncestorPageIsClientOnly(VeFns.veToPath(noteVe))) {
    return null;
  }
  if (noteVe.flags & VisualElementFlags.InsideCompositeOrDoc) {
    const context = currentLinearEditContext(store);
    if (context == null || context.editingPath == context.containerPath ||
        structuralTextNote(store, context.editingVe, context.containerVe)?.id != note.id) {
      return null;
    }
    return { kind: "linear", context };
  }
  if (!locallyEditable(store, note) || !itemCanMove(note) || !locallyEditable(store, itemState.get(note.parentId)) ||
      note.relationshipToParent != RelationshipToParent.Child || GroupFns.effectiveGroupId(note) != null ||
      !parentChainAllowsNewChild(note.parentId)) {
    return null;
  }
  return { kind: "spatial", noteVe };
}

/**
 * The notes and dividers to make from the pasted blocks. Dividers at either end are dropped: they can't hold the text
 * before or after the caret, and a pasted selection that starts or ends on a rule rarely means to add one.
 */
function piecesFromBlocks(blocks: Array<TextDocumentBlock>): Array<PastedPiece> {
  const pieces: Array<PastedPiece> = [];
  for (const block of blocks) {
    if (block.kind == "divider") {
      pieces.push({ kind: "divider" });
    } else if (block.kind == "table") {
      // Each row is a note with its cells side by side, and the header row is bold.
      const header = block.columns.join(TABLE_CELL_SEPARATOR);
      pieces.push({
        kind: "note",
        title: header,
        inlineMarks: [{ start: 0, end: header.length, flags: NoteInlineMarkFlags.Bold }],
        urls: [],
        flags: NoteFlags.None,
      });
      for (const row of block.rows) { pieces.push(noteFromTableCells(row.cells)); }
    } else {
      pieces.push({ kind: "note", title: block.title, inlineMarks: block.inlineMarks, urls: block.urls, flags: block.noteFlags });
    }
  }
  while (pieces.length > 0 && pieces[0].kind == "divider") { pieces.shift(); }
  while (pieces.length > 0 && pieces[pieces.length - 1].kind == "divider") { pieces.pop(); }
  return pieces;
}

/** A note for each line that isn't blank, trimmed. */
function piecesFromLines(text: string): Array<PastedPiece> {
  return text.split(/[\n\u2028\u2029]/)
    .map(line => line.trim())
    .filter(line => line != "")
    .map(title => ({ kind: "note", title, inlineMarks: [], urls: [], flags: NoteFlags.None }));
}

function noteFromTableCells(cells: Array<TextDocumentInlineText>): PastedNote {
  let title = "";
  let inlineMarks: Array<NoteInlineMark> = [];
  let urls: Array<NoteUrl> = [];
  for (const [i, cell] of cells.entries()) {
    const prefix = i == 0 ? "" : title + TABLE_CELL_SEPARATOR;
    inlineMarks = concatNoteInlineMarks(inlineMarks, prefix, cell.inlineMarks, cell.title);
    urls = concatNoteUrls(urls, prefix, cell.urls, cell.title);
    title = prefix + cell.title;
  }
  return { kind: "note", title, inlineMarks, urls, flags: NoteFlags.None };
}

/** A divider spans the document page or composite it is pasted into. */
function dividerWidthGr(parentId: Uid, defaultWidthGr: number): number {
  const parent = itemState.get(parentId);
  if (parent != null && isPage(parent)) { return asPageItem(parent).docWidthBl * GRID_SIZE; }
  if (parent != null && isXSizableItem(parent)) { return asXSizableItem(parent).spatialWidthGr; }
  return defaultWidthGr;
}
