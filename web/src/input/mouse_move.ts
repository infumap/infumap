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

import { GRID_SIZE, MOUSE_MOVE_AMBIGUOUS_PX } from "../constants";
import { HitboxFlags } from "../layout/hitbox";
import { allowHalfBlockWidth, asXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asPageItem, PageFns } from "../items/page-item";
import { asTableItem } from "../items/table-item";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { vectorAdd, getBoundingBoxTopLeft, desktopPxFromMouseEvent, isInside, vectorSubtract, Vector, boundingBoxFromPosSize } from "../util/geometry";
import { panic } from "../util/lang";
import { VisualElementFlags, VeFns } from "../layout/visual-element";
import { editDialogSizePx } from "../components/overlay/edit/EditDialog";
import { VisualElementSignal } from "../util/signals";
import { getHitInfo } from "./hit";
import { asPositionalItem } from "../items/base/positional-item";
import { asLinkItem, isLink } from "../items/link-item";
import { VesCache } from "../layout/ves-cache";
import { MouseAction, MouseActionState, CursorEventState, DialogMoveState, UserSettingsMoveState } from "./state";
import { arrange } from "../layout/arrange";
import { UserStoreContextModel } from "../store/UserStoreProvider";
import { editUserSettingsSizePx } from "../components/overlay/UserSettings";
import { mouseAction_moving, moving_initiate } from "./mouse_move_move";


let lastMouseOverVes: VisualElementSignal | null = null;
let lastMouseOverOpenPopupVes: VisualElementSignal | null = null;


export function mouseMoveHandler(desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel) {
  if (desktopStore.currentPage() == null) { return; }

  const hasUser = userStore.getUserMaybe() != null;

  const currentMouseDesktopPx = CursorEventState.getLastestDesktopPx();

  // It is necessary to handle dialog moving at the global level, because sometimes the mouse position may
  // get outside the dialog area when being moved quickly.
  if (desktopStore.editDialogInfo() != null) {
    if (DialogMoveState.get() != null) {
      let changePx = vectorSubtract(currentMouseDesktopPx, DialogMoveState.get()!.lastMousePosPx!);
      desktopStore.setEditDialogInfo(({
        item: desktopStore.editDialogInfo()!.item,
        desktopBoundsPx: boundingBoxFromPosSize(vectorAdd(getBoundingBoxTopLeft(desktopStore.editDialogInfo()!.desktopBoundsPx), changePx), { ...editDialogSizePx })
      }));
      DialogMoveState.get()!.lastMousePosPx = currentMouseDesktopPx;
      return;
    }
    if (isInside(currentMouseDesktopPx, desktopStore.editDialogInfo()!.desktopBoundsPx)) {
      mouseMove_handleNoButtonDown(desktopStore, hasUser);
      return;
    }
  }
  if (desktopStore.editUserSettingsInfo() != null) {
    if (UserSettingsMoveState.get() != null) {
      let changePx = vectorSubtract(currentMouseDesktopPx, UserSettingsMoveState.get()!.lastMousePosPx!);
      desktopStore.setEditUserSettingsInfo(({
        desktopBoundsPx: boundingBoxFromPosSize(vectorAdd(getBoundingBoxTopLeft(desktopStore.editUserSettingsInfo()!.desktopBoundsPx), changePx), { ...editUserSettingsSizePx })
      }));
      UserSettingsMoveState.get()!.lastMousePosPx = currentMouseDesktopPx;
      return;
    }
    if (isInside(currentMouseDesktopPx, desktopStore.editUserSettingsInfo()!.desktopBoundsPx)) {
      mouseMove_handleNoButtonDown(desktopStore, hasUser);
      return;
    }
  }

  if (MouseActionState.empty()) {
    mouseMove_handleNoButtonDown(desktopStore, hasUser);
    return;
  }

  let deltaPx = vectorSubtract(currentMouseDesktopPx, MouseActionState.get().startPx!);

  changeMouseActionStateMaybe(deltaPx, desktopStore, currentMouseDesktopPx, hasUser);

  switch (MouseActionState.get().action) {
    case MouseAction.Ambiguous:
      return;
    case MouseAction.Resizing:
      mouseAction_resizing(deltaPx, desktopStore);
      return;
    case MouseAction.ResizingPopup:
      mouseAction_resizingPopup(deltaPx, desktopStore);
      return;
    case MouseAction.ResizingColumn:
      mouseAction_resizingColumn(deltaPx, desktopStore);
      return;
    case MouseAction.MovingPopup:
      mouseAction_movingPopup(deltaPx, desktopStore);
      return;
    case MouseAction.Moving:
      mouseAction_moving(deltaPx, currentMouseDesktopPx, desktopStore);
      return;
    default:
      panic("unknown mouse action.");
  }
}


