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
import { asContainerItem } from "../items/base/container-item";
import { NoteFlags } from "../items/base/flags-item";
import { GroupFns } from "../items/base/group-item";
import { Item, ItemType } from "../items/base/item";
import { asXSizableItem } from "../items/base/x-sizeable-item";
import { DividerFns } from "../items/divider-item";
import { parsePastedMarkdownBlocks, type TextDocumentBlock, type TextDocumentTableBlock } from "../items/markdown-blocks";
import {
  NoteFns, NoteInlineMark, NoteItem, NoteUrl, asNoteItem, concatNoteInlineMarks, concatNoteUrls, isNote,
} from "../items/note-item";
import { asPageItem, isPage } from "../items/page-item";
import { createMarkdownTableItems } from "../items/text-document";
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

type PastedNote = {
  kind: "note",
  title: string,
  inlineMarks: Array<NoteInlineMark>,
  urls: Array<NoteUrl>,
  flags: number,
};

type PastedPiece = PastedNote | { kind: "divider" } | { kind: "table", block: TextDocumentTableBlock };

type PasteTarget =
  { kind: "linear", context: LinearEditContext } |
  { kind: "spatial", noteVe: VisualElement };

/**
 * Paste text into the note being edited as a note for each paragraph in it. With parseMarkdown, the paragraphs are the
 * blocks of markdown in the text: headings, list items, code blocks, dividers, tables and lines. Without it, they are its
 * lines as they are. The note keeps the text before the caret, followed by the first paragraph. The text after the caret
 * follows the last paragraph, and the caret ends up between them. A divider or table can't hold text, so at the start
 * of the paste it follows the text before the caret, and at the end it is followed by a note with the text after the
 * caret, which holds the caret. With no text before the caret, the note gives up its place to a leading divider or table
 * rather than staying empty above it. A note in a composite or document page gets the new items next to it. Any other
 * note is first put into a new composite, as Enter does.
 *
 * Returns false, having changed nothing, when the paste is the caller's to make: the text is one paragraph that isn't a
 * table, the note is a code note (pasted code stays together), or the note is somewhere a paragraph can't be split, such
 * as a table, a link, a list page line, a group or an attachment.
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
  if (pieces.length < 2 && !pieces.some(piece => piece.kind == "table")) { return false; }
  const target = pasteTargetMaybe(store, note, noteVe);
  if (target == null) { return false; }
  // Read the selection before a confirm dialog takes the focus.
  const split = prepareNoteParagraphSplit(store, element);
  if (split == null || split.note.id != note.id) { return false; }

  const paragraphCount = pieces.reduce((count, piece) => count + (piece.kind == "table" ? piece.block.rows.length + 1 : 1), 0);
  if (paragraphCount > MAX_LINE_COUNT) {
    showPasteMessage(store, `Can't paste ${paragraphCount} paragraphs: the limit is ${MAX_LINE_COUNT}.`);
    return true;
  }
  if (paragraphCount > CONFIRM_LINE_COUNT && !window.confirm(`Add ${paragraphCount} paragraphs?`)) { return true; }

  // The pieces with the text before and after the caret joined to them, or as notes of their own.
  const before: PastedNote = { kind: "note", title: split.beforeText, inlineMarks: split.beforeInlineMarks, urls: split.beforeUrls, flags: NoteFlags.None };
  const after: PastedNote = { kind: "note", title: split.afterText, inlineMarks: split.afterInlineMarks, urls: split.afterUrls, flags: NoteFlags.None };
  const all = [...pieces];
  if (all[0].kind == "note") {
    all[0] = joinedNotes(before, all[0], all[0].flags);
  } else if (before.title != "") {
    all.unshift(before);
  }
  const lastPiece = all[all.length - 1];
  let caretPosition = 0;
  if (lastPiece.kind == "note") {
    caretPosition = lastPiece.title.length;
    all[all.length - 1] = joinedNotes(lastPiece, after, lastPiece.flags);
  } else {
    all.push(after);
  }
  // The note becomes the first note, and the pieces before it go above it. There is always one: the paste ends with one.
  const noteIndex = all.findIndex(piece => piece.kind == "note");
  const notePiece = all[noteIndex] as PastedNote;

  const token = store.editorHistory.begin(
    [note.id, target.kind == "linear" ? target.context.containerVe.displayItem.id : note.parentId], "Paste");
  // Finish the old edit before changing the note, or moving it into a new composite.
  store.overlay.setTextEditInfo(store.history, null);
  const parentId = target.kind == "linear"
    ? target.context.containerVe.displayItem.id
    : wrapNoteInNewComposite(store, note, token).id;

  // A heading or list item pasted at the start of a note makes the note one too.
  if (split.beforeText == "" && (notePiece.flags & BLOCK_STYLE_FLAGS) != 0) {
    note.flags = (note.flags & ~BLOCK_STYLE_FLAGS) | notePiece.flags;
  }
  note.inlineMarks = notePiece.inlineMarks;
  note.urls = notePiece.urls;
  note.title = notePiece.title;
  NoteFns.ensureTitleUrl(note);
  store.textEdit.saveItem(note, true);

  const addItems = (newItems: Array<Item>): void => {
    for (const newItem of newItems) {
      store.editorHistory.include(token, newItem.id);
      itemState.add(newItem);
      store.editorHistory.track(server.addItem(newItem, null));
    }
  };
  for (let i = 0; i < noteIndex; ++i) {
    const position = asContainerItem(itemState.get(parentId)!).computed_children.indexOf(note.id);
    addItems(itemsForPiece(note, parentId, all[i], itemState.newOrderingAtChildrenPosition(parentId, position, null), split.continuationFlags));
  }
  let previousId = note.id;
  for (let i = noteIndex + 1; i < all.length; ++i) {
    const newItems = itemsForPiece(note, parentId, all[i], itemState.newOrderingDirectlyAfterChild(parentId, previousId), split.continuationFlags);
    addItems(newItems);
    previousId = newItems[0].id;
  }

  arrangeNow(store, "paste-markdown-create-items");
  // The last piece is always a note, which has the caret.
  if (target.kind == "linear") {
    focusItemInLinearContainer(store, target.context.containerPath, previousId, caretPosition);
    store.editorHistory.commit(token);
  } else {
    const notePath = editNoteInNewComposite(store, target.noteVe, parentId, previousId, caretPosition);
    store.editorHistory.commit(token, historyCaret({ itemPath: notePath, itemType: ItemType.Note }, caretPosition));
  }
  return true;
}

/**
 * The new items for a piece pasted next to note in parentId, first the item to put at ordering, then any it contains.
 * A plain line continues the list the note is in, as if typed followed by Enter.
 */
