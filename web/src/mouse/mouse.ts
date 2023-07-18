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
import { allowHalfBlockWidth, asXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asPageItem, calcPageInnerSpatialDimensionsBl } from "../items/page-item";
import { asTableItem, isTable } from "../items/table-item";
import { DesktopStoreContextModel, findVisualElements } from "../store/DesktopStoreProvider";
import { UserStoreContextModel } from "../store/UserStoreProvider";
import { vectorAdd, getBoundingBoxTopLeft, desktopPxFromMouseEvent, isInside, vectorSubtract, Vector, boundingBoxFromPosSize, Dimensions } from "../util/geometry";
import { panic, throwExpression } from "../util/lang";
import { VisualElement, VisualElementPath, itemIdAndLinkIdMaybeFromVisualElementPath, itemIdFromVisualElementPath, visualElementDesktopBoundsPx as visualElementBoundsOnDesktopPx, visualElementSignalFromPath, visualElementToPath } from "../layout/visual-element";
import { arrange, rearrangeVisualElement, switchToPage } from "../layout/arrange";
import { editDialogSizePx } from "../components/context/EditDialog";
import { VisualElementSignal } from "../util/signals";
import { batch } from "solid-js";
import { AttachmentsItem, asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { Attachment, Child } from "../layout/relationship-to-parent";
import { asContainerItem } from "../items/base/container-item";
import { getHitInfo } from "./hitInfo";
import { PositionalItem, asPositionalItem } from "../items/base/positional-item";
import { PlaceholderItem, isPlaceholder, newPlaceholderItem } from "../items/placeholder-item";
import { Item } from "../items/base/item";
import { EMPTY_UID } from "../util/uid";
import { updateHref } from "../util/browser";
import { asLinkItem, isLink } from "../items/link-item";


const MOUSE_LEFT = 0;
const MOUSE_RIGHT = 2;

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
  activeElement: VisualElementPath,
  activeRoot: VisualElementPath,
  moveOver_containerElement: VisualElementPath | null,
  moveOver_attachHitboxElement: VisualElementPath | null,
  moveOver_scaleDefiningElement: VisualElementPath | null,
  startPx: Vector,
  startPosBl: Vector | null,
  startWidthBl: number | null,
  startHeightBl: number | null,
  startAttachmentsItem: AttachmentsItem | null,     // when taking an attachment out of a table.
  clickOffsetProp: Vector | null,
  hitMeta: HitboxMeta | null,
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


export function mouseDownHandler(
    desktopStore: DesktopStoreContextModel,
    ev: MouseEvent) {
  if (desktopStore.topLevelPageId() == null) { return; }
  if (ev.button == MOUSE_LEFT) {
    mouseLeftDownHandler(desktopStore, ev);
  } else if (ev.button == MOUSE_RIGHT) {
    mouseRightDownHandler(desktopStore, ev);
  } else {
    console.log("unsupported mouse button: " + ev.button);
  }
}


// **** LEFT DOWN ****
export function mouseLeftDownHandler(
    desktopStore: DesktopStoreContextModel,
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
    if (hitInfo.overElementVes.get().isPopup) {
      asPageItem(desktopStore.topLevelVisualElement().item).selectedAttachment = EMPTY_UID;
      switchToPage(desktopStore, hitInfo.overElementVes.get().item.id);
    } else {
      asPageItem(hitInfo.overElementVes.get().item).selectedAttachment = EMPTY_UID;
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
    ? desktopStore.getItem(hitInfo.overElementVes.get().linkItemMaybe!.id)!
    : desktopStore.getItem(hitInfo.overElementVes.get().item.id)!;
  let boundsOnDesktopPx = visualElementBoundsOnDesktopPx(hitInfo.overElementVes.get())
  const onePxSizeBl = hitInfo.overElementVes.get().isPopup
    ? { x: (calcSizeForSpatialBl(hitInfo.overElementVes.get().linkItemMaybe!, desktopStore.getItem).w + POPUP_TOOLBAR_WIDTH_BL) / boundsOnDesktopPx.w,
        y: calcSizeForSpatialBl(hitInfo.overElementVes.get().linkItemMaybe!, desktopStore.getItem).h / boundsOnDesktopPx.h }
    : { x: calcSizeForSpatialBl(activeItem, desktopStore.getItem).w / boundsOnDesktopPx.w,
        y: calcSizeForSpatialBl(activeItem, desktopStore.getItem).h / boundsOnDesktopPx.h };
  let clickOffsetProp = {
    x: (startPx.x - boundsOnDesktopPx.x) / boundsOnDesktopPx.w,
    y: (startPx.y - boundsOnDesktopPx.y) / boundsOnDesktopPx.h
  };
  const startAttachmentsItem = calcStartTableAttachmentsItemMaybe(desktopStore, activeItem);
  mouseActionState = {
    activeRoot: visualElementToPath(hitInfo.rootVe.isPopup ? hitInfo.rootVe.parent!.get() : hitInfo.rootVe),
    activeElement: visualElementToPath(hitInfo.overElementVes.get()),
    moveOver_containerElement: null,
    moveOver_attachHitboxElement: null,
    moveOver_scaleDefiningElement: visualElementToPath(
      getHitInfo(desktopStore, desktopPosPx, [hitInfo.overElementVes.get().item.id], false).overPositionableVe!),
    hitboxTypeOnMouseDown: hitInfo.hitboxType,
    action: MouseAction.Ambiguous,
    startPx,
    startPosBl,
    startWidthBl,
    startHeightBl,
    startAttachmentsItem,
    clickOffsetProp,
    onePxSizeBl,
    hitMeta: hitInfo.overElementMeta,
    newPlaceholderItem: null,
  }
}

function calcStartTableAttachmentsItemMaybe(desktopStore: DesktopStoreContextModel, activeItem: Item): AttachmentsItem | null {
  if (activeItem == null) {
    return null;
  }

  if (activeItem.parentId == null) {
    return null;
  }

  if (activeItem.relationshipToParent != "attachment") {
    return null;
  }

  let parent = desktopStore.getItem(activeItem.parentId)!;
  if (parent.parentId == null) {
    return null;
  }

  let parentParent = desktopStore.getItem(parent.parentId)!;
  if (!isTable(parentParent)) {
    return null;
  }

  return asAttachmentsItem(parent);
}

// **** RIGHT DOWN ****
export function mouseRightDownHandler(
    desktopStore: DesktopStoreContextModel,
    ev: MouseEvent) {

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

  const hitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [], true);
  if (asPageItem(hitInfo.rootVe.item).selectedAttachment != EMPTY_UID) {
    asPageItem(hitInfo.rootVe.item).selectedAttachment = EMPTY_UID;
    arrange(desktopStore);
    return;
  }

  if (desktopStore.popupId() != null) {
    desktopStore.popPopupId();
    arrange(desktopStore);
    return;
  }

  desktopStore.popTopLevelPageId();
  updateHref(desktopStore);
  arrange(desktopStore);
}


// **** MOVE ****
export function mouseMoveHandler(desktopStore: DesktopStoreContextModel) {
  if (desktopStore.topLevelPageId() == null) { return; }

  const ev = desktopStore.lastMouseMoveEvent();
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

  const activeVisualElement = visualElementSignalFromPath(desktopStore, mouseActionState.activeElement).get();
  const activeItem = asPositionalItem(activeVisualElement.linkItemMaybe != null
    ? desktopStore.getItem(activeVisualElement.linkItemMaybe!.id)!
    : desktopStore.getItem(activeVisualElement.item.id)!);

  if (mouseActionState.action == MouseAction.Ambiguous) {
    if (Math.abs(deltaPx.x) > MOUSE_MOVE_AMBIGUOUS_PX || Math.abs(deltaPx.y) > MOUSE_MOVE_AMBIGUOUS_PX) {
      if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Resize) > 0) {
        mouseActionState.startPosBl = null;
        if (activeVisualElement.isPopup) {
          mouseActionState.startWidthBl = activeVisualElement.linkItemMaybe!.spatialWidthGr / GRID_SIZE;
          mouseActionState.startHeightBl = null;
          mouseActionState.action = MouseAction.ResizingPopup;
        } else {
          mouseActionState.startWidthBl = asXSizableItem(activeItem).spatialWidthGr / GRID_SIZE;
          if (isYSizableItem(activeItem)) {
            mouseActionState.startHeightBl = asYSizableItem(activeItem).spatialHeightGr / GRID_SIZE;
          } else if(isLink(activeItem) && isYSizableItem(activeVisualElement.item)) {
            mouseActionState.startHeightBl = asLinkItem(activeItem).spatialHeightGr / GRID_SIZE;
          } else {
            mouseActionState.startHeightBl = null;
          }
          mouseActionState.action = MouseAction.Resizing;
        }

      } else if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Move) > 0) {
        mouseActionState.startWidthBl = null;
        mouseActionState.startHeightBl = null;
        if (activeVisualElement.isPopup) {
          mouseActionState.action = MouseAction.MovingPopup;
          const activeRoot = visualElementSignalFromPath(desktopStore, mouseActionState.activeRoot).get().item;
          const popupPositionGr = asPageItem(activeRoot).popupPositionGr;
          mouseActionState.startPosBl = { x: popupPositionGr.x / GRID_SIZE, y: popupPositionGr.y / GRID_SIZE };
        } else {
          const parentItem = desktopStore.getItem(activeItem.parentId)!;
          if (isTable(parentItem) && activeItem.relationshipToParent == Child) {
            moveActiveItemOutOfTable(desktopStore);
          }
          mouseActionState.startPosBl = {
            x: activeItem.spatialPositionGr.x / GRID_SIZE,
            y: activeItem.spatialPositionGr.y / GRID_SIZE
          };
          mouseActionState.action = MouseAction.Moving;
          const hitInfo = getHitInfo(desktopStore, desktopPosPx, [], false);
          if (activeItem.relationshipToParent == Attachment) {
            moveActiveItemToPage(desktopStore, hitInfo.overPositionableVe!, desktopPosPx, Attachment);
          }
        }

      } else if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.ColResize) > 0) {
        mouseActionState.startPosBl = null;
        mouseActionState.startHeightBl = null;
        const colNum = mouseActionState.hitMeta?.resizeColNumber!;
        mouseActionState.startWidthBl = asTableItem(activeItem).tableColumns[colNum].widthGr / GRID_SIZE;
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

    if (isYSizableItem(activeItem) || (isLink(activeItem) && isYSizableItem(activeVisualElement.item))) {
      let newHeightBl = mouseActionState!.startHeightBl! + deltaBl.y;
      newHeightBl = Math.round(newHeightBl);
      if (newHeightBl < 1) { newHeightBl = 1.0; }
      if (isLink(activeItem) && isYSizableItem(activeVisualElement.item)) {
        asLinkItem(activeItem).spatialHeightGr = newHeightBl * GRID_SIZE;
      } else {
        asYSizableItem(activeItem).spatialHeightGr = newHeightBl * GRID_SIZE;
      }
    }

    let { itemId, linkIdMaybe } = itemIdAndLinkIdMaybeFromVisualElementPath(mouseActionState.activeElement);
    findVisualElements(desktopStore, itemId, linkIdMaybe).forEach(ve => {
      rearrangeVisualElement(desktopStore, ve);
    });

  // ### Resizing Popup
  } else if (mouseActionState.action == MouseAction.ResizingPopup) {
    const deltaBl = {
      x: deltaPx.x * mouseActionState.onePxSizeBl.x * 2.0, // * 2.0 because it's centered, so mouse distance -> half the desired increase in width.
      y: deltaPx.y * mouseActionState.onePxSizeBl.y * 2.0
    };

    let newWidthBl = mouseActionState!.startWidthBl! + deltaBl.x;
    newWidthBl = Math.round(newWidthBl * 2.0) / 2.0;
    if (newWidthBl < 5) { newWidthBl = 5.0; }

    const activeRoot = visualElementSignalFromPath(desktopStore, mouseActionState.activeRoot).get();
    asPageItem(activeRoot.item).popupWidthGr = newWidthBl * GRID_SIZE;
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

    asTableItem(activeItem).tableColumns[mouseActionState!.hitMeta!.resizeColNumber!].widthGr = newWidthBl * GRID_SIZE;

    let { itemId, linkIdMaybe } = itemIdAndLinkIdMaybeFromVisualElementPath(mouseActionState.activeElement);
    findVisualElements(desktopStore, itemId, linkIdMaybe).forEach(ve => {
      rearrangeVisualElement(desktopStore, ve);
    });

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
    const activeRoot = visualElementSignalFromPath(desktopStore, mouseActionState.activeRoot).get();
    asPageItem(activeRoot.item).popupPositionGr = newPositionGr;
    arrange(desktopStore);

  // ### Moving
  } else if (mouseActionState.action == MouseAction.Moving) {

    const hitInfo = getHitInfo(desktopStore, desktopPosPx, [activeVisualElement.item.id], false);

    // update move over element state.
    if (mouseActionState.moveOver_containerElement == null ||
        mouseActionState.moveOver_containerElement! != visualElementToPath(hitInfo.overContainerVe!)) {
      if (mouseActionState.moveOver_containerElement != null) {
        visualElementSignalFromPath(desktopStore, mouseActionState.moveOver_containerElement).get().movingItemIsOver.set(false);
      }
      hitInfo.overContainerVe!.movingItemIsOver.set(true);
      mouseActionState.moveOver_containerElement = visualElementToPath(hitInfo.overContainerVe!);
    }

    // update move over attach state.
    batch(() => {
      if (mouseActionState!.moveOver_attachHitboxElement != null) {
        visualElementSignalFromPath(desktopStore, mouseActionState!.moveOver_attachHitboxElement).get().movingItemIsOverAttach.set(false);
      }
      if (hitInfo.hitboxType & HitboxType.Attach) {
        hitInfo.overElementVes.get().movingItemIsOverAttach.set(true);
        mouseActionState!.moveOver_attachHitboxElement = visualElementToPath(hitInfo.overElementVes.get());
      } else {
        mouseActionState!.moveOver_attachHitboxElement = null;
      }
    });

    if (visualElementSignalFromPath(desktopStore, mouseActionState.moveOver_scaleDefiningElement!).get().item != hitInfo.overPositionableVe!.item) {
      moveActiveItemToPage(desktopStore, hitInfo.overPositionableVe!, desktopPosPx, Child);
    }

    if (isTable(hitInfo.overContainerVe!.item)) {
      handleOverTable(desktopStore, hitInfo.overContainerVe!, desktopPosPx);
    }

    const deltaBl = {
      x: deltaPx.x * mouseActionState.onePxSizeBl.x,
      y: deltaPx.y * mouseActionState.onePxSizeBl.y
    };

    let newPosBl = vectorAdd(mouseActionState.startPosBl!, deltaBl);
    newPosBl.x = Math.round(newPosBl.x * 2.0) / 2.0;
    newPosBl.y = Math.round(newPosBl.y * 2.0) / 2.0;
    const inElement = visualElementSignalFromPath(desktopStore, mouseActionState.moveOver_scaleDefiningElement!).get().item;
    const dimBl = calcPageInnerSpatialDimensionsBl(asPageItem(inElement));
    if (newPosBl.x < 0.0) { newPosBl.x = 0.0; }
    if (newPosBl.y < 0.0) { newPosBl.y = 0.0; }
    if (newPosBl.x > dimBl.w - 0.5) { newPosBl.x = dimBl.w - 0.5; }
    if (newPosBl.y > dimBl.h - 0.5) { newPosBl.y = dimBl.h - 0.5; }
    activeItem.spatialPositionGr = { x: newPosBl.x * GRID_SIZE, y: newPosBl.y * GRID_SIZE };

    let { itemId, linkIdMaybe } = itemIdAndLinkIdMaybeFromVisualElementPath(mouseActionState.activeElement);
    findVisualElements(desktopStore, itemId, linkIdMaybe).forEach(ve => {
      rearrangeVisualElement(desktopStore, ve);
    });
  }
}

