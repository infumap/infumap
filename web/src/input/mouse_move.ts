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

import { NATURAL_BLOCK_SIZE_PX, GRID_SIZE, MOUSE_MOVE_AMBIGUOUS_PX } from "../constants";
import { HitboxFlags } from "../layout/hitbox";
import { allowHalfBlockWidth, asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { itemCanMove } from "../items/base/capabilities-item";
import { ArrangeAlgorithm, asPageItem, isPage, PageFns } from "../items/page-item";
import { TEMP_SEARCH_RESULTS_ORIGIN } from "../items/search-item";
import { asTableItem, isTable } from "../items/table-item";
import { asNoteItem, isNote, NoteItem } from "../items/note-item";
import { NoteFlags } from "../items/base/flags-item";
import { StoreContextModel } from "../store/StoreProvider";
import { vectorAdd, getBoundingBoxTopLeft, desktopPxFromMouseEvent, isInside, vectorSubtract, Vector, boundingBoxFromPosSize, compareVector } from "../util/geometry";
import { panic } from "../util/lang";
import { VisualElement, VisualElementFlags, VeFns, veFlagIsRoot, isVeTranslucentPage, type VisualElementPath } from "../layout/visual-element";
import { HitInfoFns } from "./hit";
import { asPositionalItem } from "../items/base/positional-item";
import { asLinkItem, isLink } from "../items/link-item";
import { VesCache } from "../layout/ves-cache";
import { MouseAction, MouseActionState, CursorEventState, UserSettingsMoveState } from "./state";
import { arrangeNow } from "../layout/arrange";
import { editUserSettingsSizePx } from "../components/overlay/UserSettings";
import { mouseAction_moving, moving_initiate } from "./mouse_move_move";
import { PageFlags } from "../items/base/flags-item";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { toolbarPopupBoxBoundsPx } from "../components/toolbar/Toolbar_Popup";
import { itemState } from "../store/ItemState";
import { ImageFns, asImageItem, isImage } from "../items/image-item";
import { calcSpatialPopupGeometry } from "../layout/arrange/popup";
import { calcJustifiedPagePaddingPx } from "../layout/arrange/justified_metrics";
import {
  calculateCalendarDimensions,
  getCalendarDividerCenterPx,
  solveCalendarMonthWidthForDividerOffset,
} from "../util/calendar-layout";


let lastMouseOverPath: VisualElementPath | null = null;
let lastMouseOverOpenPopupPath: VisualElementPath | null = null;
let lastMouseOverCompositeMoveOutPath: VisualElementPath | null = null;
let lastMouseOverCatalogPagePath: VisualElementPath | null = null;
let lastMouseOverSearchGridPagePath: VisualElementPath | null = null;
let lastSelectionArrangeTimeMs = 0;
let lastSelectionSignature = "";
const SELECTION_ARRANGE_THROTTLE_MS = 33;


export function mouseMoveHandler(store: StoreContextModel) {
  if (store.history.currentPageVeid() == null) { return; }

  if (document.activeElement!.id.includes("toolbarTitleDiv")) {
    return;
  }

  const hasUser = store.user.getUserMaybe() != null;

  const currentMouseDesktopPx = CursorEventState.getLatestDesktopPx(store);

  // It is necessary to handle dialog moving at the global level, because sometimes the mouse position may
  // get outside the dialog area when being moved quickly.
  if (store.overlay.editUserSettingsInfo.get() != null) {
    if (UserSettingsMoveState.get() != null) {
      let changePx = vectorSubtract(currentMouseDesktopPx, UserSettingsMoveState.get()!.lastMousePosPx!);
      store.overlay.editUserSettingsInfo.set(({
        desktopBoundsPx: boundingBoxFromPosSize(vectorAdd(getBoundingBoxTopLeft(store.overlay.editUserSettingsInfo.get()!.desktopBoundsPx), changePx), { ...editUserSettingsSizePx })
      }));
      UserSettingsMoveState.get()!.lastMousePosPx = currentMouseDesktopPx;
      return;
    }
    if (isInside(currentMouseDesktopPx, store.overlay.editUserSettingsInfo.get()!.desktopBoundsPx)) {
      mouseMove_handleNoButtonDown(store, hasUser);
      return;
    }
  }

  if (MouseActionState.empty()) {
    mouseMove_handleNoButtonDown(store, hasUser);
    return;
  }

  let deltaPx = vectorSubtract(currentMouseDesktopPx, MouseActionState.getStartPx()!);

  changeMouseActionStateMaybe(deltaPx, store, currentMouseDesktopPx, hasUser);

  switch (MouseActionState.getAction()) {
    case MouseAction.Ambiguous:
      return;
    case MouseAction.Resizing:
      mouseAction_resizing(deltaPx, store);
      return;
    case MouseAction.ResizingPopup:
      mouseAction_resizingPopup(deltaPx, store);
      return;
    case MouseAction.ResizingColumn:
      mouseAction_resizingColumn(deltaPx, store);
      return;
    case MouseAction.ResizingDockItem:
      mouseAction_resizingDockItem(deltaPx, store);
      return;
    case MouseAction.MovingPopup:
      mouseAction_movingPopup(deltaPx, store);
      return;
    case MouseAction.Moving:
      mouseAction_moving(deltaPx, currentMouseDesktopPx, store);
      return;
    case MouseAction.ResizingDock:
      mouseAction_resizingDock(deltaPx, store);
      return;
    case MouseAction.ResizingListPageColumn:
      mouseAction_resizingListPageColumn(deltaPx, store);
      return;
    case MouseAction.ResizingCalendarMonth:
      mouseAction_resizingCalendarMonth(store);
      return;
    case MouseAction.Selecting:
      mouseAction_selecting(store);
      return;
    default:
      panic("unknown mouse action.");
  }
}


export function clearMouseOverState(store: StoreContextModel) {
  if (lastMouseOverPath) {
    store.perVe.setMouseIsOver(lastMouseOverPath, false);
    lastMouseOverPath = null;
  }
  if (lastMouseOverOpenPopupPath) {
    store.perVe.setMouseIsOverOpenPopup(lastMouseOverOpenPopupPath, false);
    lastMouseOverOpenPopupPath = null;
  }
  if (lastMouseOverCompositeMoveOutPath) {
    store.perVe.setMouseIsOverCompositeMoveOut(lastMouseOverCompositeMoveOutPath, false);
    lastMouseOverCompositeMoveOutPath = null;
  }
  if (lastMouseOverCatalogPagePath) {
    store.perVe.setMoveOverRowNumber(lastMouseOverCatalogPagePath, -1);
    lastMouseOverCatalogPagePath = null;
  }
  if (lastMouseOverSearchGridPagePath) {
    store.perVe.setMoveOverIndex(lastMouseOverSearchGridPagePath, -1);
    lastMouseOverSearchGridPagePath = null;
  }
}

function findAncestorVe(
  ve: VisualElement | null,
  matches: (candidate: VisualElement) => boolean,
): VisualElement | null {
  let current = ve;
  while (current) {
    if (matches(current)) {
      return current;
    }
    if (!current.parentPath) {
      return null;
    }
    current = VesCache.current.readNode(current.parentPath) ?? null;
  }
  return null;
}

function hoveredVeCandidates(hitInfo: ReturnType<typeof HitInfoFns.hit>): Array<VisualElement | null> {
  return [
    hitInfo.overVes?.get() ?? null,
    hitInfo.subSubRootVe ?? null,
    hitInfo.subRootVe ?? null,
    hitInfo.rootVes.get(),
  ];
}

function findAncestorVeAcrossCandidates(
  hitInfo: ReturnType<typeof HitInfoFns.hit>,
  matches: (candidate: VisualElement) => boolean,
): VisualElement | null {
  for (const candidate of hoveredVeCandidates(hitInfo)) {
    const match = findAncestorVe(candidate, matches);
    if (match) {
      return match;
    }
  }
  return null;
}

function isCatalogPageVe(ve: VisualElement): boolean {
  return isPage(ve.displayItem) && asPageItem(ve.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Catalog;
}

function isSearchResultsCatalogPageVe(ve: VisualElement): boolean {
  return isCatalogPageVe(ve) && asPageItem(ve.displayItem).origin == TEMP_SEARCH_RESULTS_ORIGIN;
}

function isSearchResultsGridPageVe(ve: VisualElement): boolean {
  if (!isPage(ve.displayItem)) {
    return false;
  }
  const pageItem = asPageItem(ve.displayItem);
  return pageItem.arrangeAlgorithm == ArrangeAlgorithm.Grid && pageItem.origin == TEMP_SEARCH_RESULTS_ORIGIN;
}

function isCatalogChildPageVe(ve: VisualElement | null): boolean {
  if (!ve || !isPage(ve.displayItem) || !ve.parentPath) {
    return false;
  }
  const parentVe = VesCache.current.readNode(ve.parentPath) ?? null;
  return parentVe != null &&
    isPage(parentVe.displayItem) &&
    asPageItem(parentVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Catalog;
}

function resolveCatalogRowOwner(ve: VisualElement | null): { pageVe: VisualElement, rowNumber: number } | null {
  let current = ve;
  let result: { pageVe: VisualElement, rowNumber: number } | null = null;
  while (current) {
    if (current.row != null && current.parentPath) {
      const parentVe = VesCache.current.readNode(current.parentPath) ?? null;
      if (parentVe && isCatalogPageVe(parentVe)) {
        result = {
          pageVe: parentVe,
          rowNumber: current.row,
        };
      }
    }
    if (!current.parentPath) {
      return result;
    }
    current = VesCache.current.readNode(current.parentPath) ?? null;
  }
  return result;
}

function resolveCatalogPageVe(
  hitInfo: ReturnType<typeof HitInfoFns.hit>,
  rowOwner: { pageVe: VisualElement, rowNumber: number } | null,
): VisualElement | null {
  return rowOwner?.pageVe ??
    findAncestorVeAcrossCandidates(hitInfo, isSearchResultsCatalogPageVe) ??
    findAncestorVeAcrossCandidates(hitInfo, isCatalogPageVe);
}

function catalogRowNumberFromBounds(
  store: StoreContextModel,
  desktopPosPx: Vector,
  catalogPageVe: VisualElement,
): number {
  if (!catalogPageVe.childAreaBoundsPx || !catalogPageVe.viewportBoundsPx) {
    return -1;
  }

  const catalogViewportBoundsPx = VeFns.veViewportBoundsRelativeToDesktopPx(store, catalogPageVe);
  const scrollVeid = VeFns.actualVeidFromVe(catalogPageVe);
  const scrollYPx = Math.max(0, catalogPageVe.childAreaBoundsPx.h - catalogPageVe.viewportBoundsPx.h) *
    store.perItem.getPageScrollYProp(scrollVeid);
  const localY = desktopPosPx.y - catalogViewportBoundsPx.y + scrollYPx;
  const rowHeightPx = catalogPageVe.cellSizePx?.h ?? 0;
  const numRows = catalogPageVe.numRows ?? 0;
  if (rowHeightPx <= 0 || localY < 0 || localY >= catalogPageVe.childAreaBoundsPx.h) {
    return -1;
  }
  return Math.min(Math.floor(localY / rowHeightPx), Math.max(numRows - 1, 0));
}

function rowNumberFromAncestorUntilPage(overVe: VisualElement | null, pageVe: VisualElement): number {
  let current = overVe;
  const pagePath = VeFns.veToPath(pageVe);
  while (current && VeFns.veToPath(current) != pagePath) {
    if (current.row != null) {
      return current.row;
    }
    if (!current.parentPath) {
      return -1;
    }
    current = VesCache.current.readNode(current.parentPath) ?? null;
  }
  return -1;
}

function currentCatalogRowHover(store: StoreContextModel, desktopPosPx: Vector, hitInfo: ReturnType<typeof HitInfoFns.hit>): { pagePath: string | null, rowNumber: number } {
  const overVe = hitInfo.overVes?.get() ?? null;
  const rowOwner = resolveCatalogRowOwner(overVe);
  const catalogPageVe = resolveCatalogPageVe(hitInfo, rowOwner);

  if (!catalogPageVe) {
    return { pagePath: null, rowNumber: -1 };
  }

  if (!isSearchResultsCatalogPageVe(catalogPageVe)) {
    return { pagePath: null, rowNumber: -1 };
  }

  let rowNumber = rowOwner?.rowNumber ?? catalogRowNumberFromBounds(store, desktopPosPx, catalogPageVe);

  if (rowNumber < 0 && typeof hitInfo.overElementMeta?.catalogRowNumber != "undefined") {
    rowNumber = hitInfo.overElementMeta.catalogRowNumber;
  }

  if (rowNumber < 0) {
    rowNumber = rowNumberFromAncestorUntilPage(overVe, catalogPageVe);
  }
  return {
    pagePath: VeFns.veToPath(catalogPageVe),
    rowNumber,
  };
}

function searchGridCellIndexFromBounds(
  store: StoreContextModel,
  desktopPosPx: Vector,
  gridPageVe: VisualElement,
  pageItem: ReturnType<typeof asPageItem>,
): number {
  if (!gridPageVe.childAreaBoundsPx || !gridPageVe.viewportBoundsPx || !gridPageVe.cellSizePx) {
    return -1;
  }

  const gridViewportBoundsPx = VeFns.veViewportBoundsRelativeToDesktopPx(store, gridPageVe);
  const scrollVeid = VeFns.actualVeidFromVe(gridPageVe);
  const scrollYPx = Math.max(0, gridPageVe.childAreaBoundsPx.h - gridPageVe.viewportBoundsPx.h) *
    store.perItem.getPageScrollYProp(scrollVeid);
  const pagePaddingPx = calcJustifiedPagePaddingPx(gridPageVe.childAreaBoundsPx.w, pageItem.justifiedRowAspect);
  const localX = desktopPosPx.x - gridViewportBoundsPx.x - pagePaddingPx;
  const localY = desktopPosPx.y - gridViewportBoundsPx.y + scrollYPx - pagePaddingPx;
  const cellW = gridPageVe.cellSizePx.w;
  const cellH = gridPageVe.cellSizePx.h;
  const contentWidthPx = cellW * Math.max(1, pageItem.gridNumberOfColumns);
  const contentHeightPx = cellH * Math.max(0, gridPageVe.numRows ?? 0);
  if (cellW <= 0 || cellH <= 0 || localX < 0 || localX >= contentWidthPx || localY < 0 || localY >= contentHeightPx) {
    return -1;
  }

  const col = Math.floor(localX / cellW);
  const row = Math.floor(localY / cellH);
  const rawIndex = row * Math.max(1, pageItem.gridNumberOfColumns) + col;
  if (rawIndex < 0 || rawIndex >= pageItem.computed_children.length) {
    return -1;
  }
  return rawIndex;
}

function directChildOfPage(overVe: VisualElement | null, pageVe: VisualElement): VisualElement | null {
  let current = overVe;
  let directChild: VisualElement | null = null;
  const pagePath = VeFns.veToPath(pageVe);
  while (current && VeFns.veToPath(current) != pagePath) {
    directChild = current;
    if (!current.parentPath) {
      return null;
    }
    current = VesCache.current.readNode(current.parentPath) ?? null;
  }
  return directChild;
}

function currentSearchGridCellHover(store: StoreContextModel, desktopPosPx: Vector, hitInfo: ReturnType<typeof HitInfoFns.hit>): { pagePath: string | null, resultIndex: number } {
  const overVe = hitInfo.overVes?.get() ?? null;
  const gridPageVe = findAncestorVeAcrossCandidates(hitInfo, isSearchResultsGridPageVe);

  if (!gridPageVe) {
    return { pagePath: null, resultIndex: -1 };
  }

  const pageItem = asPageItem(gridPageVe.displayItem);
  let resultIndex = typeof hitInfo.overElementMeta?.searchGridCellIndex != "undefined"
    ? hitInfo.overElementMeta.searchGridCellIndex
    : searchGridCellIndexFromBounds(store, desktopPosPx, gridPageVe, pageItem);

  if (resultIndex < 0 && overVe) {
    const directChildOfGridPage = directChildOfPage(overVe, gridPageVe);
    if (directChildOfGridPage && directChildOfGridPage.row != null && directChildOfGridPage.col != null) {
      resultIndex = directChildOfGridPage.row * Math.max(1, pageItem.gridNumberOfColumns) + directChildOfGridPage.col;
    }
  }
  return {
    pagePath: VeFns.veToPath(gridPageVe),
    resultIndex,
  };
}


function changeMouseActionStateMaybe(
  deltaPx: Vector,
  store: StoreContextModel,
  desktopPosPx: Vector,
  hasUser: boolean) {
  if (!MouseActionState.isAction(MouseAction.Ambiguous)) { return; }
  if (!hasUser) { return; }

  if (!(Math.abs(deltaPx.x) > MOUSE_MOVE_AMBIGUOUS_PX || Math.abs(deltaPx.y) > MOUSE_MOVE_AMBIGUOUS_PX)) {
    return;
  }

  const activeVisualElementSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeVisualElementSignal) {
    store.anItemIsMoving.set(false);
    return;
  }
  let activeVisualElement = activeVisualElementSignal.get();
  let activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  if (MouseActionState.hitboxTypeIncludes(HitboxFlags.Resize)) {
    MouseActionState.setStartPosBl(null);
    if (activeVisualElement.flags & VisualElementFlags.Popup) {
      const parentVe = MouseActionState.readVisualElement(activeVisualElement.parentPath)!;
      const parentPage = asPageItem(parentVe.displayItem);
      const popupItem = activeVisualElement.displayItem;
      if (parentPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
        MouseActionState.setStartWidthBl(activeVisualElement.linkItemMaybe!.spatialWidthGr / GRID_SIZE);

        if (isNote(popupItem) && (asNoteItem(popupItem).flags & NoteFlags.ExplicitHeight)) {
          if (activeVisualElement.actualLinkItemMaybe != null) {
            MouseActionState.setStartHeightBl(activeVisualElement.actualLinkItemMaybe.spatialHeightGr / GRID_SIZE);
          } else {
            MouseActionState.setStartHeightBl(asNoteItem(popupItem).spatialHeightGr / GRID_SIZE);
          }
        } else if (activeVisualElement.linkItemMaybe!.spatialHeightGr) {
          MouseActionState.setStartHeightBl(activeVisualElement.linkItemMaybe!.spatialHeightGr / GRID_SIZE);
        } else {
          MouseActionState.setStartHeightBl(null);
        }
      } else {
        // Cell-based popup (grid, justified, calendar)
        if (parentPage.arrangeAlgorithm == ArrangeAlgorithm.Calendar && !isPage(popupItem) && !isImage(popupItem)) {
          const actualLinkItemMaybe = activeVisualElement.actualLinkItemMaybe;
          if (actualLinkItemMaybe != null) {
            MouseActionState.setStartWidthBl(actualLinkItemMaybe.spatialWidthGr / GRID_SIZE);
          } else if (isXSizableItem(popupItem)) {
            MouseActionState.setStartWidthBl(asXSizableItem(popupItem).spatialWidthGr / GRID_SIZE);
          } else if (activeVisualElement.blockSizePx != null && activeVisualElement.blockSizePx.w > 0) {
            MouseActionState.setStartWidthBl(activeVisualElement.boundsPx.w / activeVisualElement.blockSizePx.w);
          } else {
            MouseActionState.setStartWidthBl(activeVisualElement.boundsPx.w / NATURAL_BLOCK_SIZE_PX.w);
          }

          if (isNote(popupItem) && (asNoteItem(popupItem).flags & NoteFlags.ExplicitHeight)) {
            MouseActionState.setStartHeightBl((actualLinkItemMaybe?.spatialHeightGr ?? asNoteItem(popupItem).spatialHeightGr) / GRID_SIZE);
          } else if (isYSizableItem(popupItem)) {
            MouseActionState.setStartHeightBl((actualLinkItemMaybe?.spatialHeightGr ?? asYSizableItem(popupItem).spatialHeightGr) / GRID_SIZE);
          } else {
            MouseActionState.setStartHeightBl(null);
          }
        } else if (isPage(popupItem)) {
          MouseActionState.setStartWidthBl(PageFns.getCellPopupWidthNormForParent(parentPage, asPageItem(popupItem)));
          MouseActionState.setStartHeightBl(null);
        } else if (isImage(popupItem)) {
          MouseActionState.setStartWidthBl(ImageFns.getCellPopupWidthNormForParent(asImageItem(popupItem), store.desktopMainAreaBoundsPx()));
          MouseActionState.setStartHeightBl(null);
        } else {
          MouseActionState.setStartWidthBl(parentPage.defaultCellPopupWidthNorm);
          MouseActionState.setStartHeightBl(null);
        }
      }
      MouseActionState.setAction(MouseAction.ResizingPopup);
    } else {
      MouseActionState.setStartWidthBl(isLink(activeItem) ? asLinkItem(activeItem).spatialWidthGr / GRID_SIZE : asXSizableItem(activeItem).spatialWidthGr / GRID_SIZE);
      if (activeVisualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
        const parentPath = activeVisualElement.parentPath!;
        const parentVe = MouseActionState.readVisualElement(parentPath)!;
        if (isComposite(parentVe.displayItem)) {
          const compositeWidthBl = asCompositeItem(parentVe.displayItem).spatialWidthGr / GRID_SIZE;
          if (compositeWidthBl < MouseActionState.getStartWidthBl()!) {
            MouseActionState.setStartWidthBl(compositeWidthBl);
          }
        } else if (isPage(parentVe.displayItem)) {
          const docWidthBl = asPageItem(parentVe.displayItem).docWidthBl;
          if (docWidthBl < MouseActionState.getStartWidthBl()!) {
            MouseActionState.setStartWidthBl(docWidthBl);
          }
        } else {
          panic("unexpected item type: " + parentVe.displayItem.itemType);
        }
      }

      if (isYSizableItem(activeItem)) {
        MouseActionState.setStartHeightBl(asYSizableItem(activeItem).spatialHeightGr / GRID_SIZE);
      } else if (isLink(activeItem) && (isYSizableItem(activeVisualElement.displayItem) || isNote(activeVisualElement.displayItem))) {
        MouseActionState.setStartHeightBl(asLinkItem(activeItem).spatialHeightGr / GRID_SIZE);
      } else if (isNote(activeItem) && (asNoteItem(activeItem).flags & NoteFlags.ExplicitHeight)) {
        MouseActionState.setStartHeightBl(asNoteItem(activeItem).spatialHeightGr / GRID_SIZE);
      } else {
        MouseActionState.setStartHeightBl(null);
      }
      store.anItemIsResizing.set(true);
      MouseActionState.setAction(MouseAction.Resizing);
    }

  } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.HorizontalResize)) {
    MouseActionState.setStartPosBl(null);
    MouseActionState.setStartHeightBl(null);
    if (activeVisualElement.flags & VisualElementFlags.IsDock) {
      MouseActionState.setAction(MouseAction.ResizingDock);
      MouseActionState.setStartWidthBl(store.getCurrentDockWidthPx() / NATURAL_BLOCK_SIZE_PX.w);
    } else if (isPage(activeVisualElement.displayItem) &&
      asPageItem(activeVisualElement.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Calendar &&
      MouseActionState.getHitMeta()?.calendarDividerMonth != null) {
      const dividerMonth = MouseActionState.getHitMeta()!.calendarDividerMonth!;
      const currentResize = store.perVe.getCalendarMonthResize(VeFns.veToPath(activeVisualElement));
      const startResize = currentResize != null &&
        (currentResize.month == dividerMonth || currentResize.month == dividerMonth + 1)
        ? { ...currentResize }
        : null;
      MouseActionState.setStartCalendarMonthResize(startResize);
      MouseActionState.setAction(MouseAction.ResizingCalendarMonth);
    } else if (isPage(activeVisualElement.displayItem)) {
      MouseActionState.setStartWidthBl(asPageItem(activeVisualElement.displayItem).tableColumns[0].widthGr / GRID_SIZE);
      MouseActionState.setAction(MouseAction.ResizingListPageColumn);
    } else {
      const colNum = MouseActionState.getHitMeta()!.colNum!;
      if (activeVisualElement.linkItemMaybe != null) {
        MouseActionState.setStartWidthBl(asTableItem(activeVisualElement.displayItem).tableColumns[colNum].widthGr / GRID_SIZE);
      } else {
        MouseActionState.setStartWidthBl(asTableItem(activeItem).tableColumns[colNum].widthGr / GRID_SIZE);
      }
      MouseActionState.setAction(MouseAction.ResizingColumn);
    }

  } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.VerticalResize)) {
    MouseActionState.setAction(MouseAction.ResizingDockItem);

  } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.Move) ||
    MouseActionState.compositeHitboxTypeIncludes(HitboxFlags.Move)) {
    if (!MouseActionState.hitboxTypeIncludes(HitboxFlags.Move) &&
      MouseActionState.compositeHitboxTypeIncludes(HitboxFlags.Move)) {
      // if the composite move hitbox is hit, but not the child, then swap out the active element.
      MouseActionState.setHitboxTypeOnMouseDown(MouseActionState.getCompositeHitboxTypeOnMouseDown());
      if (!MouseActionState.switchActiveElementToComposite()) {
        store.anItemIsMoving.set(false);
        return;
      }
      const newActiveSignal = MouseActionState.getActiveVisualElementSignal();
      if (!newActiveSignal) {
        store.anItemIsMoving.set(false);
        return;
      }
      activeVisualElement = newActiveSignal.get();
      activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));
    }
    if (!itemCanMove(VeFns.treeItem(activeVisualElement))) {
      store.anItemIsMoving.set(false);
      return;
    }
    MouseActionState.setStartWidthBl(null);
    MouseActionState.setStartHeightBl(null);
    if (activeVisualElement.flags & VisualElementFlags.Popup) {
      store.anItemIsMoving.set(true);
      MouseActionState.setAction(MouseAction.MovingPopup);
      const popupVe = activeVisualElement;
      const popupItem = popupVe.displayItem;
      const parentVe = MouseActionState.readVisualElement(popupVe.parentPath)!;
      const parentPage = asPageItem(parentVe.displayItem);
      if (parentPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
        let popupPositionGr;

        // Check for attachment popup
        const currentPopupSpec = store.history.currentPopupSpec();
        const isFromAttachment = currentPopupSpec?.isFromAttachment ?? false;
        const isSourceTopLeftAnchored = currentPopupSpec?.sourceTopLeftGr != null && !isPage(popupItem) && !isImage(popupItem);

        if (isFromAttachment || isSourceTopLeftAnchored) {
          const { linkItem, widthGr, heightGr } = calcSpatialPopupGeometry(store, parentPage, currentPopupSpec!.actualVeid, parentVe.childAreaBoundsPx!);
          const centerX = linkItem.spatialPositionGr.x + (widthGr ?? 0) / 2.0;
          const centerY = linkItem.spatialPositionGr.y + (heightGr ?? 0) / 2.0;
          popupPositionGr = { x: centerX, y: centerY };
        } else if (isPage(popupItem)) {
          popupPositionGr = PageFns.getPopupPositionGrForParent(parentPage, asPageItem(popupItem));
        } else if (isImage(popupItem)) {
          popupPositionGr = ImageFns.getPopupPositionGrForParent(parentPage, asImageItem(popupItem));
        } else {
          popupPositionGr = parentPage.defaultPopupPositionGr;
        }
        MouseActionState.setStartPosBl({ x: popupPositionGr.x / GRID_SIZE, y: popupPositionGr.y / GRID_SIZE });
      } else {
        let popupPositionNorm;
        if (isPage(popupItem)) {
          popupPositionNorm = PageFns.getCellPopupPositionNormForParent(parentPage, asPageItem(popupItem));
        } else if (isImage(popupItem)) {
          popupPositionNorm = ImageFns.getCellPopupPositionNormForParent(asImageItem(popupItem));
        } else {
          popupPositionNorm = parentPage.defaultCellPopupPositionNorm;
        }
        MouseActionState.setStartPosBl({ x: popupPositionNorm.x, y: popupPositionNorm.y });
      }
    } else {
      moving_initiate(store, activeItem, activeVisualElement, desktopPosPx);
    }
  } else if (veFlagIsRoot(activeVisualElement.flags)) {
    if (isPage(activeVisualElement.displayItem) &&
      asPageItem(activeVisualElement.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
      store.overlay.selectionMarqueePx.set(null);
      return;
    }
    MouseActionState.setAction(MouseAction.Selecting);
    const startPx = MouseActionState.getStartPx()!;
    store.overlay.selectionMarqueePx.set({ x: startPx.x, y: startPx.y, w: 0, h: 0 });
    store.overlay.selectedVeids.set([]);
  }
}


