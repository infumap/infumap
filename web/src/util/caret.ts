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

import { Vector } from "./geometry";


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
 * TODO (HIGH): needs work..
 */
export const closestCaretPositionToClientPx = (el: HTMLElement, clientPx: Vector): number => {
  const textNode = el.childNodes[0];
  const range = document.createRange();
  let closestDistSq = 10000000.0;
  let closestPos = 0;
  let foundSameLine = false;
  for (let i=0; i<=textNode.textContent!.length; ++i) {
    range.setStart(textNode, i);
    range.setEnd(textNode, i);
    const bounds = range.getBoundingClientRect();
    const centerPx = { x: bounds.left, y: bounds.top + bounds.height / 2.0 };
    const distSq =
      (clientPx.x - centerPx.x) * (clientPx.x - centerPx.x) +
      (clientPx.y - centerPx.y) * (clientPx.y - centerPx.y);
    const isSameLine = clientPx.y > bounds.top && clientPx.y < bounds.bottom;
    if (distSq < closestDistSq && (isSameLine || !foundSameLine)) {
      closestDistSq = distSq;
      closestPos = i;
      foundSameLine = isSameLine;
    }
  }
  return closestPos;
}
