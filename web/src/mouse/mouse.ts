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
import { HitboxType } from "../layout/hitbox";
import { server } from "../server";
import { calcSizeForSpatialBl, handleClick, handlePopupClick } from "../items/base/item-polymorphism";
import { allowHalfBlockWidth, asXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asPageItem, calcPageInnerSpatialDimensionsBl, isPage } from "../items/page-item";
import { asTableItem, isTable } from "../items/table-item";
import { DesktopStoreContextModel, visualElementsWithId } from "../store/DesktopStoreProvider";
import { UserStoreContextModel } from "../store/UserStoreProvider";
import { vectorAdd, getBoundingBoxTopLeft, desktopPxFromMouseEvent, isInside, vectorSubtract, Vector, boundingBoxFromPosSize, Dimensions } from "../util/geometry";
import { panic, throwExpression } from "../util/lang";
import { EMPTY_UID } from "../util/uid";
import { compareOrderings } from "../util/ordering";
import { VisualElement, VisualElementPath, itemIdFromVisualElementPath, visualElementDesktopBoundsPx, visualElementSignalFromPath, visualElementToPath } from "../layout/visual-element";
import { arrange, rearrangeVisualElement, switchToPage } from "../layout/arrange";
import { editDialogSizePx } from "../components/context/EditDialog";
import { VisualElementSignal } from "../util/signals";
import { batch } from "solid-js";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { Attachment, Child } from "../layout/relationship-to-parent";
import { asContainerItem, isContainer } from "../items/base/container-item";
import { getHitInfo } from "./hit";


const MOUSE_LEFT = 0;
const MOUSE_RIGHT = 2;

enum MouseAction {
  Ambiguous,
  Moving,
  Resizing,
  ColResizing,
}

interface MouseActionState {
  hitboxTypeOnMouseDown: HitboxType,
  activeElement: VisualElementPath,
  moveOverContainerElement: VisualElementPath | null,
  moveOverAttachElement: VisualElementPath | null,
  scaleDefiningElement: VisualElementPath | null,
  startPx: Vector,
  startPosBl: Vector | null,
  clickOffsetProp: Vector | null,
  startWidthBl: number | null,
  startHeightBl: number | null,
  hitMeta: any | null,
  action: MouseAction,
  onePxSizeBl: Vector,
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
    console.log("unrecognized mouse button: " + ev.button);
  }
}


// **** LEFT DOWN ****
export function mouseLeftDownHandler(
    desktopStore: DesktopStoreContextModel,
    ev: MouseEvent) {

  const desktopPosPx = desktopPxFromMouseEvent(ev);

  if (desktopStore.contextMenuInfo() != null) {
    desktopStore.setContextMenuInfo(null); return;
  }

  let dialogInfo = desktopStore.editDialogInfo();
  if (dialogInfo != null) {
    if (isInside(desktopPosPx, dialogInfo!.desktopBoundsPx)) {
      dialogMoveState = { lastMousePosPx: desktopPosPx };
      return;
    }

    desktopStore.setEditDialogInfo(null); return;
  }

  const hitInfo = getHitInfo(desktopStore, desktopPosPx, [], false);
  if (hitInfo.hitboxType == HitboxType.None) {
    if (hitInfo.overElementVes.get().isPopup) {
      switchToPage(desktopStore, hitInfo.overElementVes.get().item.id);
    }
    mouseActionState = null;
    return;
  }

  const startPosBl = null;
  const startWidthBl = null;
  const startHeightBl = null;
  const startPx = desktopPxFromMouseEvent(ev);
  const activeItem = desktopStore.getItem(hitInfo.overElementVes.get().item.id)!;
  let desktopBoundsPx = visualElementDesktopBoundsPx(hitInfo.overElementVes.get());
  const onePxSizeBl = {
    x: calcSizeForSpatialBl(activeItem, desktopStore.getItem).w / desktopBoundsPx.w,
    y: calcSizeForSpatialBl(activeItem, desktopStore.getItem).h / desktopBoundsPx.h
  };
  let clickOffsetProp = {
    x: (startPx.x - desktopBoundsPx.x) / desktopBoundsPx.w,
    y: (startPx.y - desktopBoundsPx.y) / desktopBoundsPx.h
  };
  mouseActionState = {
    activeElement: visualElementToPath(hitInfo.overElementVes.get()),
    moveOverContainerElement: null,
    moveOverAttachElement: null,
    scaleDefiningElement: visualElementToPath(
      getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [hitInfo.overElementVes.get().item.id], false).overPositionableVe!),
    hitboxTypeOnMouseDown: hitInfo.hitboxType,
    action: MouseAction.Ambiguous,
    startPx,
    startPosBl,
    clickOffsetProp,
    startWidthBl,
    startHeightBl,
    onePxSizeBl,
    hitMeta: hitInfo.overElementMeta,
  }
}