function selectionRectFromStartAndCurrent(store: StoreContextModel): { x: number; y: number; w: number; h: number } {
  const start = MouseActionState.getStartPx()!;
  const current = CursorEventState.getLatestDesktopPx(store);
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  const w = Math.abs(current.x - start.x);
  const h = Math.abs(current.y - start.y);
  return { x, y, w, h };
}

function mouseAction_selecting(store: StoreContextModel) {
  const rect = selectionRectFromStartAndCurrent(store);
  store.overlay.selectionMarqueePx.set(rect);
  if (rect.w <= 0 || rect.h <= 0) {
    store.overlay.selectedVeids.set([]);
    return;
  }

  const selectionRootVe = MouseActionState.readSelectionRoot()!;
  const activeRootBounds = VeFns.veViewportBoundsRelativeToDesktopPx(store, selectionRootVe);
  const selectionRect = {
    x: Math.max(rect.x, activeRootBounds.x),
    y: Math.max(rect.y, activeRootBounds.y),
    w: Math.min(rect.x + rect.w, activeRootBounds.x + activeRootBounds.w) - Math.max(rect.x, activeRootBounds.x),
    h: Math.min(rect.y + rect.h, activeRootBounds.y + activeRootBounds.h) - Math.max(rect.y, activeRootBounds.y),
  };
  if (selectionRect.w <= 0 || selectionRect.h <= 0) {
    store.overlay.selectedVeids.set([]);
    return;
  }

  const selected: Array<{ itemId: string; linkIdMaybe: string | null }> = [];
  const selectedSet = new Set<string>();
  const rootPath = MouseActionState.getSelectionRootPath()!;
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const path = stack.pop()!;
    const ves = MouseActionState.getVisualElementSignal(path);
    if (!ves) { continue; }
    const ve = ves.get();
    if (ve.parentPath && !(ve.flags & VisualElementFlags.LineItem)) {
      const veBox = VeFns.veViewportBoundsRelativeToDesktopPx(store, ve);
      if (veBox.w > 0 && veBox.h > 0) {
        const ix = Math.max(selectionRect.x, veBox.x);
        const iy = Math.max(selectionRect.y, veBox.y);
        const ax = Math.min(selectionRect.x + selectionRect.w, veBox.x + veBox.w);
        const ay = Math.min(selectionRect.y + selectionRect.h, veBox.y + veBox.h);
        if (ix < ax && iy < ay) {
          // If inside a composite, select the composite parent instead of the child
          if (ve.flags & VisualElementFlags.InsideCompositeOrDoc) {
            const parentVe = MouseActionState.readVisualElement(ve.parentPath)!;
            if (isComposite(parentVe.displayItem)) {
              const itemId = parentVe.displayItem.id;
              const linkIdMaybe = parentVe.actualLinkItemMaybe ? parentVe.actualLinkItemMaybe.id : null;
              const key = itemId + (linkIdMaybe ? `[${linkIdMaybe}]` : "");
              if (!selectedSet.has(key)) { selected.push({ itemId, linkIdMaybe }); selectedSet.add(key); }
              continue;
            }
          }

          const isSelectableContainer = isTable(ve.displayItem);
          if ((!(ve.flags & VisualElementFlags.ShowChildren) || isSelectableContainer || isVeTranslucentPage(ve)) && !(ve.flags & VisualElementFlags.Popup)) {
            const itemId = ve.displayItem.id;
            const linkIdMaybe = ve.actualLinkItemMaybe ? ve.actualLinkItemMaybe.id : null;
            const key = itemId + (linkIdMaybe ? `[${linkIdMaybe}]` : "");
            if (!selectedSet.has(key)) { selected.push({ itemId, linkIdMaybe }); selectedSet.add(key); }
          }
        }
      }
    }
    for (const child of VesCache.render.getChildren(VeFns.veToPath(ve))()) { stack.push(VeFns.veToPath(child.get())); }
    for (const att of VesCache.render.getAttachments(VeFns.veToPath(ve))()) { stack.push(VeFns.veToPath(att.get())); }
  }
  store.overlay.selectedVeids.set(selected);


  const signature = (() => {
    const ids = selected.map(s => s.itemId + (s.linkIdMaybe ? `[${s.linkIdMaybe}]` : ""));
    ids.sort();
    return ids.join(",");
  })();
  const now = Date.now();
  if (signature !== lastSelectionSignature && (now - lastSelectionArrangeTimeMs) > SELECTION_ARRANGE_THROTTLE_MS) {
    lastSelectionSignature = signature;
    lastSelectionArrangeTimeMs = now;
    arrangeNow(store, "selection-marquee-update");
  }
}


