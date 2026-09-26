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

export function normalizeClipboardLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function clipboardTextForSingleLine(text: string): string {
  return normalizeClipboardLineEndings(text).replace(/[\n\t\u2028\u2029]/g, " ");
}
