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

import { VisualElementPath } from "../layout/visual-element";
import { Vector } from "./geometry";
import { panic } from "./lang";


/**
 * Set the caret position to @param targetPosition in contentEditable @param el.
 */
export const setCaretPosition = (el: HTMLElement, targetPosition: number) => {
  // implementation as in:
  // https://phuoc.ng/collection/html-dom/get-or-set-the-cursor-position-in-a-content-editable-element/

  const createRange = (node: any, targetPosition: number) => {
    let range = document.createRange();
    range.selectNode(node);
    range.setStart(node, 0);
    let pos = 0;
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current.nodeType === Node.TEXT_NODE) {
        const len = current.textContent.length;
        if (pos + len >= targetPosition) {
          range.setEnd(current, targetPosition - pos);
          return range;
        }
        pos += len;
      } else if (current.childNodes && current.childNodes.length > 0) {
        for (let i = current.childNodes.length - 1; i >= 0; i--) {
          stack.push(current.childNodes[i]);
        }
      }
    }
    // The target position is greater than the length of the contenteditable element.
    range.setEnd(node, node.childNodes.length);
    return range;
  };

  const range = createRange(el, targetPosition);
  range.setStart(range.endContainer, range.endOffset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
};

type TextRangePosition = {
  node: Node,
  offset: number,
};

function resolveTextRangePosition(root: Node, targetPosition: number): TextRangePosition {
  const clampedTargetPosition = Math.max(0, targetPosition);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = clampedTargetPosition;
  let lastTextNode: Node | null = null;

  while (walker.nextNode()) {
    const current = walker.currentNode;
    lastTextNode = current;
    const len = current.textContent?.length ?? 0;
    if (remaining <= len) {
      return { node: current, offset: remaining };
    }
    remaining -= len;
  }

  if (lastTextNode != null) {
    return {
      node: lastTextNode,
      offset: lastTextNode.textContent?.length ?? 0,
    };
  }

  return { node: root, offset: root.childNodes.length };
}

function createTextRange(root: HTMLElement, startPosition: number, endPosition: number): Range {
  const range = document.createRange();
  const start = resolveTextRangePosition(root, startPosition);
  const end = resolveTextRangePosition(root, endPosition);
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}


/**
 * Get the caret position in contentEditable @param el.
 */
export const getCaretPosition = (el: HTMLElement) => {
  // TODO (LOW): consider sel.rangeCount
  const sel = window.getSelection()!;
  const range = sel.getRangeAt(0);
  const clonedRange = range.cloneRange();
  clonedRange.selectNodeContents(el!);
  clonedRange.setEnd(range.endContainer, range.endOffset);
  return clonedRange.toString().length;
}

/**
 * Return a DOMRect for the visual line containing a caret position in a contentEditable element.
 */
export const getCaretLineRect = (el: HTMLElement, targetPosition: number): DOMRect => {
  const textLength = el.textContent?.length ?? 0;
  if (textLength == 0) {
    return el.getBoundingClientRect();
  }

  const clampedPosition = Math.max(0, Math.min(targetPosition, textLength));
  const startPosition = clampedPosition >= textLength
    ? Math.max(0, textLength - 1)
    : clampedPosition;
  const endPosition = clampedPosition >= textLength
    ? textLength
    : Math.min(textLength, startPosition + 1);

  return createTextRange(el, startPosition, endPosition).getBoundingClientRect();
}


/**
 * Determine the closest caret position in element el (note: the first child node must be
 * of type TEXT_NODE) to the specified clientPx position.
 */
export const closestCaretPositionToClientPx = (el: HTMLElement, clientPx: Vector): number => {
  let textNode = null
  for (let i=0; i<el.childNodes.length; ++i) {
    if (el.childNodes[i].nodeType == Node.TEXT_NODE) {
      textNode = el.childNodes[i];
      break;
    }
    if (el.childNodes[i].nodeName != "BR") {
      panic("closestCaretPositionToClientPx: expecting node of type TEXT_NODE or BR element");
    }
  }
  if (!textNode) { return 0; }
  const range = document.createRange();
  let closestDistSq = 10000000.0;
  let closestPos = 0;
  let foundSameLine = false;
  for (let i=0; i<=textNode.textContent!.length; ++i) {
    range.setStart(textNode, i);
    if (i == textNode.textContent!.length) {
      range.setEnd(textNode, i);
    } else {
      range.setEnd(textNode, i+1);
    }
    const bounds = range.getBoundingClientRect();
    const centerPx = { x: bounds.left, y: bounds.top + bounds.height / 2.0 };
    const distSq =
      (clientPx.x - centerPx.x) * (clientPx.x - centerPx.x) +
      (clientPx.y - centerPx.y) * (clientPx.y - centerPx.y);
    const isSameLine = clientPx.y > bounds.top && clientPx.y < bounds.bottom;
    if (distSq < closestDistSq && isSameLine && !foundSameLine) {
      closestDistSq = distSq;
      closestPos = i;
      foundSameLine = true;
    } else if (isSameLine) {
      if (!foundSameLine || distSq < closestDistSq) {
        closestDistSq = distSq;
        closestPos = i;
      }
      foundSameLine = true;
    }
  }
  return closestPos;
}


/**
 * Determine the HTMLElement the caret is currently in.
 */
export const currentCaretElement = (): HTMLElement | null => {
  const selection = window.getSelection();
  if (selection == null || selection.anchorNode == null) { return null; }

  let fallback: HTMLElement | null = null;
  let node: Node | null = selection.anchorNode;
  while (node != null) {
    if (node instanceof HTMLElement) {
      fallback = fallback ?? node;
      if (parseEditPathInfoFromDomId(node.id) != null) {
        return node;
      }
    }
    node = node.parentNode;
  }

  return fallback;
}


export enum EditElementType {
  Title = 0x001,
  Column = 0x002,
}

export interface EditPathInfo {
  path: VisualElementPath,
  type: EditElementType,
  colNumMaybe: number | null,
}

function parseEditPathInfoFromDomId(id: string): EditPathInfo | null {
  if (id.endsWith(":title")) {
    return {
      path: id.substring(0, id.length - ":title".length),
      type: EditElementType.Title,
      colNumMaybe: null,
    };
  }

  const colMatch = id.match(/^(.*):col(\d+)$/);
  if (colMatch != null) {
    return {
      path: colMatch[1],
      type: EditElementType.Column,
      colNumMaybe: parseInt(colMatch[2], 10),
    };
  }

  return null;
}

export function getEditPathInfoForNode(node: Node | null): EditPathInfo | null {
  let current: Node | null = node;
  while (current != null) {
    if (current instanceof HTMLElement) {
      const pathInfo = parseEditPathInfoFromDomId(current.id);
      if (pathInfo != null) {
        return pathInfo;
      }
    }
    current = current.parentNode;
  }
  return null;
}

export function editPathInfoToDomId(epi: EditPathInfo): string {
  if (epi.type == EditElementType.Title) {
    return epi.path + ":title";
  }
  return epi.path + ":col" + epi.colNumMaybe;
}

export function getTextOffsetWithinElement(el: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.setEnd(node, offset);
  return range.toString().length;
}

/**
 * Determine details pertaining to the item whose title or column name is currently being edited.
 *
 * Panics if there is no such item.
 */
export const getCurrentCaretVePath_title = (): EditPathInfo => {
  const el = currentCaretElement();
  if (!el) { throw("No HTML element selection."); }

  const pathInfo = parseEditPathInfoFromDomId(el.id);
  if (pathInfo != null) { return pathInfo; }

  throw("HTML element with caret has id that does not end with :title or :col[number]");
}
