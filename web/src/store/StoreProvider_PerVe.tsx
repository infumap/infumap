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
import { BooleanSignal, NumberSignal, createBooleanSignal, createNumberSignal } from "../util/signals";


export interface PerVeStoreContextModel {
  getMouseIsOver: (vePath: VisualElementPath) => boolean,
  setMouseIsOver: (vePath: VisualElementPath, isOver: boolean) => void,

  getMouseIsOverOpenPopup: (vePath: VisualElementPath) => boolean,
  setMouseIsOverOpenPopup: (vePath: VisualElementPath, isOver: boolean) => void,

  getMovingItemIsOver: (vePath: VisualElementPath) => boolean,  // for containers only.
  setMovingItemIsOver: (vePath: VisualElementPath, isOver: boolean) => void,

  getMovingItemIsOverAttach: (vePath: VisualElementPath) => boolean,  // for attachment items only.
  setMovingItemIsOverAttach: (vePath: VisualElementPath, isOver: boolean) => void,

  getMovingItemIsOverAttachComposite: (vePath: VisualElementPath) => boolean,
  setMovingItemIsOverAttachComposite: (vePath: VisualElementPath, isOver: boolean) => void,

  getMoveOverRowNumber: (vePath: VisualElementPath) => number,  // for tables only
  setMoveOverRowNumber: (vePath: VisualElementPath, rowNumber: number) => void,

  getMoveOverIndex: (vePath: VisualElementPath) => number, // for grid pages
  setMoveOverIndex: (vePath: VisualElementPath, index: number) => void,

  getMoveOverColAttachmentNumber: (vePath: VisualElementPath) => number,  // for tables only
  setMoveOverColAttachmentNumber: (vePath: VisualElementPath, colNumber: number) => void,

  getIsExpanded: (vePath: VisualElementPath) => boolean,
  setIsExpanded: (vePath: VisualElementPath, isExpanded: boolean) => void,

  clear: () => void,
}

function clear() {
}

