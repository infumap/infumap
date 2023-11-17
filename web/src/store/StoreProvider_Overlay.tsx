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

import { HitInfo } from "../input/hit";
import { Item } from "../items/base/item";
import { VisualElementPath } from "../layout/visual-element";
import { BoundingBox, Vector } from "../util/geometry";
import { InfuSignal, createInfuSignal } from "../util/signals";


export interface OverlayCoordinates {
  topLeftPx: Vector
}

export interface EditOverlayInfo {
  itemPath: VisualElementPath
}

export interface TableEditOverlayInfo {
  itemPath: VisualElementPath,
  colNum: number | null,
  startBl: number | null,
  endBl: number | null,
}

export interface ContextMenuInfo {
  posPx: Vector,
  hitInfo: HitInfo
}

export interface EditDialogInfo {
  desktopBoundsPx: BoundingBox,
  item: Item
}

export interface EditUserSettingsInfo {
  desktopBoundsPx: BoundingBox,
}


export interface OverlayStoreContextModel {
  // desktop overlays
  noteEditOverlayInfo: InfuSignal<EditOverlayInfo | null>,
  tableEditOverlayInfo: InfuSignal<TableEditOverlayInfo | null>,
  searchOverlayVisible: InfuSignal<boolean>,
  editDialogInfo: InfuSignal<EditDialogInfo | null>,
  editUserSettingsInfo: InfuSignal<EditUserSettingsInfo | null>,
  contextMenuInfo: InfuSignal<ContextMenuInfo | null>,

  // global overlays
  noteUrlOverlayInfoMaybe: InfuSignal<OverlayCoordinates | null>,
  noteFormatOverlayInfoMaybe: InfuSignal<OverlayCoordinates | null>,
  pageColorOverlayInfoMaybe: InfuSignal<OverlayCoordinates | null>,
  pageAspectOverlayInfoMaybe: InfuSignal<OverlayCoordinates | null>,
  pageWidthOverlayInfoMaybe: InfuSignal<OverlayCoordinates | null>,
  pageNumColsOverlayInfoMaybe: InfuSignal<OverlayCoordinates | null>,
  isPanicked: InfuSignal<boolean>,

  clear: () => void,
}


export function makeOverlayStore(): OverlayStoreContextModel {
  const tableEditOverlayInfo = createInfuSignal<TableEditOverlayInfo | null>(null);
  const noteEditOverlayInfo = createInfuSignal<EditOverlayInfo | null>(null);
  const searchOverlayVisible = createInfuSignal<boolean>(false);
  const editDialogInfo = createInfuSignal<EditDialogInfo | null>(null);
  const editUserSettingsInfo = createInfuSignal<EditUserSettingsInfo | null>(null);
  const contextMenuInfo = createInfuSignal<ContextMenuInfo | null>(null);

  function clear() {
    tableEditOverlayInfo.set(null);
    editDialogInfo.set(null);
    editUserSettingsInfo.set(null);
    contextMenuInfo.set(null);
    noteEditOverlayInfo.set(null);
    searchOverlayVisible.set(false);
  }

  return ({
    tableEditOverlayInfo,
    searchOverlayVisible,
    noteEditOverlayInfo,
    editDialogInfo,
    editUserSettingsInfo,
    contextMenuInfo,

    isPanicked: createInfuSignal<boolean>(false),

    noteUrlOverlayInfoMaybe: createInfuSignal<OverlayCoordinates | null>(null),
    noteFormatOverlayInfoMaybe: createInfuSignal<OverlayCoordinates | null>(null),
    pageColorOverlayInfoMaybe: createInfuSignal<OverlayCoordinates | null>(null),
    pageAspectOverlayInfoMaybe: createInfuSignal<OverlayCoordinates | null>(null),
    pageWidthOverlayInfoMaybe: createInfuSignal<OverlayCoordinates | null>(null),
    pageNumColsOverlayInfoMaybe: createInfuSignal<OverlayCoordinates | null>(null),

    clear,
  });
}