export function mouseMoveNoButtonDownHandler(desktopStore: DesktopStoreContextModel) {
  const dialogInfo = desktopStore.editDialogInfo();
  const contextMenuInfo = desktopStore.contextMenuInfo();
  const hasModal = dialogInfo != null || contextMenuInfo != null;
  const ev = desktopStore.lastMouseMoveEvent();
  let hitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [], false);
  let overElementVes = hitInfo.overElementVes;
  if (overElementVes != lastMouseOverVes || hasModal) {
    if (lastMouseOverVes != null) {
      lastMouseOverVes.get().mouseIsOver.set(false);
      lastMouseOverVes = null;
    }
  }
  if ((overElementVes!.get().item == null /* unteathered link */ || overElementVes!.get().item.id != desktopStore.topLevelPageId()) &&
      !overElementVes.get().isPopup && !overElementVes.get().mouseIsOver.get() &&
      !hasModal) {
    overElementVes!.get().mouseIsOver.set(true);
    lastMouseOverVes = overElementVes;
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
  const tableItem = asTableItem(overContainerVe.item);
  const tableDimensionsBl: Dimensions = {
    w: tableItem.spatialWidthGr / GRID_SIZE,
    h: tableItem.spatialHeightGr / GRID_SIZE
  };
  const tableBoundsPx = visualElementBoundsOnDesktopPx(overContainerVe);

  // row
  const mousePropY = (desktopPx.y - tableBoundsPx.y) / tableBoundsPx.h;
  const tableRowNumber = Math.floor(mousePropY * tableDimensionsBl.h);
  let insertRow = tableRowNumber + tableItem.scrollYProp.get() - 1;
  if (insertRow < 0) { insertRow = 0; }
  const adjustPosBy = insertRow > tableItem.computed_children.length
    ? insertRow - tableItem.computed_children.length
    : 0;
  overContainerVe.moveOverRowNumber.set(tableRowNumber - adjustPosBy);

  // col
  const mousePropX = (desktopPx.x - tableBoundsPx.x) / tableBoundsPx.w;
  const tableXBl = Math.floor(mousePropX * tableDimensionsBl.w * 2.0) / 2.0;
  const childItem = desktopStore.getItem(tableItem.computed_children[insertRow]);
  if (isAttachmentsItem(childItem)) {
    // first work out which column
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

    const numAttachments = asAttachmentsItem(childItem!).computed_attachments.length;
    let attachmentPos = colNumber - 1;
    overContainerVe.moveOverColAttachmentNumber.set(attachmentPos);
  } else {
    overContainerVe.moveOverColAttachmentNumber.set(-1);
  }
}

