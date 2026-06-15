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
import {
  noteHasBulletStyle,
  noteHasListStyle,
  noteHasNumberedStyle,
  noteIndentLevelFromFlags,
  NoteFlags,
} from "../items/base/flags-item";


const lineCountCache = new Map<String, number>();
const textHeightCache = new Map<String, number>();
export const NOTE_BULLET_MARKER_TEXT = "\u25CF";
export const NOTE_BULLET_MARKER_FONT_SIZE_MULTIPLIER = 0.50;
export const NOTE_BULLET_MARKER_OFFSET_PX = 3;
export const NOTE_BULLET_TEXT_INSET_PX = 18;
export const NOTE_NUMBERED_TEXT_INSET_PX = 30;
export const NOTE_LIST_INDENT_WIDTH_PX = 18;
export const DOCUMENT_NOTE_HEIGHT_QUANTUM_PX = 2;
export const DOCUMENT_PARAGRAPH_LINE_HEIGHT_EXTRA_PX = 2;

export function noteHasBullet(flags: NoteFlags): boolean {
  return noteHasBulletStyle(flags);
}

export function noteHasNumbered(flags: NoteFlags): boolean {
  return noteHasNumberedStyle(flags);
}

export function noteHasListMarker(flags: NoteFlags): boolean {
  return noteHasListStyle(flags);
}

export function noteListMarkerText(flags: NoteFlags, listItemNumber: number | null | undefined): string {
  if (noteHasBullet(flags)) { return NOTE_BULLET_MARKER_TEXT; }
  if (noteHasNumbered(flags)) { return `${listItemNumber ?? 1}.`; }
  return "";
}

export function noteListTextInsetPx(flags: NoteFlags): number {
  if (noteHasBullet(flags)) { return NOTE_BULLET_TEXT_INSET_PX; }
  if (noteHasNumbered(flags)) { return NOTE_NUMBERED_TEXT_INSET_PX; }
  return 0;
}

export function noteTextBlockPaddingLeftPx(flags: NoteFlags, leadingInsetPx: number = 0): number {
  return noteHasListMarker(flags) ? leadingInsetPx + noteListTextInsetPx(flags) + noteIndentLevelFromFlags(flags) * NOTE_LIST_INDENT_WIDTH_PX : 0;
}

export function noteTextBlockTextIndentPx(flags: NoteFlags, leadingInsetPx: number = 0): number {
  return noteHasListMarker(flags) ? 0 : leadingInsetPx;
}

export function noteListMarkerLeftPx(flags: NoteFlags, leadingInsetPx: number = 0): number {
  if (!noteHasListMarker(flags)) { return 0; }
  const markerOffsetPx = noteHasBullet(flags) ? NOTE_BULLET_MARKER_OFFSET_PX : 0;
  return leadingInsetPx + markerOffsetPx + noteIndentLevelFromFlags(flags) * NOTE_LIST_INDENT_WIDTH_PX;
}

export function noteBulletMarkerLeftPx(flags: NoteFlags, leadingInsetPx: number = 0): number {
  return noteListMarkerLeftPx(flags, leadingInsetPx);
}

export function desktopPopupIconTextIndentPx(widthBl: number): number {
  if (widthBl <= 0) { return 0; }
  return Math.max(((widthBl * LINE_HEIGHT_PX) - NOTE_PADDING_PX * 2) / widthBl - NOTE_PADDING_PX, 0);
}

export function measureLineCount(s: string, widthBl: number, flags: NoteFlags, textIndentPx: number = 0): number {
  const key = s + "-#####-" + widthBl + "~" + flags + "~" + textIndentPx; // TODO (LOW): not foolproof.
  if (lineCountCache.has(key)) {
    return lineCountCache.get(key)!;
  }
  if (lineCountCache.size > 10000) {
    // TODO (LOW): something better than this, though this trivial strategy should be very effective.
    lineCountCache.clear();
  }
  const lineCount = measureTextHeightPx(s, widthBl, flags, textIndentPx) / LINE_HEIGHT_PX;
  const result = Math.ceil(lineCount * 2) / 2;
  lineCountCache.set(key, result);
  return result;
}

export function measureDocumentNoteHeightBl(s: string, widthBl: number, flags: NoteFlags, textIndentPx: number = 0): number {
  const lineHeightPx = documentLineHeightPxForNote(flags);
  const measuredHeightPx = Math.max(
    measureTextHeightPx(s, widthBl, flags, textIndentPx, lineHeightPx),
    lineHeightPx,
  );
  return Math.ceil(measuredHeightPx / DOCUMENT_NOTE_HEIGHT_QUANTUM_PX) * DOCUMENT_NOTE_HEIGHT_QUANTUM_PX / LINE_HEIGHT_PX;
}

