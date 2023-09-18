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

import { GRID_SIZE, MOUSE_MOVE_AMBIGUOUS_PX, POPUP_TOOLBAR_WIDTH_BL } from "../constants";
import { HitboxMeta, HitboxType } from "../layout/hitbox";
import { server } from "../server";
import { calcSizeForSpatialBl, handleClick, handlePopupClick } from "../items/base/item-polymorphism";
import { allowHalfBlockWidth, asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asPageItem, calcPageInnerSpatialDimensionsBl, getPopupPositionGr } from "../items/page-item";
import { asTableItem, isTable } from "../items/table-item";
import { DesktopStoreContextModel, PopupType, findVisualElements } from "../store/DesktopStoreProvider";
import { UserStoreContextModel } from "../store/UserStoreProvider";
import { vectorAdd, getBoundingBoxTopLeft, desktopPxFromMouseEvent, isInside, vectorSubtract, Vector, boundingBoxFromPosSize, Dimensions } from "../util/geometry";
import { panic, throwExpression } from "../util/lang";
import { VisualElement, VisualElementFlags, VisualElementPath, getVeid, visualElementDesktopBoundsPx as visualElementBoundsOnDesktopPx, visualElementToPath } from "../layout/visual-element";
import { arrange } from "../layout/arrange";
import { editDialogSizePx } from "../components/edit/EditDialog";
import { VisualElementSignal } from "../util/signals";
import { AttachmentsItem, asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { Attachment, Child } from "../layout/relationship-to-parent";
import { asContainerItem } from "../items/base/container-item";
import { getHitInfo } from "./hitInfo";
import { PositionalItem, asPositionalItem, isPositionalItem } from "../items/base/positional-item";
import { PlaceholderItem, isPlaceholder, newPlaceholderItem } from "../items/placeholder-item";
import { Item } from "../items/base/item";
import { asLinkItem, getLinkToId, isLink, newLinkItem, newLinkItemFromItem } from "../items/link-item";
import { COL_HEADER_HEIGHT_BL, HEADER_HEIGHT_BL } from "../components/items/Table";
import { itemState } from "../store/ItemState";
import { mouseMoveState } from "../store/MouseMoveState";
import { TableFlags } from "../items/base/flags-item";
import { VesCache } from "../layout/ves-cache";
import { switchToPage, updateHref } from "../layout/navigation";
import { CompositeItem, asCompositeItem, isComposite, newCompositeItem } from "../items/composite-item";
import { newOrdering } from "../util/ordering";
import { isNote } from "../items/note-item";


export const MOUSE_LEFT = 0;
export const MOUSE_RIGHT = 2;

enum MouseAction {
  Ambiguous,
  Moving,
  MovingPopup,
  Resizing,
  ResizingColumn,
  ResizingPopup,
}

interface MouseActionState {
  hitboxTypeOnMouseDown: HitboxType,
  compositeHitboxTypeMaybeOnMouseDown: HitboxType,

  hitMeta: HitboxMeta | null,

  activeElement: VisualElementPath,
  activeCompositeElementMaybe: VisualElementPath | null,

  activeRoot: VisualElementPath,

  moveOver_containerElement: VisualElementPath | null,
  moveOver_attachHitboxElement: VisualElementPath | null,
  moveOver_attachCompositeHitboxElement: VisualElementPath | null,
  moveOver_scaleDefiningElement: VisualElementPath | null,

  startPx: Vector,
  startPosBl: Vector | null,
  startWidthBl: number | null,
  startHeightBl: number | null,

  startAttachmentsItem: AttachmentsItem | null,     // when taking an attachment out of a table.
  startCompositeItem: CompositeItem | null,         // when taking an item out of a composite item.

  clickOffsetProp: Vector | null,

  action: MouseAction,

  onePxSizeBl: Vector,
  newPlaceholderItem: PlaceholderItem | null,
}
let mouseActionState: MouseActionState | null = null;

interface DialogMoveState {
  lastMousePosPx: Vector,
}
let dialogMoveState: DialogMoveState | null = null;

let lastMouseOverVes: VisualElementSignal | null = null;
let lastMouseOverOpenPopupVes: VisualElementSignal | null = null;


export function mouseDownHandler(
    desktopStore: DesktopStoreContextModel,
    userStore: UserStoreContextModel,
    ev: MouseEvent) {
  if (desktopStore.currentPage() == null) { return; }
  if (ev.button == MOUSE_LEFT) {
    mouseLeftDownHandler(desktopStore, userStore, ev);
  } else if (ev.button == MOUSE_RIGHT) {
    mouseRightDownHandler(desktopStore, userStore, ev);
  } else {
    console.error("unsupported mouse button: " + ev.button);
  }
}


// **** MOUSE LEFT DOWN HANDLER ****
export function mouseLeftDownHandler(
    desktopStore: DesktopStoreContextModel,
    userStore: UserStoreContextModel,
    ev: MouseEvent) {

  const desktopPosPx = desktopPxFromMouseEvent(ev);

  if (desktopStore.contextMenuInfo() != null) {
    desktopStore.setContextMenuInfo(null);
    return;
  }

  let dialogInfo = desktopStore.editDialogInfo();
  if (dialogInfo != null) {
    if (isInside(desktopPosPx, dialogInfo!.desktopBoundsPx)) {
      dialogMoveState = { lastMousePosPx: desktopPosPx };
      return;
    }

    desktopStore.setEditDialogInfo(null);
    return;
  }

  const hitInfo = getHitInfo(desktopStore, desktopPosPx, [], false);
  if (hitInfo.hitboxType == HitboxType.None) {
    if (hitInfo.overElementVes.get().flags & VisualElementFlags.Popup) {
      switchToPage(desktopStore, userStore, getVeid(hitInfo.overElementVes.get()), true);
    } else {
      arrange(desktopStore);
    }
    mouseActionState = null;
    return;
  }

  const startPosBl = null;
  const startWidthBl = null;
  const startHeightBl = null;
  const startPx = desktopPosPx;
  const activeItem = hitInfo.overElementVes.get().linkItemMaybe != null
    ? itemState.getItem(hitInfo.overElementVes.get().linkItemMaybe!.id)!
    : itemState.getItem(hitInfo.overElementVes.get().displayItem.id)!;
  let boundsOnDesktopPx = visualElementBoundsOnDesktopPx(hitInfo.overElementVes.get());
  let onePxSizeBl;
  if (hitInfo.overElementVes.get().flags & VisualElementFlags.Popup) {
    onePxSizeBl = {
      x: (calcSizeForSpatialBl(hitInfo.overElementVes.get().linkItemMaybe!).w + POPUP_TOOLBAR_WIDTH_BL) / boundsOnDesktopPx.w,
      y: calcSizeForSpatialBl(hitInfo.overElementVes.get().linkItemMaybe!).h / boundsOnDesktopPx.h };
  } else {
    if (hitInfo.compositeHitboxTypeMaybe) {
      const activeCompositeItem = hitInfo.overContainerVe!.linkItemMaybe != null
        ? itemState.getItem(hitInfo.overContainerVe!.linkItemMaybe!.id)!
        : itemState.getItem(hitInfo.overContainerVe!.displayItem.id)!;
      const compositeBoundsOnDesktopPx = visualElementBoundsOnDesktopPx(hitInfo.overContainerVe!);
      onePxSizeBl = {
        x: calcSizeForSpatialBl(activeCompositeItem).w / compositeBoundsOnDesktopPx.w,
        y: calcSizeForSpatialBl(activeCompositeItem).h / compositeBoundsOnDesktopPx.h };
    } else {
      onePxSizeBl = {
        x: calcSizeForSpatialBl(activeItem).w / boundsOnDesktopPx.w,
        y: calcSizeForSpatialBl(activeItem).h / boundsOnDesktopPx.h };
    }
  }

  let clickOffsetProp = {
    x: (startPx.x - boundsOnDesktopPx.x) / boundsOnDesktopPx.w,
    y: (startPx.y - boundsOnDesktopPx.y) / boundsOnDesktopPx.h
  };
  const startAttachmentsItem = calcStartTableAttachmentsItemMaybe(activeItem);
  const startCompositeItem = calcStartCompositeItemMaybe(activeItem);
  mouseActionState = {
    activeRoot: visualElementToPath(hitInfo.rootVe.flags & VisualElementFlags.Popup ? VesCache.get(hitInfo.rootVe.parentPath!)!.get() : hitInfo.rootVe),
    activeElement: visualElementToPath(hitInfo.overElementVes.get()),
    activeCompositeElementMaybe: hitInfo.compositeHitboxTypeMaybe ? visualElementToPath(hitInfo.overContainerVe!) : null,
    moveOver_containerElement: null,
    moveOver_attachHitboxElement: null,
    moveOver_attachCompositeHitboxElement: null,
    moveOver_scaleDefiningElement: visualElementToPath(
      getHitInfo(desktopStore, desktopPosPx, [hitInfo.overElementVes.get().displayItem.id], false).overPositionableVe!),
    hitboxTypeOnMouseDown: hitInfo.hitboxType,
    compositeHitboxTypeMaybeOnMouseDown: hitInfo.compositeHitboxTypeMaybe,
    action: MouseAction.Ambiguous,
    startPx,
    startPosBl,
    startWidthBl,
    startHeightBl,
    startAttachmentsItem,
    startCompositeItem,
    clickOffsetProp,
    onePxSizeBl,
    hitMeta: hitInfo.overElementMeta,
    newPlaceholderItem: null,
  }
}

function calcStartCompositeItemMaybe(activeItem: Item): CompositeItem | null {
  if (activeItem == null) { return null; }
  if (activeItem.parentId == null) { return null; }
  if (activeItem.relationshipToParent != Child) { return null; }
  let parent = itemState.getItem(activeItem.parentId)!;
  if (parent.parentId == null) { return null; }
  if (!isComposite(parent)) { return null; }
  return asCompositeItem(parent);
}

function calcStartTableAttachmentsItemMaybe(activeItem: Item): AttachmentsItem | null {
  if (activeItem == null) { return null; }
  if (activeItem.parentId == null) { return null; }
  if (activeItem.relationshipToParent != Attachment) { return null; }
  let parent = itemState.getItem(activeItem.parentId)!;
  if (parent.parentId == null) { return null; }
  let parentParent = itemState.getItem(parent.parentId)!;
  if (!isTable(parentParent)) { return null; }
  return asAttachmentsItem(parent);
}

// **** MOUSE RIGHT DOWN HANDLER ****
export function mouseRightDownHandler(
    desktopStore: DesktopStoreContextModel,
    userStore: UserStoreContextModel,
    _ev: MouseEvent) {

  if (desktopStore.contextMenuInfo()) {
    desktopStore.setContextMenuInfo(null);
    mouseMoveNoButtonDownHandler(desktopStore);
    return;
  }

  if (desktopStore.editDialogInfo() != null) {
    desktopStore.setEditDialogInfo(null);
    mouseMoveNoButtonDownHandler(desktopStore);
    return;
  }

  if (desktopStore.currentPopupSpec() != null) {
    desktopStore.popPopup();
    const page = asPageItem(itemState.getItem(desktopStore.currentPage()!.itemId)!);
    page.pendingPopupAlignmentPoint = null;
    page.pendingPopupPositionGr = null;
    page.pendingPopupWidthGr = null;
    arrange(desktopStore);
    return;
  }

  desktopStore.popPage();
  updateHref(desktopStore, userStore);
  arrange(desktopStore);
}


// **** MOUSE MOVE HANDLER ****
export function mouseMoveHandler(desktopStore: DesktopStoreContextModel) {
  if (desktopStore.currentPage() == null) { return; }

  const ev = mouseMoveState.lastMouseMoveEvent();
  const desktopPosPx = desktopPxFromMouseEvent(ev);

  // It is necessary to handle dialog moving at the global level, because sometimes the mouse position may
  // get outside the dialog area when being moved quickly.
  if (desktopStore.editDialogInfo() != null) {
    if (dialogMoveState != null) {
      let currentMousePosPx = desktopPxFromMouseEvent(ev);
      let changePx = vectorSubtract(currentMousePosPx, dialogMoveState.lastMousePosPx!);
      desktopStore.setEditDialogInfo(({
        item: desktopStore.editDialogInfo()!.item,
        desktopBoundsPx: boundingBoxFromPosSize(vectorAdd(getBoundingBoxTopLeft(desktopStore.editDialogInfo()!.desktopBoundsPx), changePx), { ...editDialogSizePx })
      }));
      dialogMoveState.lastMousePosPx = currentMousePosPx;
      return;
    }
    if (isInside(desktopPosPx, desktopStore.editDialogInfo()!.desktopBoundsPx)) {
      mouseMoveNoButtonDownHandler(desktopStore);
      return;
    }
  }

  if (mouseActionState == null) {
    mouseMoveNoButtonDownHandler(desktopStore);
    return;
  }

  const deltaPx = vectorSubtract(desktopPosPx, mouseActionState.startPx!);

  let activeVisualElement = VesCache.get(mouseActionState.activeElement)!.get();
  let activeItem = asPositionalItem(activeVisualElement.linkItemMaybe != null
    ? itemState.getItem(activeVisualElement.linkItemMaybe!.id)!
    : itemState.getItem(activeVisualElement.displayItem.id)!);

  if (mouseActionState.action == MouseAction.Ambiguous) {
    if (Math.abs(deltaPx.x) > MOUSE_MOVE_AMBIGUOUS_PX || Math.abs(deltaPx.y) > MOUSE_MOVE_AMBIGUOUS_PX) {
      if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Resize) > 0) {
        mouseActionState.startPosBl = null;
        if (activeVisualElement.flags & VisualElementFlags.Popup) {
          mouseActionState.startWidthBl = activeVisualElement.linkItemMaybe!.spatialWidthGr / GRID_SIZE;
          mouseActionState.startHeightBl = null;
          mouseActionState.action = MouseAction.ResizingPopup;
        } else {
          mouseActionState.startWidthBl = asXSizableItem(activeItem).spatialWidthGr / GRID_SIZE;
          if (isYSizableItem(activeItem)) {
            mouseActionState.startHeightBl = asYSizableItem(activeItem).spatialHeightGr / GRID_SIZE;
          } else if(isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem)) {
            mouseActionState.startHeightBl = asLinkItem(activeItem).spatialHeightGr / GRID_SIZE;
          } else {
            mouseActionState.startHeightBl = null;
          }
          mouseActionState.action = MouseAction.Resizing;
        }

      } else if (((mouseActionState.hitboxTypeOnMouseDown & HitboxType.Move) > 0) ||
                 ((mouseActionState.compositeHitboxTypeMaybeOnMouseDown & HitboxType.Move))) {
        if (!(mouseActionState.hitboxTypeOnMouseDown & HitboxType.Move) &&
            (mouseActionState.compositeHitboxTypeMaybeOnMouseDown & HitboxType.Move)) {
          // if the composite move hitbox is hit, but not the child, then swap out the active element.
          mouseActionState.hitboxTypeOnMouseDown = mouseActionState.compositeHitboxTypeMaybeOnMouseDown!;
          mouseActionState.activeElement = mouseActionState.activeCompositeElementMaybe!;
          activeVisualElement = VesCache.get(mouseActionState.activeElement)!.get();
          activeItem = asPositionalItem(activeVisualElement.linkItemMaybe != null
            ? itemState.getItem(activeVisualElement.linkItemMaybe!.id)!
            : itemState.getItem(activeVisualElement.displayItem.id)!);
        }
        mouseActionState.startWidthBl = null;
        mouseActionState.startHeightBl = null;
        if (activeVisualElement.flags & VisualElementFlags.Popup) {
          mouseActionState.action = MouseAction.MovingPopup;
          const activeRoot = VesCache.get(mouseActionState.activeRoot)!.get().displayItem;
          const popupPositionGr = getPopupPositionGr(asPageItem(activeRoot));
          mouseActionState.startPosBl = { x: popupPositionGr.x / GRID_SIZE, y: popupPositionGr.y / GRID_SIZE };
        } else {
          const shouldCreateLink = ev.shiftKey;
          const parentItem = itemState.getItem(activeItem.parentId)!;
          if (isTable(parentItem) && activeItem.relationshipToParent == Child) {
            moveActiveItemOutOfTable(desktopStore, shouldCreateLink);
            mouseActionState.startPosBl = {
              x: activeItem.spatialPositionGr.x / GRID_SIZE,
              y: activeItem.spatialPositionGr.y / GRID_SIZE
            };
          }
          else if (activeItem.relationshipToParent == Attachment) {
            const hitInfo = getHitInfo(desktopStore, desktopPosPx, [], false);
            moveActiveItemToPage(desktopStore, hitInfo.overPositionableVe!, desktopPosPx, Attachment, shouldCreateLink);
          }
          else if (isComposite(itemState.getItem(activeItem.parentId)!)) {
            const hitInfo = getHitInfo(desktopStore, desktopPosPx, [], false);
            moveActiveItemToPage(desktopStore, hitInfo.overPositionableVe!, desktopPosPx, Child, shouldCreateLink);
          }
          else {
            mouseActionState.startPosBl = {
              x: activeItem.spatialPositionGr.x / GRID_SIZE,
              y: activeItem.spatialPositionGr.y / GRID_SIZE
            };
            if (shouldCreateLink) {
              const link = newLinkItemFromItem(activeItem, Child, itemState.newOrderingDirectlyAfterChild(activeItem.parentId, activeItem.id));
              itemState.addItem(link);
              server.addItem(link, null);
              arrange(desktopStore);
              let ve = findVisualElements(desktopStore, activeItem.id, link.id);
              if (ve.length != 1) { panic(); }
              mouseActionState.activeElement = visualElementToPath(ve[0].get());
            }
          }
          mouseActionState.action = MouseAction.Moving;
        }

      } else if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.ColResize) > 0) {
        mouseActionState.startPosBl = null;
        mouseActionState.startHeightBl = null;
        const colNum = mouseActionState.hitMeta!.resizeColNumber!;
        if (activeVisualElement.linkItemMaybe != null) {
          mouseActionState.startWidthBl = asTableItem(activeVisualElement.displayItem).tableColumns[colNum].widthGr / GRID_SIZE;
        } else {
          mouseActionState.startWidthBl = asTableItem(activeItem).tableColumns[colNum].widthGr / GRID_SIZE;
        }
        mouseActionState.action = MouseAction.ResizingColumn;
      }

    }
  }

  if (mouseActionState.action == MouseAction.Ambiguous) {
    return;
  }

  // ### Resizing
  if (mouseActionState.action == MouseAction.Resizing) {
    const deltaBl = {
      x: deltaPx.x * mouseActionState.onePxSizeBl.x,
      y: deltaPx.y * mouseActionState.onePxSizeBl.y
    };

    let newWidthBl = mouseActionState!.startWidthBl! + deltaBl.x;
    newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
    if (newWidthBl < 1) { newWidthBl = 1.0; }

    asXSizableItem(activeItem).spatialWidthGr = newWidthBl * GRID_SIZE;

    if (isYSizableItem(activeItem) || (isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem))) {
      let newHeightBl = mouseActionState!.startHeightBl! + deltaBl.y;
      newHeightBl = Math.round(newHeightBl);
      if (newHeightBl < 1) { newHeightBl = 1.0; }
      if (isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem)) {
        asLinkItem(activeItem).spatialHeightGr = newHeightBl * GRID_SIZE;
      } else {
        asYSizableItem(activeItem).spatialHeightGr = newHeightBl * GRID_SIZE;
      }
    }

    arrange(desktopStore);

  // ### Resizing Popup
  } else if (mouseActionState.action == MouseAction.ResizingPopup) {
    const deltaBl = {
      x: deltaPx.x * mouseActionState.onePxSizeBl.x * 2.0, // * 2.0 because it's centered, so mouse distance -> half the desired increase in width.
      y: deltaPx.y * mouseActionState.onePxSizeBl.y * 2.0
    };

    let newWidthBl = mouseActionState!.startWidthBl! + deltaBl.x;
    newWidthBl = Math.round(newWidthBl * 2.0) / 2.0;
    if (newWidthBl < 5) { newWidthBl = 5.0; }

    const activeRoot = VesCache.get(mouseActionState.activeRoot)!.get();
    asPageItem(activeRoot.displayItem).pendingPopupWidthGr = newWidthBl * GRID_SIZE;

    arrange(desktopStore);

  // ### Resizing Column
  } else if (mouseActionState.action == MouseAction.ResizingColumn) {
    const deltaBl = {
      x: deltaPx.x * mouseActionState.onePxSizeBl.x,
      y: deltaPx.y * mouseActionState.onePxSizeBl.y
    };

    let newWidthBl = mouseActionState!.startWidthBl! + deltaBl.x;
    newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
    if (newWidthBl < 1) { newWidthBl = 1.0; }

    if (activeVisualElement.linkItemMaybe != null) {
      asTableItem(activeVisualElement.displayItem).tableColumns[mouseActionState!.hitMeta!.resizeColNumber!].widthGr = newWidthBl * GRID_SIZE;
    } else {
      asTableItem(activeItem).tableColumns[mouseActionState!.hitMeta!.resizeColNumber!].widthGr = newWidthBl * GRID_SIZE;
    }

    arrange(desktopStore);

  // ### Moving Popup
  } else if (mouseActionState.action == MouseAction.MovingPopup) {
    const deltaBl = {
      x: Math.round(deltaPx.x * mouseActionState.onePxSizeBl.x * 2.0)/2.0,
      y: Math.round(deltaPx.y * mouseActionState.onePxSizeBl.y * 2.0)/2.0
    };
    const newPositionGr = {
      x: (mouseActionState.startPosBl!.x + deltaBl.x) * GRID_SIZE,
      y: (mouseActionState.startPosBl!.y + deltaBl.y) * GRID_SIZE
    };
    const activeRoot = VesCache.get(mouseActionState.activeRoot)!.get();
    asPageItem(activeRoot.displayItem).pendingPopupPositionGr = newPositionGr;

    arrange(desktopStore);

  // ### Moving
  } else if (mouseActionState.action == MouseAction.Moving) {

    let ignoreIds = [activeVisualElement.displayItem.id];
    if (isComposite(activeVisualElement.displayItem)) {
      const compositeItem = asCompositeItem(activeVisualElement.displayItem);
      for (let i=0; i<compositeItem.computed_children.length; ++i) { ignoreIds.push(compositeItem.computed_children[i]); }
    }
    const hitInfo = getHitInfo(desktopStore, desktopPosPx, ignoreIds, false);

    // update move over element state.
    if (mouseActionState.moveOver_containerElement == null ||
        mouseActionState.moveOver_containerElement! != visualElementToPath(hitInfo.overContainerVe!)) {
      if (mouseActionState.moveOver_containerElement != null) {
        VesCache.get(mouseActionState.moveOver_containerElement)!.get().movingItemIsOver.set(false);
      }
      hitInfo.overContainerVe!.movingItemIsOver.set(true);
      mouseActionState.moveOver_containerElement = visualElementToPath(hitInfo.overContainerVe!);
    }

    // update move over attach state.
    if (mouseActionState!.moveOver_attachHitboxElement != null) {
      VesCache.get(mouseActionState!.moveOver_attachHitboxElement)!.get().movingItemIsOverAttach.set(false);
    }
    if (hitInfo.hitboxType & HitboxType.Attach) {
      hitInfo.overElementVes.get().movingItemIsOverAttach.set(true);
      mouseActionState!.moveOver_attachHitboxElement = visualElementToPath(hitInfo.overElementVes.get());
    } else {
      mouseActionState!.moveOver_attachHitboxElement = null;
    }

    // update move over attach composite state.
    if (mouseActionState!.moveOver_attachCompositeHitboxElement != null) {
      VesCache.get(mouseActionState!.moveOver_attachCompositeHitboxElement)!.get().movingItemIsOverAttachComposite.set(false);
    }
    if (hitInfo.hitboxType & HitboxType.AttachComposite) {
      hitInfo.overElementVes.get().movingItemIsOverAttachComposite.set(true);
      mouseActionState!.moveOver_attachCompositeHitboxElement = visualElementToPath(hitInfo.overElementVes.get());
    } else {
      mouseActionState!.moveOver_attachCompositeHitboxElement = null;
    }

    if (VesCache.get(mouseActionState.moveOver_scaleDefiningElement!)!.get().displayItem != hitInfo.overPositionableVe!.displayItem) {
      moveActiveItemToPage(desktopStore, hitInfo.overPositionableVe!, desktopPosPx, Child, false);
    }

    if (isTable(hitInfo.overContainerVe!.displayItem)) {
      handleOverTable(desktopStore, hitInfo.overContainerVe!, desktopPosPx);
    }

    const deltaBl = {
      x: deltaPx.x * mouseActionState.onePxSizeBl.x,
      y: deltaPx.y * mouseActionState.onePxSizeBl.y
    };

    let newPosBl = vectorAdd(mouseActionState.startPosBl!, deltaBl);
    newPosBl.x = Math.round(newPosBl.x * 2.0) / 2.0;
    newPosBl.y = Math.round(newPosBl.y * 2.0) / 2.0;
    const inElement = VesCache.get(mouseActionState.moveOver_scaleDefiningElement!)!.get().displayItem;
    const dimBl = calcPageInnerSpatialDimensionsBl(asPageItem(inElement));
    if (newPosBl.x < 0.0) { newPosBl.x = 0.0; }
    if (newPosBl.y < 0.0) { newPosBl.y = 0.0; }
    if (newPosBl.x > dimBl.w - 0.5) { newPosBl.x = dimBl.w - 0.5; }
    if (newPosBl.y > dimBl.h - 0.5) { newPosBl.y = dimBl.h - 0.5; }
    activeItem.spatialPositionGr = { x: newPosBl.x * GRID_SIZE, y: newPosBl.y * GRID_SIZE };

    arrange(desktopStore);
  }
}

