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
import { BooleanSignal, InfuSignal, NumberSignal, createBooleanSignal, createInfuSignal, createNumberSignal } from "../util/signals";
import {
  decodeCalendarMonthIndex,
  encodeCalendarMonthIndex,
  type CalendarMonthResize,
} from "../util/calendar-layout";


export interface IndexAndPosition {
  index: number,
  position: number,
}


export interface PerVeStoreContextModel {
  getMouseIsOver: (vePath: VisualElementPath) => boolean,
  setMouseIsOver: (vePath: VisualElementPath, isOver: boolean) => void,

  getMouseIsOverOpenPopup: (vePath: VisualElementPath) => boolean,
  setMouseIsOverOpenPopup: (vePath: VisualElementPath, isOver: boolean) => void,

  getMouseIsOverCompositeMoveOut: (vePath: VisualElementPath) => boolean,
  setMouseIsOverCompositeMoveOut: (vePath: VisualElementPath, isOver: boolean) => void,

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

  getMoveOverIndexAndPosition: (vePath: VisualElementPath) => IndexAndPosition, // for dock, justified pages.
  setMoveOverIndexAndPosition: (vePath: VisualElementPath, index: IndexAndPosition) => void,

  getMoveOverColAttachmentNumber: (vePath: VisualElementPath) => number,  // for tables only
  setMoveOverColAttachmentNumber: (vePath: VisualElementPath, colNumber: number) => void,

  getMoveOverChildContainerPath: (vePath: VisualElementPath) => VisualElementPath | null,  // for tables only
  setMoveOverChildContainerPath: (vePath: VisualElementPath, childPath: VisualElementPath | null) => void,

  getMoveOverAttachmentIndex: (vePath: VisualElementPath) => number,  // for attachable items
  setMoveOverAttachmentIndex: (vePath: VisualElementPath, index: number) => void,

  getIsExpanded: (vePath: VisualElementPath) => boolean,
  setIsExpanded: (vePath: VisualElementPath, isExpanded: boolean) => void,

  getCalendarMonthIndex: (vePath: VisualElementPath) => number,
  setCalendarMonthIndex: (vePath: VisualElementPath, monthIndex: number) => void,

  getCalendarYear: (vePath: VisualElementPath) => number,
  setCalendarYear: (vePath: VisualElementPath, year: number) => void,

  getCalendarMonthResize: (vePath: VisualElementPath) => CalendarMonthResize | null,
  setCalendarMonthResize: (vePath: VisualElementPath, resize: CalendarMonthResize | null) => void,

  getAutoMovedIntoView: (vePath: VisualElementPath) => boolean,
  setAutoMovedIntoView: (vePath: VisualElementPath, isAutoMoved: boolean) => void,

  clear: () => void,
}