function changeMouseActionStateMaybe(
    deltaPx: Vector,
    desktopStore: DesktopStoreContextModel,
    desktopPosPx: Vector,
    hasUser: boolean) {
  if (MouseActionState.get().action != MouseAction.Ambiguous) { return; }
  if (!hasUser) { return; }

  if (!(Math.abs(deltaPx.x) > MOUSE_MOVE_AMBIGUOUS_PX || Math.abs(deltaPx.y) > MOUSE_MOVE_AMBIGUOUS_PX)) {
    return;
  }

  let activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
  let activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));

  if ((MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Resize) > 0) {
    MouseActionState.get().startPosBl = null;
    if (activeVisualElement.flags & VisualElementFlags.Popup) {
      MouseActionState.get().startWidthBl = activeVisualElement.linkItemMaybe!.spatialWidthGr / GRID_SIZE;
      MouseActionState.get().startHeightBl = null;
      MouseActionState.get().action = MouseAction.ResizingPopup;
    } else {
      MouseActionState.get().startWidthBl = asXSizableItem(activeItem).spatialWidthGr / GRID_SIZE;
      if (isYSizableItem(activeItem)) {
        MouseActionState.get().startHeightBl = asYSizableItem(activeItem).spatialHeightGr / GRID_SIZE;
      } else if(isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem)) {
        MouseActionState.get().startHeightBl = asLinkItem(activeItem).spatialHeightGr / GRID_SIZE;
      } else {
        MouseActionState.get().startHeightBl = null;
      }
      MouseActionState.get().action = MouseAction.Resizing;
    }

  } else if (((MouseActionState.get().hitboxTypeOnMouseDown & HitboxFlags.Move) > 0) ||
             ((MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown & HitboxFlags.Move))) {
    if (!(MouseActionState.get().hitboxTypeOnMouseDown & HitboxFlags.Move) &&
        (MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown & HitboxFlags.Move)) {
      // if the composite move hitbox is hit, but not the child, then swap out the active element.
      MouseActionState.get().hitboxTypeOnMouseDown = MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown!;
      MouseActionState.get().activeElement = MouseActionState.get().activeCompositeElementMaybe!;
      MouseActionState.get().startActiveElementParent = VeFns.parentPath(MouseActionState.get().activeCompositeElementMaybe!);
      activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
      activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));
    }
    MouseActionState.get().startWidthBl = null;
    MouseActionState.get().startHeightBl = null;
    if (activeVisualElement.flags & VisualElementFlags.Popup) {
      desktopStore.setItemIsMoving(true);
      MouseActionState.get().action = MouseAction.MovingPopup;
      const activeRoot = VesCache.get(MouseActionState.get().activeRoot)!.get().displayItem;
      const popupPositionGr = PageFns.getPopupPositionGr(asPageItem(activeRoot));
      MouseActionState.get().startPosBl = { x: popupPositionGr.x / GRID_SIZE, y: popupPositionGr.y / GRID_SIZE };
    } else {
      moving_initiate(desktopStore, activeItem, activeVisualElement, desktopPosPx);
    }

  } else if ((MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.ColResize) > 0) {
    MouseActionState.get().startPosBl = null;
    MouseActionState.get().startHeightBl = null;
    const colNum = MouseActionState.get().hitMeta!.resizeColNumber!;
    if (activeVisualElement.linkItemMaybe != null) {
      MouseActionState.get().startWidthBl = asTableItem(activeVisualElement.displayItem).tableColumns[colNum].widthGr / GRID_SIZE;
    } else {
      MouseActionState.get().startWidthBl = asTableItem(activeItem).tableColumns[colNum].widthGr / GRID_SIZE;
    }
    MouseActionState.get().action = MouseAction.ResizingColumn;
  }
}


function mouseAction_resizing(deltaPx: Vector, desktopStore: DesktopStoreContextModel) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
  const activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));

  const deltaBl = {
    x: deltaPx.x * MouseActionState.get().onePxSizeBl.x,
    y: deltaPx.y * MouseActionState.get().onePxSizeBl.y
  };

  let newWidthBl = MouseActionState.get()!.startWidthBl! + deltaBl.x;
  newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
  if (newWidthBl < 1) { newWidthBl = 1.0; }

  asXSizableItem(activeItem).spatialWidthGr = newWidthBl * GRID_SIZE;

  if (isYSizableItem(activeItem) || (isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem))) {
    let newHeightBl = MouseActionState.get()!.startHeightBl! + deltaBl.y;
    newHeightBl = Math.round(newHeightBl);
    if (newHeightBl < 1) { newHeightBl = 1.0; }
    if (isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem)) {
      asLinkItem(activeItem).spatialHeightGr = newHeightBl * GRID_SIZE;
    } else {
      asYSizableItem(activeItem).spatialHeightGr = newHeightBl * GRID_SIZE;
    }
  }

  arrange(desktopStore);
}


