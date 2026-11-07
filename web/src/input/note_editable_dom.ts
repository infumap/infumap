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

import { NoteInlineMarkFlags, noteInlineTextSegments, safeNoteLinkUrl, type NoteItem } from "../items/note-item";
import { getTextOffsetWithinElement, resolveTextRangePosition, setDirectionalTextSelection, textSelectionOffsets } from "../util/caret";

/** The editor owns its children; Solid owns only the host and its layout/styles.
 * Leave native text nodes alone when their contents and formatting already match.
 * Reconcile only at an explicit render boundary, never during composition.
 * A selection reaching outside the note blocks a background render, but a command that changed the note itself, such
 * as formatting that selection, passes renderThroughCrossItemSelection to show the change and keep the selection.
 */
export function reconcileNoteEditableDom(element: HTMLElement, note: NoteItem, renderThroughCrossItemSelection: boolean = false): void {
  const content = document.createDocumentFragment();
  for (const segment of noteInlineTextSegments(note.inlineMarks, note.urls, note.title)) {
    const span = document.createElement("span");
    if (segment.flags & NoteInlineMarkFlags.Bold) { span.style.fontWeight = "bold"; }
    if (segment.flags & NoteInlineMarkFlags.Italic) { span.style.fontStyle = "italic"; }
    if (safeNoteLinkUrl(segment.url) != null) {
      span.className = "text-blue-600";
      span.style.cursor = "text";
    }
    span.textContent = segment.text;
    content.append(span);
  }
  if (note.title == "" || note.title.endsWith("\n")) {
    const placeholder = document.createElement("br");
    placeholder.setAttribute("data-note-placeholder", "");
    content.append(placeholder);
  }
  const children = Array.from(content.childNodes);
  if (element.childNodes.length == children.length &&
      children.every((child, index) => child.isEqualNode(element.childNodes[index]))) { return; }

  const selection = window.getSelection();
  const offsets = textSelectionOffsets(element);
  const anchorInside = selection?.anchorNode != null && element.contains(selection.anchorNode);
  const focusInside = selection?.focusNode != null && element.contains(selection.focusNode);
  if (offsets == null && selection && (anchorInside || focusInside)) {
    // A cross-item selection must not be disturbed by a background render.
    if (!renderThroughCrossItemSelection) { return; }
    // The end outside the note is untouched by replacing its children, so only the end inside needs restoring.
    const keep = (inside: boolean, node: Node, offset: number) => inside
      ? { inside, node, offset: Math.min(getTextOffsetWithinElement(element, node, offset), note.title.length) }
      : { inside, node, offset };
    const anchor = keep(anchorInside, selection.anchorNode!, selection.anchorOffset);
    const focus = keep(focusInside, selection.focusNode!, selection.focusOffset);
    element.replaceChildren(content);
    const resolve = (end: typeof anchor) => end.inside ? resolveTextRangePosition(element, end.offset) : end;
    const anchorPosition = resolve(anchor);
    const focusPosition = resolve(focus);
    selection.setBaseAndExtent(anchorPosition.node, anchorPosition.offset, focusPosition.node, focusPosition.offset);
    return;
  }
  element.replaceChildren(content);
  if (offsets != null) {
    setDirectionalTextSelection(element, Math.min(offsets.anchor, note.title.length), Math.min(offsets.focus, note.title.length));
  }
}