// **** RIGHT DOWN ****
export function mouseRightDownHandler(
    desktopStore: DesktopStoreContextModel,
    _ev: MouseEvent) {

  if (desktopStore.contextMenuInfo()) {
    desktopStore.setContextMenuInfo(null);
    return;
  }

  if (desktopStore.editDialogInfo() != null) {
    desktopStore.setEditDialogInfo(null);
    return;
  }

  if (desktopStore.popupId() != null) {
    desktopStore.popPopupId();
    arrange(desktopStore);
    return;
  }

  desktopStore.popTopLevelPageId();
  arrange(desktopStore);
}


// **** MOVE ****
export function mouseMoveHandler(desktopStore: DesktopStoreContextModel) {
  if (desktopStore.topLevelPageId() == null) { return; }

  const ev = desktopStore.lastMouseMoveEvent();

  // It is necessary to handle dialog moving at the global level, because sometimes the mouse position may
  // get outside the dialog area when being moved quickly.
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

  if (mouseActionState == null) {
    mouseMoveNoButtonDownHandler(desktopStore);
    return;
  }

  const deltaPx = vectorSubtract(desktopPxFromMouseEvent(ev), mouseActionState.startPx!);

  const activeItem = visualElementSignalFromPath(desktopStore, mouseActionState.activeElement).get().item;

  if (mouseActionState.action == MouseAction.Ambiguous) {
    if (Math.abs(deltaPx.x) > MOUSE_MOVE_AMBIGUOUS_PX || Math.abs(deltaPx.y) > MOUSE_MOVE_AMBIGUOUS_PX) {
      if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Resize) > 0) {
        mouseActionState.startPosBl = null;
        mouseActionState.startWidthBl = asXSizableItem(activeItem).spatialWidthGr / GRID_SIZE;
        if (isYSizableItem(activeItem)) {
          mouseActionState.startHeightBl = asYSizableItem(activeItem).spatialHeightGr / GRID_SIZE;
        } else {
          mouseActionState.startHeightBl = null;
        }
        mouseActionState.action = MouseAction.Resizing;
      } else if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.ColResize) > 0) {
        mouseActionState.startPosBl = null;
        mouseActionState.startHeightBl = null;
        const colNum: number = mouseActionState.hitMeta!;
        mouseActionState.startWidthBl = asTableItem(activeItem).tableColumns[colNum].widthGr / GRID_SIZE;
        mouseActionState.action = MouseAction.ColResizing;
      } else if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Move) > 0) {
        if (isTable(desktopStore.getItem(activeItem.parentId)!)) {
          moveActiveItemOutOfTable(desktopStore);
        }
        mouseActionState.startWidthBl = null;
        mouseActionState.startHeightBl = null;
        mouseActionState.startPosBl = {
          x: activeItem.spatialPositionGr.x / GRID_SIZE,
          y: activeItem.spatialPositionGr.y / GRID_SIZE
        };
        mouseActionState.action = MouseAction.Moving;
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

    if (isYSizableItem(activeItem)) {
      let newHeightBl = mouseActionState!.startHeightBl! + deltaBl.y;
      newHeightBl = Math.round(newHeightBl);
      if (newHeightBl < 1) { newHeightBl = 1.0; }
      asYSizableItem(activeItem).spatialHeightGr = newHeightBl * GRID_SIZE;
    }

    visualElementsWithId(desktopStore, itemIdFromVisualElementPath(mouseActionState.activeElement)).forEach(ve => {
      rearrangeVisualElement(desktopStore, ve);
    });

  // ### Col Resizing
  } else if (mouseActionState.action == MouseAction.ColResizing) {
    const deltaBl = {
      x: deltaPx.x * mouseActionState.onePxSizeBl.x,
      y: deltaPx.y * mouseActionState.onePxSizeBl.y
    };

    let newWidthBl = mouseActionState!.startWidthBl! + deltaBl.x;
    newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
    if (newWidthBl < 1) { newWidthBl = 1.0; }

    asTableItem(activeItem).tableColumns[mouseActionState!.hitMeta].widthGr = newWidthBl * GRID_SIZE;

    visualElementsWithId(desktopStore, itemIdFromVisualElementPath(mouseActionState.activeElement)).forEach(ve => {
      rearrangeVisualElement(desktopStore, ve);
    });

  // ### Moving
  } else if (mouseActionState.action == MouseAction.Moving) {

    const hitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [activeItem.id], false);
    const overVe = hitInfo.overElementVes.get();

    // update move over element state.
    if (mouseActionState.moveOverContainerElement == null ||
        mouseActionState.moveOverContainerElement! != visualElementToPath(hitInfo.overContainerVe!)) {
      if (mouseActionState.moveOverContainerElement != null) {
        visualElementSignalFromPath(desktopStore, mouseActionState.moveOverContainerElement).get().movingItemIsOver.set(false);
      }
      hitInfo.overContainerVe!.movingItemIsOver.set(true);
      mouseActionState.moveOverContainerElement = visualElementToPath(hitInfo.overContainerVe!);
    }

    // update move over attach state.
    batch(() => {
      if (mouseActionState!.moveOverAttachElement != null) {
        visualElementSignalFromPath(desktopStore, mouseActionState!.moveOverAttachElement).get().movingItemIsOverAttach.set(false);
      }
      if (hitInfo.hitboxType & HitboxType.Attach) {
        hitInfo.overElementVes.get().movingItemIsOverAttach.set(true);
        mouseActionState!.moveOverAttachElement = visualElementToPath(hitInfo.overElementVes.get());
      } else {
        mouseActionState!.moveOverAttachElement = null;
      }
    });

    if (visualElementSignalFromPath(desktopStore, mouseActionState.scaleDefiningElement!).get().item != hitInfo.overPositionableVe!.item ||
        activeItem.relationshipToParent == Attachment) {
      moveActiveItemToDifferentPage(desktopStore, hitInfo.overPositionableVe!, desktopPxFromMouseEvent(ev));
    }

    if (isTable(hitInfo.overContainerVe!.item)) {
      handleMoveOverTable(desktopStore, hitInfo.overContainerVe!, desktopPxFromMouseEvent(ev));
    }

    const deltaBl = {
      x: deltaPx.x * mouseActionState.onePxSizeBl.x,
      y: deltaPx.y * mouseActionState.onePxSizeBl.y
    };

    let newPosBl = vectorAdd(mouseActionState.startPosBl!, deltaBl);
    newPosBl.x = Math.round(newPosBl.x * 2.0) / 2.0;
    newPosBl.y = Math.round(newPosBl.y * 2.0) / 2.0;
    const inElement = visualElementSignalFromPath(desktopStore, mouseActionState.scaleDefiningElement!).get().item;
    const dimBl = calcPageInnerSpatialDimensionsBl(asPageItem(inElement));
    if (newPosBl.x < 0.0) { newPosBl.x = 0.0; }
    if (newPosBl.y < 0.0) { newPosBl.y = 0.0; }
    if (newPosBl.x > dimBl.w - 0.5) { newPosBl.x = dimBl.w - 0.5; }
    if (newPosBl.y > dimBl.h - 0.5) { newPosBl.y = dimBl.h - 0.5; }
    activeItem.spatialPositionGr = { x: newPosBl.x * GRID_SIZE, y: newPosBl.y * GRID_SIZE };

    visualElementsWithId(desktopStore, itemIdFromVisualElementPath(mouseActionState.activeElement)).forEach(ve => {
      rearrangeVisualElement(desktopStore, ve);
    });
  }
}

