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

import { LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../constants";
import { NoteFlags } from "../items/base/flags-item";


const lineCountCache = new Map<String, number>();

export function measureLineCount(s: string, widthBl: number, flags: NoteFlags): number {
  const key = s + "-#####-" + widthBl + "~" + flags; // TODO (LOW): not foolproof.
  if (lineCountCache.has(key)) {
    return lineCountCache.get(key)!;
  }
  if (lineCountCache.size > 10000) {
    // TODO (LOW): something better than this, though this trivial strategy should be very effective.
    lineCountCache.clear();
  }
  const div = document.createElement("div");
  const style = getTextStyleForNote(flags);
  if (style.isCode) {
    div.setAttribute("class", "font-mono");
  }
  div.setAttribute("style",
    `left: ${NOTE_PADDING_PX}px; ` +
    `top: ${NOTE_PADDING_PX - LINE_HEIGHT_PX/4}px; ` +
    `right: ${widthBl*LINE_HEIGHT_PX - NOTE_PADDING_PX}px; ` +
    `width: ${widthBl*LINE_HEIGHT_PX - NOTE_PADDING_PX*2}px; ` +
    `${style.isBold ? 'font-weight: bold; ' : ""}` +
    `font-size: ${style.fontSize}px; ` +
    `line-height: ${LINE_HEIGHT_PX * style.lineHeightMultiplier}px; ` +
    `overflow-wrap: break-word; white-space: pre-wrap;`);
  const txt = document.createTextNode(s);
  div.appendChild(txt);
  document.body.appendChild(div);
  const lineCount = div.offsetHeight / LINE_HEIGHT_PX;
  document.body.removeChild(div);
  const result = Math.ceil(lineCount * 2) / 2;
  lineCountCache.set(key, result);
  return result;
}

const widthCache = new Map<String, number>();

export function measureWidthBl(s: string, style: InfuTextStyle): number {
  const key = s + "-#####-" + style.fontSize + style.isBold + style.lineHeightMultiplier; // TODO (LOW): not foolproof.
  if (widthCache.has(key)) {
    return widthCache.get(key)!;
  }
  if (widthCache.size > 10000) {
    // TODO (LOW): something better than this, though this trivial strategy should be very effective.
    widthCache.clear();
  }
  const div = document.createElement("div");
  div.setAttribute("style",
    `${style.isBold ? 'font-weight: bold; ' : ""}` +
    `font-size: ${style.fontSize}px; ` +
    `line-height: ${LINE_HEIGHT_PX * style.lineHeightMultiplier}px; `+
    `display: inline-block;`);
  const txt = document.createTextNode(s);
  div.appendChild(txt);
  document.body.appendChild(div);
  const widthBl = div.offsetWidth / LINE_HEIGHT_PX;
  document.body.removeChild(div);
  const result = Math.ceil(widthBl * 2) / 2;
  widthCache.set(key, result);
  return result;
}


export interface InfuTextStyle {
  fontSize: number,
  lineHeightMultiplier: number,
  isBold: boolean,
  isCode: boolean,
}

export function getTextStyleForNote(flags: NoteFlags): InfuTextStyle {
  if (flags & NoteFlags.Heading3) {
    return { fontSize: 16, lineHeightMultiplier: 1.0, isBold: true, isCode: false };
  }
  if (flags & NoteFlags.Heading2) {
    return { fontSize: 32, lineHeightMultiplier: 1.5, isBold: true, isCode: false };
  }
  if (flags & NoteFlags.Heading1) {
    return { fontSize: 48, lineHeightMultiplier: 2.0, isBold: true, isCode: false };
  }
  if (flags & NoteFlags.Code) {
    return { fontSize: 16, lineHeightMultiplier: 1.0, isBold: false, isCode: true }
  }
  return { fontSize: 16, lineHeightMultiplier: 1.0, isBold: false, isCode: false };
}