export function makePerVeStore(): PerVeStoreContextModel {
  const mouseIsOver = new Map<string, BooleanSignal>();
  const mouseIsOverOpenPopup = new Map<string, BooleanSignal>();
  const mouseIsOverCompositeMoveOut = new Map<string, BooleanSignal>();
  const movingItemIsOver = new Map<string, BooleanSignal>();
  const movingItemIsOverAttach = new Map<string, BooleanSignal>();
  const movingItemIsOverAttachComposite = new Map<string, BooleanSignal>();
  const moveOverRowNumber = new Map<string, NumberSignal>();
  const moveOverColAttachmentNumber = new Map<string, NumberSignal>();
  const moveOverChildContainerPath = new Map<string, InfuSignal<VisualElementPath | null>>();
  const moveOverAttachmentIndex = new Map<string, NumberSignal>();
  const moveOverIndex = new Map<string, NumberSignal>();
  const moveOverIndexAndPosition = new Map<string, InfuSignal<IndexAndPosition>>();
  const isExpanded = new Map<string, BooleanSignal>();
  const calendarMonthIndex = new Map<string, NumberSignal>();
  const calendarYear = new Map<string, NumberSignal>();
  const calendarMonthResize = new Map<string, InfuSignal<CalendarMonthResize | null>>();
  const autoMovedIntoView = new Map<string, BooleanSignal>();

  const clear = (): void => {
    mouseIsOver.clear();
    mouseIsOverOpenPopup.clear();
    mouseIsOverCompositeMoveOut.clear();
    movingItemIsOver.clear();
    movingItemIsOverAttach.clear();
    movingItemIsOverAttachComposite.clear();
    moveOverRowNumber.clear();
    moveOverColAttachmentNumber.clear();
    moveOverChildContainerPath.clear();
    moveOverAttachmentIndex.clear();
    moveOverIndex.clear();
    moveOverIndexAndPosition.clear();
    isExpanded.clear();
    calendarMonthIndex.clear();
    calendarYear.clear();
    calendarMonthResize.clear();
    autoMovedIntoView.clear();
  };

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

  const getMouseIsOverCompositeMoveOut = (vePath: VisualElementPath): boolean => {
    if (!mouseIsOverCompositeMoveOut.get(vePath)) {
      mouseIsOverCompositeMoveOut.set(vePath, createBooleanSignal(false));
    }
    return mouseIsOverCompositeMoveOut.get(vePath)!.get();
  };

  const setMouseIsOverCompositeMoveOut = (vePath: VisualElementPath, isOver: boolean): void => {
    if (!mouseIsOverCompositeMoveOut.get(vePath)) {
      mouseIsOverCompositeMoveOut.set(vePath, createBooleanSignal(isOver));
      return;
    }
    mouseIsOverCompositeMoveOut.get(vePath)!.set(isOver);
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

  const setMoveOverIndex = (vePath: VisualElementPath, index: number): void => {
    if (!moveOverIndex.get(vePath)) {
      moveOverIndex.set(vePath, createNumberSignal(-1));
      return;
    }
    moveOverIndex.get(vePath)!.set(index);
  };

  const getMoveOverIndexAndPosition = (vePath: VisualElementPath): IndexAndPosition => {
    if (!moveOverIndexAndPosition.get(vePath)) {
      moveOverIndexAndPosition.set(vePath, createInfuSignal<IndexAndPosition>({ index: -1, position: -1 }));
    }
    return moveOverIndexAndPosition.get(vePath)!.get();
  };

  const setMoveOverIndexAndPosition = (vePath: VisualElementPath, ip: IndexAndPosition): void => {
    if (!moveOverIndexAndPosition.get(vePath)) {
      moveOverIndexAndPosition.set(vePath, createInfuSignal<IndexAndPosition>(ip));
      return;
    }
    moveOverIndexAndPosition.get(vePath)!.set(ip);
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

  const getMoveOverChildContainerPath = (vePath: VisualElementPath): VisualElementPath | null => {
    if (!moveOverChildContainerPath.get(vePath)) {
      moveOverChildContainerPath.set(vePath, createInfuSignal<VisualElementPath | null>(null));
    }
    return moveOverChildContainerPath.get(vePath)!.get();
  };

  const setMoveOverChildContainerPath = (vePath: VisualElementPath, childPath: VisualElementPath | null): void => {
    if (!moveOverChildContainerPath.get(vePath)) {
      moveOverChildContainerPath.set(vePath, createInfuSignal<VisualElementPath | null>(childPath));
      return;
    }
    moveOverChildContainerPath.get(vePath)!.set(childPath);
  };

  const getMoveOverAttachmentIndex = (vePath: VisualElementPath): number => {
    if (!moveOverAttachmentIndex.get(vePath)) {
      moveOverAttachmentIndex.set(vePath, createNumberSignal(-1));
    }
    return moveOverAttachmentIndex.get(vePath)!.get();
  };

  const setMoveOverAttachmentIndex = (vePath: VisualElementPath, index: number): void => {
    if (!moveOverAttachmentIndex.get(vePath)) {
      moveOverAttachmentIndex.set(vePath, createNumberSignal(-1));
      return;
    }
    moveOverAttachmentIndex.get(vePath)!.set(index);
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

  const getDefaultCalendarMonthIndex = (): number => {
    const now = new Date();
    return encodeCalendarMonthIndex(now.getFullYear(), now.getMonth() + 1);
  };

  const getCalendarMonthIndex = (vePath: VisualElementPath): number => {
    if (!calendarMonthIndex.get(vePath)) {
      calendarMonthIndex.set(vePath, createNumberSignal(getDefaultCalendarMonthIndex()));
    }
    return calendarMonthIndex.get(vePath)!.get();
  };

  const setCalendarMonthIndex = (vePath: VisualElementPath, monthIndex: number): void => {
    const previousMonthIndex = calendarMonthIndex.get(vePath)?.get();
    const previousYear = calendarYear.get(vePath)?.get();

    if (!calendarMonthIndex.get(vePath)) {
      calendarMonthIndex.set(vePath, createNumberSignal(monthIndex));
    } else {
      calendarMonthIndex.get(vePath)!.set(monthIndex);
    }

    const nextYear = decodeCalendarMonthIndex(monthIndex).year;
    if (!calendarYear.get(vePath)) {
      calendarYear.set(vePath, createNumberSignal(nextYear));
    } else if (previousYear == null || previousYear !== nextYear) {
      calendarYear.get(vePath)!.set(nextYear);
    }

    if (previousMonthIndex == null || previousMonthIndex !== monthIndex) {
      if (calendarMonthResize.get(vePath)) {
        calendarMonthResize.get(vePath)!.set(null);
      }
    }
  };

  const getCalendarYear = (vePath: VisualElementPath): number => {
    return decodeCalendarMonthIndex(getCalendarMonthIndex(vePath)).year;
  };

  const setCalendarYear = (vePath: VisualElementPath, year: number): void => {
    const { month } = decodeCalendarMonthIndex(getCalendarMonthIndex(vePath));
    setCalendarMonthIndex(vePath, encodeCalendarMonthIndex(year, month));
  };

  const getCalendarMonthResize = (vePath: VisualElementPath): CalendarMonthResize | null => {
    if (!calendarMonthResize.get(vePath)) {
      calendarMonthResize.set(vePath, createInfuSignal<CalendarMonthResize | null>(null));
    }
    return calendarMonthResize.get(vePath)!.get();
  };

  const setCalendarMonthResize = (vePath: VisualElementPath, resize: CalendarMonthResize | null): void => {
    if (!calendarMonthResize.get(vePath)) {
      calendarMonthResize.set(vePath, createInfuSignal<CalendarMonthResize | null>(resize));
      return;
    }
    calendarMonthResize.get(vePath)!.set(resize);
  };

  const getAutoMovedIntoView = (vePath: VisualElementPath): boolean => {
    if (!autoMovedIntoView.get(vePath)) {
      autoMovedIntoView.set(vePath, createBooleanSignal(false));
    }
    return autoMovedIntoView.get(vePath)!.get();
  };

  const setAutoMovedIntoView = (vePath: VisualElementPath, isAutoMoved: boolean): void => {
    if (!autoMovedIntoView.get(vePath)) {
      autoMovedIntoView.set(vePath, createBooleanSignal(isAutoMoved));
      return;
    }
    autoMovedIntoView.get(vePath)!.set(isAutoMoved);
  };

  return ({
    getMouseIsOver,
    setMouseIsOver,

    getMouseIsOverOpenPopup,
    setMouseIsOverOpenPopup,

    getMouseIsOverCompositeMoveOut,
    setMouseIsOverCompositeMoveOut,

    getMovingItemIsOver,
    setMovingItemIsOver,

    getMovingItemIsOverAttach,
    setMovingItemIsOverAttach,

    getMovingItemIsOverAttachComposite,
    setMovingItemIsOverAttachComposite,

    getMoveOverIndex,
    setMoveOverIndex,

    getMoveOverIndexAndPosition,
    setMoveOverIndexAndPosition,

    getMoveOverRowNumber,
    setMoveOverRowNumber,

    getMoveOverColAttachmentNumber,
    setMoveOverColAttachmentNumber,

    getMoveOverChildContainerPath,
    setMoveOverChildContainerPath,

    getMoveOverAttachmentIndex,
    setMoveOverAttachmentIndex,

    getIsExpanded,
    setIsExpanded,

    getCalendarMonthIndex,
    setCalendarMonthIndex,

    getCalendarYear,
    setCalendarYear,

    getCalendarMonthResize,
    setCalendarMonthResize,

    getAutoMovedIntoView,
    setAutoMovedIntoView,

    clear
  });
}
