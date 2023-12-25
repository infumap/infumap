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

import { EMPTY_VEID, Veid, VisualElementPath } from "../layout/visual-element";
import { InfuSignal, NumberSignal, createInfuSignal, createNumberSignal } from "../util/signals";
import { Uid } from "../util/uid";


export interface PerItemStoreContextModel {
  getSelectedListPageItem: (listPageVeid: Veid) => Veid,
  setSelectedListPageItem: (listPageVeid: Veid, selectedVeid: Veid) => void,

  getListPageColWidth: (itemId: Uid) => number,
  setListPageColWidth: (itemId: Uid, width: number) => void,

  getTableScrollYPos: (veid: Veid) => number,
  setTableScrollYPos: (veid: Veid, pos: number) => void,

  getPageScrollXProp: (veid: Veid) => number,
  setPageScrollXProp: (veid: Veid, prop: number) => void,

  getPageScrollYProp: (veid: Veid) => number,
  setPageScrollYProp: (veid: Veid, prop: number) => void,

  clear: () => void,
}

export function makePerItemStore(): PerItemStoreContextModel {
  // TODO (LOW): Unsure if lots of these signals, after lots of navigation, will create a perf issue. possibly
  // want to keep the number under control on page changes (delete those with value 0).
  const tableScrollPositions = new Map<string, NumberSignal>();
  const pageScrollXPxs = new Map<string, NumberSignal>();
  const pageScrollYPxs = new Map<string, NumberSignal>();
  const selectedItems = new Map<string, InfuSignal<Veid>>();
  const listPageColWidths = new Map<string, NumberSignal>();

  const getTableScrollYPos = (veid: Veid): number => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!tableScrollPositions.get(key)) {
      tableScrollPositions.set(key, createNumberSignal(0.0));
    }
    return tableScrollPositions.get(key)!.get();
  };

  const setTableScrollYPos = (veid: Veid, pos: number): void => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!tableScrollPositions.get(key)) {
      tableScrollPositions.set(key, createNumberSignal(pos));
      return;
    }
    tableScrollPositions.get(key)!.set(pos);
  };

  const getPageScrollXProp = (veid: Veid): number => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollXPxs.get(key)) {
      pageScrollXPxs.set(key, createNumberSignal(0.0));
    }
    return pageScrollXPxs.get(key)!.get();
  };

  const setPageScrollXProp = (veid: Veid, prop: number): void => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollXPxs.get(key)) {
      pageScrollXPxs.set(key, createNumberSignal(prop));
      return;
    }
    pageScrollXPxs.get(key)!.set(prop);
  };

  const getPageScrollYProp = (veid: Veid): number => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollYPxs.get(key)) {
      pageScrollYPxs.set(key, createNumberSignal(0.0));
    }
    return pageScrollYPxs.get(key)!.get();
  };

  const setPageScrollYProp = (veid: Veid, prop: number): void => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollYPxs.get(key)) {
      pageScrollYPxs.set(key, createNumberSignal(prop));
      return;
    }
    pageScrollYPxs.get(key)!.set(prop);
  };

  const getSelectedListPageItem = (listPageVeid: Veid): Veid => {
    const key = listPageVeid.itemId + (listPageVeid.linkIdMaybe == null ? "" : "[" + listPageVeid.linkIdMaybe + "]");
    if (!selectedItems.get(key)) {
      selectedItems.set(key, createInfuSignal<Veid>(EMPTY_VEID));
    }
    return selectedItems.get(key)!.get();
  };

  const setSelectedListPageItem = (listPageVeid: Veid, selectedVeid: Veid): void => {
    const key = listPageVeid.itemId + (listPageVeid.linkIdMaybe == null ? "" : "[" + listPageVeid.linkIdMaybe + "]");
    if (!selectedItems.get(key)) {
      selectedItems.set(key, createInfuSignal<Veid>(selectedVeid));
      return;
    }
    selectedItems.get(key)!.set(selectedVeid);
  };

  const getListPageColWidth = (itemId: Uid): number => {
    const key = itemId;
    if (!listPageColWidths.get(key)) {
      listPageColWidths.set(key, createNumberSignal(0));
    }
    return listPageColWidths.get(key)!.get();
  };

  const setListPageColWidth = (itemId: Uid, col: number): void => {
    const key = itemId;
    if (!listPageColWidths.get(key)) {
      listPageColWidths.set(key, createNumberSignal(col));
      return;
    }
    listPageColWidths.get(key)!.set(col);
  };

  function clear() {
    tableScrollPositions.clear();
    pageScrollXPxs.clear();
    pageScrollYPxs.clear();
    selectedItems.clear();
  }

  return ({
    getListPageColWidth, setListPageColWidth,
    getSelectedListPageItem, setSelectedListPageItem,
    getTableScrollYPos, setTableScrollYPos,
    getPageScrollXProp, setPageScrollXProp,
    getPageScrollYProp, setPageScrollYProp,
    clear
  });
}
