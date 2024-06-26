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
import { Item, ItemType } from "../items/base/item";
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
import { HitInfoFns } from "./hit";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { DoubleClickState, CursorEventState, MouseAction, MouseActionState, UserSettingsMoveState, ClickState } from "./state";
import { PageFns, asPageItem, isPage } from "../items/page-item";
import { PageFlags } from "../items/base/flags-item";
import { PAGE_EMBEDDED_INTERACTIVE_TITLE_HEIGHT_BL, PAGE_POPUP_TITLE_HEIGHT_BL } from "../constants";
import { toolbarBoxBoundsPx } from "../components/toolbar/Toolbar_Popup";
import { serverOrRemote } from "../server";
import { trimNewline } from "../util/string";
import { isRating } from "../items/rating-item";
import { isLink } from "../items/link-item";
import { MouseEventActionFlags } from "./enums";
import { asNoteItem } from "../items/note-item";
import { asFileItem } from "../items/file-item";


export const MOUSE_LEFT = 0;
export const MOUSE_RIGHT = 2;


export async function mouseDownHandler(store: StoreContextModel, buttonNumber: number, viaOverlay: boolean): Promise<MouseEventActionFlags> {
  let defaultResult = MouseEventActionFlags.PreventDefault;

  if (store.history.currentPageVeid() == null) { return defaultResult; }

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

  // Page title edit via toolbar.
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

  // In text edit mode.
  if (store.overlay.textEditInfo()) {
    if (isInsideItemOptionsToolbox()) { return MouseEventActionFlags.PreventDefault; }

    if (store.user.getUserMaybe() == null || store.history.getFocusItem().ownerId != store.user.getUser().userId) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      store.overlay.setTextEditInfo(store.history, null);
      fullArrange(store);
      if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
      defaultResult = MouseEventActionFlags.None;
    }

    else {
      const editingItemPath = store.overlay.textEditInfo()!.itemPath;
      const editingDomId = store.overlay.textEditInfo()!.colNum != null
        ? editingItemPath + ":col" + store.overlay.textEditInfo()!.colNum
        : editingItemPath + ":title";
      const editingDomEl = document.getElementById(editingDomId);
      if (isInside(CursorEventState.getLatestClientPx(), boundingBoxFromDOMRect(editingDomEl!.getBoundingClientRect())!) &&
          buttonNumber == MOUSE_LEFT) {
        return MouseEventActionFlags.None;
      }
      const newText = editingDomEl!.innerText;
      const item = itemState.get(VeFns.veidFromPath(editingItemPath).itemId)!;

      if (store.overlay.textEditInfo()!.itemType == ItemType.Table) {
        if (store.overlay.textEditInfo()!.colNum == null) {
          asTableItem(item).title = trimNewline(newText);
        } else {
          asTableItem(item).tableColumns[store.overlay.textEditInfo()!.colNum!].name = trimNewline(newText);
        }
      }
      else if (store.overlay.textEditInfo()!.itemType == ItemType.Page) {
        asPageItem(item).title = trimNewline(newText);
      }
      else if (store.overlay.textEditInfo()!.itemType == ItemType.Note) {
        editingDomEl!.parentElement!.scrollLeft = 0;
        asNoteItem(item).title = trimNewline(newText);
      }
      else if (store.overlay.textEditInfo()!.itemType == ItemType.File) {
        editingDomEl!.parentElement!.scrollLeft = 0;
        asFileItem(item).title = trimNewline(newText);
      }

      serverOrRemote.updateItem(store.history.getFocusItem());

      store.overlay.toolbarPopupInfoMaybe.set(null);
      store.overlay.setTextEditInfo(store.history, null);
      fullArrange(store);
      if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
      defaultResult = MouseEventActionFlags.None;
    }
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

  if (store.overlay.textEditInfo() && store.overlay.textEditInfo()!.itemType == ItemType.Expression) {
    if (isInsideItemOptionsToolbox()) { return MouseEventActionFlags.PreventDefault; }
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      serverOrRemote.updateItem(store.history.getFocusItem());
    }
    store.overlay.setTextEditInfo(store.history, null);
    fullArrange(store);
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
  }

  if (store.overlay.textEditInfo() && store.overlay.textEditInfo()!.itemType == ItemType.Password) {
    if (isInsideItemOptionsToolbox()) { return MouseEventActionFlags.PreventDefault; }
    if (store.user.getUserMaybe() != null && store.history.getFocusItem().ownerId == store.user.getUser().userId) {
      serverOrRemote.updateItem(store.history.getFocusItem());
    }
    store.overlay.setTextEditInfo(store.history, null);
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

  if (store.overlay.tableColumnContextMenuInfo.get() != null) {
    DoubleClickState.preventDoubleClick();
    store.overlay.tableColumnContextMenuInfo.set(null);
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

  const hitInfo = HitInfoFns.hit(store, desktopPosPx, [], false, false);
  if (hitInfo.hitboxType == HitboxFlags.None && !HitInfoFns.isOverTableInComposite(hitInfo)) {
    if (HitInfoFns.getHitVe(hitInfo).flags & VisualElementFlags.Popup && !viaOverlay) {
      DoubleClickState.preventDoubleClick();
      switchToPage(store, VeFns.actualVeidFromVe(HitInfoFns.getHitVe(hitInfo)), true, false, false);
    } else if(isPage(HitInfoFns.getHitVe(hitInfo).displayItem) &&
              asPageItem(HitInfoFns.getHitVe(hitInfo).displayItem).flags & PageFlags.EmbeddedInteractive) {
      DoubleClickState.preventDoubleClick();
      store.history.setFocus(VeFns.veToPath(HitInfoFns.getHitVe(hitInfo)));
      switchToPage(store, VeFns.actualVeidFromVe(HitInfoFns.getHitVe(hitInfo)), true, false, false);
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
  const activeItem = VeFns.canonicalItem(HitInfoFns.getHitVe(hitInfo));
  let boundsOnTopLevelPagePx = VeFns.veBoundsRelativeToDestkopPx(store, HitInfoFns.getHitVe(hitInfo));
  let onePxSizeBl;
  if (HitInfoFns.getHitVe(hitInfo).flags & VisualElementFlags.Popup) {
    const sizeBl = isPage(HitInfoFns.getHitVe(hitInfo).displayItem)
      ? ItemFns.calcSpatialDimensionsBl(HitInfoFns.getHitVe(hitInfo).linkItemMaybe!, { w: 0, h: PAGE_POPUP_TITLE_HEIGHT_BL })
      : ItemFns.calcSpatialDimensionsBl(HitInfoFns.getHitVe(hitInfo).linkItemMaybe!);
    onePxSizeBl = {
      x: sizeBl.w / boundsOnTopLevelPagePx.w,
      y: sizeBl.h / boundsOnTopLevelPagePx.h };
  } else {
    if (hitInfo.compositeHitboxTypeMaybe) {
      const activeCompositeItem = VeFns.canonicalItem(HitInfoFns.getCompositeContainerVe(hitInfo)!);
      const compositeBoundsOnTopLevelPagePx = VeFns.veBoundsRelativeToDestkopPx(store, HitInfoFns.getCompositeContainerVe(hitInfo)!);
      onePxSizeBl = {
        x: ItemFns.calcSpatialDimensionsBl(activeCompositeItem).w / compositeBoundsOnTopLevelPagePx.w,
        y: ItemFns.calcSpatialDimensionsBl(activeCompositeItem).h / compositeBoundsOnTopLevelPagePx.h };
    } else {
      const sizeBl = (HitInfoFns.getHitVe(hitInfo).flags & VisualElementFlags.EmbededInteractiveRoot)
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

  const canHitEmbeddedInteractive = !!(HitInfoFns.getHitVe(hitInfo).flags & VisualElementFlags.EmbededInteractiveRoot);
  const ignoreItems = [HitInfoFns.getHitVe(hitInfo).displayItem.id];
  const hitInfoFiltered = HitInfoFns.hit(store, desktopPosPx, ignoreItems, false, canHitEmbeddedInteractive);
  const scaleDefiningElement = VeFns.veToPath(hitInfoFiltered.overPositionableVe!);

  const activeElementPath = VeFns.veToPath(HitInfoFns.getHitVe(hitInfo));

  if (longHoldTimeoutId) {
    clearTimeout(longHoldTimeoutId);
  }

  const overDisplayItem = HitInfoFns.getHitVe(hitInfo).displayItem;
  setTimeout(() => {
    if (MouseActionState.empty()) { return; }
    if (MouseActionState.get().action != MouseAction.Ambiguous) { return; }
    if (isPage(overDisplayItem)) {
      PageFns.handleLongClick(HitInfoFns.getHitVe(hitInfo), store);
      MouseActionState.set(null);
    } else if (isRating(overDisplayItem)) {
      store.history.setFocus(activeElementPath);
      MouseActionState.set(null);
    }
  }, 750);

  MouseActionState.set({
    activeRoot: VeFns.veToPath(hitInfo.rootVes.get().flags & VisualElementFlags.Popup ? VesCache.get(hitInfo.rootVes.get().parentPath!)!.get() : hitInfo.rootVes.get()),
    startActiveElementParent: HitInfoFns.getHitVe(hitInfo).parentPath!,
    activeElementPath,
    activeCompositeElementMaybe: hitInfo.compositeHitboxTypeMaybe ? VeFns.veToPath(HitInfoFns.getCompositeContainerVe(hitInfo)!) : null,
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
    // make sure not PreventDefault in the case of clicking on a contenteditable.
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

  if (store.overlay.tableColumnContextMenuInfo.get()) {
    store.overlay.tableColumnContextMenuInfo.set(null);
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

  // compact expanded list item.
  let hi = HitInfoFns.hit(store, CursorEventState.getLatestDesktopPx(store), [], true, false);
  if (hi.hitboxType & HitboxFlags.Expand) {
    const itemPath = VeFns.veToPath(HitInfoFns.getHitVe(hi));
    store.perVe.setIsExpanded(itemPath, !store.perVe.getIsExpanded(itemPath));
    fullArrange(store);
  }

  const changedPages = navigateBack(store);
  if (!changedPages) {
    await navigateUp(store);
  }
}