function mouseAction_resizingPopup(deltaPx: Vector, desktopStore: DesktopStoreContextModel) {
  const deltaBl = {
    x: deltaPx.x * MouseActionState.get().onePxSizeBl.x * 2.0, // * 2.0 because it's centered, so mouse distance -> half the desired increase in width.
    y: deltaPx.y * MouseActionState.get().onePxSizeBl.y * 2.0
  };

  let newWidthBl = MouseActionState.get()!.startWidthBl! + deltaBl.x;
  newWidthBl = Math.round(newWidthBl * 2.0) / 2.0;
  if (newWidthBl < 5) { newWidthBl = 5.0; }

  const activeRoot = VesCache.get(MouseActionState.get().activeRoot)!.get();
  asPageItem(activeRoot.displayItem).pendingPopupWidthGr = newWidthBl * GRID_SIZE;

  arrange(desktopStore);
}


function mouseAction_resizingColumn(deltaPx: Vector, desktopStore: DesktopStoreContextModel) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
  const activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));

  const deltaBl = {
    x: deltaPx.x * MouseActionState.get().onePxSizeBl.x,
    y: deltaPx.y * MouseActionState.get().onePxSizeBl.y
  };

  let newWidthBl = MouseActionState.get()!.startWidthBl! + deltaBl.x;
  newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
  if (newWidthBl < 1) { newWidthBl = 1.0; }

  if (activeVisualElement.linkItemMaybe != null) {
    asTableItem(activeVisualElement.displayItem).tableColumns[MouseActionState.get()!.hitMeta!.resizeColNumber!].widthGr = newWidthBl * GRID_SIZE;
  } else {
    asTableItem(activeItem).tableColumns[MouseActionState.get()!.hitMeta!.resizeColNumber!].widthGr = newWidthBl * GRID_SIZE;
  }

  arrange(desktopStore);
}


function mouseAction_movingPopup(deltaPx: Vector, desktopStore: DesktopStoreContextModel) {
  const deltaBl = {
    x: Math.round(deltaPx.x * MouseActionState.get().onePxSizeBl.x * 2.0)/2.0,
    y: Math.round(deltaPx.y * MouseActionState.get().onePxSizeBl.y * 2.0)/2.0
  };
  const newPositionGr = {
    x: (MouseActionState.get().startPosBl!.x + deltaBl.x) * GRID_SIZE,
    y: (MouseActionState.get().startPosBl!.y + deltaBl.y) * GRID_SIZE
  };
  const activeRoot = VesCache.get(MouseActionState.get().activeRoot)!.get();
  asPageItem(activeRoot.displayItem).pendingPopupPositionGr = newPositionGr;

  arrange(desktopStore);
}



export function mouseMove_handleNoButtonDown(desktopStore: DesktopStoreContextModel, hasUser: boolean) {
  const dialogInfo = desktopStore.editDialogInfo();
  const userSettingsInfo = desktopStore.editUserSettingsInfo();
  const contextMenuInfo = desktopStore.contextMenuInfo();
  const hasModal = dialogInfo != null || contextMenuInfo != null || userSettingsInfo != null;

  const ev = CursorEventState.get();
  const hitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [], false);
  const overElementVes = hitInfo.overElementVes;

  if (overElementVes != lastMouseOverVes || hasModal) {
    if (lastMouseOverVes != null) {
      lastMouseOverVes.get().mouseIsOver.set(false);
      lastMouseOverVes = null;
    }
  }

  if (overElementVes != lastMouseOverOpenPopupVes || !(hitInfo.hitboxType & HitboxFlags.OpenPopup) || hasModal) {
    if (lastMouseOverOpenPopupVes != null) {
      lastMouseOverOpenPopupVes.get().mouseIsOverOpenPopup.set(false);
      lastMouseOverOpenPopupVes = null;
    }
  }

  if ((overElementVes!.get().displayItem.id != desktopStore.currentPage()!.itemId) &&
      !(overElementVes.get().flags & VisualElementFlags.Popup) && !overElementVes.get().mouseIsOver.get() &&
      !hasModal) {
    overElementVes!.get().mouseIsOver.set(true);
    lastMouseOverVes = overElementVes;
  }

  if ((overElementVes!.get().displayItem.id != desktopStore.currentPage()!.itemId) &&
      !(overElementVes.get().flags & VisualElementFlags.Popup) && !overElementVes.get().mouseIsOverOpenPopup.get() &&
      !hasModal) {
    if (hitInfo.hitboxType & HitboxFlags.OpenPopup) {
      overElementVes!.get().mouseIsOverOpenPopup.set(true);
      lastMouseOverOpenPopupVes = overElementVes;
    } else {
      overElementVes!.get().mouseIsOverOpenPopup.set(false);
    }
  }

  if (hasUser) {
    if (hitInfo.hitboxType & HitboxFlags.Resize) {
      document.body.style.cursor = "nwse-resize";
    } else if (hitInfo.hitboxType & HitboxFlags.ColResize) {
      document.body.style.cursor = "ew-resize";
    } else if ((hitInfo.hitboxType & HitboxFlags.Move) && (hitInfo.overElementVes.get().flags & VisualElementFlags.Popup)) {
      document.body.style.cursor = "move";
    } else if (hitInfo.hitboxType & HitboxFlags.Expand) {
      document.body.style.cursor = "zoom-in";
    } else {
      document.body.style.cursor = "default";
    }
  }
}