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
import { DesktopStoreContextModel } from "./store/desktop/DesktopStoreProvider";
import { GeneralStoreContextModel } from "./store/GeneralStoreProvider";
import { UserStoreContextModel } from "./store/UserStoreProvider";
import { add, getBoundingBoxTopLeft, desktopPxFromMouseEvent, isInside, subtract, Vector, offsetBoundingBoxTopLeftBy, boundingBoxFromPosSize } from "./util/geometry";
import { panic } from "./util/lang";
import { EMPTY_UID, Uid } from "./util/uid";
import { batch } from "solid-js";
import { compareOrderings } from "./util/ordering";
import { VisualElement_Concrete, findNearestContainerVe } from "./store/desktop/visual-element";
import { switchToPage } from "./store/desktop/layout/arrange";
import { asContainerItem } from "./store/desktop/items/base/container-item";
import { HTMLDivElementWithData } from "./util/html";
import { editDialogSizePx } from "./components/context/EditDialog";


const MOUSE_LEFT = 0;
const MOUSE_RIGHT = 2;

enum MouseAction {
  Ambiguous,
  Moving,
  Resizing,
}

interface HitInfo {
  hitboxType: HitboxType,
  visualElement: VisualElement_Concrete
}

export function rootVisualElement(): VisualElement_Concrete | null {
  const desktopEl = document.getElementById("desktop")!;
  if (desktopEl == null) { return null; }
  if (desktopEl.children.length == 0) { return null; }
  const topPage = desktopEl.children[0]!;
  return (topPage as HTMLDivElementWithData).data as VisualElement_Concrete;
}

function topLevelVisualElements(): Array<VisualElement_Concrete> {
  const desktopEl = document.getElementById("desktop")!;
  const topPage = desktopEl.children[0]!;
  return Array.from(topPage.children)
    .filter(c => (c as HTMLDivElementWithData).data != null)
    .map(c => (c as HTMLDivElementWithData).data as VisualElement_Concrete);
}

function childVisualElementsOfTable(id: Uid): Array<VisualElement_Concrete> {
  const tableChildAreaEl = document.getElementById(id)!;
  const innerScrollEl = tableChildAreaEl.children[0]!;
  return Array.from(innerScrollEl.children)
    .filter(c => (c as HTMLDivElementWithData).data != null)
    .map(c => (c as HTMLDivElementWithData).data as VisualElement_Concrete);
}

function _childVisualElementsOfPage(id: Uid): Array<VisualElement_Concrete> {
  const pageChildAreaEl = document.getElementById(id)!;
  return Array.from(pageChildAreaEl.children)
    .filter(c => (c as HTMLDivElementWithData).data != null)
    .map(c => (c as HTMLDivElementWithData).data as VisualElement_Concrete);
}

