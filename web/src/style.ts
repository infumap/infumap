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

import { Item, ItemType } from "./items/base/item";
import { asPageItem, isPage } from "./items/page-item";
import { StoreContextModel } from "./store/StoreProvider";
import { hexToRGBA, rgbArrayToRgbaFunc, rgbHexToArray } from "./util/color";
import { LINE_HEIGHT_PX } from "./constants";
import { assert } from "./util/lang";
import { Uid } from "./util/uid";

// Page colours. They started as one HSV saturation and value (0.52, 0.46) at different hues, which is what makes them
// read as one family, and were then nudged apart in OKLab: the pages draw them at 35% (translucent) and about 7% (title
// bar), which shrinks the differences between them, so the closest pairs need all the room they can get. Orange moved
// towards amber, away from red, and yellow took a little more chroma to stay clear of it. Purple leans to magenta and
// green to blue-green, so blue/purple and yellow/green stay apart with red-green colour blindness. Gray was darkened
// for white titles on large opaque pages. Blue (the default) and red are as they were. Index 0 is the default. Stored
// pages refer to these by index, so reordering or removing one needs an item log migration (see
// migrate_record_v41_to_v42, which added teal in the place of a duplicate blue).
export let Colors = [
  "#395176", // blue [default]
  "#76393A", // red
  "#78532F", // orange
  "#75712F", // yellow
  "#357844", // green
  "#2C6E78", // teal
  "#763A70", // purple
  "#6E6E6E"  // gray
];

// Fill of items drawn as outlines (without text) because they are too small for it to be legible. Types with a
// characteristic text color (file and text titles) are tinted towards it, so they can be told apart from notes.
export const OUTLINE_COLOR = "#ddd";
const FILE_OUTLINE_COLOR = "#d8e4d7";
const TEXT_OUTLINE_COLOR = "#e2d8e4";

export function outlineColorForItem(item: Item): string {
  if (item.itemType == ItemType.File) { return FILE_OUTLINE_COLOR; }
  if (item.itemType == ItemType.Text) { return TEXT_OUTLINE_COLOR; }
  return OUTLINE_COLOR;
}

export function linearGradient(colIndex: number, lightenByAlpha: number): string {
  assert(lightenByAlpha < 0.986, "invalid lightenByAlpha: " + lightenByAlpha);
  return `linear-gradient(270deg, ${hexToRGBA(Colors[colIndex], 0.986-lightenByAlpha)}, ${hexToRGBA(Colors[colIndex], 1.0-lightenByAlpha)})`;
}

// Opaque pages are lightened (lightenByAlpha for linearGradient) by a base amount, and further with on screen size,
// since the strength of the color that suits a small page is heavy on a large one. The size based part is zero up to
// one block in size. The interpolation is logarithmic in size, so mid sized pages change noticeably, whilst large ones
// are not washed out.
const OPAQUE_PAGE_LIGHTEN_ALPHA_BASE = 0.07;
const OPAQUE_PAGE_LIGHTEN_ALPHA_SIZE_MAX = 0.2;
const OPAQUE_PAGE_MAX_LIGHTEN_SIZE_BL = 10;

/** sizePx is the geometric mean of the width and height of the page on screen. */
export function opaquePageLightenAlpha(sizePx: number): number {
  const sizeBl = sizePx / LINE_HEIGHT_PX;
  if (sizeBl <= 1.0) { return OPAQUE_PAGE_LIGHTEN_ALPHA_BASE; }
  const t = Math.min(1.0, Math.log(sizeBl) / Math.log(OPAQUE_PAGE_MAX_LIGHTEN_SIZE_BL));
  return OPAQUE_PAGE_LIGHTEN_ALPHA_BASE + OPAQUE_PAGE_LIGHTEN_ALPHA_SIZE_MAX * t;
}

export function stripedGradient(colIndex: number, lightenByAlpha: number): string {
  return `repeating-linear-gradient(
    135deg,
    ${hexToRGBA(Colors[colIndex], 0.986-lightenByAlpha)},
    ${hexToRGBA(Colors[colIndex], 0.986-lightenByAlpha)} 10px,
    ${hexToRGBA(Colors[colIndex], (0.986-lightenByAlpha) * 0.8)} 10px,
    ${hexToRGBA(Colors[colIndex], (0.986-lightenByAlpha) * 0.8)} 20px
  );`;
}

