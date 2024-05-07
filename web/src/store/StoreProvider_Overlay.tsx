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
import { HistoryStoreContextModel } from "./StoreProvider_History";


export enum ToolbarPopupType {
  NoteUrl = "url",
  NoteFormat = "format",
  PageColor = "color",
  PageAspect = "aspect",
  PageWidth = "width",
  PageNumCols = "numcols",
  PageDocWidth = "docwidth",
  PageCellAspect = "cellaspect",
  PageJustifiedRowAspect = "justifiedrowaspect",
  PageArrangeAlgorithm = "arrangealgorithm",
  TableNumCols = "tablenumcols",
  Ids = "ids",
}

export interface ToolbarPopupInfo {
  type: ToolbarPopupType,
  topLeftPx: Vector
}

export enum CursorPosition {
  Start = "START",
  End = "END",
  UnderMouse = "UNDER_MOUSE",
}

export interface EditOverlayInfo {
  itemPath: VisualElementPath,
  initialCursorPosition: CursorPosition | number
}

export interface TableEditInfo {
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
  // Desktop overlays. TODO (MEDIUM): move all these to Main.
  searchOverlayVisible: InfuSignal<boolean>,
  editDialogInfo: InfuSignal<EditDialogInfo | null>,
  editUserSettingsInfo: InfuSignal<EditUserSettingsInfo | null>,
  contextMenuInfo: InfuSignal<ContextMenuInfo | null>,

  // Main overlays
  toolbarPopupInfoMaybe: InfuSignal<ToolbarPopupInfo | null>,

  expressionEditOverlayInfo: () => EditOverlayInfo | null,
  pageEditInfo: () => EditOverlayInfo | null,
  tableEditInfo: () => TableEditInfo | null,
  noteEditInfo: () => EditOverlayInfo | null,
  passwordEditOverlayInfo: () => EditOverlayInfo | null,

  setExpressionEditOverlayInfo: (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => void,
  setPageEditInfo: (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => void,
  setTableEditInfo: (historyStore: HistoryStoreContextModel, info: TableEditInfo | null) => void,
  setNoteEditInfo: (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => void,
  setPasswordEditOverlayInfo: (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => void,

  isPanicked: InfuSignal<boolean>,

  clear: () => void,

  anOverlayIsVisible: () => boolean,
}


export function makeOverlayStore(): OverlayStoreContextModel {
  const expressionEditOverlayInfo_ = createInfuSignal<EditOverlayInfo | null>(null);
  const pageEditInfo_ = createInfuSignal<EditOverlayInfo | null>(null);
  const tableEditInfo_ = createInfuSignal<TableEditInfo | null>(null);
  const noteEditInfo_ = createInfuSignal<EditOverlayInfo | null>(null);
  const passwordEditOverlayInfo_ = createInfuSignal<EditOverlayInfo | null>(null);

  const searchOverlayVisible = createInfuSignal<boolean>(false);
  const editDialogInfo = createInfuSignal<EditDialogInfo | null>(null);
  const editUserSettingsInfo = createInfuSignal<EditUserSettingsInfo | null>(null);
  const contextMenuInfo = createInfuSignal<ContextMenuInfo | null>(null);

  const toolbarPopupInfoMaybe = createInfuSignal<ToolbarPopupInfo | null>(null);

  function clear() {
    expressionEditOverlayInfo_.set(null);
    pageEditInfo_.set(null);
    tableEditInfo_.set(null);
    noteEditInfo_.set(null);
    passwordEditOverlayInfo_.set(null);

    editDialogInfo.set(null);
    editUserSettingsInfo.set(null);
    contextMenuInfo.set(null);
    searchOverlayVisible.set(false);
  }

  function anOverlayIsVisible(): boolean {
    return (
      expressionEditOverlayInfo_.get() != null ||
      pageEditInfo_.get() != null ||
      tableEditInfo_.get() != null ||
      noteEditInfo_.get() != null ||
      passwordEditOverlayInfo_.get() != null ||
      searchOverlayVisible.get() ||
      editDialogInfo.get() != null ||
      editUserSettingsInfo.get() != null ||
      contextMenuInfo.get() != null ||
      toolbarPopupInfoMaybe.get() != null
    );
  }

  const expressionEditOverlayInfo = (): EditOverlayInfo | null => expressionEditOverlayInfo_.get();
  const pageEditInfo = (): EditOverlayInfo | null => pageEditInfo_.get();
  const tableEditInfo = (): TableEditInfo | null => tableEditInfo_.get();
  const noteEditInfo = (): EditOverlayInfo | null => noteEditInfo_.get();
  const passwordEditOverlayInfo = (): EditOverlayInfo | null => passwordEditOverlayInfo_.get();

  const setExpressionEditOverlayInfo = (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => {
    if (info == null) { historyStore.setFocus(null) }
    else { historyStore.setFocus(info.itemPath); }
    expressionEditOverlayInfo_.set(info);
  }

  const setPageEditInfo = (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => {
    if (info == null) { historyStore.setFocus(null) }
    else { historyStore.setFocus(info.itemPath); }
    pageEditInfo_.set(info);
  }

  const setTableEditInfo = (historyStore: HistoryStoreContextModel, info: TableEditInfo | null) => {
    if (info == null) { historyStore.setFocus(null) }
    else { historyStore.setFocus(info.itemPath); }
    tableEditInfo_.set(info);
  }

  const setNoteEditInfo = (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => {
    if (info == null) { historyStore.setFocus(null) }
    else { historyStore.setFocus(info.itemPath); }
    noteEditInfo_.set(info);
  }

  const setPasswordEditOverlayInfo = (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => {
    if (info == null) { historyStore.setFocus(null) }
    else { historyStore.setFocus(info.itemPath); }
    passwordEditOverlayInfo_.set(info);
  }

  return ({
    expressionEditOverlayInfo,
    pageEditInfo,
    tableEditInfo,
    noteEditInfo,
    passwordEditOverlayInfo,

    setExpressionEditOverlayInfo,
    setPageEditInfo,
    setTableEditInfo,
    setNoteEditInfo,
    setPasswordEditOverlayInfo,

    searchOverlayVisible,
    editDialogInfo,
    editUserSettingsInfo,
    contextMenuInfo,

    isPanicked: createInfuSignal<boolean>(false),

    toolbarPopupInfoMaybe,

    clear,
    anOverlayIsVisible,
  });
}
