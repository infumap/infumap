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
import { asPageItem, isPage, PageFns } from "../items/page-item";
import { asTableItem, isTable } from "../items/table-item";
import { StoreContextModel } from "../store/StoreProvider";
import { vectorAdd, getBoundingBoxTopLeft, desktopPxFromMouseEvent, isInside, vectorSubtract, Vector, boundingBoxFromPosSize, compareVector } from "../util/geometry";
import { panic } from "../util/lang";
import { VisualElementFlags, VeFns, veFlagIsRoot } from "../layout/visual-element";
import { VisualElementSignal } from "../util/signals";
import { HitInfoFns } from "./hit";
import { asPositionalItem } from "../items/base/positional-item";
import { asLinkItem, isLink } from "../items/link-item";
import { VesCache } from "../layout/ves-cache";
import { MouseAction, MouseActionState, CursorEventState, UserSettingsMoveState } from "./state";
import { fullArrange } from "../layout/arrange";
import { editUserSettingsSizePx } from "../components/overlay/UserSettings";
import { mouseAction_moving, moving_initiate } from "./mouse_move_move";
import { PageFlags } from "../items/base/flags-item";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { toolbarPopupBoxBoundsPx } from "../components/toolbar/Toolbar_Popup";
import { asFlipCardItem, isFlipCard } from "../items/flipcard-item";
import { itemState } from "../store/ItemState";


let lastMouseOverVes: VisualElementSignal | null = null;
let lastMouseOverOpenPopupVes: VisualElementSignal | null = null;


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

  let deltaPx = vectorSubtract(currentMouseDesktopPx, MouseActionState.get().startPx!);

  changeMouseActionStateMaybe(deltaPx, store, currentMouseDesktopPx, hasUser);

  switch (MouseActionState.get().action) {
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
    case MouseAction.Selecting:
      console.debug("TODO (HIGH): multi-item selection.");
      return;
    default:
      panic("unknown mouse action.");
  }
}