function mouseAction_resizingDock(deltaPx: Vector, store: StoreContextModel) {
  const startPx = MouseActionState.getStartDockWidthPx()!;
  let newDockWidthPx = Math.round((startPx + deltaPx.x) / NATURAL_BLOCK_SIZE_PX.w) * NATURAL_BLOCK_SIZE_PX.w;
  if (newDockWidthPx > 12 * NATURAL_BLOCK_SIZE_PX.w) { newDockWidthPx = 12 * NATURAL_BLOCK_SIZE_PX.w; }
  if (store.getCurrentDockWidthPx() != newDockWidthPx) {
    store.setDockWidthPx(newDockWidthPx);
    arrangeNow(store, "resize-dock");
  }
}


function mouseAction_resizing(deltaPx: Vector, store: StoreContextModel) {
  let requireArrange = false;

  const activeSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeSignal) {
    store.anItemIsResizing.set(false);
    return;
  }
  const activeVisualElement = activeSignal.get();
  const activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  const onePxSizeBl = MouseActionState.getOnePxSizeBl()!;
  const deltaBl = {
    x: deltaPx.x * onePxSizeBl.x,
    y: deltaPx.y * onePxSizeBl.y
  };

  let newWidthBl = MouseActionState.getStartWidthBl()! + deltaBl.x;
  if (isLink(activeItem)) {
    if (isLink(activeVisualElement.displayItem)) {
      newWidthBl = Math.round(newWidthBl);
    } else {
      newWidthBl = allowHalfBlockWidth(asXSizableItem(activeVisualElement.displayItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
    }
  } else {
    newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
  }
  if (newWidthBl < 1) { newWidthBl = 1.0; }

  if (activeVisualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
    const parentPath = activeVisualElement.parentPath!;
    const parentVe = MouseActionState.readVisualElement(parentPath)!;

    if (isComposite(parentVe.displayItem)) {
      const compositeWidthBl = asCompositeItem(parentVe.displayItem).spatialWidthGr / GRID_SIZE;
      if (compositeWidthBl < newWidthBl) {
        MouseActionState.setStartWidthBl(compositeWidthBl);
      }
    } else if (isPage(parentVe.displayItem)) {
      const docWidthBl = asPageItem(parentVe.displayItem).docWidthBl;
      if (docWidthBl < newWidthBl) {
        MouseActionState.setStartWidthBl(docWidthBl);
      }
    } else {
      panic("unexpected item type: " + parentVe.displayItem.itemType);
    }
  }

  const newWidthGr = newWidthBl * GRID_SIZE;

  if (isLink(activeItem)) {
    if (newWidthGr != asLinkItem(activeItem).spatialWidthGr) {
      asLinkItem(activeItem).spatialWidthGr = newWidthGr;
      requireArrange = true;
    }
  } else {
    if (newWidthGr != asXSizableItem(activeItem).spatialWidthGr) {
      asXSizableItem(activeItem).spatialWidthGr = newWidthGr;
      requireArrange = true;
    }
  }

  if (isNote(activeItem) && (asNoteItem(activeItem).flags & NoteFlags.ExplicitHeight)) {
    let newHeightBl = MouseActionState.getStartHeightBl()! + deltaBl.y;
    newHeightBl = Math.round(newHeightBl);

    if (newHeightBl < 1) { newHeightBl = 1.0; }
    const newHeightGr = newHeightBl * GRID_SIZE;

    if (newHeightGr != asNoteItem(activeItem).spatialHeightGr) {
      asNoteItem(activeItem).spatialHeightGr = newHeightGr;
      requireArrange = true;
    }
  }
  else if (isYSizableItem(activeItem) || (isLink(activeItem) && (isYSizableItem(activeVisualElement.displayItem) || isNote(activeVisualElement.displayItem)))) {
    let newHeightBl = MouseActionState.getStartHeightBl()! + deltaBl.y;
    newHeightBl = Math.round(newHeightBl);
    if (newHeightBl < 1) { newHeightBl = 1.0; }

    const newHeightGr = newHeightBl * GRID_SIZE;
    if (isLink(activeItem) && (isYSizableItem(activeVisualElement.displayItem) || isNote(activeVisualElement.displayItem))) {
      if (newHeightGr != asLinkItem(activeItem).spatialHeightGr) {
        asLinkItem(activeItem).spatialHeightGr = newHeightGr;
        requireArrange = true;
      }
    } else {
      if (newHeightGr != asYSizableItem(activeItem).spatialHeightGr) {
        asYSizableItem(activeItem).spatialHeightGr = newHeightGr;
        requireArrange = true;
      }
    }
  }

  if (requireArrange) {
    arrangeNow(store, "resize-item");
  }
}


function mouseAction_resizingPopup(deltaPx: Vector, store: StoreContextModel) {
  const activeVeSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeVeSignal) {
    store.anItemIsResizing.set(false);
    return;
  }
  const activeVe = activeVeSignal.get();

  if (isPage(activeVe.displayItem)) {
    const parentVe = MouseActionState.readVisualElement(activeVe.parentPath)!;
    const parentPage = asPageItem(parentVe.displayItem);
    const popupItem = asPageItem(activeVe.displayItem);

    if (parentPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
      const onePxSizeBl = MouseActionState.getOnePxSizeBl()!;
      const deltaBl = {
        x: deltaPx.x * onePxSizeBl.x * 2.0,
        y: deltaPx.y * onePxSizeBl.y * 2.0
      };
      let newWidthBl = MouseActionState.getStartWidthBl()! + deltaBl.x;
      newWidthBl = Math.round(newWidthBl * 2.0) / 2.0;
      if (newWidthBl < 3.0) { newWidthBl = 3.0; }
      const newWidthGr = newWidthBl * GRID_SIZE;

      if (newWidthGr != popupItem.pendingPopupWidthGr) {
        popupItem.pendingPopupWidthGr = newWidthGr;
        arrangeNow(store, "resize-popup-page-spatial");
      }
    } else {
      const onePxSizeBl = MouseActionState.getOnePxSizeBl()!;
      const deltaNorm = {
        x: deltaPx.x * onePxSizeBl.x * 2.0,
        y: deltaPx.y * onePxSizeBl.y * 2.0
      };
      let newWidthNorm = MouseActionState.getStartWidthBl()! + deltaNorm.x;
      if (newWidthNorm < 0.1) { newWidthNorm = 0.1; }
      if (newWidthNorm > 0.95) { newWidthNorm = 0.95; }

      if (newWidthNorm != popupItem.pendingCellPopupWidthNorm) {
        popupItem.pendingCellPopupWidthNorm = newWidthNorm;
        arrangeNow(store, "resize-popup-page-cell");
      }
    }
    return;
  }

  if (isImage(activeVe.displayItem)) {
    const parentVe = MouseActionState.readVisualElement(activeVe.parentPath)!;
    const parentPage = asPageItem(parentVe.displayItem);
    const popupItem = asImageItem(activeVe.displayItem);

    if (parentPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
      const onePxSizeBl = MouseActionState.getOnePxSizeBl()!;
      const deltaBl = {
        x: deltaPx.x * onePxSizeBl.x * 2.0,
        y: deltaPx.y * onePxSizeBl.y * 2.0
      };
      let newWidthBl = MouseActionState.getStartWidthBl()! + deltaBl.x;
      newWidthBl = Math.round(newWidthBl * 2.0) / 2.0;
      if (newWidthBl < 3.0) { newWidthBl = 3.0; }
      const newWidthGr = newWidthBl * GRID_SIZE;

      if (newWidthGr != popupItem.pendingPopupWidthGr) {
        popupItem.pendingPopupWidthGr = newWidthGr;
        arrangeNow(store, "resize-popup-image-spatial");
      }
    } else {
      const onePxSizeBl = MouseActionState.getOnePxSizeBl()!;
      const deltaNorm = {
        x: deltaPx.x * onePxSizeBl.x * 2.0,
        y: deltaPx.y * onePxSizeBl.y * 2.0
      };
      let newWidthNorm = MouseActionState.getStartWidthBl()! + deltaNorm.x;
      if (newWidthNorm < 0.1) { newWidthNorm = 0.1; }
      if (newWidthNorm > 0.95) { newWidthNorm = 0.95; }

      if (newWidthNorm != popupItem.pendingCellPopupWidthNorm) {
        popupItem.pendingCellPopupWidthNorm = newWidthNorm;
        arrangeNow(store, "resize-popup-image-cell");
      }
    }
    return;
  }

  const popupResizeOnePxSizeBl = MouseActionState.getOnePxSizeBl()!;
  const parentVe = MouseActionState.readVisualElement(activeVe.parentPath)!;
  const parentPage = asPageItem(parentVe.displayItem);
  const deltaMultiplier = parentPage.arrangeAlgorithm == ArrangeAlgorithm.Calendar ? 1.0 : 2.0;
  const deltaBl = {
    x: deltaPx.x * popupResizeOnePxSizeBl.x * deltaMultiplier,
    y: deltaPx.y * popupResizeOnePxSizeBl.y * deltaMultiplier
  };

  let newWidthBl = MouseActionState.getStartWidthBl()! + deltaBl.x;
  newWidthBl = Math.round(newWidthBl * 2.0) / 2.0;
  if (newWidthBl < 3.0) { newWidthBl = 3.0; }
  const newWidthGr = newWidthBl * GRID_SIZE;

  const activeVeid = VeFns.veidFromItems(activeVe.displayItem, activeVe.actualLinkItemMaybe);
  const popupDisplayItem = itemState.get(activeVeid.itemId)!;

  let requireArrange = false;

  if (isXSizableItem(popupDisplayItem)) {
    if (activeVeid.linkIdMaybe) {
      asLinkItem(itemState.get(activeVeid.linkIdMaybe)!).spatialWidthGr = newWidthGr;
    } else {
      asXSizableItem(popupDisplayItem).spatialWidthGr = newWidthGr;
    }
    requireArrange = true;
  }

  if (isNote(popupDisplayItem) &&
    (asNoteItem(popupDisplayItem).flags & NoteFlags.ExplicitHeight) &&
    MouseActionState.getStartHeightBl() != null) {
    let newHeightBl = MouseActionState.getStartHeightBl()! + deltaBl.y;
    newHeightBl = Math.round(newHeightBl * 2.0) / 2.0;
    if (newHeightBl < 1) { newHeightBl = 1.0; }
    const newHeightGr = newHeightBl * GRID_SIZE;
    if (activeVeid.linkIdMaybe) {
      asLinkItem(itemState.get(activeVeid.linkIdMaybe)!).spatialHeightGr = newHeightGr;
    } else {
      asNoteItem(popupDisplayItem).spatialHeightGr = newHeightGr;
    }
    requireArrange = true;
  } else if (isYSizableItem(popupDisplayItem)) {
    let newHeightBl = MouseActionState.getStartHeightBl()! + deltaBl.y;

    if (isTable(popupDisplayItem)) {
      newHeightBl = Math.round(newHeightBl);
    } else {
      newHeightBl = Math.round(newHeightBl * 2.0) / 2.0;
    }

    if (newHeightBl < 3) { newHeightBl = 3.0; }
    const newHeightGr = newHeightBl * GRID_SIZE;
    if (activeVeid.linkIdMaybe) {
      asLinkItem(itemState.get(activeVeid.linkIdMaybe)!).spatialHeightGr = newHeightGr;
    } else {
      asYSizableItem(popupDisplayItem).spatialHeightGr = newHeightGr;
    }
    requireArrange = true;
  }

  if (requireArrange) {
    arrangeNow(store, "resize-popup-item");
  }
}