export function mouseMoveNoButtonDownHandler(desktopStore: DesktopStoreContextModel) {
  const dialogInfo = desktopStore.editDialogInfo();
  const contextMenuInfo = desktopStore.contextMenuInfo();
  const hasModal = dialogInfo != null || contextMenuInfo != null;
  const ev = mouseMoveState.lastMouseMoveEvent();
  const hitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [], false);
  const overElementVes = hitInfo.overElementVes;

  if (overElementVes != lastMouseOverVes || hasModal) {
    if (lastMouseOverVes != null) {
      lastMouseOverVes.get().mouseIsOver.set(false);
      lastMouseOverVes = null;
    }
  }
  if (overElementVes != lastMouseOverOpenPopupVes || !(hitInfo.hitboxType & HitboxType.OpenPopup) || hasModal) {
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
    if (hitInfo.hitboxType & HitboxType.OpenPopup) {
      overElementVes!.get().mouseIsOverOpenPopup.set(true);
      lastMouseOverOpenPopupVes = overElementVes;
    } else {
      overElementVes!.get().mouseIsOverOpenPopup.set(false);
    }
  }

  if ((hitInfo.hitboxType & HitboxType.Resize) > 0) {
    document.body.style.cursor = "nwse-resize";
  } else if ((hitInfo.hitboxType & HitboxType.ColResize) > 0) {
    document.body.style.cursor = "ew-resize";
  } else {
    document.body.style.cursor = "default";
  }
}

