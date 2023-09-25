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

import { LINE_HEIGHT_PX } from "../constants";
import { NoteFlags } from "../items/base/flags-item";


const cache = new Map<String, number>();

export function measureLineCount(s: string, widthBl: number, flags: NoteFlags): number {
  const key = s + "-#####-" + widthBl + "~" + flags; // TODO (LOW): not foolproof.
  if (cache.has(key)) {
    return cache.get(key)!;
  }
  if (cache.size > 10000) {
    // TODO (LOW): something better than this, though this trivial strategy should be very effective.
    cache.clear();
  }
  const div = document.createElement("div");
  const style = getTextStyleForNote(flags);
  div.setAttribute("style", `width: ${widthBl*LINE_HEIGHT_PX}px; ${style.isBold ? 'font-weight: bold; ' : ""}font-size: ${style.fontSize}px; line-height: ${LINE_HEIGHT_PX * style.lineHeightMultiplier}px; overflow-wrap: break-word;`);
  const txt = document.createTextNode(s);
  div.appendChild(txt);
  document.body.appendChild(div);
  const lineCount = div.offsetHeight / LINE_HEIGHT_PX;
  document.body.removeChild(div);
  const result = Math.ceil(lineCount * 2) / 2;
  cache.set(key, result);
  return result;
}

export interface InfuTextStyle {
  fontSize: number,
  lineHeightMultiplier: number,
  isBold: boolean,
}

export function getTextStyleForNote(flags: NoteFlags): InfuTextStyle {
  if (flags & NoteFlags.Heading3) {
    return { fontSize: 16, lineHeightMultiplier: 1.0, isBold: true };
  }
  if (flags & NoteFlags.Heading2) {
    return { fontSize: 32, lineHeightMultiplier: 1.5, isBold: true };
  }
  if (flags & NoteFlags.Heading1) {
    return { fontSize: 48, lineHeightMultiplier: 2.0, isBold: true };
  }
  return { fontSize: 16, lineHeightMultiplier: 1.0, isBold: false };
}
