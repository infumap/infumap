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

import { AttachmentsItem, asAttachmentsItem } from "../items/base/attachments-item";
import { Item } from "../items/base/item";
import { ItemFns } from "../items/base/item-polymorphism";
import { CompositeItem, asCompositeItem, isComposite } from "../items/composite-item";
import { isTable } from "../items/table-item";
import { arrange } from "../layout/arrange";
import { HitboxFlags } from "../layout/hitbox";
import { navigateBack, navigateUp, switchToPage } from "../layout/navigation";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VisualElementFlags, VeFns } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { isInside } from "../util/geometry";
import { getHitInfo } from "./hit";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { DoubleClickState, DialogMoveState, CursorEventState, MouseAction, MouseActionState, UserSettingsMoveState } from "./state";
import { asPageItem, isPage } from "../items/page-item";
import { PageFlags } from "../items/base/flags-item";
import { PAGE_EMBEDDED_INTERACTIVE_TITLE_HEIGHT_BL, PAGE_POPUP_TITLE_HEIGHT_BL } from "../constants";
import { toolbarBoxBoundsPx } from "../components/toolbar/Toolbar_Overlay";
import { server } from "../server";
import { noteEditOverlay_clearJustCreated } from "../components/overlay/NoteEditOverlay";
import { CursorPosition } from "../store/StoreProvider_Overlay";
import { isRating } from "../items/rating-item";
import { isLink } from "../items/link-item";


export const MOUSE_LEFT = 0;
export const MOUSE_RIGHT = 2;


export enum MouseDownActionFlags {
  None =           0x00,
  PreventDefault = 0x01,
}

export async function mouseDownHandler(store: StoreContextModel, buttonNumber: number, viaOverlay: boolean): Promise<MouseDownActionFlags> {
  let defaultResult = MouseDownActionFlags.PreventDefault;

  if (store.history.currentPage() == null) { return defaultResult; }

  if (store.overlay.toolbarOverlayInfoMaybe.get() != null) {
    if (isInside(CursorEventState.getLatestClientPx(), toolbarBoxBoundsPx(store))) { return MouseDownActionFlags.None; }
    store.overlay.toolbarOverlayInfoMaybe.set(null);
    store.touchToolbar();
    arrange(store);
    server.updateItem(store.history.getFocusItem());
    if (buttonNumber != MOUSE_LEFT) {
      return MouseDownActionFlags.None;
    }
  }

  if (store.overlay.editingTitle.get()) {
    store.overlay.editingTitle.set(null);
    store.overlay.toolbarOverlayInfoMaybe.set(null);
    store.touchToolbar();
    arrange(store);
    server.updateItem(store.history.getFocusItem());
    store.touchToolbar();
  }

  function isInItemOptionsToolbox(): boolean {
    const toolboxDiv = document.getElementById("toolbarItemOptionsDiv")!;
    if (!toolboxDiv) { return false; }
    const bounds = toolboxDiv.getBoundingClientRect();
    const boundsPx = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
    return isInside(CursorEventState.getLatestClientPx(), boundsPx);
  }

  if (isLink(store.history.getFocusItem()) || isRating(store.history.getFocusItem())) {
    if (buttonNumber != MOUSE_LEFT || !isInItemOptionsToolbox()) {
      store.history.setFocus(VeFns.addVeidToPath(store.history.currentPage()!, ""));
    }
    defaultResult = MouseDownActionFlags.None;
  }

  if (store.overlay.expressionEditOverlayInfo()) {
    if (isInItemOptionsToolbox()) { return MouseDownActionFlags.PreventDefault; }
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      server.updateItem(store.history.getFocusItem());
    }
    store.overlay.setExpressionEditOverlayInfo(store.history, null);
    arrange(store);
  }

  if (store.overlay.pageEditOverlayInfo()) {
    if (isInItemOptionsToolbox()) { return MouseDownActionFlags.PreventDefault; }
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      server.updateItem(store.history.getFocusItem());
    }
    store.overlay.setPageEditOverlayInfo(store.history, null);
    arrange(store);
  }

  if (store.overlay.tableEditOverlayInfo()) {
    if (isInItemOptionsToolbox()) { return MouseDownActionFlags.PreventDefault; }
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      server.updateItem(store.history.getFocusItem());
    }
    store.overlay.setTableEditOverlayInfo(store.history, null);
    arrange(store);
  }

  if (store.overlay.noteEditOverlayInfo()) {
    if (isInItemOptionsToolbox()) { return MouseDownActionFlags.PreventDefault; }
    noteEditOverlay_clearJustCreated();
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      server.updateItem(store.history.getFocusItem());
    }
    store.overlay.setNoteEditOverlayInfo(store.history, null);
    arrange(store);
  }

  if (store.overlay.passwordEditOverlayInfo()) {
    if (isInItemOptionsToolbox()) { return MouseDownActionFlags.PreventDefault; }
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      server.updateItem(store.history.getFocusItem());
    }
    store.overlay.setPasswordEditOverlayInfo(store.history, null);
    arrange(store);
  }

  switch(buttonNumber) {
    case MOUSE_LEFT:
      mouseLeftDownHandler(store, viaOverlay);
      return defaultResult;
    case MOUSE_RIGHT:
      await mouseRightDownHandler(store);
      return defaultResult;
    default:
      console.warn("unsupported mouse button: " + buttonNumber);
      return defaultResult;
  }
}

