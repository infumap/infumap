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
import { BooleanSignal, createBooleanSignal } from "../util/signals";


export interface PerVeStoreContextModel {
  getMouseIsOver: (vePath: VisualElementPath) => boolean,
  setMouseIsOver: (vePath: VisualElementPath, isOver: boolean) => void,

  clear: () => void,
}

function clear() {
}

export function makePerVeStore(): PerVeStoreContextModel {
  const mouseIsOver = new Map<string, BooleanSignal>();

  const getMouseIsOver = (vePath: VisualElementPath): boolean => {
    if (!mouseIsOver.get(vePath)) {
      mouseIsOver.set(vePath, createBooleanSignal(false));
    }
    return mouseIsOver.get(vePath)!.get();
  };

  const setMouseIsOver = (vePath: VisualElementPath, isOver: boolean): void => {
    if (!mouseIsOver.get(vePath)) {
      mouseIsOver.set(vePath, createBooleanSignal(isOver));
      return;
    }
    mouseIsOver.get(vePath)!.set(isOver);
  };

  return ({
    getMouseIsOver,
    setMouseIsOver,

    clear
  });
}