function changeMouseActionStateMaybe(
    deltaPx: Vector,
    store: StoreContextModel,
    desktopPosPx: Vector,
    hasUser: boolean) {
  if (MouseActionState.get().action != MouseAction.Ambiguous) { return; }
  if (!hasUser) { return; }

  if (!(Math.abs(deltaPx.x) > MOUSE_MOVE_AMBIGUOUS_PX || Math.abs(deltaPx.y) > MOUSE_MOVE_AMBIGUOUS_PX)) {
    return;
  }

  let activeVisualElement = VesCache.get(MouseActionState.get().activeElementPath)!.get();
  let activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  if ((MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Resize) > 0) {
    MouseActionState.get().startPosBl = null;
    if (activeVisualElement.flags & VisualElementFlags.Popup) {
      MouseActionState.get().startWidthBl = activeVisualElement.linkItemMaybe!.spatialWidthGr / GRID_SIZE;
      if (activeVisualElement.linkItemMaybe!.spatialHeightGr) {
        MouseActionState.get().startHeightBl = activeVisualElement.linkItemMaybe!.spatialHeightGr / GRID_SIZE;
      } else {
        MouseActionState.get().startHeightBl = null;
      }
      MouseActionState.get().action = MouseAction.ResizingPopup;
    } else {
      MouseActionState.get().startWidthBl = isLink(activeItem) ? asLinkItem(activeItem).spatialWidthGr / GRID_SIZE : asXSizableItem(activeItem).spatialWidthGr / GRID_SIZE;
      if (activeVisualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
        const parentPath = activeVisualElement.parentPath!;
        const parentVe = VesCache.get(parentPath)!.get();
        if (isComposite(parentVe.displayItem)) {
          const compositeWidthBl = asCompositeItem(parentVe.displayItem).spatialWidthGr / GRID_SIZE;
          if (compositeWidthBl < MouseActionState.get().startWidthBl!) {
            MouseActionState.get().startWidthBl = compositeWidthBl;
          }
        } else if (isPage(parentVe.displayItem)) {
          const docWidthBl = asPageItem(parentVe.displayItem).docWidthBl;
          if (docWidthBl < MouseActionState.get().startWidthBl!) {
            MouseActionState.get().startWidthBl = docWidthBl;
          }
        } else {
          panic("unexpected item type: " + parentVe.displayItem.itemType);
        }
      }

      if (isYSizableItem(activeItem)) {
        MouseActionState.get().startHeightBl = asYSizableItem(activeItem).spatialHeightGr / GRID_SIZE;
      } else if (isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem)) {
        MouseActionState.get().startHeightBl = asLinkItem(activeItem).spatialHeightGr / GRID_SIZE;

      } else if (isFlipCard(activeItem)) {
        MouseActionState.get().startHeightBl = asXSizableItem(activeItem).spatialWidthGr / asFlipCardItem(activeItem).naturalAspect / GRID_SIZE;
      } else if (isLink(activeItem) && isFlipCard(activeVisualElement.displayItem)) {
        MouseActionState.get().startHeightBl = asXSizableItem(activeVisualElement.displayItem).spatialWidthGr / asFlipCardItem(activeVisualElement.displayItem).naturalAspect / GRID_SIZE;

      } else {
        MouseActionState.get().startHeightBl = null;
      }
      store.anItemIsResizing.set(true);
      MouseActionState.get().action = MouseAction.Resizing;
    }

  } else if ((MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.HorizontalResize) > 0) {
    MouseActionState.get().startPosBl = null;
    MouseActionState.get().startHeightBl = null;
    if (activeVisualElement.flags & VisualElementFlags.IsDock) {
      MouseActionState.get().action = MouseAction.ResizingDock;
      MouseActionState.get().startWidthBl = store.getCurrentDockWidthPx() / NATURAL_BLOCK_SIZE_PX.w;
    } else if (isPage(activeVisualElement.displayItem)) {
      MouseActionState.get().startWidthBl = asPageItem(activeVisualElement.displayItem).tableColumns[0].widthGr / GRID_SIZE;
      MouseActionState.get().action = MouseAction.ResizingListPageColumn;
    } else {
      const colNum = MouseActionState.get().hitMeta!.colNum!;
      if (activeVisualElement.linkItemMaybe != null) {
        MouseActionState.get().startWidthBl = asTableItem(activeVisualElement.displayItem).tableColumns[colNum].widthGr / GRID_SIZE;
      } else {
        MouseActionState.get().startWidthBl = asTableItem(activeItem).tableColumns[colNum].widthGr / GRID_SIZE;
      }
      MouseActionState.get().action = MouseAction.ResizingColumn;
    }

  } else if ((MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.VerticalResize) > 0) {
    MouseActionState.get().action = MouseAction.ResizingDockItem;

  } else if (((MouseActionState.get().hitboxTypeOnMouseDown & HitboxFlags.Move) > 0) ||
             ((MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown & HitboxFlags.Move))) {
    if (!(MouseActionState.get().hitboxTypeOnMouseDown & HitboxFlags.Move) &&
        (MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown & HitboxFlags.Move)) {
      // if the composite move hitbox is hit, but not the child, then swap out the active element.
      MouseActionState.get().hitboxTypeOnMouseDown = MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown!;
      MouseActionState.get().activeElementPath = MouseActionState.get().activeCompositeElementMaybe!;
      MouseActionState.get().startActiveElementParent = VeFns.parentPath(MouseActionState.get().activeCompositeElementMaybe!);
      activeVisualElement = VesCache.get(MouseActionState.get().activeElementPath)!.get();
      activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));
    }
    MouseActionState.get().startWidthBl = null;
    MouseActionState.get().startHeightBl = null;
    if (activeVisualElement.flags & VisualElementFlags.Popup) {
      store.anItemIsMoving.set(true);
      MouseActionState.get().action = MouseAction.MovingPopup;
      const activeRoot = VesCache.get(MouseActionState.get().activeRoot)!.get().displayItem;
      const popupPositionGr = PageFns.getPopupPositionGr(asPageItem(activeRoot));
      MouseActionState.get().startPosBl = { x: popupPositionGr.x / GRID_SIZE, y: popupPositionGr.y / GRID_SIZE };
    } else {
      moving_initiate(store, activeItem, activeVisualElement, desktopPosPx);
    }
  } else if (veFlagIsRoot(VesCache.get(MouseActionState.get().activeElementPath)!.get().flags) ||
             VesCache.get(MouseActionState.get().activeElementPath)!.get().flags & VisualElementFlags.FlipCardPage) {
    MouseActionState.get().action = MouseAction.Selecting;
  } else {
    console.debug(VesCache.get(MouseActionState.get().activeElementPath)!.get().flags);
  }
}


function mouseAction_resizingDock(deltaPx: Vector, store: StoreContextModel) {
  const startPx = MouseActionState.get().startDockWidthPx!;
  let newDockWidthPx = Math.round((startPx + deltaPx.x) / NATURAL_BLOCK_SIZE_PX.w) * NATURAL_BLOCK_SIZE_PX.w;
  if (newDockWidthPx > 12 * NATURAL_BLOCK_SIZE_PX.w ) { newDockWidthPx = 12 * NATURAL_BLOCK_SIZE_PX.w; }
  if (store.getCurrentDockWidthPx() != newDockWidthPx) {
    store.setDockWidthPx(newDockWidthPx);
    fullArrange(store);
  }
}


