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

import { NoteFlags, noteIndentLevelFromFlags } from "../items/base/flags-item";
import { isTitledItem } from "../items/base/titled-item";
import { isDivider } from "../items/divider-item";
import {
  NoteInlineMark, NoteInlineMarkFlags, NoteUrl, asNoteItem, isNote, normalizeNoteInlineMarks, normalizeNoteUrls,
  safeNoteLinkUrl, splitNoteInlineMarks, splitNoteUrls,
} from "../items/note-item";
import { asPageItem, isPage } from "../items/page-item";
import { isPassword } from "../items/password-item";
import { asTextItem, clipboardTextCreateShowsPlaceholder, isText } from "../items/text-item";
import { noteHasBullet, noteHasNumbered } from "../layout/text";
import { VesCache } from "../layout/ves-cache";
import { StoreContextModel } from "../store/StoreProvider";
import { getTextOffsetWithinElement } from "../util/caret";
import { currentLinearEditContext, edit_cutLinearRange, structuralPathsInLinearContainer } from "./edit";


/**
 * The notes of a copy from a composite or document page, for a paste back into Infumap. Its text/plain and text/html
 * are for other apps: html can't hold all of a note (line breaks within it, alignment, code that isn't a separate
 * block), and its plain text holds less. Browsers keep a custom type within themselves, and give it only to pages of the
 * same origin.
 */
export const NOTES_CLIPBOARD_TYPE = "application/x-infumap-notes";

const HEADING_FLAGS = NoteFlags.Heading1 | NoteFlags.Heading2 | NoteFlags.Heading3 | NoteFlags.Heading4;

export type CopiedNote = {
  kind: "note",
  title: string,
  inlineMarks: Array<NoteInlineMark>,
  urls: Array<NoteUrl>,
  flags: number,
  /** The number shown for a numbered list item, for the plain text. Not read from the clipboard. */
  listItemNumber: number | null,
};

export type CopiedPiece = CopiedNote | { kind: "divider" };


/**
 * Copy or cut of a text selection over more than one note of the composite or document page being edited. Returns false,
 * leaving the event alone, for any other selection, including one within a single note.
 *
 * The browser's own copy runs the notes together: they are absolutely positioned elements, so to it they aren't separate
 * blocks. A cut couldn't happen at all: the selection crosses an item boundary.
 */
export function noteClipboardCopyOrCutHandler(store: StoreContextModel, ev: ClipboardEvent): boolean {
  if (ev.clipboardData == null || (ev.type != "copy" && ev.type != "cut")) { return false; }
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) { return false; }
  if (ev.type == "cut" && store.editorHistory.busy()) { return false; }
  const selection = window.getSelection();
  if (selection == null || selection.rangeCount != 1 || selection.isCollapsed) { return false; }
  const context = currentLinearEditContext(store);
  if (context == null) { return false; }
  const range = selection.getRangeAt(0);

  const paths = structuralPathsInLinearContainer(context);
  const titles = paths.map(path => document.getElementById(path + ":title"));
  const selected = titles.flatMap((title, i) => title != null && range.intersectsNode(title) ? [i] : []);
  if (selected.length < 2) { return false; }
  const first = selected[0];
  const last = selected[selected.length - 1];

  // Take the text being typed into the model, which the pieces are read from.
  store.textEdit.flushActive();

  // A boundary outside any note, e.g. after select all, is at the start of the first note or the end of the last.
  const startOffset = boundaryOffset(titles[first]!, range.startContainer, range.startOffset, 0);
  const endOffset = boundaryOffset(titles[last]!, range.endContainer, range.endOffset, Number.MAX_SAFE_INTEGER);

  const pieces: Array<CopiedPiece> = [];
  for (let i = first; i <= last; ++i) {
    const ve = VesCache.current.readNode(paths[i]);
    if (ve == null) { continue; }
    const item = ve.displayItem;
    const from = i == first ? startOffset : 0;
    const to = i == last ? endOffset : Number.MAX_SAFE_INTEGER;
    if (isNote(item)) {
      const note = asNoteItem(item);
      pieces.push(selectedPart(note.title, note.inlineMarks, note.urls, note.flags, ve.listItemNumber, from, to));
    } else if (isPage(item) && i == 0 && paths[0] == context.containerPath) {
      // The document page's title.
      pieces.push(selectedPart(asPageItem(item).title, [], [], NoteFlags.Heading1, null, from, to));
    } else if (isDivider(item)) {
      pieces.push({ kind: "divider" });
    } else if (isTitledItem(item) && !isPassword(item) && !(isText(item) && clipboardTextCreateShowsPlaceholder(asTextItem(item)))) {
      // Another item with its title shown (a text item, file, page, table ...): the selected part of the title, as
      // shown, linked to the item, since that's what clicking the title does. Not the item itself: part of a title
      // selected means nothing as an item, and items are copied by selecting them. A password is left out, so a select
      // all doesn't put it on the clipboard, as is the prompt shown in a text item waiting for a paste.
      const text = selectedTextWithin(range, titles[i]!);
      if (text.trim() == "") { continue; }
      pieces.push({
        kind: "note", title: text, inlineMarks: [], flags: NoteFlags.None, listItemNumber: null,
        urls: [{ start: 0, end: text.length, url: `infumap://${item.id}` }],
      });
    }
    // Items with no title shown (an image shown as a picture ...) have no text selected.
  }
  // A selection that starts at the very end of a note, or ends at the very start of one, touches it without selecting
  // any of its text: leave it out rather than adding an empty paragraph.
  while (pieces.length > 0 && pieces[0].kind == "note" && pieces[0].title == "") { pieces.shift(); }
  while (pieces.length > 0 && pieces[pieces.length - 1].kind == "note" && (pieces[pieces.length - 1] as CopiedNote).title == "") { pieces.pop(); }

  const clipboardData = ev.clipboardData;
  const writeClipboard = () => {
    clipboardData.setData("text/plain", plainTextForPieces(pieces));
    clipboardData.setData("text/html", htmlForPieces(pieces));
    clipboardData.setData(NOTES_CLIPBOARD_TYPE, JSON.stringify(pieces.map(piece => piece.kind == "divider"
      ? piece
      : { kind: "note", title: piece.title, inlineMarks: piece.inlineMarks, urls: piece.urls, flags: piece.flags })));
  };
  if (ev.type == "copy") {
    writeClipboard();
    ev.preventDefault();
    ev.stopImmediatePropagation();
    return true;
  }
  edit_cutLinearRange(store, ev, context, paths[first], startOffset, paths[last], endOffset, writeClipboard);
  return true;
}