function mouseAction_resizingListPageColumn(deltaPx: Vector, store: StoreContextModel) {
  const listPageSignal = MouseActionState.getActiveVisualElementSignal();
  if (!listPageSignal) {
    store.anItemIsResizing.set(false);
    return;
  }
  const activeVisualElement = listPageSignal.get();

  const listPageColumnOnePxSizeBl = MouseActionState.getOnePxSizeBl()!;
  const deltaBl = {
    x: deltaPx.x * listPageColumnOnePxSizeBl.x,
    y: deltaPx.y * listPageColumnOnePxSizeBl.y
  };

  let newWidthBl = Math.round(MouseActionState.getStartWidthBl()! + deltaBl.x);
  if (newWidthBl < 1) { newWidthBl = 1.0; }
  const newWidthGr = newWidthBl * GRID_SIZE;

  asPageItem(activeVisualElement.displayItem).tableColumns[0].widthGr = newWidthGr;
  arrangeNow(store, "resize-list-page-column");
}

function mouseAction_resizingCalendarMonth(store: StoreContextModel) {
  document.body.style.cursor = "ew-resize";
  const calendarPageSignal = MouseActionState.getActiveVisualElementSignal();
  if (!calendarPageSignal) {
    return;
  }
  const activeVisualElement = calendarPageSignal.get();
  if (!activeVisualElement.childAreaBoundsPx || !activeVisualElement.viewportBoundsPx) {
    return;
  }

  const dividerMonth = MouseActionState.getHitMeta()?.calendarDividerMonth;
  if (!dividerMonth) {
    return;
  }

  const veid = VeFns.veidFromVe(activeVisualElement);
  const scrollXPx = store.perItem.getPageScrollXProp(veid) *
    (activeVisualElement.childAreaBoundsPx.w - activeVisualElement.viewportBoundsPx.w);
  const pointerX = CursorEventState.getLatestDesktopPx(store).x -
    activeVisualElement.viewportBoundsPx.x +
    scrollXPx;

  const baselineResize = MouseActionState.getStartCalendarMonthResize();
  const baselineDimensions = calculateCalendarDimensions(activeVisualElement.childAreaBoundsPx, baselineResize);
  const baselineDividerX = getCalendarDividerCenterPx(baselineDimensions, dividerMonth);
  const resizedMonth = baselineResize != null
    ? baselineResize.month
    : (pointerX >= baselineDividerX ? dividerMonth : dividerMonth + 1);
  const widthPx = solveCalendarMonthWidthForDividerOffset(
    activeVisualElement.childAreaBoundsPx,
    dividerMonth,
    resizedMonth,
    pointerX,
  );

  const defaultWidth = calculateCalendarDimensions(activeVisualElement.childAreaBoundsPx).columnWidth;
  const nextResize = Math.abs(widthPx - defaultWidth) < 0.5
    ? null
    : { month: resizedMonth, widthPx };
  const vePath = VeFns.veToPath(activeVisualElement);
  const currentResize = store.perVe.getCalendarMonthResize(vePath);

  const changed =
    (currentResize == null) !== (nextResize == null) ||
    (currentResize != null && nextResize != null && (
      currentResize.month != nextResize.month ||
      Math.abs(currentResize.widthPx - nextResize.widthPx) >= 0.5
    ));
  if (!changed) {
    return;
  }

  store.perVe.setCalendarMonthResize(vePath, nextResize);
  arrangeNow(store, "resize-calendar-page-month");
}