export function handleOverTable(desktopStore: DesktopStoreContextModel, overContainerVe: VisualElement, desktopPx: Vector) {
  const tableItem = asTableItem(overContainerVe.displayItem);
  const tableDimensionsBl: Dimensions = {
    w: (overContainerVe.linkItemMaybe ? overContainerVe.linkItemMaybe.spatialWidthGr : tableItem.spatialWidthGr) / GRID_SIZE,
    h: (overContainerVe.linkItemMaybe ? overContainerVe.linkItemMaybe.spatialHeightGr : tableItem.spatialHeightGr) / GRID_SIZE
  };
  const tableBoundsPx = visualElementBoundsOnDesktopPx(overContainerVe);

  // col
  const mousePropX = (desktopPx.x - tableBoundsPx.x) / tableBoundsPx.w;
  const tableXBl = Math.floor(mousePropX * tableDimensionsBl.w * 2.0) / 2.0;
  let accumBl = 0;
  let colNumber = tableItem.tableColumns.length - 1;
  for (let i=0; i<tableItem.tableColumns.length; ++i) {
    accumBl += tableItem.tableColumns[i].widthGr / GRID_SIZE;
    if (accumBl >= tableDimensionsBl.w) {
      colNumber = i;
      break;
    }
    if (tableXBl < accumBl) {
      colNumber = i;
      break;
    }
  }
  const attachmentPos = colNumber - 1;

  // row
  const mousePropY = (desktopPx.y - tableBoundsPx.y) / tableBoundsPx.h;
  const rawTableRowNumber = attachmentPos == -1 ? Math.round(mousePropY * tableDimensionsBl.h) : Math.floor(mousePropY * tableDimensionsBl.h);
  const yScrollPos = desktopStore.getTableScrollYPos(getVeid(overContainerVe));
  let insertRow = rawTableRowNumber + yScrollPos - HEADER_HEIGHT_BL - ((tableItem.flags & TableFlags.ShowColHeader) ? COL_HEADER_HEIGHT_BL : 0);
  if (insertRow < yScrollPos) { insertRow = yScrollPos; }
  insertRow -= insertRow > tableItem.computed_children.length
    ? insertRow - tableItem.computed_children.length
    : 0;
  overContainerVe.moveOverRowNumber.set(insertRow);

  const childItem = itemState.getItem(tableItem.computed_children[insertRow]);
  if (isAttachmentsItem(childItem) || (isLink(childItem) && isAttachmentsItem(itemState.getItem(getLinkToId(asLinkItem(childItem!))!)))) {
    overContainerVe.moveOverColAttachmentNumber.set(attachmentPos);
  } else {
    overContainerVe.moveOverColAttachmentNumber.set(-1);
  }

}

