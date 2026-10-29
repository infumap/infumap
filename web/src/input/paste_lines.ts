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

import { normalizeClipboardLineEndings } from "../util/editable_text";


const BULLET_MARKER = /^[-*•]\s+(?=\S)/;
const NUMBERED_MARKER = /^\d+[.)]\s+(?=\S)/;

/**
 * Split pasted plain text into the titles of the notes to create, one per line.
 *
 * Lines are trimmed and blank lines dropped. Tabs become a single space: a row's other columns are its attachments,
 * not cells of the line, so tab separated text is kept as one title rather than split into columns.
 *
 * List markers ("- ", "* ", "• ", or "1. ", "1) ") are removed only when there are at least two lines and every one of
 * them has the same kind of marker. A lone "1. Introduction", or a list of urls with one line that happens to start
 * with "- ", is text, and stripping it would lose what the user pasted.
 */
export function parsePastedLines(text: string): Array<string> {
  const lines = normalizeClipboardLineEndings(text)
    .split(/[\n\u2028\u2029]/)
    .map(line => line.replace(/\s*\t\s*/g, " ").trim())
    .filter(line => line.length > 0);
  if (lines.length < 2) { return lines; }
  for (const marker of [BULLET_MARKER, NUMBERED_MARKER]) {
    if (lines.every(line => marker.test(line))) {
      return lines.map(line => line.replace(marker, ""));
    }
  }
  return lines;
}
