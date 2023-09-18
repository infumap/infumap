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


const cache = new Map<String, number>();

export function measureLineCount(s: string, widthBl: number): number {
  const key = s + "-#####-" + widthBl; // TODO (LOW): not foolproof.
  if (cache.has(key)) {
    return cache.get(key)!;
  }
  if (cache.size > 10000) {
    // TODO (LOW): something better than this, though this trivial strategy should be very effective.
    cache.clear();
  }
  const div = document.createElement("div");
  div.setAttribute("style", `line-height: ${LINE_HEIGHT_PX}px; width: ${widthBl*LINE_HEIGHT_PX}px; overflow-wrap: break-word;`);
  const txt = document.createTextNode(s);
  div.appendChild(txt);
  document.body.appendChild(div);
  const lineCount = div.offsetHeight / LINE_HEIGHT_PX;
  document.body.removeChild(div);
  const result = Math.floor(lineCount);
  cache.set(key, result);
  return result;
}