export function moveActiveItemToPage(desktopStore: DesktopStoreContextModel, moveToVe: VisualElement, desktopPx: Vector, relationshipToParent: string, shouldCreateLink: boolean) {
  const activeElement = VesCache.get(mouseActionState!.activeElement!)!.get();
  const activeItem = asPositionalItem(activeElement.linkItemMaybe != null ? activeElement.linkItemMaybe! : activeElement.displayItem);
  const activeElementLinkItemMaybeId = activeElement.linkItemMaybe == null ? null : activeElement.linkItemMaybe.id;
  const activeElementItemId = activeElement.displayItem.id;

  const currentParent = itemState.getItem(activeItem.parentId)!;
  const moveToPage = asPageItem(moveToVe.displayItem);
  const moveToPageAbsoluteBoundsPx = visualElementBoundsOnDesktopPx(moveToVe);
  const moveToPageInnerSizeBl = calcPageInnerSpatialDimensionsBl(moveToPage);
  const mousePointBl = {
    x: Math.round((desktopPx.x - moveToPageAbsoluteBoundsPx.x) / moveToPageAbsoluteBoundsPx.w * moveToPageInnerSizeBl.w * 2.0) / 2.0,
    y: Math.round((desktopPx.y - moveToPageAbsoluteBoundsPx.y) / moveToPageAbsoluteBoundsPx.h * moveToPageInnerSizeBl.h * 2.0) / 2.0
  };
  const activeItemDimensionsBl = calcSizeForSpatialBl(activeItem);
  const clickOffsetInActiveItemBl = relationshipToParent == Child
    ? { x: Math.round(activeItemDimensionsBl.w * mouseActionState!.clickOffsetProp!.x * 2.0) / 2.0,
        y: Math.round(activeItemDimensionsBl.h * mouseActionState!.clickOffsetProp!.y * 2.0) / 2.0 }
    : { x: 0, y: 0 };
  const startPosBl = vectorSubtract(mousePointBl, clickOffsetInActiveItemBl);
  const newItemPosGr = { x: startPosBl.x * GRID_SIZE, y: startPosBl.y * GRID_SIZE };
  mouseActionState!.startPx = desktopPx;
  mouseActionState!.startPosBl = startPosBl;
  const moveToPath = visualElementToPath(moveToVe);

  let oldActiveItemOrdering = activeItem.ordering;
  activeItem.parentId = moveToVe.displayItem.id;
  activeItem.ordering = itemState.newOrderingAtEndOfChildren(moveToVe.displayItem.id);
  activeItem.spatialPositionGr = newItemPosGr;
  activeItem.relationshipToParent = Child;
  moveToPage.computed_children = [activeItem.id, ...moveToPage.computed_children];
  if (relationshipToParent == Child) {
    asContainerItem(currentParent).computed_children
      = asContainerItem(currentParent).computed_children.filter(childItem => childItem != activeItem.id);
  }
  else if (relationshipToParent == Attachment) {
    const parent = asAttachmentsItem(currentParent);
    const isLast = parent.computed_attachments[asAttachmentsItem(currentParent).computed_attachments.length-1] == activeItem.id;
    parent.computed_attachments = parent.computed_attachments.filter(childItem => childItem != activeItem.id);
    if (!isLast) {
      const placeholderItem = newPlaceholderItem(activeItem.ownerId, currentParent.id, Attachment, oldActiveItemOrdering);
      itemState.addItem(placeholderItem);
      mouseActionState!.newPlaceholderItem = placeholderItem;
    }
    mouseActionState!.startAttachmentsItem = parent;
  }

  arrange(desktopStore);

  let done = false;
  findVisualElements(desktopStore, activeElementItemId, activeElementLinkItemMaybeId).forEach(ve => {
    if (ve.get().parentPath == moveToPath) {
      mouseActionState!.activeElement = visualElementToPath(ve.get());
      let boundsPx = VesCache.get(mouseActionState!.activeElement)!.get().boundsPx;
      mouseActionState!.onePxSizeBl = {
        x: calcSizeForSpatialBl(activeItem).w / boundsPx.w,
        y: calcSizeForSpatialBl(activeItem).h / boundsPx.h
      };
      done = true;
    }
  });
  if (!done) {
    panic();
  }

  done = false;
  findVisualElements(desktopStore, moveToVe.displayItem.id, moveToVe.linkItemMaybe == null ? null : moveToVe.linkItemMaybe.id).forEach(ve => {
    if (visualElementToPath(ve.get()) == moveToPath) {
      mouseActionState!.moveOver_scaleDefiningElement = visualElementToPath(ve.get());
      done = true;
    }
  });
  if (!done) { panic(); }
}