export function moveActiveItemToPage(desktopStore: DesktopStoreContextModel, moveToVe: VisualElement, desktopPx: Vector, relationshipToParent: string) {
  const activeElement = visualElementSignalFromPath(desktopStore, mouseActionState!.activeElement!).get();
  const activeItem = asPositionalItem(activeElement.linkItemMaybe != null ? activeElement.linkItemMaybe! : activeElement.item);
  const activeElementLinkItemMaybeId = activeElement.linkItemMaybe == null ? null : activeElement.linkItemMaybe.id;
  const activeElementItemId = activeElement.item.id;

  const currentParent = desktopStore.getItem(activeItem.parentId)!;
  const moveToPage = asPageItem(moveToVe.item);
  const moveToPageAbsoluteBoundsPx = visualElementBoundsOnDesktopPx(moveToVe);
  const moveToPageInnerSizeBl = calcPageInnerSpatialDimensionsBl(moveToPage);
  const mousePointBl = {
    x: Math.round((desktopPx.x - moveToPageAbsoluteBoundsPx.x) / moveToPageAbsoluteBoundsPx.w * moveToPageInnerSizeBl.w * 2.0) / 2.0,
    y: Math.round((desktopPx.y - moveToPageAbsoluteBoundsPx.y) / moveToPageAbsoluteBoundsPx.h * moveToPageInnerSizeBl.h * 2.0) / 2.0
  };
  const activeItemDimensionsBl = calcSizeForSpatialBl(activeItem, desktopStore.getItem);
  const clickOffsetInActiveItemBl = relationshipToParent == Child
    ? { x: Math.round(activeItemDimensionsBl.w * mouseActionState!.clickOffsetProp!.x * 2.0) / 2.0,
        y: Math.round(activeItemDimensionsBl.h * mouseActionState!.clickOffsetProp!.y * 2.0) / 2.0 }
    : { x: 0, y: 0 };
  const newItemPosBl = vectorSubtract(mousePointBl, clickOffsetInActiveItemBl);
  const newItemPosGr = { x: newItemPosBl.x * GRID_SIZE, y: newItemPosBl.y * GRID_SIZE };
  mouseActionState!.startPx = desktopPx;
  mouseActionState!.startPosBl = newItemPosBl;
  const moveToVisualPathString = visualElementToPath(moveToVe);

  let oldActiveItemOrdering = activeItem.ordering;
  activeItem.parentId = moveToVe.item.id;
  activeItem.ordering = desktopStore.newOrderingAtEndOfChildren(moveToVe.item.id);
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
      desktopStore.addItem(placeholderItem);
      mouseActionState!.newPlaceholderItem = placeholderItem;
    }
    mouseActionState!.startAttachmentsItem = parent;
  }

  arrange(desktopStore);

  let done = false;
  findVisualElements(desktopStore, activeElementItemId, activeElementLinkItemMaybeId).forEach(ve => {
    if (visualElementToPath(ve.get().parent!.get()) == moveToVisualPathString) {
      mouseActionState!.activeElement = visualElementToPath(ve.get());
      let boundsPx = visualElementSignalFromPath(desktopStore, mouseActionState!.activeElement).get().boundsPx;
      mouseActionState!.onePxSizeBl = {
        x: calcSizeForSpatialBl(activeItem, desktopStore.getItem).w / boundsPx.w,
        y: calcSizeForSpatialBl(activeItem, desktopStore.getItem).h / boundsPx.h
      };
      done = true;
    }
  });
  if (!done) {
    panic();
  }

  done = false;
  findVisualElements(desktopStore, moveToVe.item.id, moveToVe.linkItemMaybe == null ? null : moveToVe.linkItemMaybe.id).forEach(ve => {
    if (visualElementToPath(ve.get()) == moveToVisualPathString) {
      mouseActionState!.moveOver_scaleDefiningElement = visualElementToPath(ve.get());
      done = true;
    }
  });
  if (!done) { panic(); }
}

