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

import { Item } from "./items/base/item";
import { asPageItem } from "./items/page-item";
import { StoreContextModel } from "./store/StoreProvider";
import { hexToRGBA, rgbArrayToRgbaFunc, rgbHexToArray } from "./util/color";
import { assert } from "./util/lang";
import { Uid } from "./util/uid";

export let Colors = [
  "#395176", // blue [default]
  "#395176", // blue
  "#76393A", // red
  "#764F39", // orange
  "#767139", // yellow
  "#3B7639", // green
  "#6F3976", // purple
  "#767676"  // gray
];

export function linearGradient(colIndex: number, lightenByAlpha: number): string {
  assert(lightenByAlpha < 0.986, "invalid lightenByAlpha: " + lightenByAlpha);
  return `linear-gradient(270deg, ${hexToRGBA(Colors[colIndex], 0.986-lightenByAlpha)}, ${hexToRGBA(Colors[colIndex], 1.0-lightenByAlpha)})`;
}

export function translucent(colIndex: number, lightenByAlpha: number): string {
  return `${hexToRGBA(Colors[colIndex], 0.986-lightenByAlpha)}`;
}

// https://stackoverflow.com/questions/17242144/javascript-convert-hsb-hsv-color-to-rgb-accurately/54024653#54024653
function hsv2rgb(h: number, s: number, v: number) {
  let f = (n: number) => {
    let k = (n+h/60)%6;
    return v - v*s*Math.max( Math.min(k,4-k,1), 0);
  }
  return [f(5),f(3),f(1)];
}

// https://stackoverflow.com/questions/8022885/rgb-to-hsv-color-in-javascript/54070620#54070620
function rgb2hsv(r: number, g: number, b: number) {
  let v = Math.max(r,g,b), c=v-Math.min(r,g,b);
  let h = c && ((v==r) ? (g-b)/c : ((v==g) ? 2+(b-r)/c : 4+(r-g)/c));
  return [60*(h<0?h+6:h), v&&c/v, v];
}

export enum BorderType {
  MainPage,
  Popup
}

export const borderColorForColorIdx = (idx: number, borderType: BorderType) => {
  let c1 = Colors[idx];
  let c2 = rgbHexToArray(c1);
  let c3 = rgb2hsv(c2[0], c2[1], c2[2]);
  if (borderType == BorderType.MainPage) {
    c3[1] = 0.1;
    c3[2] = 220;
  } else {
    c3[1] = 0.25;
    c3[2] = 150;
  }
  // the transform does not work as desired for gray. hack to fix this.
  if (c2[0] == c2[1] && c2[1] == c2[2]) { c3[1] = 0.0; }
  let c4 = hsv2rgb(c3[0], c3[1], c3[2]);
  let c5 = rgbArrayToRgbaFunc(c4);
  return c5;
}

export const mainPageBorderColor = (store: StoreContextModel, getItem: (id: Uid) => Item | null) => {
  if (store.history.currentPageVeid() == null) { return LIGHT_BORDER_COLOR; }
  if (store.history.getFocusIsCurrentPage()) {
    return borderColorForColorIdx(asPageItem(getItem(store.history.currentPageVeid()!.itemId)!).backgroundColorIndex, BorderType.MainPage);
  }
  return LIGHT_BORDER_COLOR;
}

export const mainPageBorderWidth = (store: StoreContextModel) => {
  if (store.history.currentPageVeid() == null) { return 1; }
  return store.history.getFocusIsCurrentPage()
    ? 2
    : 1;
}

export let FEATURE_COLOR = translucent(0, 0.636);

export let FEATURE_COLOR_DARK = "#000000";

export let HIGHLIGHT_ENTRY_COLOR = "#a8c7fa";

export let LIGHT_BORDER_COLOR = "#e1e3e1"; // matches chrome v120 color scheme.

export let BORDER_COLOR = "#c9d5e2"; // slate-300.

export let SELECTED_DARK = "#d8d8d8";

export let SELECTED_LIGHT = "#f3f3f3";