export function mouseMoveNoButtonDownHandler(desktopStore: DesktopStoreContextModel) {
  const ev = desktopStore.lastMouseMoveEvent();
  let currentHitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [], false);
  let overElementVes = currentHitInfo.overElementVes;
  if (overElementVes != lastMouseOverVes) {
    if (lastMouseOverVes != null) {
      lastMouseOverVes.get().mouseIsOver.set(false);
      lastMouseOverVes = null;
    }
  }
  if (overElementVes!.get().item.id != desktopStore.topLevelPageId() &&
      !overElementVes.get().isPopup && !overElementVes.get().mouseIsOver.get()) {
    overElementVes!.get().mouseIsOver.set(true);
    lastMouseOverVes = overElementVes;
  }
  if ((currentHitInfo.hitboxType & HitboxType.Resize) > 0) {
    document.body.style.cursor = "nwse-resize";
  } else if ((currentHitInfo.hitboxType & HitboxType.ColResize) > 0) {
    document.body.style.cursor = "ew-resize";
  } else {
    document.body.style.cursor = "default";
  }
}

export function handleMoveOverTable(desktopStore: DesktopStoreContextModel, moveToVe: VisualElement, desktopPx: Vector) {
  const tableItem = asTableItem(moveToVe.item);
  const tableDimensionsBl: Dimensions = {
    w: tableItem.spatialWidthGr / GRID_SIZE,
    h: tableItem.spatialHeightGr / GRID_SIZE
  };
  const tableBoundsPx = visualElementDesktopBoundsPx(moveToVe);

  // row
  const mousePropY = (desktopPx.y - tableBoundsPx.y) / tableBoundsPx.h;
  const tableRowNumber = Math.floor(mousePropY * tableDimensionsBl.h);
  let insertRow = tableRowNumber + tableItem.scrollYProp.get() - 1;
  if (insertRow < 0) { insertRow = 0; }
  const adjustPosBy = insertRow > tableItem.computed_children.length
    ? insertRow - tableItem.computed_children.length
    : 0;
  moveToVe.moveOverRowNumber.set(tableRowNumber - adjustPosBy);

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
    // then work out position in attachments from that.
    const numAttachments = asAttachmentsItem(childItem!).computed_attachments.length;
    let attachmentPos = colNumber - 1;
    if (attachmentPos > numAttachments) {
      attachmentPos = numAttachments;
    }
    moveToVe.moveOverColAttachmentNumber.set(attachmentPos);
  } else {
    moveToVe.moveOverColAttachmentNumber.set(-1);
  }
}