export function getHitInfo(
    desktopStore: DesktopStoreContextModel,
    posOnDesktopPx: Vector,
    ignore: Array<Uid>): HitInfo {

  const rootVe = rootVisualElement();
  const topLevelPage = asPageItem(desktopStore.getItem(rootVe!.itemId)!);

  const posReltiveToTopLevelVisualElementPx = add(posOnDesktopPx, { x: topLevelPage.scrollXPx.get(), y: topLevelPage.scrollYPx.get() });

  const topLevelVes = topLevelVisualElements();
  for (let i=0; i<topLevelVes.length; ++i) {
    const childVe = topLevelVes[i];
    if (!isInside(posReltiveToTopLevelVisualElementPx, childVe.boundsPx)) {
      continue;
    }

    // handle inside table child area.
    if (isTable(childVe) && isInside(posReltiveToTopLevelVisualElementPx, childVe.childAreaBoundsPx!)) {
      const tableVe = childVe;

      // resize hitbox of table takes precedence over everything in the child area.
      let resizeHitbox = tableVe.hitboxes[tableVe.hitboxes.length-1];
      if (resizeHitbox.type != HitboxType.Resize) { panic(); }
      if (isInside(posReltiveToTopLevelVisualElementPx, offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(tableVe.boundsPx!)))) {
        return ({ hitboxType: HitboxType.Resize, visualElement: tableVe });
      }

      let tableItem = asTableItem(desktopStore.getItem(tableVe.itemId)!);
      let tableChildVes = childVisualElementsOfTable(tableItem.id);

      for (let j=0; j<tableChildVes.length; ++j) {
        const tableChildVe = tableChildVes[j];
        const posRelativeToTableChildAreaPx = subtract(
          posReltiveToTopLevelVisualElementPx,
          { x: tableVe.childAreaBoundsPx!.x, y: tableVe.childAreaBoundsPx!.y - tableItem.scrollYPx.get() }
        );
        if (isInside(posRelativeToTableChildAreaPx, tableChildVe.boundsPx)) {
          let hitboxType = HitboxType.None;
          for (let k=tableChildVe.hitboxes.length-1; k>=0; --k) {
            if (isInside(posRelativeToTableChildAreaPx, offsetBoundingBoxTopLeftBy(tableChildVe.hitboxes[k].boundsPx, getBoundingBoxTopLeft(tableChildVe.boundsPx)))) {
              hitboxType |= tableChildVe.hitboxes[k].type;
            }
          }
          if (!ignore.find(a => a == tableChildVe.itemId)) {
            return ({ hitboxType, visualElement: tableChildVes[j] });
          }
        }
      }
    }

    // handle inside any other item (including pages, which can't clicked in).
    let hitboxType = HitboxType.None;
    for (let j=childVe.hitboxes.length-1; j>=0; --j) {
      if (isInside(posReltiveToTopLevelVisualElementPx, offsetBoundingBoxTopLeftBy(childVe.hitboxes[j].boundsPx, getBoundingBoxTopLeft(childVe.boundsPx)))) {
        hitboxType |= childVe.hitboxes[j].type;
      }
    }
    if (!ignore.find(a => a == childVe.itemId)) {
      return ({ hitboxType, visualElement: topLevelVes[i] });
    }
  }

  // didn't intersect any top level visual element.
  return { hitboxType: HitboxType.None, visualElement: rootVe! };
}