function measureTextHeightPx(s: string, widthBl: number, flags: NoteFlags, textIndentPx: number = 0, lineHeightPxMaybe: number | null = null): number {
  const key = s + "-#####-" + widthBl + "~" + flags + "~" + textIndentPx + "~" + (lineHeightPxMaybe ?? ""); // TODO (LOW): not foolproof.
  if (textHeightCache.has(key)) {
    return textHeightCache.get(key)!;
  }
  if (textHeightCache.size > 10000) {
    // TODO (LOW): something better than this, though this trivial strategy should be very effective.
    textHeightCache.clear();
  }
  const div = document.createElement("div");
  const style = getTextStyleForNote(flags);
  const paddingLeftPx = noteTextBlockPaddingLeftPx(flags, textIndentPx);
  const actualTextIndentPx = noteTextBlockTextIndentPx(flags, textIndentPx);
  div.setAttribute("class", `${style.alignClass} ${style.isCode ? ' font-mono' : '' }`);
  div.setAttribute("style",
    `position: absolute; visibility: hidden; pointer-events: none; ` +
    `left: -10000px; top: 0px; z-index: -1; ` +
    `right: ${widthBl*LINE_HEIGHT_PX - NOTE_PADDING_PX}px; ` +
    `width: ${widthBl*LINE_HEIGHT_PX - NOTE_PADDING_PX*2}px; ` +
    `box-sizing: border-box; padding-left: ${paddingLeftPx}px; ` +
    `${style.isBold ? 'font-weight: bold; ' : ""}` +
    `font-size: ${style.fontSize}px; ` +
    `line-height: ${lineHeightPxMaybe ?? LINE_HEIGHT_PX * style.lineHeightMultiplier}px; ` +
    `overflow-wrap: break-word; white-space: pre-wrap; ` +
    `text-indent: ${actualTextIndentPx}px;`);
  const txt = document.createTextNode(s);
  div.appendChild(txt);
  document.body.appendChild(div);
  const heightPx = div.offsetHeight;
  document.body.removeChild(div);
  textHeightCache.set(key, heightPx);
  return heightPx;
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
  div.setAttribute("class", `${style.alignClass} ${style.isCode ? ' font-mono' : '' }`);
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
  alignClass: string,
}

function noteHasHeadingStyle(flags: NoteFlags): boolean {
  return !!(
    (flags & NoteFlags.Heading1) ||
    (flags & NoteFlags.Heading2) ||
    (flags & NoteFlags.Heading3) ||
    (flags & NoteFlags.Heading4)
  );
}

function noteIsDocumentParagraph(flags: NoteFlags): boolean {
  return !noteHasHeadingStyle(flags) &&
    !noteHasListStyle(flags) &&
    !(flags & NoteFlags.Code);
}

export function documentLineHeightPxForNote(flags: NoteFlags): number {
  const style = getTextStyleForNote(flags);
  return LINE_HEIGHT_PX * style.lineHeightMultiplier +
    (noteIsDocumentParagraph(flags) ? DOCUMENT_PARAGRAPH_LINE_HEIGHT_EXTRA_PX : 0);
}

export function getTextStyleForNote(flags: NoteFlags): InfuTextStyle {
  const bodyFontSizePx = 16;
  const heading1Scale = 1.9;
  const heading2Scale = 1.45;
  const heading3Scale = 1.2;
  const heading4Scale = 1.0;

  let alignClass = "text-left";
  if (flags & NoteFlags.AlignRight) {
    alignClass = "text-right";
  } else if (flags & NoteFlags.AlignCenter) {
    alignClass = "text-center";
  } else if (flags & NoteFlags.AlignJustify) {
    alignClass = "text-justify";
  }

  const isCode = (flags & NoteFlags.Code) != 0;

  if (flags & NoteFlags.Heading1) {
    return { fontSize: bodyFontSizePx * heading1Scale, lineHeightMultiplier: heading1Scale, isBold: true, isCode, alignClass };
  }
  if (flags & NoteFlags.Heading2) {
    return { fontSize: bodyFontSizePx * heading2Scale, lineHeightMultiplier: heading2Scale, isBold: true, isCode, alignClass };
  }
  if (flags & NoteFlags.Heading3) {
    return { fontSize: bodyFontSizePx * heading3Scale, lineHeightMultiplier: heading3Scale, isBold: true, isCode, alignClass };
  }
  if (flags & NoteFlags.Heading4) {
    return { fontSize: bodyFontSizePx * heading4Scale, lineHeightMultiplier: heading4Scale, isBold: true, isCode, alignClass };
  }

  return { fontSize: bodyFontSizePx, lineHeightMultiplier: 1.0, isBold: false, isCode, alignClass };
}
