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
import { asTableItem, isTable } from "../items/table-item";
import { fullArrange } from "../layout/arrange";
import { HitboxFlags } from "../layout/hitbox";
import { navigateBack, navigateUp, switchToPage } from "../layout/navigation";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VisualElementFlags, VeFns } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { BoundingBox, boundingBoxFromDOMRect, isInside } from "../util/geometry";
import { getHitInfo } from "./hit";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { DoubleClickState, DialogMoveState, CursorEventState, MouseAction, MouseActionState, UserSettingsMoveState, ClickState } from "./state";
import { asPageItem, isPage } from "../items/page-item";
import { PageFlags } from "../items/base/flags-item";
import { PAGE_EMBEDDED_INTERACTIVE_TITLE_HEIGHT_BL, PAGE_POPUP_TITLE_HEIGHT_BL } from "../constants";
import { toolbarBoxBoundsPx } from "../components/toolbar/Toolbar_Popup";
import { serverOrRemote } from "../server";
import { noteEditOverlay_clearJustCreated } from "../components/overlay/NoteEditOverlay";
import { CursorPosition } from "../store/StoreProvider_Overlay";
import { isRating } from "../items/rating-item";
import { isLink } from "../items/link-item";
import { MouseEventActionFlags } from "./enums";


export const MOUSE_LEFT = 0;
export const MOUSE_RIGHT = 2;


