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


/**
 * If text ends with a newline, trim it.
 */
export function trimNewline(text: string): string {
  if (text.endsWith("\n")) {
    return text.substring(0, text.length-1);
  }
  return text;
}


/**
 * Used to force creation of a TEXT_NODE inside the note span element
 * which is required to make contenteditable behave as desired.
 *
 * the \n should be detected and removed prior to persistence of the
 * note item text.
 */
export function appendNewlineIfEmpty(text: string): string {
  if (text == "") { return "\n"; }
  return text;
}


/**
 * Test whether or not text contains any whitespace characters.
 */
export function hasWhiteSpace(text: string): boolean {
  return /\s/g.test(text);
}


/**
 * Test whether or not text is a valid web url.
 */
export function isUrl(text: string): boolean {
    let url;
    if (hasWhiteSpace(text)) { return false; }
    try { url = new URL(text); }
    catch (_e) { return false; }
    return url.protocol === "http:" || url.protocol === "https:";
}