interface MouseActionState {
  hitboxTypeOnMouseDown: HitboxType,
  activeVisualElement: VisualElement_Concrete,
  moveOverContainerVisualElement: VisualElement_Concrete | null,
  startPx: Vector,
  startPosBl: Vector | null,
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

let lastMouseOverId: Uid | null = null;


export function mouseDownHandler(
    desktopStore: DesktopStoreContextModel,
    generalStore: GeneralStoreContextModel,
    ev: MouseEvent) {
  if (desktopStore.currentPageId() == null) { return; }
  if (ev.button == MOUSE_LEFT) {
    mouseLeftDownHandler(desktopStore, generalStore, ev);
  } else if (ev.button == MOUSE_RIGHT) {
    mouseRightDownHandler(desktopStore, generalStore);
  } else {
    console.log("unrecognized mouse button: " + ev.button);
  }
}


export function mouseLeftDownHandler(
    desktopStore: DesktopStoreContextModel,
    generalStore: GeneralStoreContextModel,
    ev: MouseEvent) {

  const desktopPosPx = desktopPxFromMouseEvent(ev);

  if (generalStore.contextMenuInfo() != null) {
    generalStore.setContextMenuInfo(null); return;
  }

  let dialogInfo = generalStore.editDialogInfo();
  if (dialogInfo != null) {
    if (isInside(desktopPosPx, dialogInfo!.desktopBoundsPx)) {
      dialogMoveState = { lastMousePosPx: desktopPosPx };
      return;
    }

    generalStore.setEditDialogInfo(null); return;
  }

  const hitInfo = getHitInfo(desktopStore, desktopPosPx, []);
  if (hitInfo.hitboxType == HitboxType.None) {
    mouseActionState = null;
    return;
  }

  const startPosBl = null;
  const startWidthBl = null;
  const startHeightBl = null;
  const startPx = desktopPxFromMouseEvent(ev);
  const activeItem = desktopStore.getItem(hitInfo.visualElement.itemId)!;
  const onePxSizeBl = {
    x: calcSizeForSpatialBl(activeItem, desktopStore.getItem).w / hitInfo.visualElement.boundsPx.w,
    y: calcSizeForSpatialBl(activeItem, desktopStore.getItem).h / hitInfo.visualElement.boundsPx.h
  };
  mouseActionState = {
    activeVisualElement: hitInfo.visualElement,
    moveOverContainerVisualElement: null,
    hitboxTypeOnMouseDown: hitInfo.hitboxType,
    action: MouseAction.Ambiguous,
    startPx,
    startPosBl,
    startWidthBl,
    startHeightBl,
    onePxSizeBl,
  }
}


export function mouseRightDownHandler(
    desktopStore: DesktopStoreContextModel,
    generalStore: GeneralStoreContextModel) {

  if (generalStore.contextMenuInfo()) {
    generalStore.setContextMenuInfo(null); return;
  }

  if (generalStore.editDialogInfo() != null) {
    generalStore.setEditDialogInfo(null); return;
  }

  let parentId = desktopStore.getItem(desktopStore.currentPageId()!)!.parentId;
  let loopCount = 0;
  while (!isPage(desktopStore.getItem(parentId!)!)) {
    if (parentId == EMPTY_UID) {
      // At the root page.
      return;
    }
    parentId = desktopStore.getItem(parentId)!.parentId;
    if (loopCount++ > 10) { panic(); }
  }
  switchToPage(desktopStore, parentId);
}


export function mouseMoveHandler(
    desktopStore: DesktopStoreContextModel,
    generalStore: GeneralStoreContextModel,
    ev: MouseEvent) {
  if (desktopStore.currentPageId() == null) { return; }

  // It is necessary to handle dialog moving at the global level, because sometimes the mouse position may
  // get outside the dialog area when being moved quickly.
  if (dialogMoveState != null) {
    let currentMousePosPx = desktopPxFromMouseEvent(ev);
    let changePx = subtract(currentMousePosPx, dialogMoveState.lastMousePosPx!);
    generalStore.setEditDialogInfo(({
      item: generalStore.editDialogInfo()!.item,
      desktopBoundsPx: boundingBoxFromPosSize(add(getBoundingBoxTopLeft(generalStore.editDialogInfo()!.desktopBoundsPx), changePx), { ...editDialogSizePx })
    }));
    dialogMoveState.lastMousePosPx = currentMousePosPx;
    return;
  }

  if (mouseActionState == null) {
    let currentHitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), []);
    let overItem = desktopStore.getItem(currentHitInfo.visualElement!.itemId)!;
    if (overItem.id != lastMouseOverId) {
      batch(() => {
        if (lastMouseOverId != null) {
          desktopStore.getItem(lastMouseOverId)!.computed_mouseIsOver.set(false);
        }
        lastMouseOverId = null;
        if (overItem.id != desktopStore.currentPageId()) {
          desktopStore.getItem(overItem.id)!.computed_mouseIsOver.set(true);
          lastMouseOverId = overItem.id;
        }
      });
    }
    if ((currentHitInfo.hitboxType & HitboxType.Resize) > 0) {
      document.body.style.cursor = "nwse-resize";
    } else {
      document.body.style.cursor = "default";
    }
    return;
  }

  const deltaPx = subtract(desktopPxFromMouseEvent(ev), mouseActionState.startPx!);

  const activeItem = desktopStore.getItem(mouseActionState.activeVisualElement!.itemId)!;

  if (mouseActionState.action == MouseAction.Ambiguous) {
    if (Math.abs(deltaPx.x) > MOUSE_MOVE_AMBIGUOUS_PX || Math.abs(deltaPx.y) > MOUSE_MOVE_AMBIGUOUS_PX) {
      if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Resize) > 0) {
        mouseActionState.startPosBl = null;
        mouseActionState.startWidthBl = asXSizableItem(activeItem).spatialWidthGr.get() / GRID_SIZE;
        if (isYSizableItem(activeItem)) {
          mouseActionState.startHeightBl = asYSizableItem(activeItem).spatialHeightGr.get() / GRID_SIZE;
        }
        mouseActionState.action = MouseAction.Resizing;
      } else if ((mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Move) > 0) {
        if (isTable(desktopStore.getItem(activeItem.parentId)!)) {
          moveActiveItemOutOfTable(desktopStore);
        }
        mouseActionState.startWidthBl = null;
        mouseActionState.startPosBl = {
          x: activeItem.spatialPositionGr.get().x / GRID_SIZE,
          y: activeItem.spatialPositionGr.get().y / GRID_SIZE
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
    batch(() => {
      let newWidthBl = mouseActionState!.startWidthBl! + deltaBl.x;
      newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
      if (newWidthBl < 1) { newWidthBl = 1.0; }

      asXSizableItem(activeItem).spatialWidthGr.set(newWidthBl * GRID_SIZE);

      if (isYSizableItem(activeItem)) {
        let newHeightBl = mouseActionState!.startHeightBl! + deltaBl.y;
        newHeightBl = Math.round(newHeightBl);
        if (newHeightBl < 1) { newHeightBl = 1.0; }
        asYSizableItem(activeItem).spatialHeightGr.set(newHeightBl * GRID_SIZE);
      }
    });

  // ### Moving
  } else if (mouseActionState.action == MouseAction.Moving) {
    const overHitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [activeItem.id]);
    const overVes = overHitInfo.visualElement;
    const overContainerVe = findNearestContainerVe(overVes);

    if (mouseActionState.moveOverContainerVisualElement == null ||
        mouseActionState.moveOverContainerVisualElement! != overContainerVe) {
      if (mouseActionState.moveOverContainerVisualElement != null) {
        asContainerItem(desktopStore.getItem(mouseActionState.moveOverContainerVisualElement!.itemId)!)
          .computed_movingItemIsOver.set(false);
      }
      asContainerItem(desktopStore.getItem(overContainerVe.itemId)!).computed_movingItemIsOver.set(true);
      mouseActionState.moveOverContainerVisualElement = overContainerVe;
      if (isTable(overContainerVe)) {
        console.log("over table");
        // TODO (HIGH): update table item here with mouse over position.
      }
    }

    let newPosBl = add(mouseActionState.startPosBl!, deltaBl);
    newPosBl.x = Math.round(newPosBl.x * 2.0) / 2.0;
    newPosBl.y = Math.round(newPosBl.y * 2.0) / 2.0;
    if (newPosBl.x < 0.0) { newPosBl.x = 0.0; }
    if (newPosBl.y < 0.0) { newPosBl.y = 0.0; }
    activeItem.spatialPositionGr.set({ x: newPosBl.x * GRID_SIZE, y: newPosBl.y * GRID_SIZE });
  }
}

