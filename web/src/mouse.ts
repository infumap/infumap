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
import { add, getTopLeft, desktopPxFromMouseEvent, isInside, subtract, Vector, offsetTopLeftBy } from "./util/geometry";
import { panic } from "./util/lang";
import { EMPTY_UID, Uid } from "./util/uid";
import { batch } from "solid-js";
import { compareOrderings } from "./util/ordering";
import { findNearestContainerVe } from "./store/desktop/visual-element";
import { switchToPage } from "./store/desktop/layout/arrange";
import { asContainerItem } from "./store/desktop/items/base/container-item";
import { ShadowDomElement } from "./store/desktop/shadow-dom";


const MOUSE_LEFT = 0;
const MOUSE_RIGHT = 2;

enum MouseAction {
  Ambiguous,
  Moving,
  Resizing,
}

interface HitInfo {
  hitboxType: HitboxType,
  visualElement: ShadowDomElement
}

export function rootElement() {
  const desktopEl = document.getElementById("desktop")!;
  const topPage = desktopEl.children[0]!;
  const topShadowEl = (topPage as any).data as ShadowDomElement;
  return topShadowEl
}

export function topLevelElements() {
  const desktopEl = document.getElementById("desktop")!;
  const topPage = desktopEl.children[0]!;
  const topPageChildren = Array.from(topPage.children).filter((c: any) => c.data != null).map((c:any) => c.data as ShadowDomElement);
  return topPageChildren;
}

export function elementsOfTable(id: Uid) {
  const tableChildAreaEl = document.getElementById(id)!;
  const innerScrollEl = tableChildAreaEl.children[0]!;
  const tableChildren = Array.from(innerScrollEl.children).filter((c: any) => c.data != null).map((c: any) => c.data as ShadowDomElement);
  return tableChildren;
}

export function getHitInfo(
  desktopStore: DesktopStoreContextModel,
  posOnDesktopPx: Vector,
  ignore: Array<Uid>): HitInfo {

const topShadowEl = rootElement();
const topPageChildren = topLevelElements();

const topLevelPage = asPageItem(desktopStore.getItem(topShadowEl.itemId)!);
const posReltiveToTopLevelVisualElementPx = add(posOnDesktopPx, { x: topLevelPage.scrollXPx.get(), y: topLevelPage.scrollYPx.get() });

for (let i=0; i<topPageChildren.length; ++i) {
  const child = topPageChildren[i] as ShadowDomElement;
  if (isInside(posReltiveToTopLevelVisualElementPx, child.boundsPx)) {
    if (isTable(child) && isInside(posReltiveToTopLevelVisualElementPx, child.childAreaBoundsPx!)) {
      // resize hitbox of table takes precedence over everything in the child area.
      let resizeHitbox = child.hitboxes[child.hitboxes.length-1];
      if (resizeHitbox.type != HitboxType.Resize) { panic(); }
      if (isInside(posReltiveToTopLevelVisualElementPx, offsetTopLeftBy(resizeHitbox.boundsPx, getTopLeft(child.boundsPx!)))) {
        return ({
          hitboxType: HitboxType.Resize,
          visualElement: topPageChildren[i],
        });
      }

      let tableItem = asTableItem(desktopStore.getItem(child.itemId)!);
      let tableChildren = elementsOfTable(tableItem.id);

      for (let j=0; j<tableChildren.length; ++j) {
        const tableChild = tableChildren[j];
        const posRelativeToTableChildAreaPx = subtract(
          posReltiveToTopLevelVisualElementPx,
          { x: child.childAreaBoundsPx!.x, y: child.childAreaBoundsPx!.y - tableItem.scrollYPx.get() }
        );
        if (isInside(posRelativeToTableChildAreaPx, tableChild.boundsPx)) {
          let hitboxType = HitboxType.None;
          for (let k=tableChild.hitboxes.length-1; k>=0; --k) {
            if (isInside(posRelativeToTableChildAreaPx, offsetTopLeftBy(tableChild.hitboxes[k].boundsPx, getTopLeft(tableChild.boundsPx)))) {
              hitboxType |= tableChild.hitboxes[k].type;
            }
          }
          if (!ignore.find(a => a == tableChild.itemId)) {
            return ({
              hitboxType,
              visualElement: tableChildren[j]
            });
          }
        }
      }
    } else {
      let hitboxType = HitboxType.None;
      for (let j=child.hitboxes.length-1; j>=0; --j) {
        if (isInside(posReltiveToTopLevelVisualElementPx, offsetTopLeftBy(child.hitboxes[j].boundsPx, getTopLeft(child.boundsPx)))) {
          hitboxType |= child.hitboxes[j].type;
        }
      }
      if (!ignore.find(a => a == child.itemId)) {
        return ({
          hitboxType,
          visualElement: topPageChildren[i],
        });
      }
    }
  }
}

return {
  hitboxType: HitboxType.None,
  visualElement: topShadowEl,
};
}