/**
 * The pieces of a copy made by noteClipboardCopyOrCutHandler, or null if the clipboard has none. Anything about them
 * that isn't valid is dropped: the clipboard could have been written by another page of this origin.
 */
export function copiedPiecesFromClipboard(clipboardData: DataTransfer): Array<CopiedPiece> | null {
  if (!clipboardData.types.includes(NOTES_CLIPBOARD_TYPE)) { return null; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clipboardData.getData(NOTES_CLIPBOARD_TYPE));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) { return null; }
  const pieces: Array<CopiedPiece> = [];
  for (const raw of parsed) {
    if (raw == null || typeof raw != "object") { continue; }
    if (raw.kind == "divider") { pieces.push({ kind: "divider" }); continue; }
    if (raw.kind != "note" || typeof raw.title != "string") { continue; }
    const title: string = raw.title;
    const inlineMarks = normalizeNoteInlineMarks(
      (Array.isArray(raw.inlineMarks) ? raw.inlineMarks : [])
        .filter((mark: any) => mark != null && typeof mark == "object")
        .map((mark: any) => ({ start: Number(mark.start), end: Number(mark.end), flags: Number(mark.flags) })),
      title);
    const urls = normalizeNoteUrls(
      (Array.isArray(raw.urls) ? raw.urls : [])
        .filter((url: any) => url != null && typeof url == "object")
        .map((url: any) => ({ start: Number(url.start), end: Number(url.end), url: safeNoteLinkUrl(url.url) ?? "" })),
      title);
    const flags = Number.isInteger(raw.flags) ? raw.flags : NoteFlags.None;
    pieces.push({ kind: "note", title, inlineMarks, urls, flags, listItemNumber: null });
  }
  return pieces.length == 0 ? null : pieces;
}

function boundaryOffset(title: HTMLElement, node: Node, offset: number, outside: number): number {
  return title.contains(node) ? getTextOffsetWithinElement(title, node, offset) : outside;
}

/** The text of element within range, as rendered. */
function selectedTextWithin(range: Range, element: Element): string {
  const part = document.createRange();
  part.selectNodeContents(element);
  if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) { part.setStart(range.startContainer, range.startOffset); }
  if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) { part.setEnd(range.endContainer, range.endOffset); }
  return part.toString();
}

function selectedPart(
  title: string, inlineMarks: Array<NoteInlineMark>, urls: Array<NoteUrl>, flags: number, listItemNumber: number | null,
  from: number, to: number,
): CopiedNote {
  const end = Math.min(to, title.length);
  const start = Math.min(from, end);
  const head = title.substring(0, end);
  return {
    kind: "note",
    title: title.substring(start, end),
    inlineMarks: splitNoteInlineMarks(splitNoteInlineMarks(inlineMarks, title, end)[0], head, start)[1],
    urls: splitNoteUrls(splitNoteUrls(urls, title, end)[0], head, start)[1],
    flags,
    listItemNumber,
  };
}