export function translucent(colIndex: number, lightenByAlpha: number): string {
  return `${hexToRGBA(Colors[colIndex], 0.986-lightenByAlpha)}`;
}

// Strong enough to stand apart from a focused page's title bar directly above, which is a tint of about 8%.
const TABLE_HEADER_TINT = 0.12;
// Any lighter and the title bar and column headings run together. A neutral grey dominates the pale fill it edges.
const TABLE_LINE_TINT = 0.35;

function opaquePageColorTint(colIndex: number, tint: number): string {
  return rgbArrayToRgbaFunc(rgbHexToArray(Colors[colIndex]).map(c => Math.round(255 - (255 - c) * tint)));
}

/** The background of a table's column headings. */
export function tableHeaderBackgroundColor(colIndex: number): string {
  return opaquePageColorTint(colIndex, TABLE_HEADER_TINT);
}

/** The lines around the column headings of a table page, and between its columns. */
export function tablePageLineColor(colIndex: number): string {
  return opaquePageColorTint(colIndex, TABLE_LINE_TINT);
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
  Popup,
  Dock
}

export const borderColorForColorIdx = (idx: number, borderType: BorderType) => {
  let c1 = Colors[idx];
  let c2 = rgbHexToArray(c1);
  let c3 = rgb2hsv(c2[0], c2[1], c2[2]);
  if (borderType == BorderType.MainPage) {
    c3[1] = 0.1;
    c3[2] = 220;
  } else if (borderType == BorderType.Dock) {
    c3[1] = 0.04;
    c3[2] = 230;
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
  store.touchToolbarDependency();
  if (store.history.currentPageVeid() == null) { return LIGHT_BORDER_COLOR; }
  const currentRootItem = getItem(store.history.currentPageVeid()!.itemId);
  if (!currentRootItem || !isPage(currentRootItem)) {
    return LIGHT_BORDER_COLOR;
  }
  if (store.history.getFocusIsCurrentPage()) {
    return borderColorForColorIdx(asPageItem(currentRootItem).backgroundColorIndex, BorderType.MainPage);
  }
  return LIGHT_BORDER_COLOR;
}

export const mainPageBorderWidth = (store: StoreContextModel) => {
  store.touchToolbarDependency();
  if (store.history.currentPageVeid() == null) { return 1; }
  return store.history.getFocusIsCurrentPage()
    ? 2
    : 1;
}

export let FEATURE_COLOR = translucent(0, 0.636);

export let FEATURE_COLOR_DARK = "#000000";

// Also --color-chrome-line in index.css, for dividers in the toolbar, menus and dialogs.
export let LIGHT_BORDER_COLOR = "#e1e3e1"; // matches chrome v120 color scheme.

// Also --color-item-line in index.css.
export let BORDER_COLOR = "#c9d5e2"; // slate-300.

// Also --color-control-selected in index.css, for highlighted buttons and chosen options in chrome.
export let SELECTED_DARK = "#d4d9e1";

export let SELECTED_LIGHT = "#f3f3f3";

export let LINK_TRIANGLE_COLOR = "#b143";

export const FIND_HIGHLIGHT_COLOR = 'rgba(255, 255, 0, 0.4)';
export const SELECTION_HIGHLIGHT_COLOR = '#4a90e24d';
export const SELECTION_MARQUEE_BORDER_COLOR = '#4a90e2';
// Kept faint so selected items remain distinguishable underneath the marquee while dragging.
export const SELECTION_MARQUEE_FILL_COLOR = '#4a90e214';
// Text shadow for white page titles drawn over the page background (translucent and opaque pages).
export const PAGE_TITLE_TEXT_SHADOW = '0 1px 3px rgba(0, 0, 0, 0.35), 0 0 1px rgba(0, 0, 0, 0.25)';

export const FOCUS_RING_INNER_COLOR = 'rgba(255, 255, 255, 0.72)';
// Also --color-focus in index.css, for the focus indicator of controls in chrome.
export const FOCUS_RING_COLOR = 'rgba(0, 82, 255, 0.9)';
export const FOCUS_RING_BOX_SHADOW =
  `inset 0 0 0 1px ${FOCUS_RING_INNER_COLOR}, inset 0 0 0 3px ${FOCUS_RING_COLOR}`;