interface MouseActionState {
  hitboxTypeOnMouseDown: HitboxType,
  activeVisualElement: ShadowDomElement,
  moveOverContainerVisualElement: ShadowDomElement | null,
  startPx: Vector,
  startPosBl: Vector | null,
  startWidthBl: number | null,
  startHeightBl: number | null,
  action: MouseAction,
  onePxSizeBl: Vector,
}

let mouseActionState: MouseActionState | null = null;
let lastMouseOverId: Uid | null = null;


export function mouseDownHandler(
    desktopStore: DesktopStoreContextModel,
    generalStore: GeneralStoreContextModel,
    userStore: UserStoreContextModel,
    ev: MouseEvent) {

  if (desktopStore.currentPageId() == null) { return; }

  if (ev.button == MOUSE_LEFT) {
    mouseLeftDownHandler(desktopStore, generalStore, ev);
  } else if (ev.button == MOUSE_RIGHT) {
    mouseRightDownHandler(desktopStore, generalStore, userStore);
  } else {
    console.log("unrecognized mouse button: " + ev.button);
  }
}


export function mouseLeftDownHandler(
    desktopStore: DesktopStoreContextModel,
    generalStore: GeneralStoreContextModel,
    ev: MouseEvent) {

  if (generalStore.contextMenuInfo() != null) { generalStore.setContextMenuInfo(null); return; }
  if (generalStore.editDialogInfo() != null) { generalStore.setEditDialogInfo(null); return; }

  let hitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), []);
  if (hitInfo.hitboxType == HitboxType.None) {
    mouseActionState = null;
    return;
  }
  let startPosBl = null;
  let startWidthBl = null;
  let startHeightBl = null;
  let startPx = desktopPxFromMouseEvent(ev);

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
    generalStore: GeneralStoreContextModel,
    userStore: UserStoreContextModel) {

  if (generalStore.contextMenuInfo()) { generalStore.setContextMenuInfo(null); return; }
  if (generalStore.editDialogInfo() != null) { generalStore.setEditDialogInfo(null); return; }

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
  switchToPage(desktopStore, parentId, userStore.getUser());
}


export function mouseMoveHandler(
    desktopStore: DesktopStoreContextModel,
    ev: MouseEvent) {

  if (desktopStore.currentPageId() == null) { return; }

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

      desktopStore.updateItem(activeItem.id, item => {
        asXSizableItem(item).spatialWidthGr = newWidthBl * GRID_SIZE;
      });

      if (isYSizableItem(activeItem)) {
        let newHeightBl = mouseActionState!.startHeightBl! + deltaBl.y;
        newHeightBl = Math.round(newHeightBl);
        if (newHeightBl < 1) { newHeightBl = 1.0; }
        desktopStore.updateItem(activeItem.id, item => {
          asYSizableItem(item).spatialHeightGr = newHeightBl * GRID_SIZE;
        });
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

function findVisualElement(id: Uid): ShadowDomElement | null {
  let r = topLevelElements().find(el => el.itemId == id);
  return r ? r : null;
}

export function moveActiveItemOutOfTable(desktopStore: DesktopStoreContextModel) {
  const activeItemId = mouseActionState!.activeVisualElement!.itemId;
  const activeItem = desktopStore.getItem(mouseActionState!.activeVisualElement!.itemId)!;
  const tableItem = asTableItem(desktopStore.getItem(activeItem.parentId)!);
  let itemPosInTablePx = getTopLeft(mouseActionState!.activeVisualElement!.boundsPx);
  itemPosInTablePx.y -= tableItem.scrollYPx.get();
  const tableVeId = mouseActionState!.activeVisualElement!.parentId!;
  const tableVe = topLevelElements().find(el => el.itemId == tableVeId)!;
  const tableParentVe = rootElement();
  const tablePosInPagePx = getTopLeft(tableVe.childAreaBoundsPx!);
  const itemPosInPagePx = add(tablePosInPagePx, itemPosInTablePx);
  const tableParentPage = asPageItem(desktopStore.getItem(tableItem.parentId)!);
  const itemPosInPageGr = {
    x: itemPosInPagePx.x / tableParentVe.boundsPx.w * tableParentPage.innerSpatialWidthGr,
    y: itemPosInPagePx.y / tableParentVe.boundsPx.h * calcPageInnerSpatialDimensionsBl(tableParentPage).h * GRID_SIZE
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
  mouseActionState!.activeVisualElement = findVisualElement(activeItemId)!;
}

export function mouseUpHandler(
    userStore: UserStoreContextModel,
    desktopStore: DesktopStoreContextModel) {

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
