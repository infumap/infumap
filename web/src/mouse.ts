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
import { VisualElement } from "./store/desktop/visual-element";
import { arrange, rearrangeVisualElement, switchToPage } from "./store/desktop/layout/arrange";
import { isContainer } from "./store/desktop/items/base/container-item";
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
  const posRelativeToTopLevelVisualElementPx = add(posOnDesktopPx, { x: topLevelPage.scrollXPx.get(), y: topLevelPage.scrollYPx.get() });

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
      posRelativeToRootVisualElementPx = subtract(
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
        const posRelativeToTableChildAreaPx = subtract(
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


interface MouseActionState {
  hitboxTypeOnMouseDown: HitboxType,
  activeVisualElementSignal: VisualElementSignal,
  moveOverContainerVisualElement: VisualElement | null,
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

let lastMouseOver: VisualElementSignal | null = null;


export function mouseDownHandler(
    desktopStore: DesktopStoreContextModel,
    generalStore: GeneralStoreContextModel,
    ev: MouseEvent) {
  if (desktopStore.topLevelPageId() == null) { return; }
  if (ev.button == MOUSE_LEFT) {
    mouseLeftDownHandler(desktopStore, generalStore, ev);
  } else if (ev.button == MOUSE_RIGHT) {
    mouseRightDownHandler(desktopStore, generalStore, ev);
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
    if (hitInfo.visualElementSignal.get().isPopup) {
      switchToPage(desktopStore, hitInfo.visualElementSignal.get().item.id);
    }
    mouseActionState = null;
    return;
  }

  const startPosBl = null;
  const startWidthBl = null;
  const startHeightBl = null;
  const startPx = desktopPxFromMouseEvent(ev);
  const activeItem = desktopStore.getItem(hitInfo.visualElementSignal.get().item.id)!;
  const onePxSizeBl = {
    x: calcSizeForSpatialBl(activeItem, desktopStore.getItem).w / hitInfo.visualElementSignal.get().boundsPx.w,
    y: calcSizeForSpatialBl(activeItem, desktopStore.getItem).h / hitInfo.visualElementSignal.get().boundsPx.h
  };
  mouseActionState = {
    activeVisualElementSignal: hitInfo.visualElementSignal,
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
    ev: MouseEvent) {

  if (generalStore.contextMenuInfo()) {
    generalStore.setContextMenuInfo(null);
    return;
  }

  if (generalStore.editDialogInfo() != null) {
    generalStore.setEditDialogInfo(null);
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


export function mouseMoveHandler(
    desktopStore: DesktopStoreContextModel,
    generalStore: GeneralStoreContextModel,
    ev: MouseEvent) {
  if (desktopStore.topLevelPageId() == null) { return; }

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
    let overElement = currentHitInfo.visualElementSignal;
    if (overElement != lastMouseOver) {
      batch(() => {
        if (lastMouseOver != null) {
          lastMouseOver.get().computed_mouseIsOver.set(false);
        }
        lastMouseOver = null;
        if (overElement!.get().item.id != desktopStore.topLevelPageId() &&
            !overElement.get().isPopup) {
          overElement!.get().computed_mouseIsOver.set(true);
          lastMouseOver = overElement;
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

  const activeItem = mouseActionState.activeVisualElementSignal!.get().item;

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

    rearrangeVisualElement(desktopStore, mouseActionState.activeVisualElementSignal);

  // ### Moving
  } else if (mouseActionState.action == MouseAction.Moving) {
    const overHitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [activeItem.id]);
    const overVes = overHitInfo.visualElementSignal.get();
    const overContainerVe = isContainer(overVes.item)
      ? overVes
      : (() => {
        if (overVes.parent == null) { panic(); }
        const result = overVes.parent.get();
        if (!isContainer(result.item)) { panic(); }
        return result;
      })();

    if (mouseActionState.moveOverContainerVisualElement == null ||
        mouseActionState.moveOverContainerVisualElement! != overContainerVe) {
      if (mouseActionState.moveOverContainerVisualElement != null) {
        mouseActionState.moveOverContainerVisualElement.computed_movingItemIsOver.set(false);
      }
      overContainerVe.computed_movingItemIsOver.set(true);
      mouseActionState.moveOverContainerVisualElement = overContainerVe;
      if (isTable(overContainerVe.item)) {
        console.log("over table");
        // TODO (HIGH): update table item here with mouse over position.
      }
    }

    let newPosBl = add(mouseActionState.startPosBl!, deltaBl);
    newPosBl.x = Math.round(newPosBl.x * 2.0) / 2.0;
    newPosBl.y = Math.round(newPosBl.y * 2.0) / 2.0;
    if (newPosBl.x < 0.0) { newPosBl.x = 0.0; }
    if (newPosBl.y < 0.0) { newPosBl.y = 0.0; }
    activeItem.spatialPositionGr = { x: newPosBl.x * GRID_SIZE, y: newPosBl.y * GRID_SIZE };
    rearrangeVisualElement(desktopStore, mouseActionState.activeVisualElementSignal);
  }
}

export function moveActiveItemOutOfTable(desktopStore: DesktopStoreContextModel) {
  const activeItem = mouseActionState!.activeVisualElementSignal!.get().item;
  const tableItem = asTableItem(desktopStore.getItem(activeItem.parentId)!);
  let itemPosInTablePx = getBoundingBoxTopLeft(mouseActionState!.activeVisualElementSignal!.get().boundsPx);
  itemPosInTablePx.y -= tableItem.scrollYPx.get();
  const tableVeId = mouseActionState!.activeVisualElementSignal!.get().parent!.get().item.id;
  // TODO (MEDIUM): won't work in the (anticipated) general case.
  const tableVe = desktopStore.topLevelVisualElement().children.map(c => c.get()).find(el => el.item.id == tableVeId)!;
  // TODO (MEDIUM): won't work in the (anticipated) general case.
  const tableParentVe = desktopStore.topLevelVisualElement();
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
    activeItem.spatialPositionGr = itemPosInPageQuantizedGr;
    // TODO (LOW): something more efficient:
    arrange(desktopStore); // align visual elements with item tree.
  });
  // TODO (MEDIUM): won't work in (anticipated) general case.
  mouseActionState!.activeVisualElementSignal = desktopStore.topLevelVisualElement().children.find(el => el.get().item.id == activeItem.id)!;
  mouseActionState!.onePxSizeBl = {
    x: calcSizeForSpatialBl(activeItem, desktopStore.getItem).w / mouseActionState!.activeVisualElementSignal.get().boundsPx.w,
    y: calcSizeForSpatialBl(activeItem, desktopStore.getItem).h / mouseActionState!.activeVisualElementSignal.get().boundsPx.h
  };
}

export function mouseUpHandler(
    userStore: UserStoreContextModel,
    desktopStore: DesktopStoreContextModel) {

  dialogMoveState = null;

  if (mouseActionState == null) { return; }

  const activeItem = mouseActionState.activeVisualElementSignal!.get().item;

  if (mouseActionState.moveOverContainerVisualElement != null) {
    mouseActionState.moveOverContainerVisualElement.computed_movingItemIsOver.set(false);
  }

  switch (mouseActionState.action) {
    case MouseAction.Moving:
      const overVes = mouseActionState.moveOverContainerVisualElement!;
      const moveOverContainerId = overVes.item.id;
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
          activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };

          const moveOverContainer = desktopStore.getContainerItem(moveOverContainerId)!;
          const moveOverContainerChildren = [activeItem.id, ...moveOverContainer.computed_children.get()];
          moveOverContainerChildren.sort(
            (a, b) => compareOrderings(desktopStore.getItem(a)!.ordering, desktopStore.getItem(b)!.ordering));
          moveOverContainer.computed_children.set(moveOverContainerChildren);

          const prevParent = desktopStore.getContainerItem(prevParentId)!;
          prevParent.computed_children.set(prevParent.computed_children.get().filter(i => i != activeItem.id));
        });
        arrange(desktopStore);
      }
      if (mouseActionState.startPosBl!.x * GRID_SIZE != activeItem.spatialPositionGr.x ||
          mouseActionState.startPosBl!.y * GRID_SIZE != activeItem.spatialPositionGr.y ||
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
