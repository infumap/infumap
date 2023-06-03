/*
  Copyright (C) 2022-2023 The Infumap Authors
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

import { GRID_SIZE, MOUSE_MOVE_AMBIGUOUS_PX } from "./constants";
import { HitboxType } from "./store/desktop/hitbox";
import { server } from "./server";
import { calcSizeForSpatialBl, handleClick, handlePopupClick } from "./store/desktop/items/base/item-polymorphism";
import { allowHalfBlockWidth, asXSizableItem } from "./store/desktop/items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "./store/desktop/items/base/y-sizeable-item";
import { asPageItem, calcPageInnerSpatialDimensionsBl, isPage } from "./store/desktop/items/page-item";
import { asTableItem, isTable } from "./store/desktop/items/table-item";
import { DesktopStoreContextModel, visualElementsWithId } from "./store/desktop/DesktopStoreProvider";
import { UserStoreContextModel } from "./store/UserStoreProvider";
import { vectorAdd, getBoundingBoxTopLeft, desktopPxFromMouseEvent, isInside, vectorSubtract, Vector, offsetBoundingBoxTopLeftBy, boundingBoxFromPosSize } from "./util/geometry";
import { assert, panic, throwExpression } from "./util/lang";
import { EMPTY_UID, Uid } from "./util/uid";
import { compareOrderings } from "./util/ordering";
import { VisualElement, VisualElementPathString, itemIdFromVisualElementPath, visualElementDesktopBoundsPx, visualElementSignalFromPathString, visualElementToPathString } from "./store/desktop/visual-element";
import { arrange, rearrangeVisualElement, switchToPage } from "./store/desktop/layout/arrange";
import { editDialogSizePx } from "./components/context/EditDialog";
import { VisualElementSignal } from "./util/signals";


const MOUSE_LEFT = 0;
const MOUSE_RIGHT = 2;

enum MouseAction {
  Ambiguous,
  Moving,
  Resizing,
}

interface HitInfo {
  hitboxType: HitboxType,
  visualElementSignal: VisualElementSignal
}


export function getHitInfo(
    desktopStore: DesktopStoreContextModel,
    posOnDesktopPx: Vector,
    ignore: Array<Uid>): HitInfo {

  const topLevelVisualElement: VisualElement = desktopStore.topLevelVisualElement();
  const topLevelPage = asPageItem(topLevelVisualElement!.item);
  const posRelativeToTopLevelVisualElementPx = vectorAdd(posOnDesktopPx, { x: topLevelPage.scrollXPx.get(), y: topLevelPage.scrollYPx.get() });

  // Root is either the top level page, or popup if mouse is over the popup.
  let rootVisualElement = topLevelVisualElement;
  let posRelativeToRootVisualElementPx = posRelativeToTopLevelVisualElementPx;
  let rootVisualElementSignal = { get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement };
  if (topLevelVisualElement.children.length > 0) {
    // The ve of the popup, if there is one, is always the last of the children.
    const popupVeMaybe = topLevelVisualElement.children[topLevelVisualElement.children.length-1].get();
    if (popupVeMaybe.isPopup &&
        isInside(posRelativeToTopLevelVisualElementPx, popupVeMaybe.boundsPx)) {
      rootVisualElementSignal = topLevelVisualElement.children[rootVisualElement.children.length-1];
      rootVisualElement = rootVisualElementSignal.get();
      posRelativeToRootVisualElementPx = vectorSubtract(
        posRelativeToTopLevelVisualElementPx,
        { x: rootVisualElement.boundsPx.x, y: rootVisualElement.boundsPx.y });
    }
  }

  for (let i=rootVisualElement.children.length-1; i>=0; --i) {
    const childVisualElementSignal = rootVisualElement.children[i];
    const childVisualElement = childVisualElementSignal.get();

    if (!isInside(posRelativeToRootVisualElementPx, childVisualElement.boundsPx)) {
      continue;
    }

    // handle inside table child area.
    if (isTable(childVisualElement.item) && isInside(posRelativeToRootVisualElementPx, childVisualElement.childAreaBoundsPx!)) {
      const tableVisualElementSignal = childVisualElementSignal;
      const tableVisualElement = childVisualElement;

      // resize hitbox of table takes precedence over everything in the child area.
      let resizeHitbox = tableVisualElement.hitboxes[tableVisualElement.hitboxes.length-1];
      if (resizeHitbox.type != HitboxType.Resize) { panic(); }
      if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(tableVisualElement.boundsPx!)))) {
        return ({ hitboxType: HitboxType.Resize, visualElementSignal: tableVisualElementSignal });
      }

      let tableItem = asTableItem(tableVisualElement.item);

      for (let j=0; j<tableVisualElement.children.length; ++j) {
        const tableChildVes = tableVisualElement.children[j];
        const tableChildVe = tableChildVes.get();
        const posRelativeToTableChildAreaPx = vectorSubtract(
          posRelativeToRootVisualElementPx,
          { x: tableVisualElement.childAreaBoundsPx!.x, y: tableVisualElement.childAreaBoundsPx!.y - tableItem.scrollYPx.get() }
        );
        if (isInside(posRelativeToTableChildAreaPx, tableChildVe.boundsPx)) {
          let hitboxType = HitboxType.None;
          for (let k=tableChildVe.hitboxes.length-1; k>=0; --k) {
            if (isInside(posRelativeToTableChildAreaPx, offsetBoundingBoxTopLeftBy(tableChildVe.hitboxes[k].boundsPx, getBoundingBoxTopLeft(tableChildVe.boundsPx)))) {
              hitboxType |= tableChildVe.hitboxes[k].type;
            }
          }
          if (!ignore.find(a => a == tableChildVe.item.id)) {
            return ({ hitboxType, visualElementSignal: tableChildVes });
          }
        }
      }
    }

    // handle inside any other item (including pages, which can't clicked in).
    let hitboxType = HitboxType.None;
    for (let j=childVisualElement.hitboxes.length-1; j>=0; --j) {
      if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(childVisualElement.hitboxes[j].boundsPx, getBoundingBoxTopLeft(childVisualElement.boundsPx)))) {
        hitboxType |= childVisualElement.hitboxes[j].type;
      }
    }
    if (!ignore.find(a => a == childVisualElement.item.id)) {
      return ({ hitboxType, visualElementSignal: rootVisualElement.children[i] });
    }
  }

  return { hitboxType: HitboxType.None, visualElementSignal: rootVisualElementSignal };
}

export interface FindVisualElementsResult {
  overContainerVe: VisualElement,
  overPositionableVe: VisualElement,
}

function findVisualElements(overVe: VisualElement): FindVisualElementsResult {
  if (overVe.isInsideTable) {
    assert(isTable(overVe.parent!.get().item), "visual element marked as inside table, is not in fact inside a table.");
    const parentTableVe = overVe.parent!.get();
    const tableParentPageVe = parentTableVe.parent!.get();
    assert(isPage(tableParentPageVe.item), "the parent of a table that has a visual element child, is not a page.");
    assert(tableParentPageVe.isDragOverPositioning, "page containing table does not drag in positioning.");
    return { overContainerVe: parentTableVe, overPositionableVe: tableParentPageVe};
  }

  if (isTable(overVe.item)) {
    assert(isPage(overVe.parent!.get().item), "the parent of a table visual element that is not inside a table is not a page.");
    assert(overVe.parent!.get().isDragOverPositioning, "page containing table does not allow drag in positioning.");
    return { overContainerVe: overVe, overPositionableVe: overVe.parent!.get() };
  }

  if (isPage(overVe.item) && overVe.isDragOverPositioning) {
    return { overContainerVe: overVe, overPositionableVe: overVe };
  }

  const overVeParent = overVe.parent!.get();
  assert(isPage(overVe.parent!.get().item), "parent of non-container item not in page is not a page.");
  assert(overVe.parent!.get().isDragOverPositioning, "parent of non-container does not allow drag in positioning.");
  if (isPage(overVe.item)) {
    return { overContainerVe: overVe, overPositionableVe: overVeParent };
  }
  return { overContainerVe: overVeParent, overPositionableVe: overVeParent };
}

interface MouseActionState {
  hitboxTypeOnMouseDown: HitboxType,
  activeElement: VisualElementPathString,
  moveOverContainerElement: VisualElementPathString | null,
  scaleDefiningElement: VisualElementPathString | null,
  startPx: Vector,
  startPosBl: Vector | null,
  clickOffsetProp: Vector | null,
  startWidthBl: number | null,
  startHeightBl: number | null,
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

  const hitInfo = getHitInfo(desktopStore, desktopPosPx, []);
  if (hitInfo.hitboxType == HitboxType.None) {
    if (hitInfo.visualElementSignal.get().isPopup) {
      switchToPage(desktopStore, hitInfo.visualElementSignal.get().item.id);
    }
    mouseActionState = null;
    return;
  }

  const ves = findVisualElements(
    getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [hitInfo.visualElementSignal.get().item.id]).visualElementSignal.get()
  );

  const startPosBl = null;
  const startWidthBl = null;
  const startHeightBl = null;
  const startPx = desktopPxFromMouseEvent(ev);
  const activeItem = desktopStore.getItem(hitInfo.visualElementSignal.get().item.id)!;
  let desktopBoundsPx = visualElementDesktopBoundsPx(hitInfo.visualElementSignal.get());
  const onePxSizeBl = {
    x: calcSizeForSpatialBl(activeItem, desktopStore.getItem).w / desktopBoundsPx.w,
    y: calcSizeForSpatialBl(activeItem, desktopStore.getItem).h / desktopBoundsPx.h
  };
  let clickOffsetProp = {
    x: (startPx.x - desktopBoundsPx.x) / desktopBoundsPx.w,
    y: (startPx.y - desktopBoundsPx.y) / desktopBoundsPx.h
  };
  mouseActionState = {
    activeElement: visualElementToPathString(hitInfo.visualElementSignal.get()),
    moveOverContainerElement: null,
    scaleDefiningElement: visualElementToPathString(ves.overPositionableVe),
    hitboxTypeOnMouseDown: hitInfo.hitboxType,
    action: MouseAction.Ambiguous,
    startPx,
    startPosBl,
    clickOffsetProp,
    startWidthBl,
    startHeightBl,
    onePxSizeBl,
  }
}


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
  }

  let parentId = desktopStore.getItem(desktopStore.topLevelPageId()!)!.parentId;
  let loopCount = 0;
  while (!isPage(desktopStore.getItem(parentId!)!)) {
    if (parentId == EMPTY_UID) {
      // At the root page.
      return;
    }
    parentId = desktopStore.getItem(parentId)!.parentId;
    if (loopCount++ > 10) { panic(); }
  }

  desktopStore.popTopLevelPageId();
  arrange(desktopStore);
}

export function mouseMoveNoButtonDownHandler(desktopStore: DesktopStoreContextModel) {
  const ev = desktopStore.lastMouseMoveEvent();
  let currentHitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), []);
  let overElementVes = currentHitInfo.visualElementSignal;
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
  } else {
    document.body.style.cursor = "default";
  }
}

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

  const activeItem = visualElementSignalFromPathString(desktopStore, mouseActionState.activeElement).get().item;

  if (mouseActionState.action == MouseAction.Ambiguous) {
    if (Math.abs(deltaPx.x) > MOUSE_MOVE_AMBIGUOUS_PX || Math.abs(deltaPx.y) > MOUSE_MOVE_AMBIGUOUS_PX) {
      if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Resize) > 0) {
        mouseActionState.startPosBl = null;
        mouseActionState.startWidthBl = asXSizableItem(activeItem).spatialWidthGr / GRID_SIZE;
        if (isYSizableItem(activeItem)) {
          mouseActionState.startHeightBl = asYSizableItem(activeItem).spatialHeightGr / GRID_SIZE;
        }
        mouseActionState.action = MouseAction.Resizing;
      } else if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Move) > 0) {
        if (isTable(desktopStore.getItem(activeItem.parentId)!)) {
          moveActiveItemOutOfTable(desktopStore);
        }
        mouseActionState.startWidthBl = null;
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

  const deltaBl = {
    x: deltaPx.x * mouseActionState.onePxSizeBl.x,
    y: deltaPx.y * mouseActionState.onePxSizeBl.y
  };

  // ### Resizing
  if (mouseActionState.action == MouseAction.Resizing) {

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

  // ### Moving
  } else if (mouseActionState.action == MouseAction.Moving) {

    const overVe = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [activeItem.id]).visualElementSignal.get();
    const ves = findVisualElements(overVe);

    if (mouseActionState.moveOverContainerElement == null ||
        mouseActionState.moveOverContainerElement! != visualElementToPathString(ves.overContainerVe)) {
      if (mouseActionState.moveOverContainerElement != null) {
        visualElementSignalFromPathString(desktopStore, mouseActionState.moveOverContainerElement).get().movingItemIsOver.set(false);
      }
      ves.overContainerVe.movingItemIsOver.set(true);
      mouseActionState.moveOverContainerElement = visualElementToPathString(ves.overContainerVe);
    }

    if (visualElementSignalFromPathString(desktopStore, mouseActionState.scaleDefiningElement!).get().item != ves.overPositionableVe.item) {
      moveActiveItemToDifferentPage(desktopStore, ves.overPositionableVe, desktopPxFromMouseEvent(ev));
    }

    let newPosBl = vectorAdd(mouseActionState.startPosBl!, deltaBl);
    newPosBl.x = Math.round(newPosBl.x * 2.0) / 2.0;
    newPosBl.y = Math.round(newPosBl.y * 2.0) / 2.0;
    if (newPosBl.x < 0.0) { newPosBl.x = 0.0; }
    if (newPosBl.y < 0.0) { newPosBl.y = 0.0; }
    activeItem.spatialPositionGr = { x: newPosBl.x * GRID_SIZE, y: newPosBl.y * GRID_SIZE };

    visualElementsWithId(desktopStore, itemIdFromVisualElementPath(mouseActionState.activeElement)).forEach(ve => {
      rearrangeVisualElement(desktopStore, ve);
    });
  }
}

export function handleMoveOverTable(_desktopStore: DesktopStoreContextModel) {
  console.log("over table. draw insertion point line.");
}

export function moveActiveItemToDifferentPage(desktopStore: DesktopStoreContextModel, moveToVe: VisualElement, desktopPx: Vector) {
  const activeVisualElement = visualElementSignalFromPathString(desktopStore, mouseActionState!.activeElement!).get();
  const activeItem = activeVisualElement.item;
  const currentPage = asPageItem(desktopStore.getItem(activeItem.parentId)!);
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
  const moveToVisualPathString = visualElementToPathString(moveToVe);
  activeItem.parentId = moveToVe.item.id;
  activeItem.ordering = desktopStore.newOrderingAtEndOfChildren(moveToVe.item.id);
  activeItem.spatialPositionGr = newItemPosGr;
  moveToPage.computed_children
    = [activeItem.id, ...moveToPage.computed_children];
  currentPage.computed_children
    = currentPage.computed_children.filter(childItem => childItem != activeItem.id);
  arrange(desktopStore);

  let done = false;
  let otherVes = [];
  visualElementsWithId(desktopStore, activeVisualElement.item.id).forEach(ve => {
    if (visualElementToPathString(ve.get().parent!.get()) == moveToVisualPathString) {
      mouseActionState!.activeElement = visualElementToPathString(ve.get());
      let boundsPx = visualElementSignalFromPathString(desktopStore, mouseActionState!.activeElement).get().boundsPx;
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

  done = false;
  otherVes = [];
  visualElementsWithId(desktopStore, moveToPage.id).forEach(ve => {
    if (visualElementToPathString(ve.get()) == moveToVisualPathString) {
      mouseActionState!.scaleDefiningElement = visualElementToPathString(ve.get());
      done = true;
    } else {
      otherVes.push(ve);
    }
  });
  if (!done) { panic(); }
}

export function moveActiveItemOutOfTable(desktopStore: DesktopStoreContextModel) {
  const activeVisualElement = visualElementSignalFromPathString(desktopStore, mouseActionState!.activeElement!).get();
  const activeItem = activeVisualElement.item;
  const tableItem = asTableItem(desktopStore.getItem(activeItem.parentId)!);
  let itemPosInTablePx = getBoundingBoxTopLeft(activeVisualElement.boundsPx);
  itemPosInTablePx.y -= tableItem.scrollYPx.get();
  const tableVe = activeVisualElement.parent!.get();
  const tableParentVe = tableVe.parent!.get();
  const tableParentVisualPathString = visualElementToPathString(tableVe.parent!.get());

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
    if (visualElementToPathString(ve.get().parent!.get()) == tableParentVisualPathString) {
      mouseActionState!.activeElement = visualElementToPathString(ve.get());
      let boundsPx = visualElementSignalFromPathString(desktopStore, mouseActionState!.activeElement).get().boundsPx;
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

export function mouseUpHandler(
    desktopStore: DesktopStoreContextModel,
    userStore: UserStoreContextModel) {

  dialogMoveState = null;

  if (mouseActionState == null) { return; }

  const activeVisualElement = visualElementSignalFromPathString(desktopStore, mouseActionState.activeElement).get();
  const activeItem = activeVisualElement.item;

  if (mouseActionState.moveOverContainerElement != null) {
    visualElementSignalFromPathString(desktopStore, mouseActionState.moveOverContainerElement).get().movingItemIsOver.set(false);
  }

  switch (mouseActionState.action) {
    case MouseAction.Moving:
      const overVe = visualElementSignalFromPathString(desktopStore, mouseActionState.moveOverContainerElement!).get();
      const moveOverContainerId = overVe.item.id;
      if (moveOverContainerId == activeItem.id) {
        throwExpression("Attempt was made to move an item into itself.");
      }

      const parentChanged = moveOverContainerId != activeItem.parentId;
      if (parentChanged) {
        const prevParentId = activeItem.parentId;

        activeItem.parentId = moveOverContainerId;
        activeItem.ordering = desktopStore.newOrderingAtEndOfChildren(moveOverContainerId);
        activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };

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

    case MouseAction.Ambiguous:
      if (mouseActionState.hitboxTypeOnMouseDown! & HitboxType.OpenPopup) {
        handlePopupClick(activeVisualElement, desktopStore, userStore);
      }
      else if (mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Click) {
        handleClick(activeVisualElement, desktopStore, userStore);
      }
      break;

    default:
      panic();
  }

  mouseActionState = null;
}