let longHoldTimeoutId: number | null = null;

export function mouseLeftDownHandler(store: StoreContextModel, viaOverlay: boolean) {

  const desktopPosPx = CursorEventState.getLatestDesktopPx(store);

  if (store.overlay.contextMenuInfo.get() != null) {
    DoubleClickState.preventDoubleClick();
    store.overlay.contextMenuInfo.set(null);
    return;
  }

  let dialogInfo = store.overlay.editDialogInfo.get();
  if (dialogInfo != null) {
    DoubleClickState.preventDoubleClick();
    if (isInside(desktopPosPx, dialogInfo!.desktopBoundsPx)) {
      DialogMoveState.set({ lastMousePosPx: desktopPosPx });
      return;
    }

    store.overlay.editDialogInfo.set(null);
    return;
  }

  let userSettingsInfo = store.overlay.editUserSettingsInfo.get();
  if (userSettingsInfo != null) {
    DoubleClickState.preventDoubleClick();
    if (isInside(desktopPosPx, userSettingsInfo!.desktopBoundsPx)) {
      UserSettingsMoveState.set({ lastMousePosPx: desktopPosPx });
      return;
    }

    store.overlay.editUserSettingsInfo.set(null);
    return;
  }

  const hitInfo = getHitInfo(store, desktopPosPx, [], false, false);
  if (hitInfo.hitboxType == HitboxFlags.None) {
    if (hitInfo.overElementVes.get().flags & VisualElementFlags.Popup && !viaOverlay) {
      DoubleClickState.preventDoubleClick();
      switchToPage(store, VeFns.actualVeidFromVe(hitInfo.overElementVes.get()), true, false, false);
    } else if(isPage(hitInfo.overElementVes.get().displayItem) &&
              asPageItem(hitInfo.overElementVes.get().displayItem).flags & PageFlags.EmbeddedInteractive) {
      DoubleClickState.preventDoubleClick();
      store.history.setFocus(VeFns.veToPath(hitInfo.overElementVes.get()));
      switchToPage(store, VeFns.actualVeidFromVe(hitInfo.overElementVes.get()), true, false, false);
    } else {
      arrange(store);
    }
    MouseActionState.set(null);
    return;
  }

  const startPosBl = null;
  const startWidthBl = null;
  const startHeightBl = null;
  const startPx = desktopPosPx;
  const activeItem = VeFns.canonicalItem(hitInfo.overElementVes.get());
  let boundsOnTopLevelPagePx = VeFns.veBoundsRelativeToDestkopPx(store, hitInfo.overElementVes.get());
  let onePxSizeBl;
  if (hitInfo.overElementVes.get().flags & VisualElementFlags.Popup) {
    const sizeBl = isPage(hitInfo.overElementVes.get().displayItem)
      ? ItemFns.calcSpatialDimensionsBl(hitInfo.overElementVes.get().linkItemMaybe!, { w: 0, h: PAGE_POPUP_TITLE_HEIGHT_BL })
      : ItemFns.calcSpatialDimensionsBl(hitInfo.overElementVes.get().linkItemMaybe!);
    onePxSizeBl = {
      x: sizeBl.w / boundsOnTopLevelPagePx.w,
      y: sizeBl.h / boundsOnTopLevelPagePx.h };
  } else {
    if (hitInfo.compositeHitboxTypeMaybe) {
      const activeCompositeItem = VeFns.canonicalItem(hitInfo.overContainerVe!);
      const compositeBoundsOnTopLevelPagePx = VeFns.veBoundsRelativeToDestkopPx(store, hitInfo.overContainerVe!);
      onePxSizeBl = {
        x: ItemFns.calcSpatialDimensionsBl(activeCompositeItem).w / compositeBoundsOnTopLevelPagePx.w,
        y: ItemFns.calcSpatialDimensionsBl(activeCompositeItem).h / compositeBoundsOnTopLevelPagePx.h };
    } else {
      const sizeBl = (hitInfo.overElementVes.get().flags & VisualElementFlags.EmbededInteractiveRoot)
        ? ItemFns.calcSpatialDimensionsBl(activeItem, { w: 0, h: PAGE_EMBEDDED_INTERACTIVE_TITLE_HEIGHT_BL })
        : ItemFns.calcSpatialDimensionsBl(activeItem);
      onePxSizeBl = {
        x: sizeBl.w / boundsOnTopLevelPagePx.w,
        y: sizeBl.h / boundsOnTopLevelPagePx.h };
    }
  }

  let clickOffsetProp = {
    x: (startPx.x - boundsOnTopLevelPagePx.x) / boundsOnTopLevelPagePx.w,
    y: (startPx.y - boundsOnTopLevelPagePx.y) / boundsOnTopLevelPagePx.h
  };
  const startAttachmentsItem = calcStartTableAttachmentsItemMaybe(activeItem);
  const startCompositeItem = calcStartCompositeItemMaybe(activeItem);

  const canHitEmbeddedInteractive = !!(hitInfo.overElementVes.get().flags & VisualElementFlags.EmbededInteractiveRoot);
  const hitInfoFiltered = getHitInfo(store, desktopPosPx, [hitInfo.overElementVes.get().displayItem.id], false, canHitEmbeddedInteractive);
  const scaleDefiningElement = VeFns.veToPath(hitInfoFiltered.overPositionableVe!);

  const activeElement = VeFns.veToPath(hitInfo.overElementVes.get());

  if (longHoldTimeoutId) {
    clearTimeout(longHoldTimeoutId);
  }

  const overDisplayItem = hitInfo.overElementVes.get().displayItem;
  setTimeout(() => {
    if (MouseActionState.empty()) { return; }
    if (MouseActionState.get().action != MouseAction.Ambiguous) { return; }
    if (isPage(overDisplayItem)) {
      store.overlay.setPageEditOverlayInfo(store.history, { itemPath: activeElement, initialCursorPosition: CursorPosition.Start });
      MouseActionState.set(null);
    } else if (isRating(overDisplayItem)) {
      store.history.setFocus(activeElement);
      MouseActionState.set(null);
    }
  }, 750);

  MouseActionState.set({
    activeRoot: VeFns.veToPath(hitInfo.rootVe.flags & VisualElementFlags.Popup ? VesCache.get(hitInfo.rootVe.parentPath!)!.get() : hitInfo.rootVe),
    startActiveElementParent: hitInfo.overElementVes.get().parentPath!,
    activeElement,
    activeCompositeElementMaybe: hitInfo.compositeHitboxTypeMaybe ? VeFns.veToPath(hitInfo.overContainerVe!) : null,
    moveOver_containerElement: null,
    moveOver_attachHitboxElement: null,
    moveOver_attachCompositeHitboxElement: null,
    moveOver_scaleDefiningElement: scaleDefiningElement,
    hitboxTypeOnMouseDown: hitInfo.hitboxType,
    compositeHitboxTypeMaybeOnMouseDown: hitInfo.compositeHitboxTypeMaybe,
    action: MouseAction.Ambiguous,
    linkCreatedOnMoveStart: false,
    startPx,
    startPosBl,
    startWidthBl,
    startHeightBl,
    startDockWidthPx: store.getCurrentDockWidthPx(),
    startAttachmentsItem,
    startCompositeItem,
    clickOffsetProp,
    onePxSizeBl,
    hitMeta: hitInfo.overElementMeta,
    newPlaceholderItem: null,
    hitEmbeddedInteractive: canHitEmbeddedInteractive
  });
}