export function moveActiveItemOutOfTable(desktopStore: DesktopStoreContextModel) {
  const activeItem = desktopStore.getItem(mouseActionState!.activeVisualElement!.itemId)!;
  const tableItem = asTableItem(desktopStore.getItem(activeItem.parentId)!);
  let itemPosInTablePx = getBoundingBoxTopLeft(mouseActionState!.activeVisualElement!.boundsPx);
  itemPosInTablePx.y -= tableItem.scrollYPx.get();
  const tableVeId = mouseActionState!.activeVisualElement!.parentId!;
  // TODO (MEDIUM): won't work in the (anticipated) general case.
  const tableVe = topLevelVisualElements().find(el => el.itemId == tableVeId)!;
    // TODO (MEDIUM): won't work in the (anticipated) general case.
  const tableParentVe = rootVisualElement();
  const tablePosInPagePx = getBoundingBoxTopLeft(tableVe.childAreaBoundsPx!);
  const itemPosInPagePx = add(tablePosInPagePx, itemPosInTablePx);
  const tableParentPage = asPageItem(desktopStore.getItem(tableItem.parentId)!);
  const itemPosInPageGr = {
    x: itemPosInPagePx.x / tableParentVe!.boundsPx.w * tableParentPage.innerSpatialWidthGr.get(),
    y: itemPosInPagePx.y / tableParentVe!.boundsPx.h * calcPageInnerSpatialDimensionsBl(tableParentPage).h * GRID_SIZE
  };
  const itemPosInPageQuantizedGr = {
    x: Math.round(itemPosInPageGr.x / (GRID_SIZE / 2.0)) / 2.0 * GRID_SIZE,
    y: Math.round(itemPosInPageGr.y / (GRID_SIZE / 2.0)) / 2.0 * GRID_SIZE
  };
  batch(() => {
    tableParentPage.computed_children
      .set([activeItem.id, ...tableParentPage.computed_children.get()]);
    tableItem.computed_children
      .set(tableItem.computed_children.get().filter(childItem => childItem != activeItem.id));
    desktopStore.updateItem(activeItem.id, item => {
      item.parentId = tableParentPage.id;
      item.ordering = desktopStore.newOrderingAtEndOfChildren(tableParentPage.id);
    });
    activeItem.spatialPositionGr.set(itemPosInPageQuantizedGr);
  });
  // TODO (MEDIUM): won't work in (anticipated) general case.
  mouseActionState!.activeVisualElement = topLevelVisualElements().find(el => el.itemId == activeItem.id)!;
  mouseActionState!.onePxSizeBl = {
    x: calcSizeForSpatialBl(activeItem, desktopStore.getItem).w / mouseActionState!.activeVisualElement.boundsPx.w,
    y: calcSizeForSpatialBl(activeItem, desktopStore.getItem).h / mouseActionState!.activeVisualElement.boundsPx.h
  };
}

