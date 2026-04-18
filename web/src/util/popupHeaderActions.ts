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

import { BoundingBox } from "./geometry";


export interface PopupActionStripInput<T extends string = string> {
  key: T;
  label: string;
}

export interface PopupActionStripAction<T extends string = string> extends PopupActionStripInput<T> {
  boundsPx: BoundingBox;
  widthPx: number;
}

export interface PopupActionStripLayout<T extends string = string> {
  actions: Array<PopupActionStripAction<T>>;
  boundsPx: BoundingBox;
  fontSizePx: number;
  heightPx: number;
}

interface PopupActionStripOptions {
  fontSizePx?: number;
  gapPx?: number;
  heightPx?: number;
  horizontalPaddingPx?: number;
  minActionWidthPx?: number;
  rightInsetPx?: number;
}

const DEFAULT_OPTIONS = {
  fontSizePx: 11,
  gapPx: 4,
  heightPx: 19,
  horizontalPaddingPx: 9,
  minActionWidthPx: 52,
  rightInsetPx: 10,
};

const approxActionWidthPx = (
  label: string,
  fontSizePx: number,
  horizontalPaddingPx: number,
  minActionWidthPx: number,
): number => Math.max(
  minActionWidthPx,
  Math.round(label.length * fontSizePx * 0.56) + horizontalPaddingPx * 2,
);

export const calcPopupActionStripLayout = <T extends string>(
  actions: Array<PopupActionStripInput<T>>,
  rightEdgePx: number,
  topPx: number,
  options: PopupActionStripOptions = {},
): PopupActionStripLayout<T> => {
  const fontSizePx = options.fontSizePx ?? DEFAULT_OPTIONS.fontSizePx;
  const gapPx = options.gapPx ?? DEFAULT_OPTIONS.gapPx;
  const heightPx = options.heightPx ?? DEFAULT_OPTIONS.heightPx;
  const horizontalPaddingPx = options.horizontalPaddingPx ?? DEFAULT_OPTIONS.horizontalPaddingPx;
  const minActionWidthPx = options.minActionWidthPx ?? DEFAULT_OPTIONS.minActionWidthPx;
  const rightInsetPx = options.rightInsetPx ?? DEFAULT_OPTIONS.rightInsetPx;

  const measuredActions = actions.map((action) => ({
    ...action,
    widthPx: approxActionWidthPx(action.label, fontSizePx, horizontalPaddingPx, minActionWidthPx),
  }));

  const stripWidthPx = measuredActions.reduce((sum, action) => sum + action.widthPx, 0) +
    Math.max(0, measuredActions.length - 1) * gapPx;
  const stripBoundsPx = {
    x: rightEdgePx - rightInsetPx - stripWidthPx,
    y: topPx,
    w: stripWidthPx,
    h: heightPx,
  };

  let cursorX = stripBoundsPx.x;
  const positionedActions = measuredActions.map((action) => {
    const result = {
      ...action,
      boundsPx: {
        x: cursorX,
        y: topPx,
        w: action.widthPx,
        h: heightPx,
      },
    };
    cursorX += action.widthPx + gapPx;
    return result;
  });

  return {
    actions: positionedActions,
    boundsPx: stripBoundsPx,
    fontSizePx,
    heightPx,
  };
};