function mouseAction_resizingDockItem(deltaPx: Vector, store: StoreContextModel) {
  const dockItemSignal = MouseActionState.getActiveVisualElementSignal();
  if (!dockItemSignal) {
    store.anItemIsResizing.set(false);
    return;
  }
  const activeVisualElement = dockItemSignal.get();
  const activePage = asPageItem(activeVisualElement.displayItem);
  let newHeightPx = MouseActionState.getStartChildAreaBoundsPx()!.h + deltaPx.y;
  if (newHeightPx < 5) { newHeightPx = 5; }
  let newAspect = activeVisualElement.childAreaBoundsPx!.w / newHeightPx;
  if (newAspect < 0.125) { newAspect = 0.125; }
  if (newAspect > 8.0) { newAspect = 8.0; }
  activePage.naturalAspect = newAspect;
  arrangeNow(store, "resize-dock-item");
}

function mouseAction_resizingColumn(deltaPx: Vector, store: StoreContextModel) {
  const columnSignal = MouseActionState.getActiveVisualElementSignal();
  if (!columnSignal) {
    store.anItemIsResizing.set(false);
    return;
  }
  const activeVisualElement = columnSignal.get();
  const activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  const columnOnePxSizeBl = MouseActionState.getOnePxSizeBl()!;
  const deltaBl = {
    x: deltaPx.x * columnOnePxSizeBl.x,
    y: deltaPx.y * columnOnePxSizeBl.y
  };

  let newWidthBl = MouseActionState.get()!.startWidthBl! + deltaBl.x;
  newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
  if (newWidthBl < 1) { newWidthBl = 1.0; }
  const newWidthGr = newWidthBl * GRID_SIZE;
  const colNum = MouseActionState.getHitMeta()!.colNum!;

  if (activeVisualElement.linkItemMaybe != null) {
    if (newWidthGr != asTableItem(activeVisualElement.displayItem).tableColumns[colNum].widthGr) {
      asTableItem(activeVisualElement.displayItem).tableColumns[colNum].widthGr = newWidthGr;
      arrangeNow(store, "resize-table-column-linked");
    }
  } else {
    if (newWidthGr != asTableItem(activeItem).tableColumns[colNum].widthGr) {
      asTableItem(activeItem).tableColumns[colNum].widthGr = newWidthGr;
      arrangeNow(store, "resize-table-column");
    }
  }
}