/**
 * As a copy from a read-only document (read_only_document_copy.ts) is: paragraphs separated by a blank line, list items
 * on their own lines with markdown markers. A divider is a markdown one.
 */
function plainTextForPieces(pieces: Array<CopiedPiece>): string {
  let result = "";
  for (let i = 0; i < pieces.length; ++i) {
    const piece = pieces[i];
    if (i > 0) {
      const previous = pieces[i - 1];
      result += isListItem(previous) && isListItem(piece) ? "\n" : "\n\n";
    }
    if (piece.kind == "divider") { result += "---"; continue; }
    if (isListItem(piece)) {
      result += "  ".repeat(noteIndentLevelFromFlags(piece.flags)) +
        (noteHasBullet(piece.flags) ? "- " : `${piece.listItemNumber ?? 1}. `);
    }
    result += piece.title;
  }
  return result;
}

function isListItem(piece: CopiedPiece): boolean {
  return piece.kind == "note" && (noteHasBullet(piece.flags) || noteHasNumbered(piece.flags)) && !(piece.flags & NoteFlags.Code);
}

/** Semantic html, for other apps: headings, nested lists, code blocks, dividers, bold, italic and links. */
function htmlForPieces(pieces: Array<CopiedPiece>): string {
  const root = document.createElement("div");
  // The open lists, outermost first: the one at index i holds the list items of indent level i.
  let lists: Array<HTMLElement> = [];
  for (const piece of pieces) {
    if (piece.kind == "divider") {
      lists = [];
      root.append(document.createElement("hr"));
      continue;
    }
    if (isListItem(piece)) {
      const level = noteIndentLevelFromFlags(piece.flags);
      const tag = noteHasNumbered(piece.flags) ? "ol" : "ul";
      lists = lists.slice(0, level + 1);
      if (lists.length == level + 1 && lists[level].localName != tag) { lists.pop(); }
      while (lists.length < level + 1) {
        const list = document.createElement(tag);
        const parent = lists.length == 0 ? root : (lists[lists.length - 1].lastElementChild ?? lists[lists.length - 1]);
        parent.append(list);
        lists.push(list);
      }
      lists[level].append(inlineElement("li", piece));
      continue;
    }
    lists = [];
    if (piece.flags & NoteFlags.Code) {
      const pre = document.createElement("pre");
      pre.textContent = piece.title;
      root.append(pre);
      continue;
    }
    const heading = piece.flags & HEADING_FLAGS;
    const tag = heading == NoteFlags.Heading1 ? "h1" : heading == NoteFlags.Heading2 ? "h2" : heading == NoteFlags.Heading3 ? "h3" : heading != 0 ? "h4" : "p";
    const element = inlineElement(tag, piece);
    const align = piece.flags & NoteFlags.AlignCenter ? "center" : piece.flags & NoteFlags.AlignRight ? "right" : piece.flags & NoteFlags.AlignJustify ? "justify" : null;
    if (align != null) { element.style.textAlign = align; }
    root.append(element);
  }
  return root.innerHTML;
}

/** An element with the note's text, marks and links, with a br for each line break. */
function inlineElement(tag: string, note: CopiedNote): HTMLElement {
  const element = document.createElement(tag);
  const cuts = new Set([0, note.title.length]);
  for (const mark of note.inlineMarks) { cuts.add(mark.start); cuts.add(mark.end); }
  for (const url of note.urls) { cuts.add(url.start); cuts.add(url.end); }
  const sorted = Array.from(cuts).sort((a, b) => a - b);
  for (let i = 0; i + 1 < sorted.length; ++i) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const flags = note.inlineMarks.find(mark => mark.start <= start && end <= mark.end)?.flags ?? 0;
    const url = note.urls.find(url => url.start <= start && end <= url.end)?.url ?? null;
    let node: Node = textWithLineBreaks(note.title.substring(start, end));
    if (flags & NoteInlineMarkFlags.Italic) { node = wrapped("em", node); }
    if (flags & NoteInlineMarkFlags.Bold) { node = wrapped("strong", node); }
    const safeUrl = safeNoteLinkUrl(url);
    if (safeUrl != null) {
      const a = document.createElement("a");
      a.href = safeUrl;
      a.append(node);
      node = a;
    }
    element.append(node);
  }
  return element;
}

function textWithLineBreaks(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  text.split("\n").forEach((line, i) => {
    if (i > 0) { fragment.append(document.createElement("br")); }
    if (line != "") { fragment.append(document.createTextNode(line)); }
  });
  return fragment;
}

function wrapped(tag: string, node: Node): HTMLElement {
  const element = document.createElement(tag);
  element.append(node);
  return element;
}
