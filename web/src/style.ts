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
import { hexToRGBA } from "./util/color";
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

export const mainPageBorderColor = (store: StoreContextModel, getItem: (id: Uid) => Item | null ) => {
  const cp = store.history.currentPage();
  if (cp == null) { return LIGHT_BORDER_COLOR; }
  return store.history.getFocusIsCurrentPage()
    ? translucent(asPageItem(getItem(cp.itemId)!).backgroundColorIndex, 0.6)
    : LIGHT_BORDER_COLOR;
}

export let FEATURE_COLOR = translucent(0, 0.636);

export let HIGHLIGHT_COLOR = "#0957d0";
export let HIGHLIGHT_ENTRY_COLOR = "#a8c7fa";

export let LIGHT_BORDER_COLOR = "#e1e3e1" // matches chrome v120 color scheme.