function mouseAction_movingPopup(deltaPx: Vector, store: StoreContextModel) {
  const popupVe = MouseActionState.getActiveVisualElementSignal()!.get();
  const popupItem = popupVe.displayItem;
  const parentVe = MouseActionState.readVisualElement(popupVe.parentPath)!;
  const parentPage = asPageItem(parentVe.displayItem);

  // Check if this is an attachment popup
  const currentPopupSpec = store.history.currentPopupSpec();
  const isFromAttachment = currentPopupSpec?.isFromAttachment ?? false;
  const isSourceTopLeftAnchored = currentPopupSpec?.sourceTopLeftGr != null && !isPage(popupItem) && !isImage(popupItem);

  if (parentPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
    const onePxSizeBl = MouseActionState.getOnePxSizeBl()!;
    const startPosBl = MouseActionState.getStartPosBl()!;
    const deltaBl = {
      x: Math.round(deltaPx.x * onePxSizeBl.x * 2.0) / 2.0,
      y: Math.round(deltaPx.y * onePxSizeBl.y * 2.0) / 2.0
    };
    const newPositionGr = {
      x: (startPosBl.x + deltaBl.x) * GRID_SIZE,
      y: (startPosBl.y + deltaBl.y) * GRID_SIZE
    };

    if (isFromAttachment || isSourceTopLeftAnchored) {
      // For source-anchored popups, update the PopupSpec's pendingPositionGr
      if (currentPopupSpec!.pendingPositionGr == null ||
        compareVector(newPositionGr, currentPopupSpec!.pendingPositionGr!) != 0) {
        currentPopupSpec!.pendingPositionGr = newPositionGr;
        arrangeNow(store, isFromAttachment ? "move-popup-attachment-spatial" : "move-popup-source-anchored-spatial");
      }
    } else if (isPage(popupItem)) {
      const pageItem = asPageItem(popupItem);
      if (pageItem.pendingPopupPositionGr == null ||
        compareVector(newPositionGr, pageItem.pendingPopupPositionGr!) != 0) {
        pageItem.pendingPopupPositionGr = newPositionGr;
        arrangeNow(store, "move-popup-page-spatial");
      }
    } else if (isImage(popupItem)) {
      const imageItem = asImageItem(popupItem);
      if (imageItem.pendingPopupPositionGr == null ||
        compareVector(newPositionGr, imageItem.pendingPopupPositionGr!) != 0) {
        imageItem.pendingPopupPositionGr = newPositionGr;
        arrangeNow(store, "move-popup-image-spatial");
      }
    }
  } else {
    const onePxSizeBl = MouseActionState.getOnePxSizeBl()!;
    const startPosBl = MouseActionState.getStartPosBl()!;
    const deltaNorm = {
      x: deltaPx.x * onePxSizeBl.x,
      y: deltaPx.y * onePxSizeBl.y
    };
    const newPositionNorm = {
      x: startPosBl.x + deltaNorm.x,
      y: startPosBl.y + deltaNorm.y
    };

    if (isPage(popupItem)) {
      const pageItem = asPageItem(popupItem);
      if (pageItem.pendingCellPopupPositionNorm == null ||
        compareVector(newPositionNorm, pageItem.pendingCellPopupPositionNorm!) != 0) {
        pageItem.pendingCellPopupPositionNorm = newPositionNorm;
        arrangeNow(store, "move-popup-page-cell");
      }
    } else if (isImage(popupItem)) {
      const imageItem = asImageItem(popupItem);
      if (imageItem.pendingCellPopupPositionNorm == null ||
        compareVector(newPositionNorm, imageItem.pendingCellPopupPositionNorm!) != 0) {
        imageItem.pendingCellPopupPositionNorm = newPositionNorm;
        arrangeNow(store, "move-popup-image-cell");
      }
    }
  }
}


