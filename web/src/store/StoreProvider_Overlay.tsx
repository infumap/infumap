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
import { PageItem } from "../items/page-item";
import { VisualElementPath } from "../layout/visual-element";
import { BoundingBox, Vector } from "../util/geometry";
import { InfuSignal, createInfuSignal } from "../util/signals";
import { HistoryStoreContextModel } from "./StoreProvider_History";


export enum ToolbarOverlayType {
  NoteUrl = "url",
  NoteFormat = "format",
  PageColor = "color",
  PageAspect = "aspect",
  PageWidth = "width",
  PageNumCols = "numcols",
  PageDocWidth = "docwidth",
  PageCellAspect = "cellaspect",
  PageJustifiedRowAspect = "justifiedrowaspect",
  TableNumCols = "tablenumcols",
  Ids = "ids",
}

export interface ToolbarOverlayInfo {
  type: ToolbarOverlayType,
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

export interface EditPageTitleOverlayInfo {
  pageItem: PageItem,
  color: string,
  fontSize: string,
  fontWeight: string,
  boundsPx: BoundingBox,
  initialValue: string,
};

export interface OverlayStoreContextModel {
  // Desktop overlays. TODO (MEDIUM): move all these to Main.
  searchOverlayVisible: InfuSignal<boolean>,
  editDialogInfo: InfuSignal<EditDialogInfo | null>,
  editUserSettingsInfo: InfuSignal<EditUserSettingsInfo | null>,
  contextMenuInfo: InfuSignal<ContextMenuInfo | null>,

  // Main overlays
  toolbarOverlayInfoMaybe: InfuSignal<ToolbarOverlayInfo | null>,
  editingTitle: InfuSignal<EditPageTitleOverlayInfo | null>,

  expressionEditOverlayInfo: () => EditOverlayInfo | null,
  pageEditOverlayInfo: () => EditOverlayInfo | null,
  tableEditOverlayInfo: () => TableEditOverlayInfo | null,
  noteEditOverlayInfo: () => EditOverlayInfo | null,
  passwordEditOverlayInfo: () => EditOverlayInfo | null,

  setExpressionEditOverlayInfo: (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => void,
  setPageEditOverlayInfo: (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => void,
  setTableEditOverlayInfo: (historyStore: HistoryStoreContextModel, info: TableEditOverlayInfo | null) => void,
  setNoteEditOverlayInfo: (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => void,
  setPasswordEditOverlayInfo: (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => void,

  isPanicked: InfuSignal<boolean>,

  clear: () => void,

  anOverlayIsVisible: () => boolean,
}


export function makeOverlayStore(): OverlayStoreContextModel {
  const expressionEditOverlayInfo_ = createInfuSignal<EditOverlayInfo | null>(null);
  const pageEditOverlayInfo_ = createInfuSignal<EditOverlayInfo | null>(null);
  const tableEditOverlayInfo_ = createInfuSignal<TableEditOverlayInfo | null>(null);
  const noteEditOverlayInfo_ = createInfuSignal<EditOverlayInfo | null>(null);
  const passwordEditOverlayInfo_ = createInfuSignal<EditOverlayInfo | null>(null);

  const searchOverlayVisible = createInfuSignal<boolean>(false);
  const editDialogInfo = createInfuSignal<EditDialogInfo | null>(null);
  const editUserSettingsInfo = createInfuSignal<EditUserSettingsInfo | null>(null);
  const contextMenuInfo = createInfuSignal<ContextMenuInfo | null>(null);
  const editingTitle = createInfuSignal<EditPageTitleOverlayInfo | null>(null);

  const toolbarOverlayInfoMaybe = createInfuSignal<ToolbarOverlayInfo | null>(null);

  function clear() {
    expressionEditOverlayInfo_.set(null);
    pageEditOverlayInfo_.set(null);
    tableEditOverlayInfo_.set(null);
    noteEditOverlayInfo_.set(null);
    passwordEditOverlayInfo_.set(null);

    editDialogInfo.set(null);
    editUserSettingsInfo.set(null);
    contextMenuInfo.set(null);
    searchOverlayVisible.set(false);
    editingTitle.set(null);
  }

  function anOverlayIsVisible(): boolean {
    return (
      expressionEditOverlayInfo_.get() != null ||
      pageEditOverlayInfo_.get() != null ||
      tableEditOverlayInfo_.get() != null ||
      noteEditOverlayInfo_.get() != null ||
      passwordEditOverlayInfo_.get() != null ||
      searchOverlayVisible.get() ||
      editDialogInfo.get() != null ||
      editUserSettingsInfo.get() != null ||
      contextMenuInfo.get() != null ||
      toolbarOverlayInfoMaybe.get() != null ||
      editingTitle.get() != null
    );
  }

  const expressionEditOverlayInfo = (): EditOverlayInfo | null => expressionEditOverlayInfo_.get();
  const pageEditOverlayInfo = (): EditOverlayInfo | null => pageEditOverlayInfo_.get();
  const tableEditOverlayInfo = (): TableEditOverlayInfo | null => tableEditOverlayInfo_.get();
  const noteEditOverlayInfo = (): EditOverlayInfo | null => noteEditOverlayInfo_.get();
  const passwordEditOverlayInfo = (): EditOverlayInfo | null => passwordEditOverlayInfo_.get();

  const setExpressionEditOverlayInfo = (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => {
    if (info == null) { historyStore.setFocus(null) }
    else { historyStore.setFocus(info.itemPath); }
    expressionEditOverlayInfo_.set(info);
  }

  const setPageEditOverlayInfo = (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => {
    if (info == null) { historyStore.setFocus(null) }
    else { historyStore.setFocus(info.itemPath); }
    pageEditOverlayInfo_.set(info);
  }

  const setTableEditOverlayInfo = (historyStore: HistoryStoreContextModel, info: TableEditOverlayInfo | null) => {
    if (info == null) { historyStore.setFocus(null) }
    else { historyStore.setFocus(info.itemPath); }
    tableEditOverlayInfo_.set(info);
  }

  const setNoteEditOverlayInfo = (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => {
    if (info == null) { historyStore.setFocus(null) }
    else { historyStore.setFocus(info.itemPath); }
    noteEditOverlayInfo_.set(info);
  }

  const setPasswordEditOverlayInfo = (historyStore: HistoryStoreContextModel, info: EditOverlayInfo | null) => {
    if (info == null) { historyStore.setFocus(null) }
    else { historyStore.setFocus(info.itemPath); }
    passwordEditOverlayInfo_.set(info);
  }

  return ({
    expressionEditOverlayInfo,
    pageEditOverlayInfo,
    tableEditOverlayInfo,
    noteEditOverlayInfo,
    passwordEditOverlayInfo,

    setExpressionEditOverlayInfo,
    setPageEditOverlayInfo,
    setTableEditOverlayInfo,
    setNoteEditOverlayInfo,
    setPasswordEditOverlayInfo,

    searchOverlayVisible,
    editDialogInfo,
    editUserSettingsInfo,
    contextMenuInfo,

    isPanicked: createInfuSignal<boolean>(false),

    toolbarOverlayInfoMaybe,
    editingTitle,

    clear,
    anOverlayIsVisible,
  });
}