export function moveActiveItemOutOfTable(desktopStore: DesktopStoreContextModel, shouldCreateLink: boolean) {
  const activeVisualElement = VesCache.get(mouseActionState!.activeElement!)!.get();
  const tableVisualElement = VesCache.get(activeVisualElement.parentPath!)!.get();
  const activeItem = asPositionalItem(activeVisualElement.linkItemMaybe != null ? activeVisualElement.linkItemMaybe! : activeVisualElement.displayItem);
  const tableItem = asTableItem(tableVisualElement.displayItem);
  const tableBlockHeightPx = tableVisualElement.boundsPx.h / (tableItem.spatialHeightGr / GRID_SIZE);
  let itemPosInTablePx = getBoundingBoxTopLeft(activeVisualElement.boundsPx);
  itemPosInTablePx.y -= desktopStore.getTableScrollYPos(getVeid(tableVisualElement)) * tableBlockHeightPx;
  const tableVe = VesCache.get(activeVisualElement.parentPath!)!.get();
  const tableParentVe = VesCache.get(tableVe.parentPath!)!.get();
  const tableParentVisualPathString = tableVe.parentPath!;

  const tablePosInPagePx = getBoundingBoxTopLeft(tableVe.childAreaBoundsPx!);
  const itemPosInPagePx = vectorAdd(tablePosInPagePx, itemPosInTablePx);
  const tableParentPage = asPageItem(tableParentVe.displayItem);
  const itemPosInPageGr = {
    x: itemPosInPagePx.x / tableParentVe!.boundsPx.w * tableParentPage.innerSpatialWidthGr,
    y: itemPosInPagePx.y / tableParentVe!.boundsPx.h * calcPageInnerSpatialDimensionsBl(tableParentPage).h * GRID_SIZE
  };
  const itemPosInPageQuantizedGr = {
    x: Math.round(itemPosInPageGr.x / (GRID_SIZE / 2.0)) / 2.0 * GRID_SIZE,
    y: Math.round(itemPosInPageGr.y / (GRID_SIZE / 2.0)) / 2.0 * GRID_SIZE
  };

  tableParentPage.computed_children
    = [activeItem.id, ...tableParentPage.computed_children];
  tableItem.computed_children
    = tableItem.computed_children.filter(childItem => childItem != activeItem.id);
  activeItem.parentId = tableParentPage.id;
  activeItem.ordering = itemState.newOrderingAtEndOfChildren(tableParentPage.id);
  activeItem.spatialPositionGr = itemPosInPageQuantizedGr;

  arrange(desktopStore);

  let done = false;
  let otherVes = [];
  findVisualElements(desktopStore, activeVisualElement.displayItem.id, activeVisualElement.linkItemMaybe == null ? null : activeVisualElement.linkItemMaybe.id).forEach(ve => {
    if (ve.get().parentPath == tableParentVisualPathString) {
      mouseActionState!.activeElement = visualElementToPath(ve.get());
      let boundsPx = VesCache.get(mouseActionState!.activeElement)!.get().boundsPx;
      mouseActionState!.onePxSizeBl = {
        x: calcSizeForSpatialBl(activeItem).w / boundsPx.w,
        y: calcSizeForSpatialBl(activeItem).h / boundsPx.h
      };
      done = true;
    } else {
      otherVes.push(ve);
    }
  });
  if (!done) { panic(); }
}


