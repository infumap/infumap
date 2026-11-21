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


import { trimNewline } from "./string";

/** Note whitespace is content. Only DOM filler breaks are omitted, never text
 * characters (including NBSP, tabs, or trailing newlines).
 */
export function readNoteEditableText(root: Node): string {
  let text = "";
  const children = Array.from(root.childNodes);
  for (let i = 0; i < children.length; ++i) {
    const child = children[i];
    if (child.nodeType == Node.TEXT_NODE) {
      text += child.textContent ?? "";
    } else if (child instanceof HTMLElement) {
      if (child.tagName == "BR") {
        // Browsers may leave an unmarked final BR after deleting/typing text.
        if (!child.hasAttribute("data-note-placeholder") && i < children.length - 1) { text += "\n"; }
      } else {
        const block = child.tagName == "DIV" || child.tagName == "P";
        if (block && i > 0 && !text.endsWith("\n")) { text += "\n"; }
        text += readNoteEditableText(child);
        if (block && i < children.length - 1) { text += "\n"; }
      }
    }
  }
  return text;
}

export function readEditableText(element: HTMLElement): string {
  if (element.hasAttribute("data-note-editor")) { return readNoteEditableText(element); }
  return trimNewline(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? element.value : element.innerText);
}

/** Every kind of line break as \n, the only one note text holds. */
export function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?|[\u2028\u2029]/g, "\n");
}

/**
 * Pasted text for a field that holds one line, such as a title. Each run of whitespace with a line break in it becomes
 * a space, as do tabs. The whitespace around the text is dropped: it's almost always an artifact of the copy, such as a
 * terminal line's newline. A password keeps the spaces around it, which can be part of it, and drops only line breaks.
 */
export function singleLineTextForPaste(text: string, keepOuterSpaces: boolean = false): string {
  const normalized = normalizeLineBreaks(text);
  const outerTrimmed = keepOuterSpaces ? normalized.replace(/^\n+|\n+$/g, "") : normalized.trim();
  return outerTrimmed.replace(/\s*\n\s*/g, " ").replace(/\t/g, " ");
}

/**
 * newText, an edit of oldText that inserted text with line breaks in it (a drop can), with each run of whitespace with
 * a line break in the inserted text made a space, and where the inserted text now ends. Null if no line break was
 * inserted. Only the inserted text changes, so a line break the text already had stays.
 */
export function joinInsertedLineBreaks(oldText: string, newText: string): { text: string, insertedEnd: number } | null {
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] == newText[prefix]) { ++prefix; }
  let suffix = 0;
  while (suffix < Math.min(oldText.length, newText.length) - prefix &&
         oldText[oldText.length - 1 - suffix] == newText[newText.length - 1 - suffix]) { ++suffix; }
  const inserted = newText.substring(prefix, newText.length - suffix);
  if (!inserted.includes("\n")) { return null; }
  const joined = inserted.replace(/\s*\n\s*/g, " ");
  return { text: newText.substring(0, prefix) + joined + newText.substring(newText.length - suffix), insertedEnd: prefix + joined.length };
}