export function makePerVeStore(): PerVeStoreContextModel {
  const mouseIsOver = new Map<string, BooleanSignal>();
  const mouseIsOverOpenPopup = new Map<string, BooleanSignal>();
  const movingItemIsOver = new Map<string, BooleanSignal>();
  const movingItemIsOverAttach = new Map<string, BooleanSignal>();
  const movingItemIsOverAttachComposite = new Map<string, BooleanSignal>();
  const moveOverRowNumber = new Map<string, NumberSignal>();
  const moveOverColAttachmentNumber = new Map<string, NumberSignal>();
  const moveOverIndex = new Map<string, NumberSignal>();
  const isExpanded = new Map<string, BooleanSignal>();

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

  const getMouseIsOverOpenPopup = (vePath: VisualElementPath): boolean => {
    if (!mouseIsOverOpenPopup.get(vePath)) {
      mouseIsOverOpenPopup.set(vePath, createBooleanSignal(false));
    }
    return mouseIsOverOpenPopup.get(vePath)!.get();
  };

  const setMouseIsOverOpenPopup = (vePath: VisualElementPath, isOver: boolean): void => {
    if (!mouseIsOverOpenPopup.get(vePath)) {
      mouseIsOverOpenPopup.set(vePath, createBooleanSignal(isOver));
      return;
    }
    mouseIsOverOpenPopup.get(vePath)!.set(isOver);
  };

  const getMovingItemIsOver = (vePath: VisualElementPath): boolean => {
    if (!movingItemIsOver.get(vePath)) {
      movingItemIsOver.set(vePath, createBooleanSignal(false));
    }
    return movingItemIsOver.get(vePath)!.get();
  };

  const setMovingItemIsOver = (vePath: VisualElementPath, isOver: boolean): void => {
    if (!movingItemIsOver.get(vePath)) {
      movingItemIsOver.set(vePath, createBooleanSignal(isOver));
      return;
    }
    movingItemIsOver.get(vePath)!.set(isOver);
  };

  const getMovingItemIsOverAttach = (vePath: VisualElementPath): boolean => {
    if (!movingItemIsOverAttach.get(vePath)) {
      movingItemIsOverAttach.set(vePath, createBooleanSignal(false));
    }
    return movingItemIsOverAttach.get(vePath)!.get();
  };

  const setMovingItemIsOverAttach = (vePath: VisualElementPath, isOver: boolean): void => {
    if (!movingItemIsOverAttach.get(vePath)) {
      movingItemIsOverAttach.set(vePath, createBooleanSignal(isOver));
      return;
    }
    movingItemIsOverAttach.get(vePath)!.set(isOver);
  };

  const getMovingItemIsOverAttachComposite = (vePath: VisualElementPath): boolean => {
    if (!movingItemIsOverAttachComposite.get(vePath)) {
      movingItemIsOverAttachComposite.set(vePath, createBooleanSignal(false));
    }
    return movingItemIsOverAttachComposite.get(vePath)!.get();
  };

  const setMovingItemIsOverAttachComposite = (vePath: VisualElementPath, isOver: boolean): void => {
    if (!movingItemIsOverAttachComposite.get(vePath)) {
      movingItemIsOverAttachComposite.set(vePath, createBooleanSignal(isOver));
      return;
    }
    movingItemIsOverAttachComposite.get(vePath)!.set(isOver);
  };

  const getMoveOverRowNumber = (vePath: VisualElementPath): number => {
    if (!moveOverRowNumber.get(vePath)) {
      moveOverRowNumber.set(vePath, createNumberSignal(-1));
    }
    return moveOverRowNumber.get(vePath)!.get();
  };

  const setMoveOverRowNumber = (vePath: VisualElementPath, rowNumber: number): void => {
    if (!moveOverRowNumber.get(vePath)) {
      moveOverRowNumber.set(vePath, createNumberSignal(-1));
      return;
    }
    moveOverRowNumber.get(vePath)!.set(rowNumber);
  };

  const getMoveOverIndex = (vePath: VisualElementPath): number => {
    if (!moveOverIndex.get(vePath)) {
      moveOverIndex.set(vePath, createNumberSignal(-1));
    }
    return moveOverIndex.get(vePath)!.get();
  };

  const setMoveOverIndex = (vePath: VisualElementPath, rowNumber: number): void => {
    if (!moveOverIndex.get(vePath)) {
      moveOverIndex.set(vePath, createNumberSignal(-1));
      return;
    }
    moveOverIndex.get(vePath)!.set(rowNumber);
  };

  const getMoveOverColAttachmentNumber = (vePath: VisualElementPath): number => {
    if (!moveOverColAttachmentNumber.get(vePath)) {
      moveOverColAttachmentNumber.set(vePath, createNumberSignal(-1));
    }
    return moveOverColAttachmentNumber.get(vePath)!.get();
  };

  const setMoveOverColAttachmentNumber = (vePath: VisualElementPath, colNumber: number): void => {
    if (!moveOverColAttachmentNumber.get(vePath)) {
      moveOverColAttachmentNumber.set(vePath, createNumberSignal(-1));
      return;
    }
    moveOverColAttachmentNumber.get(vePath)!.set(colNumber);
  };

  const getIsExpanded = (vePath: VisualElementPath): boolean => {
    if (!isExpanded.get(vePath)) {
      isExpanded.set(vePath, createBooleanSignal(false));
    }
    return isExpanded.get(vePath)!.get();
  };

  const setIsExpanded = (vePath: VisualElementPath, isExp: boolean): void => {
    if (!isExpanded.get(vePath)) {
      isExpanded.set(vePath, createBooleanSignal(isExp));
      return;
    }
    isExpanded.get(vePath)!.set(isExp);
  };

  return ({
    getMouseIsOver,
    setMouseIsOver,

    getMouseIsOverOpenPopup,
    setMouseIsOverOpenPopup,

    getMovingItemIsOver,
    setMovingItemIsOver,

    getMovingItemIsOverAttach,
    setMovingItemIsOverAttach,

    getMovingItemIsOverAttachComposite,
    setMovingItemIsOverAttachComposite,

    getMoveOverIndex,
    setMoveOverIndex,

    getMoveOverRowNumber,
    setMoveOverRowNumber,

    getMoveOverColAttachmentNumber,
    setMoveOverColAttachmentNumber,

    getIsExpanded,
    setIsExpanded,

    clear
  });
}