// **** UP ****
export function mouseUpHandler(
    desktopStore: DesktopStoreContextModel,
    userStore: UserStoreContextModel) {

  dialogMoveState = null;

  if (mouseActionState == null) { return; }

  const activeVisualElementSignal = VesCache.get(mouseActionState.activeElement)!;
  const activeVisualElement = activeVisualElementSignal.get();
  const activeItem = asPositionalItem(activeVisualElement.linkItemMaybe != null ? activeVisualElement.linkItemMaybe! : activeVisualElement.displayItem);

  switch (mouseActionState.action) {
    case MouseAction.Moving:
      mouseUpHandler_moving(desktopStore, activeItem);
      break;

    case MouseAction.MovingPopup: {
      break;
    }

    case MouseAction.Resizing:
      if (mouseActionState.startWidthBl! * GRID_SIZE != asXSizableItem(activeItem).spatialWidthGr ||
          (isYSizableItem(activeItem) && mouseActionState.startHeightBl! * GRID_SIZE != asYSizableItem(activeItem).spatialHeightGr)) {
        server.updateItem(itemState.getItem(activeItem.id)!);
      }

      // mouseActionState.activeVisualElement.update(ve => {
      //   ve.resizingFromBoundsPx = null;
      // });
      break;

    case MouseAction.ResizingPopup: {
      break;
    }

    case MouseAction.ResizingColumn:
      const widthGr = activeVisualElement.linkItemMaybe == null
        ? asTableItem(activeItem).tableColumns[mouseActionState.hitMeta!.resizeColNumber!].widthGr
        : asTableItem(activeVisualElement.displayItem).tableColumns[mouseActionState.hitMeta!.resizeColNumber!].widthGr;
      if (mouseActionState.startWidthBl! * GRID_SIZE != widthGr) {
        server.updateItem(itemState.getItem(activeVisualElement.displayItem.id)!);
      }
      break;

    case MouseAction.Ambiguous:
      if (mouseActionState.hitboxTypeOnMouseDown! & HitboxType.OpenPopup) {
        handlePopupClick(activeVisualElement, desktopStore, userStore);
      }
      else if (mouseActionState.hitboxTypeOnMouseDown! & HitboxType.OpenAttachment) {
        handleAttachmentClick(desktopStore, activeVisualElement, userStore);
        arrange(desktopStore);
      }
      else if (mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Click) {
        handleClick(activeVisualElementSignal, desktopStore, userStore);
      }
      break;

    default:
      panic();
  }

  mouseActionState = null;
}

function handleAttachmentClick(desktopStore: DesktopStoreContextModel, visualElement: VisualElement, _userStore: UserStoreContextModel) {
  desktopStore.replacePopup({
    type: PopupType.Attachment,
    vePath: visualElementToPath(visualElement)
  })
}

function mouseUpHandler_moving(
    desktopStore: DesktopStoreContextModel,
    activeItem: PositionalItem) {
  if (mouseActionState == null) { return; } // make typsecript happy

  if (mouseActionState.moveOver_containerElement != null) {
    VesCache.get(mouseActionState.moveOver_containerElement)!.get()
      .movingItemIsOver.set(false);
  }

  if (mouseActionState.moveOver_attachHitboxElement != null) {
    // does not include case of move into table cells that are attachments.
    mouseUpHandler_moving_hitboxAttachTo(desktopStore, activeItem);
    return;
  }

  if (mouseActionState.moveOver_attachCompositeHitboxElement != null) {
    // does not include case of move into table cells that are attachments.
    mouseUpHandler_moving_hitboxAttachToComposite(desktopStore, activeItem);
    return;
  }

  const overContainerVe = VesCache.get(mouseActionState.moveOver_containerElement!)!.get();

  if (isTable(overContainerVe.displayItem)) {
    mouseUpHandler_moving_toTable(desktopStore, activeItem, overContainerVe);
    return;
  }

  if (overContainerVe.displayItem.id != activeItem.parentId) {
    mouseUpHandler_moving_toOpaquePage(desktopStore, activeItem, overContainerVe);
    return;
  }

  // root page
  if (mouseActionState.startPosBl!.x * GRID_SIZE != activeItem.spatialPositionGr.x ||
      mouseActionState.startPosBl!.y * GRID_SIZE != activeItem.spatialPositionGr.y) {
    server.updateItem(itemState.getItem(activeItem.id)!);
  }

  finalizeMouseUp();
  arrange(desktopStore);
}