function mouseAction_resizing(deltaPx: Vector, store: StoreContextModel) {
  let requireArrange = false;

  const activeVisualElement = VesCache.get(MouseActionState.get().activeElementPath)!.get();
  const activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  const deltaBl = {
    x: deltaPx.x * MouseActionState.get().onePxSizeBl.x,
    y: deltaPx.y * MouseActionState.get().onePxSizeBl.y
  };

  let newWidthBl = MouseActionState.get()!.startWidthBl! + deltaBl.x;
  if (isLink(activeItem)) {
    newWidthBl = allowHalfBlockWidth(asXSizableItem(activeVisualElement.displayItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
  } else {
    newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
  }
  if (newWidthBl < 1) { newWidthBl = 1.0; }

  if (activeVisualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
    const parentPath = activeVisualElement.parentPath!;
    const parentVe = VesCache.get(parentPath)!.get();

    if (isComposite(parentVe.displayItem)) {
      const compositeWidthBl = asCompositeItem(parentVe.displayItem).spatialWidthGr / GRID_SIZE;
      if (compositeWidthBl < newWidthBl) {
        MouseActionState.get().startWidthBl = compositeWidthBl;
      }
    } else if (isPage(parentVe.displayItem)) {
      const docWidthBl = asPageItem(parentVe.displayItem).docWidthBl;
      if (docWidthBl < newWidthBl) {
        MouseActionState.get().startWidthBl = docWidthBl;
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

  if (isFlipCard(activeItem) || (isLink(activeItem) && isFlipCard(activeVisualElement.displayItem))) {
    let newHeightBl = MouseActionState.get()!.startHeightBl! + deltaBl.y;
    newHeightBl = Math.round(newHeightBl);
    if (newHeightBl < 1) { newHeightBl = 1.0; }
    const newHeightGr = newHeightBl * GRID_SIZE;
    const newAspect = newWidthGr / newHeightGr;
    if (isLink(activeItem)) {
      // Don't allow y height adjust for linked to flip cards.
    } else {
      // TODO (LOW): don't require arrange if there was no change.
      const flipCardItem = asFlipCardItem(activeItem);
      flipCardItem.naturalAspect = newAspect;
      const frontPage = asPageItem(itemState.get(flipCardItem.computed_children[0])!);
      frontPage.naturalAspect = newAspect;
      frontPage.innerSpatialWidthGr = Math.round(newWidthGr / asFlipCardItem(activeItem).scale / GRID_SIZE) * GRID_SIZE;
      const backPage = asPageItem(itemState.get(flipCardItem.computed_children[1])!);
      backPage.naturalAspect = newAspect;
      backPage.innerSpatialWidthGr = Math.round(newWidthGr / asFlipCardItem(activeItem).scale / GRID_SIZE) * GRID_SIZE;
    }
    requireArrange = true;
  }
  else if (isYSizableItem(activeItem) || (isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem))) {
    let newHeightBl = MouseActionState.get()!.startHeightBl! + deltaBl.y;
    newHeightBl = Math.round(newHeightBl);
    if (newHeightBl < 1) { newHeightBl = 1.0; }

    const newHeightGr = newHeightBl * GRID_SIZE;
    if (isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem)) {
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
    fullArrange(store);
  }
}


function mouseAction_resizingPopup(deltaPx: Vector, store: StoreContextModel) {
  const deltaBl = {
    x: deltaPx.x * MouseActionState.get().onePxSizeBl.x * 2.0, // * 2.0 because it's centered, so mouse distance -> half the desired increase in width.
    y: deltaPx.y * MouseActionState.get().onePxSizeBl.y * 2.0
  };

  let newWidthBl = MouseActionState.get()!.startWidthBl! + deltaBl.x;
  newWidthBl = Math.round(newWidthBl * 2.0) / 2.0;
  if (newWidthBl < 3.0) { newWidthBl = 3.0; }
  const newWidthGr = newWidthBl * GRID_SIZE;

  const activeVe = VesCache.get(MouseActionState.get().activeElementPath)!.get();
  if (isPage(activeVe.displayItem)) {
    const activeRoot = VesCache.get(MouseActionState.get().activeRoot)!.get();
    if (newWidthGr != asPageItem(activeRoot.displayItem).pendingPopupWidthGr) {
      asPageItem(activeRoot.displayItem).pendingPopupWidthGr = newWidthGr;
      fullArrange(store);
    }
    return;
  }

  const activeVeid = VeFns.veidFromItems(activeVe.displayItem, activeVe.actualLinkItemMaybe);

  let requireArrange = false;

  if (isXSizableItem(itemState.get(activeVeid.itemId)!)) {
    if (activeVeid.linkIdMaybe) {
      asXSizableItem(itemState.get(activeVeid.linkIdMaybe)!).spatialWidthGr = newWidthGr;
    } else {
      asXSizableItem(itemState.get(activeVeid.itemId)!).spatialWidthGr = newWidthGr;
    }
    requireArrange = true;
  }

  if (isYSizableItem(itemState.get(activeVeid.itemId)!)) {
    let newHeightBl = MouseActionState.get()!.startHeightBl! + deltaBl.y;

    if (isTable(itemState.get(activeVeid.itemId)!)) {
      newHeightBl = Math.round(newHeightBl);
    } else {
      newHeightBl = Math.round(newHeightBl * 2.0) / 2.0;
    }

    if (newHeightBl < 3) { newHeightBl = 3.0; }
    const newHeightGr = newHeightBl * GRID_SIZE;
    if (activeVeid.linkIdMaybe) {
      asYSizableItem(itemState.get(activeVeid.linkIdMaybe)!).spatialHeightGr = newHeightGr;
    } else {
      asYSizableItem(itemState.get(activeVeid.itemId)!).spatialHeightGr = newHeightGr;
    }
    requireArrange = true;
  }

  if (requireArrange) {
    fullArrange(store);
  }
}


function mouseAction_resizingListPageColumn(deltaPx: Vector, store: StoreContextModel) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElementPath)!.get();

  const deltaBl = {
    x: deltaPx.x * MouseActionState.get().onePxSizeBl.x,
    y: deltaPx.y * MouseActionState.get().onePxSizeBl.y
  };

  let newWidthBl = Math.round(MouseActionState.get()!.startWidthBl! + deltaBl.x);
  if (newWidthBl < 1) { newWidthBl = 1.0; }
  const newWidthGr = newWidthBl * GRID_SIZE;

  asPageItem(activeVisualElement.displayItem).tableColumns[0].widthGr = newWidthGr;
  fullArrange(store);
}


function mouseAction_resizingDockItem(deltaPx: Vector, store: StoreContextModel) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElementPath)!.get();
  const activePage = asPageItem(activeVisualElement.displayItem);
  let newHeightPx = MouseActionState.get().startChildAreaBoundsPx!.h + deltaPx.y;
  if (newHeightPx < 5) { newHeightPx = 5; }
  let newAspect = activeVisualElement.childAreaBoundsPx!.w / newHeightPx;
  if (newAspect < 0.125) { newAspect = 0.125; }
  if (newAspect > 8.0) { newAspect = 8.0; }
  activePage.naturalAspect = newAspect;
  fullArrange(store);
}

