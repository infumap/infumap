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
import { createInfuSignal, InfuSignal } from "../util/signals";

export interface FindStoreContextModel {
  currentFindText: InfuSignal<string>,
  findMatches: InfuSignal<Array<VisualElementPath>>,
  currentMatchIndex: InfuSignal<number>,
  findActive: InfuSignal<boolean>,
  highlightedPath: InfuSignal<VisualElementPath | null>,
  clear: () => void,
}

export function makeFindStore(): FindStoreContextModel {
  const currentFindText = createInfuSignal<string>("");
  const findMatches = createInfuSignal<Array<VisualElementPath>>([]);
  const currentMatchIndex = createInfuSignal<number>(-1);
  const findActive = createInfuSignal<boolean>(false);
  const highlightedPath = createInfuSignal<VisualElementPath | null>(null);

  function clear() {
    currentFindText.set("");
    findMatches.set([]);
    currentMatchIndex.set(-1);
    findActive.set(false);
    highlightedPath.set(null);
  }

  return {
    currentFindText,
    findMatches,
    currentMatchIndex,
    findActive,
    highlightedPath,
    clear,
  };
}