function finalizeMouseUp() {
  cleanupAndPersistPlaceholders();
  maybeDeleteComposite()
}

async function maybeDeleteComposite() {
  if (mouseActionState == null) { return; } // please typescript.
  if (mouseActionState.startCompositeItem == null) { return; }
  const compositeItem = mouseActionState.startCompositeItem;
  if (compositeItem.computed_children.length == 0) { panic(); }
  if (compositeItem.computed_children.length != 1) {
    mouseActionState.startCompositeItem = null;
    return;
  }
  const compositeItemParent = asContainerItem(itemState.getItem(compositeItem.parentId)!);
  const child = itemState.getItem(compositeItem.computed_children[0])!;
  if (!isPositionalItem(child)) { panic(); }
  child.parentId = compositeItem.parentId;
  asPositionalItem(child).spatialPositionGr = compositeItem.spatialPositionGr;
  compositeItem.computed_children = [];
  compositeItemParent.computed_children.push(child.id);
  itemState.deleteItem(compositeItem.id);
  itemState.sortChildren(compositeItemParent.id);

  await server.updateItem(child);
  await server.deleteItem(compositeItem.id);
}

function cleanupAndPersistPlaceholders() {
  if (mouseActionState == null) { return; } // please typescript.
  if (mouseActionState.startAttachmentsItem == null) { return; }

  if (mouseActionState.newPlaceholderItem != null) {
    server.addItem(mouseActionState.newPlaceholderItem, null);
  }

  const placeholderParent = mouseActionState.startAttachmentsItem!;

  while (true) {
    const attachments = placeholderParent.computed_attachments;
    if (attachments.length == 0) { break; }
    const attachmentId = placeholderParent.computed_attachments[placeholderParent.computed_attachments.length-1];
    const attachment = itemState.getItem(attachmentId)!;
    if (attachment == null) { panic(); }
    if (!isPlaceholder(attachment)) {
      break;
    }
    server.deleteItem(attachment.id);
    itemState.deleteItem(attachment.id);
  }

  mouseActionState.newPlaceholderItem = null;
  mouseActionState.startAttachmentsItem = null;
}

async function mouseUpHandler_moving_hitboxAttachToComposite(desktopStore: DesktopStoreContextModel, activeItem: PositionalItem) {
  const prevParentId = activeItem.parentId;
  const prevParent = itemState.getContainerItem(prevParentId)!;

  const attachToVisualElement = VesCache.get(mouseActionState!.moveOver_attachCompositeHitboxElement!)!.get();
  attachToVisualElement.movingItemIsOverAttach.set(false);
  mouseActionState!.moveOver_attachCompositeHitboxElement = null;

  const attachToItem = asPositionalItem(attachToVisualElement.linkItemMaybe != null ? attachToVisualElement.linkItemMaybe! : attachToVisualElement.displayItem);

  if (attachToVisualElement.displayItem.id == activeItem.id) {
    // TODO (MEDIUM): More rigorous recursive check. also server side.
    throwExpression("Attempt was made to attach an item to itself.");
  }

  // case #1: attaching to an item inside an existing composite.
  if (isComposite(itemState.getItem(attachToItem.parentId)!)) {

    const destinationCompositeItem = itemState.getItem(attachToItem.parentId)!;

    // case #1.1: the moving item is not a composite.
    if (!isComposite(activeItem)) {
      activeItem.parentId = destinationCompositeItem.id;
      activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      activeItem.ordering = itemState.newOrderingDirectlyAfterChild(destinationCompositeItem.id, attachToItem.id);
      activeItem.relationshipToParent = Child;
      await server.updateItem(activeItem);

      asCompositeItem(destinationCompositeItem).computed_children.push(activeItem.id);
      itemState.sortChildren(destinationCompositeItem.id);
    }

    // case #1.2: the moving item is a composite.
    else {
      const activeItem_composite = asCompositeItem(activeItem);
      let lastPrevId = attachToItem.id;
      for (let i=0; i<activeItem_composite.computed_children.length; ++i) {
        const child = itemState.getItem(activeItem_composite.computed_children[i])!;
        child.parentId = destinationCompositeItem.id;
        child.ordering = itemState.newOrderingDirectlyAfterChild(destinationCompositeItem.id, lastPrevId);
        child.relationshipToParent = Child;
        asCompositeItem(destinationCompositeItem).computed_children.push(child.id);
        itemState.sortChildren(destinationCompositeItem.id);
        await server.updateItem(child);
        lastPrevId = child.id;
      }
      await server.deleteItem(activeItem_composite.id);
    }

    prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id && i != attachToItem.id);

  // case #2: attaching to an item that is not inside an existing composite.
  } else {

    const compositeItem = newCompositeItem(activeItem.ownerId, prevParentId, Child, attachToItem.ordering);
    compositeItem.spatialPositionGr = { x: attachToItem.spatialPositionGr.x, y: attachToItem.spatialPositionGr.y };
    if (isXSizableItem(attachToItem)) {
      compositeItem.spatialWidthGr = asXSizableItem(attachToItem).spatialWidthGr;
    }
    await server.addItem(compositeItem, null);
    itemState.addItem(compositeItem);

    attachToItem.parentId = compositeItem.id;
    attachToItem.spatialPositionGr = { x: 0.0, y: 0.0 };
    attachToItem.ordering = newOrdering();
    attachToItem.relationshipToParent = Child;
    await server.updateItem(attachToItem);
    compositeItem.computed_children.push(attachToItem.id);

    // case #2.1: this item is not a composite either.
    if (!isComposite(activeItem)) {
      activeItem.parentId = compositeItem.id;
      activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      activeItem.ordering = itemState.newOrderingAtEndOfChildren(compositeItem.id);
      activeItem.relationshipToParent = Child;
      await server.updateItem(activeItem);
    }

    // case #2.2: the moving item being attached is a composite.
    else {
      const activeItem_composite = asCompositeItem(activeItem);
      for (let i=0; i<activeItem_composite.computed_children.length; ++i) {
        const child = itemState.getItem(activeItem_composite.computed_children[i])!;
        child.parentId = compositeItem.id;
        child.ordering = itemState.newOrderingAtEndOfChildren(compositeItem.id);
        child.relationshipToParent = Child;
        await server.updateItem(child);
        compositeItem.computed_children.push(child.id);
      }
      await server.deleteItem(activeItem_composite.id);
    }

    prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id && i != attachToItem.id);
  }

  finalizeMouseUp();
  arrange(desktopStore);
}