export async function mouseDownHandler(store: StoreContextModel, buttonNumber: number, viaOverlay: boolean): Promise<MouseEventActionFlags> {
  let defaultResult = MouseEventActionFlags.PreventDefault;

  if (store.history.currentPageVeid() == null) { return defaultResult; }

  // Content editables.

  let titleBounds = boundingBoxFromDOMRect(document.getElementById("toolbarTitleDiv")!.getBoundingClientRect())!;
  if (isInside(CursorEventState.getLatestClientPx(), titleBounds)) {
    return MouseEventActionFlags.None;
  }
  if (document.activeElement == document.getElementById("toolbarTitleDiv")!) {
    let selection = window.getSelection();
    if (selection != null) { selection.removeAllRanges(); }
    const newTitleText = document.getElementById("toolbarTitleDiv")!.innerText;
    asPageItem(store.history.getFocusItem()).title = newTitleText;
    fullArrange(store);
    serverOrRemote.updateItem(store.history.getFocusItem());
    defaultResult = MouseEventActionFlags.None;
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
  }

  if (store.overlay.tableEditInfo()) {
    if (isInsideItemOptionsToolbox()) { return MouseEventActionFlags.PreventDefault; }
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      let editingPath = store.overlay.tableEditInfo()!.colNum != null
        ? store.overlay.tableEditInfo()!.itemPath + ":col" + store.overlay.tableEditInfo()!.colNum
        : store.overlay.tableEditInfo()!.itemPath + ":title";
      let el = document.getElementById(editingPath);
      if (isInside(CursorEventState.getLatestClientPx(), boundingBoxFromDOMRect(el!.getBoundingClientRect())!) &&
          buttonNumber == MOUSE_LEFT) {
        return MouseEventActionFlags.None;
      }
      let newText = el!.innerText;
      let item = asTableItem(itemState.get(VeFns.veidFromPath(editingPath).itemId)!);
      if (store.overlay.tableEditInfo()!.colNum == null) {
        item.title = newText;
      } else {
        item.tableColumns[store.overlay.tableEditInfo()!.colNum!].name = newText;
      }
      serverOrRemote.updateItem(store.history.getFocusItem());
    }
    store.overlay.setTableEditInfo(store.history, null);
    fullArrange(store);
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
    defaultResult = MouseEventActionFlags.None;
  }

  if (store.overlay.pageEditInfo()) {
    if (isInsideItemOptionsToolbox()) { return MouseEventActionFlags.PreventDefault; }
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      let editingPath = store.overlay.pageEditInfo()!.itemPath + ":title";
      let el = document.getElementById(editingPath);
      if (isInside(CursorEventState.getLatestClientPx(), boundingBoxFromDOMRect(el!.getBoundingClientRect())!) &&
          buttonNumber == MOUSE_LEFT) {
        return MouseEventActionFlags.None;
      }
      let newText = el!.innerText;
      let item = asPageItem(itemState.get(VeFns.veidFromPath(editingPath).itemId)!);
      item.title = newText;
      serverOrRemote.updateItem(store.history.getFocusItem());
    }
    store.overlay.setPageEditInfo(store.history, null);
    fullArrange(store);
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
    defaultResult = MouseEventActionFlags.None;
  }


  // Toolbar popups.

  if (store.overlay.toolbarPopupInfoMaybe.get() != null) {
    if (isInside(CursorEventState.getLatestClientPx(), toolbarBoxBoundsPx(store))) {
      // if mouse down is inside popup bounds, this is not handled by the global handler.
      return MouseEventActionFlags.None;
    }
    if (ClickState.getButtonClickBoundsPx()! != null &&
        isInside(CursorEventState.getLatestClientPx(), ClickState.getButtonClickBoundsPx()!) &&
        buttonNumber == MOUSE_LEFT) {
      // if mouse down is inside button of opened popup, this is handled in the relevant button click handler.
      ClickState.setButtonClickBoundsPx(null);
      return MouseEventActionFlags.None;
    }
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.touchToolbar();
    fullArrange(store);
    serverOrRemote.updateItem(store.history.getFocusItem());
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
  }


  // The area of the toolbar specific to an item type.

  function isInsideItemOptionsToolbox(): boolean {
    const toolboxDiv = document.getElementById("toolbarItemOptionsDiv")!;
    if (!toolboxDiv) { return false; }
    const bounds = toolboxDiv.getBoundingClientRect();
    const boundsPx: BoundingBox = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
    return isInside(CursorEventState.getLatestClientPx(), boundsPx);
  }

  if (isLink(store.history.getFocusItem()) || isRating(store.history.getFocusItem())) {
    if (buttonNumber != MOUSE_LEFT ||
        !isInsideItemOptionsToolbox()) {
      store.history.setFocus(VeFns.addVeidToPath(store.history.currentPageVeid()!, ""));
    }
    defaultResult = MouseEventActionFlags.None;
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
  }


  // Text edit overlays.

  if (store.overlay.expressionEditOverlayInfo()) {
    if (isInsideItemOptionsToolbox()) { return MouseEventActionFlags.PreventDefault; }
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      serverOrRemote.updateItem(store.history.getFocusItem());
    }
    store.overlay.setExpressionEditOverlayInfo(store.history, null);
    fullArrange(store);
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
  }

  if (store.overlay.noteEditOverlayInfo()) {
    if (isInsideItemOptionsToolbox()) { return MouseEventActionFlags.PreventDefault; }
    noteEditOverlay_clearJustCreated();
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      serverOrRemote.updateItem(store.history.getFocusItem());
    }
    store.overlay.setNoteEditOverlayInfo(store.history, null);
    fullArrange(store);
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
  }

  if (store.overlay.passwordEditOverlayInfo()) {
    if (isInsideItemOptionsToolbox()) { return MouseEventActionFlags.PreventDefault; }
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      serverOrRemote.updateItem(store.history.getFocusItem());
    }
    store.overlay.setPasswordEditOverlayInfo(store.history, null);
    fullArrange(store);
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
  }


  // Desktop handlers.

  switch(buttonNumber) {
    case MOUSE_LEFT:
      defaultResult = mouseLeftDownHandler(store, viaOverlay, defaultResult);
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

export function mouseLeftDownHandler(store: StoreContextModel, viaOverlay: boolean, defaultResult: MouseEventActionFlags): MouseEventActionFlags {
  const desktopPosPx = CursorEventState.getLatestDesktopPx(store);

  if (store.overlay.contextMenuInfo.get() != null) {
    DoubleClickState.preventDoubleClick();
    store.overlay.contextMenuInfo.set(null);
    return defaultResult;
  }

  let dialogInfo = store.overlay.editDialogInfo.get();
  if (dialogInfo != null) {
    DoubleClickState.preventDoubleClick();
    if (isInside(desktopPosPx, dialogInfo!.desktopBoundsPx)) {
      DialogMoveState.set({ lastMousePosPx: desktopPosPx });
      return defaultResult;
    }

    store.overlay.editDialogInfo.set(null);
    return defaultResult;
  }

  let userSettingsInfo = store.overlay.editUserSettingsInfo.get();
  if (userSettingsInfo != null) {
    DoubleClickState.preventDoubleClick();
    if (isInside(desktopPosPx, userSettingsInfo!.desktopBoundsPx)) {
      UserSettingsMoveState.set({ lastMousePosPx: desktopPosPx });
      return defaultResult;
    }

    store.overlay.editUserSettingsInfo.set(null);
    return defaultResult;
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
      fullArrange(store);
    }
    MouseActionState.set(null);
    return defaultResult;
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

  const activeElementPath = VeFns.veToPath(hitInfo.overElementVes.get());

  if (longHoldTimeoutId) {
    clearTimeout(longHoldTimeoutId);
  }

  const overDisplayItem = hitInfo.overElementVes.get().displayItem;
  setTimeout(() => {
    if (MouseActionState.empty()) { return; }
    if (MouseActionState.get().action != MouseAction.Ambiguous) { return; }
    if (isPage(overDisplayItem)) {
      store.overlay.setPageEditInfo(store.history, { itemPath: activeElementPath, initialCursorPosition: CursorPosition.Start });
      MouseActionState.set(null);
    } else if (isRating(overDisplayItem)) {
      store.history.setFocus(activeElementPath);
      MouseActionState.set(null);
    }
  }, 750);

  MouseActionState.set({
    activeRoot: VeFns.veToPath(hitInfo.rootVe.flags & VisualElementFlags.Popup ? VesCache.get(hitInfo.rootVe.parentPath!)!.get() : hitInfo.rootVe),
    startActiveElementParent: hitInfo.overElementVes.get().parentPath!,
    activeElementPath,
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

  if (hitInfo.hitboxType & HitboxFlags.ContentEditable) {
    return MouseEventActionFlags.None;
  }

  return defaultResult;
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
  // TODO (LOW): abstract all this somehow.

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

  if (store.overlay.toolbarPopupInfoMaybe.get() != null) {
    store.overlay.toolbarPopupInfoMaybe.set(null);
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
    return;
  }

  if (store.overlay.searchOverlayVisible.get()) {
    store.overlay.searchOverlayVisible.set(false);
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
    return;
  }

  const changedPages = navigateBack(store);
  if (!changedPages) {
    await navigateUp(store);
  }
}