export function mouseMove_handleNoButtonDown(store: StoreContextModel, hasUser: boolean) {
  if (!MouseActionState.empty()) {
    clearMouseOverState(store);
    store.mouseOverTableHeaderColumnNumber.set(null);
    return;
  }

  let isInsideToolbarPopup = false;
  if (store.overlay.toolbarPopupInfoMaybe.get() != null) {
    if (isInside(CursorEventState.getLatestClientPx(), toolbarPopupBoxBoundsPx(store))) {
      isInsideToolbarPopup = true;
    }
  }

  const userSettingsInfo = store.overlay.editUserSettingsInfo.get();
  const cmi = store.overlay.contextMenuInfo.get();
  const hasModal = cmi != null || userSettingsInfo != null;

  const ev = CursorEventState.get();
  const hitInfo = HitInfoFns.hit(store, desktopPxFromMouseEvent(ev, store), [], true);
  if (hitInfo.overElementMeta && (hitInfo.hitboxType & HitboxFlags.TableColumnContextMenu) && !isInsideToolbarPopup) {
    if (hitInfo.overElementMeta!.colNum) {
      store.mouseOverTableHeaderColumnNumber.set(hitInfo.overElementMeta!.colNum);
    } else {
      store.mouseOverTableHeaderColumnNumber.set(0);
    }
  } else {
    store.mouseOverTableHeaderColumnNumber.set(null);
  }

  const overElementVes = HitInfoFns.getHitVes(hitInfo);
  const suppressGenericMouseOver =
    isCatalogChildPageVe(overElementVes.get()) &&
    !!hitInfo.overElementMeta?.focusOnly &&
    !!hitInfo.overElementMeta?.allowOutsideBounds;
  const overCompositeMoveOutVes =
    (hitInfo.hitboxType & HitboxFlags.Move) && hitInfo.overElementMeta?.compositeMoveOut
      ? overElementVes
      : null;
  const overElementVe = overElementVes.get();
  const overElementPath = VeFns.veToPath(overElementVe);
  const overCompositeMoveOutPath = overCompositeMoveOutVes
    ? VeFns.veToPath(overCompositeMoveOutVes.get())
    : null;
  const catalogRowHover = currentCatalogRowHover(store, CursorEventState.getLatestDesktopPx(store), hitInfo);
  const searchGridCellHover = currentSearchGridCellHover(store, CursorEventState.getLatestDesktopPx(store), hitInfo);

  if (lastMouseOverCatalogPagePath != catalogRowHover.pagePath || (catalogRowHover.pagePath && store.perVe.getMoveOverRowNumber(catalogRowHover.pagePath) != catalogRowHover.rowNumber) || hasModal || isInsideToolbarPopup) {
    if (lastMouseOverCatalogPagePath) {
      store.perVe.setMoveOverRowNumber(lastMouseOverCatalogPagePath, -1);
      lastMouseOverCatalogPagePath = null;
    }
  }

  if (catalogRowHover.pagePath && catalogRowHover.rowNumber > -1 && !hasModal && !isInsideToolbarPopup) {
    store.perVe.getMoveOverRowNumber(catalogRowHover.pagePath);
    store.perVe.setMoveOverRowNumber(catalogRowHover.pagePath, catalogRowHover.rowNumber);
    lastMouseOverCatalogPagePath = catalogRowHover.pagePath;
  }

  if (lastMouseOverSearchGridPagePath != searchGridCellHover.pagePath || (searchGridCellHover.pagePath && store.perVe.getMoveOverIndex(searchGridCellHover.pagePath) != searchGridCellHover.resultIndex) || hasModal || isInsideToolbarPopup) {
    if (lastMouseOverSearchGridPagePath) {
      store.perVe.setMoveOverIndex(lastMouseOverSearchGridPagePath, -1);
      lastMouseOverSearchGridPagePath = null;
    }
  }

  if (searchGridCellHover.pagePath && searchGridCellHover.resultIndex > -1 && !hasModal && !isInsideToolbarPopup && !store.anItemIsMoving.get()) {
    store.perVe.getMoveOverIndex(searchGridCellHover.pagePath);
    store.perVe.setMoveOverIndex(searchGridCellHover.pagePath, searchGridCellHover.resultIndex);
    lastMouseOverSearchGridPagePath = searchGridCellHover.pagePath;
  }

  if (overElementPath != lastMouseOverPath || suppressGenericMouseOver || hasModal || isInsideToolbarPopup) {
    if (lastMouseOverPath != null) {
      store.perVe.setMouseIsOver(lastMouseOverPath, false);
      lastMouseOverPath = null;
    }
  }

  if (overElementPath != lastMouseOverOpenPopupPath || !(hitInfo.hitboxType & HitboxFlags.OpenPopup) || hasModal || isInsideToolbarPopup) {
    if (lastMouseOverOpenPopupPath != null) {
      store.perVe.setMouseIsOverOpenPopup(lastMouseOverOpenPopupPath, false);
      lastMouseOverOpenPopupPath = null;
    }
  }

  if ((overElementVe.displayItem.id != store.history.currentPageVeid()!.itemId) &&
    !(overElementVe.flags & VisualElementFlags.Popup) &&
    !suppressGenericMouseOver &&
    !hasModal && !isInsideToolbarPopup) {
    if (!store.perVe.getMouseIsOver(overElementPath)) {
      store.perVe.setMouseIsOver(overElementPath, true);
    }
    lastMouseOverPath = overElementPath;
  }

  if ((overElementVe.displayItem.id != store.history.currentPageVeid()!.itemId) &&
    !(overElementVe.flags & VisualElementFlags.Popup) &&
    !hasModal && !isInsideToolbarPopup) {
    if (hitInfo.hitboxType & HitboxFlags.OpenPopup) {
      if (!store.perVe.getMouseIsOverOpenPopup(overElementPath)) {
        store.perVe.setMouseIsOverOpenPopup(overElementPath, true);
      }
      lastMouseOverOpenPopupPath = overElementPath;
    } else {
      if (store.perVe.getMouseIsOverOpenPopup(overElementPath)) {
        store.perVe.setMouseIsOverOpenPopup(overElementPath, false);
      }
    }
  }

  if (overCompositeMoveOutPath != lastMouseOverCompositeMoveOutPath || hasModal || isInsideToolbarPopup) {
    if (lastMouseOverCompositeMoveOutPath != null) {
      store.perVe.setMouseIsOverCompositeMoveOut(lastMouseOverCompositeMoveOutPath, false);
      lastMouseOverCompositeMoveOutPath = null;
    }
  }

  if (overCompositeMoveOutVes != null && overCompositeMoveOutPath != null &&
    (overCompositeMoveOutVes.get().displayItem.id != store.history.currentPageVeid()!.itemId) &&
    !(overCompositeMoveOutVes.get().flags & VisualElementFlags.Popup) &&
    !hasModal && !isInsideToolbarPopup) {
    if (!store.perVe.getMouseIsOverCompositeMoveOut(overCompositeMoveOutPath)) {
      store.perVe.setMouseIsOverCompositeMoveOut(overCompositeMoveOutPath, true);
    }
    lastMouseOverCompositeMoveOutPath = overCompositeMoveOutPath;
  }

  if (hasUser && !isInsideToolbarPopup) {
    if (hitInfo.hitboxType & HitboxFlags.Resize) {
      document.body.style.cursor = "nwse-resize";
    } else if (hitInfo.hitboxType & HitboxFlags.HorizontalResize) {
      document.body.style.cursor = "ew-resize";
    } else if (hitInfo.hitboxType & HitboxFlags.VerticalResize) {
      document.body.style.cursor = "ns-resize";
    } else if (hitInfo.hitboxType & HitboxFlags.ShowPointer) {
      document.body.style.cursor = "pointer";
    } else if ((hitInfo.hitboxType & HitboxFlags.AnchorChild) || (hitInfo.hitboxType & HitboxFlags.AnchorDefault)) {
      document.body.style.cursor = "pointer";
    } else if (hitInfo.hitboxType & HitboxFlags.TriangleLinkSettings) {
      document.body.style.cursor = "pointer";
    } else if ((hitInfo.hitboxType & HitboxFlags.Move && isPage(HitInfoFns.getHitVe(hitInfo).displayItem)) &&
      ((HitInfoFns.getHitVe(hitInfo).flags & VisualElementFlags.Popup) ||
        ((asPageItem(HitInfoFns.getHitVe(hitInfo).displayItem).flags & PageFlags.EmbeddedInteractive) &&
          !(hitInfo.hitboxType & HitboxFlags.ContentEditable) &&
          !(HitInfoFns.getHitVe(hitInfo).flags & VisualElementFlags.InsideTable)))) {
      document.body.style.cursor = "move";
    } else if (hitInfo.hitboxType & HitboxFlags.ShiftLeft) {
      document.body.style.cursor = "zoom-in";
    } else if ((hitInfo.overVes!.get().flags & VisualElementFlags.Attachment) &&
      !(hitInfo.overVes!.get().flags & VisualElementFlags.InsideTable)) {
      document.body.style.cursor = "pointer";
    } else if (hitInfo.hitboxType & HitboxFlags.Expand) {
      document.body.style.cursor = "pointer";
    } else if (hitInfo.hitboxType & HitboxFlags.TableColumnContextMenu) {
      document.body.style.cursor = "pointer";
    } else if (hitInfo.hitboxType & HitboxFlags.Move &&
      isComposite(HitInfoFns.getOverContainerVe(hitInfo).displayItem)) {
      document.body.style.cursor = "default";
    } else {
      document.body.style.cursor = "default";
    }
  }
}