function mouseAction_resizingColumn(deltaPx: Vector, store: StoreContextModel) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElementPath)!.get();
  const activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  const deltaBl = {
    x: deltaPx.x * MouseActionState.get().onePxSizeBl.x,
    y: deltaPx.y * MouseActionState.get().onePxSizeBl.y
  };

  let newWidthBl = MouseActionState.get()!.startWidthBl! + deltaBl.x;
  newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
  if (newWidthBl < 1) { newWidthBl = 1.0; }
  const newWidthGr = newWidthBl * GRID_SIZE;

  if (activeVisualElement.linkItemMaybe != null) {
    if (newWidthGr != asTableItem(activeVisualElement.displayItem).tableColumns[MouseActionState.get()!.hitMeta!.colNum!].widthGr) {
      asTableItem(activeVisualElement.displayItem).tableColumns[MouseActionState.get()!.hitMeta!.colNum!].widthGr = newWidthGr;
      fullArrange(store);
    }
  } else {
    if (newWidthGr != asTableItem(activeItem).tableColumns[MouseActionState.get()!.hitMeta!.colNum!].widthGr) {
      asTableItem(activeItem).tableColumns[MouseActionState.get()!.hitMeta!.colNum!].widthGr = newWidthGr;
      fullArrange(store);
    }
  }
}