export function moveActiveItemOutOfTable(desktopStore: DesktopStoreContextModel) {
  const activeVisualElement = visualElementSignalFromPath(desktopStore, mouseActionState!.activeElement!).get();
  const tableVisualElement = activeVisualElement.parent!.get();
  const activeItem = asPositionalItem(activeVisualElement.linkItemMaybe != null ? activeVisualElement.linkItemMaybe! : activeVisualElement.item);
  const tableItem = asTableItem(tableVisualElement.item);
  const tableBlockHeightPx = tableVisualElement.boundsPx.h / (tableItem.spatialHeightGr / GRID_SIZE);
  let itemPosInTablePx = getBoundingBoxTopLeft(activeVisualElement.boundsPx);
  itemPosInTablePx.y -= tableItem.scrollYProp.get() * tableBlockHeightPx;
  const tableVe = activeVisualElement.parent!.get();
  const tableParentVe = tableVe.parent!.get();
  const tableParentVisualPathString = visualElementToPath(tableVe.parent!.get());

  const tablePosInPagePx = getBoundingBoxTopLeft(tableVe.childAreaBoundsPx!);
  const itemPosInPagePx = vectorAdd(tablePosInPagePx, itemPosInTablePx);
  const tableParentPage = asPageItem(desktopStore.getItem(tableItem.parentId)!);
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
  activeItem.ordering = desktopStore.newOrderingAtEndOfChildren(tableParentPage.id);
  activeItem.spatialPositionGr = itemPosInPageQuantizedGr;

  arrange(desktopStore);

  let done = false;
  let otherVes = [];
  findVisualElements(desktopStore, activeVisualElement.item.id, activeVisualElement.linkItemMaybe == null ? null : activeVisualElement.linkItemMaybe.id).forEach(ve => {
    if (visualElementToPath(ve.get().parent!.get()) == tableParentVisualPathString) {
      mouseActionState!.activeElement = visualElementToPath(ve.get());
      let boundsPx = visualElementSignalFromPath(desktopStore, mouseActionState!.activeElement).get().boundsPx;
      mouseActionState!.onePxSizeBl = {
        x: calcSizeForSpatialBl(activeItem, desktopStore.getItem).w / boundsPx.w,
        y: calcSizeForSpatialBl(activeItem, desktopStore.getItem).h / boundsPx.h
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

  const activeVisualElementSignal = visualElementSignalFromPath(desktopStore, mouseActionState.activeElement);
  const activeVisualElement = activeVisualElementSignal.get();
  const activeItem = asPositionalItem(activeVisualElement.linkItemMaybe != null ? activeVisualElement.linkItemMaybe! : activeVisualElement.item);

  switch (mouseActionState.action) {
    case MouseAction.Moving:
      mouseUpHandler_moving(desktopStore, activeItem);
      break;

    case MouseAction.MovingPopup: {
        const activeRoot = asPageItem(visualElementSignalFromPath(desktopStore, mouseActionState.activeRoot).get().item);
        if (activeRoot.popupPositionGr.x / GRID_SIZE != mouseActionState.startPosBl!.x ||
            activeRoot.popupPositionGr.y / GRID_SIZE != mouseActionState.startPosBl!.y) {
          server.updateItem(desktopStore.getItem(activeRoot.id)!);
        }
      break;
    }

    case MouseAction.Resizing:
      if (mouseActionState.startWidthBl! * GRID_SIZE != asXSizableItem(activeItem).spatialWidthGr ||
          (isYSizableItem(activeItem) && mouseActionState.startHeightBl! * GRID_SIZE != asYSizableItem(activeItem).spatialHeightGr)) {
        server.updateItem(desktopStore.getItem(activeItem.id)!);
      }

      // mouseActionState.activeVisualElement.update(ve => {
      //   ve.resizingFromBoundsPx = null;
      // });
      break;

    case MouseAction.ResizingPopup: {
      const activeRoot = visualElementSignalFromPath(desktopStore, mouseActionState.activeRoot).get().item;
      if (mouseActionState.startWidthBl! * GRID_SIZE != asPageItem(activeRoot).popupWidthGr) {
        server.updateItem(desktopStore.getItem(activeRoot.id)!);
      }
      break;
    }

    case MouseAction.ResizingColumn:
      if (mouseActionState.startWidthBl! * GRID_SIZE != asTableItem(activeItem).tableColumns[mouseActionState.hitMeta!.resizeColNumber!].widthGr) {
        server.updateItem(desktopStore.getItem(activeItem.id)!);
      }
      break;

    case MouseAction.Ambiguous:
      if (mouseActionState.hitboxTypeOnMouseDown! & HitboxType.OpenPopup) {
        handlePopupClick(activeVisualElement, desktopStore, userStore);
      }
      else if (mouseActionState.hitboxTypeOnMouseDown! & HitboxType.OpenAttachment) {
        handleAttachmentClick(activeVisualElement, desktopStore, userStore);
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

function handleAttachmentClick(visualElement: VisualElement, desktopStore: DesktopStoreContextModel, _userStore: UserStoreContextModel) {
  const page = asPageItem(visualElement.parent!.get().parent!.get().item);
  page.selectedAttachment = visualElement.item.id;
}

function mouseUpHandler_moving(
    desktopStore: DesktopStoreContextModel,
    activeItem: PositionalItem) {
  if (mouseActionState == null) { return; } // make typsecript happy

  if (mouseActionState.moveOver_containerElement != null) {
    visualElementSignalFromPath(desktopStore, mouseActionState.moveOver_containerElement).get()
      .movingItemIsOver.set(false);
  }

  if (mouseActionState.moveOver_attachHitboxElement != null) {
    // does not include case of move into table cells that are attachments.
    mouseUpHandler_moving_hitboxAttachTo(desktopStore, activeItem);
    return;
  }

  const overContainerVe = visualElementSignalFromPath(desktopStore, mouseActionState.moveOver_containerElement!).get();

  if (isTable(overContainerVe.item)) {
    mouseUpHandler_moving_toTable(desktopStore, activeItem, overContainerVe);
    return;
  }

  if (overContainerVe.item.id != activeItem.parentId) {
    mouseUpHandler_moving_toOpaquePage(desktopStore, activeItem, overContainerVe);
    return;
  }

  // root page
  if (mouseActionState.startPosBl!.x * GRID_SIZE != activeItem.spatialPositionGr.x ||
      mouseActionState.startPosBl!.y * GRID_SIZE != activeItem.spatialPositionGr.y) {
    server.updateItem(desktopStore.getItem(activeItem.id)!);
  }

  cleanupAndPersistPlaceholders(desktopStore);

  arrange(desktopStore);
}

function cleanupAndPersistPlaceholders(desktopStore: DesktopStoreContextModel) {
  if (mouseActionState!.startAttachmentsItem == null) {
    return;
  }

  if (mouseActionState!.newPlaceholderItem != null) {
    server.addItem(mouseActionState!.newPlaceholderItem!, null);
  }

  const placeholderParent = mouseActionState!.startAttachmentsItem!;

  while (true) {
    const attachments = placeholderParent.computed_attachments;
    if (attachments.length == 0) { break; }
    const attachmentId = placeholderParent.computed_attachments[placeholderParent.computed_attachments.length-1];
    const attachment = desktopStore.getItem(attachmentId)!;
    if (attachment == null) { panic(); }
    if (!isPlaceholder(attachment)) {
      break;
    }
    server.deleteItem(attachment.id);
    desktopStore.deleteItem(attachment.id);
  }

  mouseActionState!.newPlaceholderItem = null;
  mouseActionState!.startAttachmentsItem = null;
}

function mouseUpHandler_moving_hitboxAttachTo(desktopStore: DesktopStoreContextModel, activeItem: PositionalItem) {
  const prevParentId = activeItem.parentId;

  const attachToVisualElement = visualElementSignalFromPath(desktopStore, mouseActionState!.moveOver_attachHitboxElement!).get();
  const attachmentsItem = asAttachmentsItem(attachToVisualElement.item);
  attachToVisualElement.movingItemIsOverAttach.set(false);
  mouseActionState!.moveOver_attachHitboxElement = null;

  if (attachmentsItem.id == activeItem.id) {
    // TODO (MEDIUM): More rigorous recursive check. also server side.
    throwExpression("Attempt was made to attach an item to itself.");
  }

  activeItem.parentId = attachToVisualElement.item.id;
  activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
  activeItem.ordering = desktopStore.newOrderingAtEndOfAttachments(attachmentsItem.id);
  activeItem.relationshipToParent = Attachment;

  const attachments = [activeItem.id, ...attachmentsItem.computed_attachments];
  attachmentsItem.computed_attachments = attachments;
  desktopStore.sortAttachments(attachmentsItem.id);

  const prevParent = desktopStore.getContainerItem(prevParentId)!;
  prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id);

  cleanupAndPersistPlaceholders(desktopStore);

  arrange(desktopStore);

  server.updateItem(desktopStore.getItem(activeItem.id)!);
}

function mouseUpHandler_moving_toOpaquePage(desktopStore: DesktopStoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const moveOverContainerId = overContainerVe.item.id;

  if (moveOverContainerId == activeItem.id) {
    // TODO (HIGH): more rigorous check of entire hierarchy.
    // TODO (HIGH): quite possibly quite hard if only partial hierarchy loaded.
    throwExpression("Attempt was made to move an item into itself.");
  }

  const prevParentId = activeItem.parentId;

  if (isTable(overContainerVe.item)) {
    panic();
  }

  activeItem.spatialPositionGr = { x: 0.0, y: 0.0 }; // case only covers move into opaque pages. parent changed during move for translucent.
  activeItem.ordering = desktopStore.newOrderingAtEndOfChildren(moveOverContainerId);
  activeItem.parentId = moveOverContainerId;

  const moveOverContainer = desktopStore.getContainerItem(moveOverContainerId)!;
  const moveOverContainerChildren = [activeItem.id, ...moveOverContainer.computed_children];
  moveOverContainer.computed_children = moveOverContainerChildren;
  desktopStore.sortChildren(moveOverContainer.id);

  const prevParent = desktopStore.getContainerItem(prevParentId)!;
  prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id);

  server.updateItem(desktopStore.getItem(activeItem.id)!);

  cleanupAndPersistPlaceholders(desktopStore);

  arrange(desktopStore);
}

function mouseUpHandler_moving_toTable(desktopStore: DesktopStoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const prevParentId = activeItem.parentId;
  const moveOverContainerId = overContainerVe.item.id;

  if (moveOverContainerId == activeItem.id) {
    // TODO (HIGH): more rigorous check of entire hierarchy.
    // TODO (HIGH): quite possibly quite hard if only partial hierarchy loaded.
    throwExpression("Attempt was made to move an item into itself.");
  }

  if (overContainerVe.moveOverColAttachmentNumber.get() >= 0) {
    mouseUpHandler_moving_toTable_attachmentCell(desktopStore, activeItem, overContainerVe);
    return;
  }

  const insertPosition = overContainerVe.moveOverRowNumber.get() + asTableItem(overContainerVe.item).scrollYProp.get();
  activeItem.ordering = desktopStore.newOrderingAtChildrenPosition(moveOverContainerId, insertPosition);
  activeItem.parentId = moveOverContainerId;

  const moveOverContainer = desktopStore.getContainerItem(moveOverContainerId)!;
  const moveOverContainerChildren = [activeItem.id, ...moveOverContainer.computed_children];
  moveOverContainer.computed_children = moveOverContainerChildren;
  desktopStore.sortChildren(moveOverContainer.id);

  const prevParent = desktopStore.getContainerItem(prevParentId)!;
  prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id);

  cleanupAndPersistPlaceholders(desktopStore);

  arrange(desktopStore);

  server.updateItem(desktopStore.getItem(activeItem.id)!);
}

function mouseUpHandler_moving_toTable_attachmentCell(desktopStore: DesktopStoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const prevParentId = activeItem.parentId;

  const tableItem = asTableItem(overContainerVe.item);
  let rowNumber = overContainerVe.moveOverRowNumber.get() + asTableItem(overContainerVe.item).scrollYProp.get() - 1;
  if (rowNumber < 0) { rowNumber = 0; }

  const childId = tableItem.computed_children[rowNumber];
  const child = asAttachmentsItem(desktopStore.getItem(childId)!);
  const insertPosition = overContainerVe.moveOverColAttachmentNumber.get();
  const numPlaceholdersToCreate = insertPosition > child.computed_attachments.length ? insertPosition - child.computed_attachments.length : 0;
  for (let i=0; i<numPlaceholdersToCreate; ++i) {
    const placeholderItem = newPlaceholderItem(activeItem.ownerId, child.id, Attachment, desktopStore.newOrderingAtEndOfAttachments(childId));
    desktopStore.addItem(placeholderItem);
    server.addItem(placeholderItem, null);
  }
  if (insertPosition < child.computed_attachments.length) {
    const overAttachmentId = child.computed_attachments[insertPosition];
    const placeholderToReplaceMaybe = desktopStore.getItem(overAttachmentId)!;
    if (isPlaceholder(placeholderToReplaceMaybe)) {
      activeItem.ordering = placeholderToReplaceMaybe.ordering;
      desktopStore.deleteItem(overAttachmentId);
      server.deleteItem(overAttachmentId);
    } else {
      activeItem.ordering = desktopStore.newOrderingAtAttachmentsPosition(childId, insertPosition);
    }
  } else {
    activeItem.ordering = desktopStore.newOrderingAtAttachmentsPosition(childId, insertPosition);
  }
  activeItem.relationshipToParent = Attachment;
  activeItem.parentId = childId;
  const childAttachments = [activeItem.id, ...child.computed_attachments];
  child.computed_attachments = childAttachments;
  desktopStore.sortAttachments(child.id);

  const prevParent = desktopStore.getContainerItem(prevParentId)!;
  prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id);

  cleanupAndPersistPlaceholders(desktopStore);

  arrange(desktopStore);

  server.updateItem(desktopStore.getItem(activeItem.id)!);
}