export function moveActiveItemToDifferentPage(desktopStore: DesktopStoreContextModel, moveToVe: VisualElement, desktopPx: Vector) {
  const activeItem = visualElementSignalFromPath(desktopStore, mouseActionState!.activeElement!).get().item;
  const currentParent = desktopStore.getItem(activeItem.parentId)!;
  const moveToPage = asPageItem(moveToVe.item);
  const moveToPageAbsoluteBoundsPx = visualElementDesktopBoundsPx(moveToVe);
  const moveToPageInnerSizeBl = calcPageInnerSpatialDimensionsBl(moveToPage);
  const mousePointBl = {
    x: Math.round((desktopPx.x - moveToPageAbsoluteBoundsPx.x) / moveToPageAbsoluteBoundsPx.w * moveToPageInnerSizeBl.w * 2.0) / 2.0,
    y: Math.round((desktopPx.y - moveToPageAbsoluteBoundsPx.y) / moveToPageAbsoluteBoundsPx.h * moveToPageInnerSizeBl.h * 2.0) / 2.0
  };
  const activeItemDimensionsBl = calcSizeForSpatialBl(activeItem, desktopStore.getItem);
  const clickOffsetInActiveItemBl = {
    x: Math.round(activeItemDimensionsBl.w * mouseActionState!.clickOffsetProp!.x * 2.0) / 2.0,
    y: Math.round(activeItemDimensionsBl.h * mouseActionState!.clickOffsetProp!.y * 2.0) / 2.0
  }
  const newItemPosBl = vectorSubtract(mousePointBl, clickOffsetInActiveItemBl);
  const newItemPosGr = { x: newItemPosBl.x * GRID_SIZE, y: newItemPosBl.y * GRID_SIZE };
  mouseActionState!.startPx = desktopPx;
  mouseActionState!.startPosBl = newItemPosBl;
  const moveToVisualPathString = visualElementToPath(moveToVe);
  activeItem.parentId = moveToVe.item.id;
  activeItem.ordering = desktopStore.newOrderingAtEndOfChildren(moveToVe.item.id);
  activeItem.spatialPositionGr = newItemPosGr;
  activeItem.relationshipToParent = Child;
  moveToPage.computed_children = [activeItem.id, ...moveToPage.computed_children];
  if (isContainer(currentParent)) {
    asContainerItem(currentParent).computed_children
      = asContainerItem(currentParent).computed_children.filter(childItem => childItem != activeItem.id);
  }
  if (isAttachmentsItem(currentParent)) {
    asAttachmentsItem(currentParent).computed_attachments
      = asAttachmentsItem(currentParent).computed_attachments.filter(childItem => childItem != activeItem.id);
  }
  arrange(desktopStore);

  let done = false;
  visualElementsWithId(desktopStore, activeItem.id).forEach(ve => {
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
  if (!done) { panic(); }

  done = false;
  visualElementsWithId(desktopStore, moveToPage.id).forEach(ve => {
    if (visualElementToPath(ve.get()) == moveToVisualPathString) {
      mouseActionState!.scaleDefiningElement = visualElementToPath(ve.get());
      done = true;
    }
  });
  if (!done) { panic(); }
}

export function moveActiveItemOutOfTable(desktopStore: DesktopStoreContextModel) {
  const activeVisualElement = visualElementSignalFromPath(desktopStore, mouseActionState!.activeElement!).get();
  const tableVisualElement = activeVisualElement.parent!.get();
  const activeItem = activeVisualElement.item;
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
  visualElementsWithId(desktopStore, activeVisualElement.item.id).forEach(ve => {
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
  const activeItem = activeVisualElement.item;

  if (mouseActionState.moveOverContainerElement != null) {
    visualElementSignalFromPath(desktopStore, mouseActionState.moveOverContainerElement).get().movingItemIsOver.set(false);
  }

  switch (mouseActionState.action) {
    case MouseAction.Moving:
      const overVe = visualElementSignalFromPath(desktopStore, mouseActionState.moveOverContainerElement!).get();

      if (mouseActionState.moveOverAttachElement != null) {
        const prevParentId = activeItem.parentId;

        const attachToVisualElement = visualElementSignalFromPath(desktopStore, mouseActionState.moveOverAttachElement).get();
        const attachmentsItem = asAttachmentsItem(attachToVisualElement.item);
        attachToVisualElement.movingItemIsOverAttach.set(false);
        mouseActionState.moveOverAttachElement = null;

        activeItem.parentId = attachToVisualElement.item.id;
        activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
        activeItem.ordering = desktopStore.newOrderingAtEndOfAttachments(attachmentsItem.id);
        activeItem.relationshipToParent = Attachment;

        const attachments = [activeItem.id, ...attachmentsItem.computed_attachments];
        attachments.sort((a, b) => compareOrderings(desktopStore.getItem(a)!.ordering, desktopStore.getItem(b)!.ordering));
        attachmentsItem.computed_attachments = attachments;

        const prevParent = desktopStore.getContainerItem(prevParentId)!;
        prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id);

        arrange(desktopStore);

        server.updateItem(desktopStore.getItem(activeItem.id)!);
      }

      else {
        const moveOverContainerId = overVe.item.id;
        if (moveOverContainerId == activeItem.id) {
          // TODO (HIGH): more rigorous check of entire hierarchy.
          // TODO (HIGH): quite possibly quite hard if only partial hierarchy loaded.
          throwExpression("Attempt was made to move an item into itself.");
        }

        const parentChanged = moveOverContainerId != activeItem.parentId;
        if (parentChanged) {
          const prevParentId = activeItem.parentId;

          activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };

          if (isTable(overVe.item)) {
            if (overVe.moveOverColAttachmentNumber.get() >= 0) {
              const tableItem = asTableItem(overVe.item);
              let position = overVe.moveOverRowNumber.get() + asTableItem(overVe.item).scrollYProp.get() - 1;
              if (position < 0) { position = 0; }

              const childId = tableItem.computed_children[position];
              const child = asAttachmentsItem(desktopStore.getItem(childId)!);
              activeItem.ordering = desktopStore.newAttachmentOrderingAtPosition(childId, position);
              activeItem.relationshipToParent = Attachment;
              activeItem.parentId = childId;
              const childAttachmnets = [activeItem.id, ...child.computed_attachments];
              childAttachmnets.sort((a, b) => compareOrderings(desktopStore.getItem(a)!.ordering, desktopStore.getItem(b)!.ordering));
              child.computed_attachments = childAttachmnets;

              const prevParent = desktopStore.getContainerItem(prevParentId)!;
              prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id);

              arrange(desktopStore);

              server.updateItem(desktopStore.getItem(activeItem.id)!);
              break;

            } // else {
            const insertPosition = overVe.moveOverRowNumber.get() + asTableItem(overVe.item).scrollYProp.get();
            activeItem.ordering = desktopStore.newChildOrderingAtPosition(moveOverContainerId, insertPosition);
            // }
          } else {
            activeItem.ordering = desktopStore.newOrderingAtEndOfChildren(moveOverContainerId);
          }

          activeItem.parentId = moveOverContainerId;

          const moveOverContainer = desktopStore.getContainerItem(moveOverContainerId)!;
          const moveOverContainerChildren = [activeItem.id, ...moveOverContainer.computed_children];
          moveOverContainerChildren.sort(
            (a, b) => compareOrderings(desktopStore.getItem(a)!.ordering, desktopStore.getItem(b)!.ordering));
          moveOverContainer.computed_children = moveOverContainerChildren;

          const prevParent = desktopStore.getContainerItem(prevParentId)!;
          prevParent.computed_children = prevParent.computed_children.filter(i => i != activeItem.id);

          arrange(desktopStore);
        }

        if (mouseActionState.startPosBl!.x * GRID_SIZE != activeItem.spatialPositionGr.x ||
            mouseActionState.startPosBl!.y * GRID_SIZE != activeItem.spatialPositionGr.y ||
            parentChanged) {
          server.updateItem(desktopStore.getItem(activeItem.id)!);
        }
      }

      break;

    case MouseAction.Resizing:
      if (mouseActionState.startWidthBl! * GRID_SIZE != asXSizableItem(activeItem).spatialWidthGr ||
          (isYSizableItem(activeItem) && mouseActionState.startHeightBl! * GRID_SIZE != asYSizableItem(activeItem).spatialHeightGr)) {
        server.updateItem(desktopStore.getItem(activeItem.id)!);
      }

      // mouseActionState.activeVisualElement.update(ve => {
      //   ve.resizingFromBoundsPx = null;
      // });
      break;

    case MouseAction.ColResizing:
      if (mouseActionState.startWidthBl! * GRID_SIZE != asTableItem(activeItem).tableColumns[mouseActionState.hitMeta].widthGr) {
        server.updateItem(desktopStore.getItem(activeItem.id)!);
      }
      break;

    case MouseAction.Ambiguous:
      if (mouseActionState.hitboxTypeOnMouseDown! & HitboxType.OpenPopup) {
        handlePopupClick(activeVisualElement, desktopStore, userStore);
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