function mouseAction_movingPopup(deltaPx: Vector, store: StoreContextModel) {
  const deltaBl = {
    x: Math.round(deltaPx.x * MouseActionState.get().onePxSizeBl.x * 2.0)/2.0,
    y: Math.round(deltaPx.y * MouseActionState.get().onePxSizeBl.y * 2.0)/2.0
  };
  const newPositionGr = {
    x: (MouseActionState.get().startPosBl!.x + deltaBl.x) * GRID_SIZE,
    y: (MouseActionState.get().startPosBl!.y + deltaBl.y) * GRID_SIZE
  };
  const activeRoot = VesCache.get(MouseActionState.get().activeRoot)!.get();

  if (asPageItem(activeRoot.displayItem).pendingPopupPositionGr == null ||
      compareVector(newPositionGr, asPageItem(activeRoot.displayItem).pendingPopupPositionGr!) != 0) {
    asPageItem(activeRoot.displayItem).pendingPopupPositionGr = newPositionGr;
    fullArrange(store);
  }
}


export function mouseMove_handleNoButtonDown(store: StoreContextModel, hasUser: boolean) {

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
  if (overElementVes != lastMouseOverVes || hasModal || isInsideToolbarPopup) {
    if (lastMouseOverVes != null) {
      store.perVe.setMouseIsOver(VeFns.veToPath(lastMouseOverVes.get()), false);
      lastMouseOverVes = null;
    }
  }

  if (overElementVes != lastMouseOverOpenPopupVes || !(hitInfo.hitboxType & HitboxFlags.OpenPopup) || hasModal || isInsideToolbarPopup) {
    if (lastMouseOverOpenPopupVes != null) {
      store.perVe.setMouseIsOverOpenPopup(VeFns.veToPath(lastMouseOverOpenPopupVes.get()), false);
      lastMouseOverOpenPopupVes = null;
    }
  }

  if ((overElementVes!.get().displayItem.id != store.history.currentPageVeid()!.itemId) &&
      !(overElementVes.get().flags & VisualElementFlags.Popup) && !store.perVe.getMouseIsOver(VeFns.veToPath(overElementVes.get())) &&
      !hasModal && !isInsideToolbarPopup) {
    store.perVe.setMouseIsOver(VeFns.veToPath(overElementVes.get()), true);
    lastMouseOverVes = overElementVes;
  }

  if ((overElementVes!.get().displayItem.id != store.history.currentPageVeid()!.itemId) &&
      !(overElementVes.get().flags & VisualElementFlags.Popup) && !store.perVe.getMouseIsOverOpenPopup(VeFns.veToPath(overElementVes.get())) &&
      !hasModal && !isInsideToolbarPopup) {
    if (hitInfo.hitboxType & HitboxFlags.OpenPopup) {
      store.perVe.setMouseIsOverOpenPopup(VeFns.veToPath(overElementVes.get()), true);
      lastMouseOverOpenPopupVes = overElementVes;
    } else {
      store.perVe.setMouseIsOverOpenPopup(VeFns.veToPath(overElementVes.get()), false);
    }
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
    } else if (hitInfo.hitboxType & HitboxFlags.Anchor) {
      document.body.style.cursor = "pointer";
    } else if ((hitInfo.hitboxType & HitboxFlags.Move && isPage(HitInfoFns.getHitVe(hitInfo).displayItem)) &&
               ((HitInfoFns.getHitVe(hitInfo).flags & VisualElementFlags.Popup) ||
                ((asPageItem(HitInfoFns.getHitVe(hitInfo).displayItem).flags & PageFlags.EmbeddedInteractive) && !(hitInfo.hitboxType & HitboxFlags.ContentEditable)))) {
      document.body.style.cursor = "move";
    } else if (hitInfo.hitboxType & HitboxFlags.ShiftLeft) {
      document.body.style.cursor = "zoom-in";
    } else if (hitInfo.overVes!.get().flags & VisualElementFlags.Attachment) {
      document.body.style.cursor = "pointer";
    } else if (hitInfo.hitboxType & HitboxFlags.Expand) {
      document.body.style.cursor = "pointer";
    } else if (hitInfo.hitboxType & HitboxFlags.TableColumnContextMenu) {
      document.body.style.cursor = "pointer";
    } else if (hitInfo.hitboxType & HitboxFlags.Move &&
              isComposite(HitInfoFns.getOverContainerVe(hitInfo).displayItem)) {
      document.body.style.cursor = "default";
    } else if (hitInfo.hitboxType & HitboxFlags.Flip ||
               hitInfo.hitboxType & HitboxFlags.TimedFlip ||
               hitInfo.hitboxType & HitboxFlags.Edit) {
      document.body.style.cursor = "pointer";
    } else {
      document.body.style.cursor = "default";
    }
  }
}