function itemsForPiece(note: NoteItem, parentId: Uid, piece: PastedPiece, ordering: Uint8Array, continuationFlags: number): Array<Item> {
  if (piece.kind == "divider") {
    const divider = DividerFns.create(note.ownerId, parentId, RelationshipToParent.Child, ordering, "horizontal");
    divider.spatialWidthGr = pastedItemWidthGr(parentId);
    divider.spatialHeightGr = GRID_SIZE;
    return [divider];
  }
  if (piece.kind == "table") {
    return createMarkdownTableItems(note.ownerId, parentId, pastedItemWidthGr(parentId), piece.block, ordering);
  }
  const newNote = NoteFns.create(note.ownerId, parentId, RelationshipToParent.Child, piece.title, ordering);
  newNote.flags = (piece.flags & BLOCK_STYLE_FLAGS) != 0 ? piece.flags : continuationFlags;
  newNote.inlineMarks = piece.inlineMarks;
  newNote.urls = piece.urls;
  NoteFns.ensureTitleUrl(newNote);
  return [newNote];
}

function joinedNotes(a: PastedNote, b: PastedNote, flags: number): PastedNote {
  return {
    kind: "note",
    title: a.title + b.title,
    inlineMarks: concatNoteInlineMarks(a.inlineMarks, a.title, b.inlineMarks, b.title),
    urls: concatNoteUrls(a.urls, a.title, b.urls, b.title),
    flags,
  };
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

/** The notes, dividers and tables to make from the pasted blocks. */
function piecesFromBlocks(blocks: Array<TextDocumentBlock>): Array<PastedPiece> {
  return blocks.map((block): PastedPiece => {
    if (block.kind == "divider") { return { kind: "divider" }; }
    if (block.kind == "table") { return { kind: "table", block }; }
    return { kind: "note", title: block.title, inlineMarks: block.inlineMarks, urls: block.urls, flags: block.noteFlags };
  });
}

/** A note for each line that isn't blank, trimmed. */
function piecesFromLines(text: string): Array<PastedPiece> {
  return text.split(/[\n\u2028\u2029]/)
    .map(line => line.trim())
    .filter(line => line != "")
    .map(title => ({ kind: "note", title, inlineMarks: [], urls: [], flags: NoteFlags.None }));
}

/** Dividers and tables span the document page or composite they are pasted into. */
function pastedItemWidthGr(parentId: Uid): number {
  const parent = itemState.get(parentId)!;
  return isPage(parent) ? asPageItem(parent).docWidthBl * GRID_SIZE : asXSizableItem(parent).spatialWidthGr;
}