function calcStartCompositeItemMaybe(activeItem: Item): CompositeItem | null {
  if (activeItem == null) { return null; }
  if (activeItem.parentId == null) { return null; }
  if (activeItem.relationshipToParent != RelationshipToParent.Child) { return null; }
  let parent = itemState.get(activeItem.parentId)!;
  if (!parent) { return null; }
  if (parent.parentId == null) { return null; }
  if (!isComposite(parent)) { return null; }
  return asCompositeItem(parent);
}


function calcStartTableAttachmentsItemMaybe(activeItem: Item): AttachmentsItem | null {
  if (activeItem == null) { return null; }
  if (activeItem.parentId == null) { return null; }
  if (activeItem.relationshipToParent != RelationshipToParent.Attachment) { return null; }
  let parent = itemState.get(activeItem.parentId)!;
  if (parent.parentId == null) { return null; }
  let parentParent = itemState.get(parent.parentId)!;
  if (!isTable(parentParent)) { return null; }
  return asAttachmentsItem(parent);
}


export async function mouseRightDownHandler(store: StoreContextModel) {
  if (store.overlay.contextMenuInfo.get()) {
    store.overlay.contextMenuInfo.set(null);
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
    return;
  }

  if (store.overlay.editDialogInfo.get() != null) {
    store.overlay.editDialogInfo.set(null);
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
    return;
  }

  if (store.overlay.editUserSettingsInfo.get() != null) {
    store.overlay.editUserSettingsInfo.set(null);
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
    return;
  }

  const changedPages = navigateBack(store);
  if (!changedPages) {
    await navigateUp(store);
  }
}