function mouseUpHandler_moving_hitboxAttachTo(desktopStore: DesktopStoreContextModel, activeItem: PositionalItem) {
  const prevParentId = activeItem.parentId;

  const attachToVisualElement = VesCache.get(mouseActionState!.moveOver_attachHitboxElement!)!.get();
  const attachmentsItem = asAttachmentsItem(attachToVisualElement.displayItem);
  attachToVisualElement.movingItemIsOverAttach.set(false);
  mouseActionState!.moveOver_attachHitboxElement = null;

  if (attachmentsItem.id == activeItem.id) {
    // TODO (MEDIUM): More rigorous recursive check. also server side.
    throwExpression("Attempt was made to attach an item to itself.");
  }

  activeItem.parentId = attachToVisualElement.displayItem.id;
  activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
  activeItem.ordering = itemState.newOrderingAtEndOfAttachments(attachmentsItem.id);
  activeItem.relationshipToParent = Attachment;

  const attachments = [activeItem.id, ...attachmentsItem.computed_attachments];
  attachmentsItem.computed_attachments = attachments;
  itemState.sortAttachments(attachmentsItem.id);

  const prevParent = itemState.getContainerItem(prevParentId)!;
  prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id);

  server.updateItem(itemState.getItem(activeItem.id)!);

  finalizeMouseUp();
  arrange(desktopStore);
}

function mouseUpHandler_moving_toOpaquePage(desktopStore: DesktopStoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const moveOverContainerId = overContainerVe.displayItem.id;

  if (moveOverContainerId == activeItem.id) {
    // TODO (HIGH): more rigorous check of entire hierarchy.
    // TODO (HIGH): quite possibly quite hard if only partial hierarchy loaded.
    throwExpression("Attempt was made to move an item into itself.");
  }

  const prevParentId = activeItem.parentId;

  if (isTable(overContainerVe.displayItem)) {
    panic();
  }

  activeItem.spatialPositionGr = { x: 0.0, y: 0.0 }; // case only covers move into opaque pages. parent changed during move for translucent.
  activeItem.ordering = itemState.newOrderingAtEndOfChildren(moveOverContainerId);
  activeItem.parentId = moveOverContainerId;

  const moveOverContainer = itemState.getContainerItem(moveOverContainerId)!;
  const moveOverContainerChildren = [activeItem.id, ...moveOverContainer.computed_children];
  moveOverContainer.computed_children = moveOverContainerChildren;
  itemState.sortChildren(moveOverContainer.id);

  const prevParent = itemState.getContainerItem(prevParentId)!;
  prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id);

  server.updateItem(itemState.getItem(activeItem.id)!);

  finalizeMouseUp();
  arrange(desktopStore);
}

function mouseUpHandler_moving_toTable(desktopStore: DesktopStoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const prevParentId = activeItem.parentId;
  const moveOverContainerId = overContainerVe.displayItem.id;

  if (moveOverContainerId == activeItem.id) {
    // TODO (HIGH): more rigorous check of entire hierarchy.
    // TODO (HIGH): quite possibly quite hard if only partial hierarchy loaded.
    throwExpression("Attempt was made to move an item into itself.");
  }

  if (overContainerVe.moveOverColAttachmentNumber.get() >= 0) {
    mouseUpHandler_moving_toTable_attachmentCell(desktopStore, activeItem, overContainerVe);
    return;
  }

  const insertPosition = overContainerVe.moveOverRowNumber.get();
  activeItem.ordering = itemState.newOrderingAtChildrenPosition(moveOverContainerId, insertPosition);
  activeItem.parentId = moveOverContainerId;

  const moveOverContainer = itemState.getContainerItem(moveOverContainerId)!;
  const moveOverContainerChildren = [activeItem.id, ...moveOverContainer.computed_children];
  moveOverContainer.computed_children = moveOverContainerChildren;
  itemState.sortChildren(moveOverContainer.id);

  const prevParent = itemState.getContainerItem(prevParentId)!;
  prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id);

  server.updateItem(itemState.getItem(activeItem.id)!);

  finalizeMouseUp();
  arrange(desktopStore);
}

function mouseUpHandler_moving_toTable_attachmentCell(desktopStore: DesktopStoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const prevParentId = activeItem.parentId;

  const tableItem = asTableItem(overContainerVe.displayItem);
  let rowNumber = overContainerVe.moveOverRowNumber.get();
  const yScrollPos = desktopStore.getTableScrollYPos(getVeid(overContainerVe));
  if (rowNumber < yScrollPos) { rowNumber = yScrollPos; }

  const childId = tableItem.computed_children[rowNumber];
  const child = itemState.getItem(childId)!;
  const canonicalChild = asAttachmentsItem(isLink(child)
    ? itemState.getItem(getLinkToId(asLinkItem(child)))!
    : child);
  const insertPosition = overContainerVe.moveOverColAttachmentNumber.get();
  const numPlaceholdersToCreate = insertPosition > canonicalChild.computed_attachments.length ? insertPosition - canonicalChild.computed_attachments.length : 0;
  for (let i=0; i<numPlaceholdersToCreate; ++i) {
    const placeholderItem = newPlaceholderItem(activeItem.ownerId, canonicalChild.id, Attachment, itemState.newOrderingAtEndOfAttachments(canonicalChild.id));
    itemState.addItem(placeholderItem);
    server.addItem(placeholderItem, null);
  }
  if (insertPosition < canonicalChild.computed_attachments.length) {
    const overAttachmentId = canonicalChild.computed_attachments[insertPosition];
    const placeholderToReplaceMaybe = itemState.getItem(overAttachmentId)!;
    if (isPlaceholder(placeholderToReplaceMaybe)) {
      activeItem.ordering = placeholderToReplaceMaybe.ordering;
      itemState.deleteItem(overAttachmentId);
      server.deleteItem(overAttachmentId);
    } else {
      activeItem.ordering = itemState.newOrderingAtAttachmentsPosition(canonicalChild.id, insertPosition);
    }
  } else {
    activeItem.ordering = itemState.newOrderingAtAttachmentsPosition(canonicalChild.id, insertPosition);
  }
  activeItem.relationshipToParent = Attachment;
  activeItem.parentId = canonicalChild.id;
  const childAttachments = [activeItem.id, ...canonicalChild.computed_attachments];
  canonicalChild.computed_attachments = childAttachments;
  itemState.sortAttachments(canonicalChild.id);

  const prevParent = itemState.getContainerItem(prevParentId)!;
  prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id);

  server.updateItem(itemState.getItem(activeItem.id)!);

  finalizeMouseUp();
  arrange(desktopStore);
}

export function mouseDoubleClickHandler(
    desktopStore: DesktopStoreContextModel,
    _userStore: UserStoreContextModel,
    ev: MouseEvent) {
  if (desktopStore.currentPage() == null) { return; }
  if (desktopStore.contextMenuInfo() != null || desktopStore.editDialogInfo() != null) { return; }
  if (ev.button != MOUSE_LEFT) {
    console.error("unsupported mouse double click button: " + ev.button);
    return;
  }

  const desktopPosPx = desktopPxFromMouseEvent(ev);

  const hitInfo = getHitInfo(desktopStore, desktopPosPx, [], false);
  if (hitInfo.hitboxType == HitboxType.None) { return; }

  const activeDisplayItem = itemState.getItem(hitInfo.overElementVes.get().displayItem.id)!;
  if (!isNote(activeDisplayItem)) { return; }

  desktopStore.setTextEditOverlayInfo({ noteItemPath: visualElementToPath(hitInfo.overElementVes.get()) });
}