export function mouseUpHandler(
    userStore: UserStoreContextModel,
    desktopStore: DesktopStoreContextModel) {

  dialogMoveState = null;

  if (mouseActionState == null) { return; }

  const activeItem = desktopStore.getItem(mouseActionState.activeVisualElement!.itemId)!;

  if (mouseActionState.moveOverContainerVisualElement != null) {
    asContainerItem(desktopStore.getItem(mouseActionState.moveOverContainerVisualElement!.itemId)!)
      .computed_movingItemIsOver.set(false);
  }

  switch (mouseActionState.action) {
    case MouseAction.Moving:
      const overVes = mouseActionState.moveOverContainerVisualElement!;
      const moveOverContainerId = overVes.itemId;
      if (moveOverContainerId == activeItem.id) {
        // TODO (MEDIUM): This case did occur. Figure out how/why.
        throw new Error("Attempt was made to move an item into itself.");
      }
      const parentChanged = moveOverContainerId != activeItem.parentId;
      if (parentChanged) {
        const prevParentId = activeItem.parentId;
        batch(() => {
          desktopStore.updateItem(activeItem.id, item => {
            item.parentId = moveOverContainerId;
            item.ordering = desktopStore.newOrderingAtEndOfChildren(moveOverContainerId);
          });
          activeItem.spatialPositionGr.set({ x: 0.0, y: 0.0 });

          const moveOverContainer = desktopStore.getContainerItem(moveOverContainerId)!;
          const moveOverContainerChildren = [activeItem.id, ...moveOverContainer.computed_children.get()];
          moveOverContainerChildren.sort(
            (a, b) => compareOrderings(desktopStore.getItem(a)!.ordering, desktopStore.getItem(b)!.ordering));
          moveOverContainer.computed_children.set(moveOverContainerChildren);

          const prevParent = desktopStore.getContainerItem(prevParentId)!;
          prevParent.computed_children.set(prevParent.computed_children.get().filter(i => i != activeItem.id));
        });
      }
      if (mouseActionState.startPosBl!.x * GRID_SIZE != activeItem.spatialPositionGr.get().x ||
          mouseActionState.startPosBl!.y * GRID_SIZE != activeItem.spatialPositionGr.get().y ||
          parentChanged) {
        server.updateItem(desktopStore.getItem(activeItem.id)!);
      }
      break;

    case MouseAction.Resizing:
      if (mouseActionState.startWidthBl! * GRID_SIZE != asXSizableItem(activeItem).spatialWidthGr.get() ||
          (isYSizableItem(activeItem) && mouseActionState.startHeightBl! * GRID_SIZE != asYSizableItem(activeItem).spatialHeightGr.get())) {
        server.updateItem(desktopStore.getItem(activeItem.id)!);
      }

      // mouseActionState.activeVisualElement.update(ve => {
      //   ve.resizingFromBoundsPx = null;
      // });
      break;

    case MouseAction.Ambiguous:
      if (mouseActionState.hitboxTypeOnMouseDown! & HitboxType.OpenPopup) {
        handlePopupClick(activeItem, desktopStore, userStore);
      }
      else if (mouseActionState.hitboxTypeOnMouseDown! & HitboxType.Click) {
        handleClick(activeItem, desktopStore, userStore);
      }
      break;

    default:
      panic();
  }

  mouseActionState = null;
}
