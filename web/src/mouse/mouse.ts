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
import { HitboxType } from "../layout/hitbox";
import { server } from "../server";
import { calcSizeForSpatialBl } from "../items/base/item-polymorphism";
import { allowHalfBlockWidth, asXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asPageItem, calcPageInnerSpatialDimensionsBl, getPopupPositionGr } from "../items/page-item";
import { asTableItem, isTable } from "../items/table-item";
import { DesktopStoreContextModel, findVisualElements } from "../store/DesktopStoreProvider";
import { vectorAdd, getBoundingBoxTopLeft, desktopPxFromMouseEvent, isInside, vectorSubtract, Vector, boundingBoxFromPosSize, Dimensions } from "../util/geometry";
import { panic } from "../util/lang";
import { VisualElement, VisualElementFlags, getVeid, visualElementDesktopBoundsPx as visualElementBoundsOnDesktopPx, visualElementToPath } from "../layout/visual-element";
import { arrange } from "../layout/arrange";
import { editDialogSizePx } from "../components/edit/EditDialog";
import { VisualElementSignal } from "../util/signals";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { Attachment, Child } from "../layout/relationship-to-parent";
import { asContainerItem } from "../items/base/container-item";
import { getHitInfo } from "./hit";
import { asPositionalItem } from "../items/base/positional-item";
import { newPlaceholderItem } from "../items/placeholder-item";
import { asLinkItem, getLinkToId, isLink, newLinkItemFromItem } from "../items/link-item";
import { COL_HEADER_HEIGHT_BL, HEADER_HEIGHT_BL } from "../components/items/Table";
import { itemState } from "../store/ItemState";
import { mouseMoveState } from "../store/MouseMoveState";
import { TableFlags } from "../items/base/flags-item";
import { VesCache } from "../layout/ves-cache";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { isNote } from "../items/note-item";
import { dialogMoveState } from "./mouse_dialogState";
import { MouseAction, MouseActionState } from "./mouse_actionState";


export const MOUSE_LEFT = 0;
export const MOUSE_RIGHT = 2;


let lastMouseOverVes: VisualElementSignal | null = null;
let lastMouseOverOpenPopupVes: VisualElementSignal | null = null;


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

  if (MouseActionState.empty()) {
    mouseMoveNoButtonDownHandler(desktopStore);
    return;
  }

  const deltaPx = vectorSubtract(desktopPosPx, MouseActionState.get().startPx!);

  let activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
  let activeItem = asPositionalItem(activeVisualElement.linkItemMaybe != null
    ? itemState.getItem(activeVisualElement.linkItemMaybe!.id)!
    : itemState.getItem(activeVisualElement.displayItem.id)!);

  if (MouseActionState.get().action == MouseAction.Ambiguous) {
    if (!(Math.abs(deltaPx.x) > MOUSE_MOVE_AMBIGUOUS_PX || Math.abs(deltaPx.y) > MOUSE_MOVE_AMBIGUOUS_PX)) {
      return;
    }

    if ((MouseActionState.get().hitboxTypeOnMouseDown! & HitboxType.Resize) > 0) {
      MouseActionState.get().startPosBl = null;
      if (activeVisualElement.flags & VisualElementFlags.Popup) {
        MouseActionState.get().startWidthBl = activeVisualElement.linkItemMaybe!.spatialWidthGr / GRID_SIZE;
        MouseActionState.get().startHeightBl = null;
        MouseActionState.get().action = MouseAction.ResizingPopup;
      } else {
        MouseActionState.get().startWidthBl = asXSizableItem(activeItem).spatialWidthGr / GRID_SIZE;
        if (isYSizableItem(activeItem)) {
          MouseActionState.get().startHeightBl = asYSizableItem(activeItem).spatialHeightGr / GRID_SIZE;
        } else if(isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem)) {
          MouseActionState.get().startHeightBl = asLinkItem(activeItem).spatialHeightGr / GRID_SIZE;
        } else {
          MouseActionState.get().startHeightBl = null;
        }
        MouseActionState.get().action = MouseAction.Resizing;
      }

    } else if (((MouseActionState.get().hitboxTypeOnMouseDown & HitboxType.Move) > 0) ||
                ((MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown & HitboxType.Move))) {
      if (!(MouseActionState.get().hitboxTypeOnMouseDown & HitboxType.Move) &&
          (MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown & HitboxType.Move)) {
        // if the composite move hitbox is hit, but not the child, then swap out the active element.
        MouseActionState.get().hitboxTypeOnMouseDown = MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown!;
        MouseActionState.get().activeElement = MouseActionState.get().activeCompositeElementMaybe!;
        activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
        activeItem = asPositionalItem(activeVisualElement.linkItemMaybe != null
          ? itemState.getItem(activeVisualElement.linkItemMaybe!.id)!
          : itemState.getItem(activeVisualElement.displayItem.id)!);
      }
      MouseActionState.get().startWidthBl = null;
      MouseActionState.get().startHeightBl = null;
      if (activeVisualElement.flags & VisualElementFlags.Popup) {
        MouseActionState.get().action = MouseAction.MovingPopup;
        const activeRoot = VesCache.get(MouseActionState.get().activeRoot)!.get().displayItem;
        const popupPositionGr = getPopupPositionGr(asPageItem(activeRoot));
        MouseActionState.get().startPosBl = { x: popupPositionGr.x / GRID_SIZE, y: popupPositionGr.y / GRID_SIZE };
      } else {
        const shouldCreateLink = ev.shiftKey;
        const parentItem = itemState.getItem(activeItem.parentId)!;
        if (isTable(parentItem) && activeItem.relationshipToParent == Child) {
          moveActiveItemOutOfTable(desktopStore, shouldCreateLink);
          MouseActionState.get().startPosBl = {
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
          MouseActionState.get().startPosBl = {
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
            MouseActionState.get().activeElement = visualElementToPath(ve[0].get());
          }
        }
        MouseActionState.get().action = MouseAction.Moving;
      }

    } else if ((MouseActionState.get().hitboxTypeOnMouseDown! & HitboxType.ColResize) > 0) {
      MouseActionState.get().startPosBl = null;
      MouseActionState.get().startHeightBl = null;
      const colNum = MouseActionState.get().hitMeta!.resizeColNumber!;
      if (activeVisualElement.linkItemMaybe != null) {
        MouseActionState.get().startWidthBl = asTableItem(activeVisualElement.displayItem).tableColumns[colNum].widthGr / GRID_SIZE;
      } else {
        MouseActionState.get().startWidthBl = asTableItem(activeItem).tableColumns[colNum].widthGr / GRID_SIZE;
      }
      MouseActionState.get().action = MouseAction.ResizingColumn;
    }
  }


  // ### Resizing
  if (MouseActionState.get().action == MouseAction.Resizing) {
    const deltaBl = {
      x: deltaPx.x * MouseActionState.get().onePxSizeBl.x,
      y: deltaPx.y * MouseActionState.get().onePxSizeBl.y
    };

    let newWidthBl = MouseActionState.get()!.startWidthBl! + deltaBl.x;
    newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
    if (newWidthBl < 1) { newWidthBl = 1.0; }

    asXSizableItem(activeItem).spatialWidthGr = newWidthBl * GRID_SIZE;

    if (isYSizableItem(activeItem) || (isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem))) {
      let newHeightBl = MouseActionState.get()!.startHeightBl! + deltaBl.y;
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
  } else if (MouseActionState.get().action == MouseAction.ResizingPopup) {
    const deltaBl = {
      x: deltaPx.x * MouseActionState.get().onePxSizeBl.x * 2.0, // * 2.0 because it's centered, so mouse distance -> half the desired increase in width.
      y: deltaPx.y * MouseActionState.get().onePxSizeBl.y * 2.0
    };

    let newWidthBl = MouseActionState.get()!.startWidthBl! + deltaBl.x;
    newWidthBl = Math.round(newWidthBl * 2.0) / 2.0;
    if (newWidthBl < 5) { newWidthBl = 5.0; }

    const activeRoot = VesCache.get(MouseActionState.get().activeRoot)!.get();
    asPageItem(activeRoot.displayItem).pendingPopupWidthGr = newWidthBl * GRID_SIZE;

    arrange(desktopStore);

  // ### Resizing Column
  } else if (MouseActionState.get().action == MouseAction.ResizingColumn) {
    const deltaBl = {
      x: deltaPx.x * MouseActionState.get().onePxSizeBl.x,
      y: deltaPx.y * MouseActionState.get().onePxSizeBl.y
    };

    let newWidthBl = MouseActionState.get()!.startWidthBl! + deltaBl.x;
    newWidthBl = allowHalfBlockWidth(asXSizableItem(activeItem)) ? Math.round(newWidthBl * 2.0) / 2.0 : Math.round(newWidthBl);
    if (newWidthBl < 1) { newWidthBl = 1.0; }

    if (activeVisualElement.linkItemMaybe != null) {
      asTableItem(activeVisualElement.displayItem).tableColumns[MouseActionState.get()!.hitMeta!.resizeColNumber!].widthGr = newWidthBl * GRID_SIZE;
    } else {
      asTableItem(activeItem).tableColumns[MouseActionState.get()!.hitMeta!.resizeColNumber!].widthGr = newWidthBl * GRID_SIZE;
    }

    arrange(desktopStore);

  // ### Moving Popup
  } else if (MouseActionState.get().action == MouseAction.MovingPopup) {
    const deltaBl = {
      x: Math.round(deltaPx.x * MouseActionState.get().onePxSizeBl.x * 2.0)/2.0,
      y: Math.round(deltaPx.y * MouseActionState.get().onePxSizeBl.y * 2.0)/2.0
    };
    const newPositionGr = {
      x: (MouseActionState.get().startPosBl!.x + deltaBl.x) * GRID_SIZE,
      y: (MouseActionState.get().startPosBl!.y + deltaBl.y) * GRID_SIZE
    };
    const activeRoot = VesCache.get(MouseActionState.get().activeRoot)!.get();
    asPageItem(activeRoot.displayItem).pendingPopupPositionGr = newPositionGr;

    arrange(desktopStore);

  // ### Moving
  } else if (MouseActionState.get().action == MouseAction.Moving) {

    let ignoreIds = [activeVisualElement.displayItem.id];
    if (isComposite(activeVisualElement.displayItem)) {
      const compositeItem = asCompositeItem(activeVisualElement.displayItem);
      for (let i=0; i<compositeItem.computed_children.length; ++i) { ignoreIds.push(compositeItem.computed_children[i]); }
    }
    const hitInfo = getHitInfo(desktopStore, desktopPosPx, ignoreIds, false);

    // update move over element state.
    if (MouseActionState.get().moveOver_containerElement == null ||
      MouseActionState.get().moveOver_containerElement! != visualElementToPath(hitInfo.overContainerVe!)) {
      if (MouseActionState.get().moveOver_containerElement != null) {
        VesCache.get(MouseActionState.get().moveOver_containerElement!)!.get().movingItemIsOver.set(false);
      }
      hitInfo.overContainerVe!.movingItemIsOver.set(true);
      MouseActionState.get().moveOver_containerElement = visualElementToPath(hitInfo.overContainerVe!);
    }

    // update move over attach state.
    if (MouseActionState.get().moveOver_attachHitboxElement != null) {
      VesCache.get(MouseActionState.get().moveOver_attachHitboxElement!)!.get().movingItemIsOverAttach.set(false);
    }
    if (hitInfo.hitboxType & HitboxType.Attach) {
      hitInfo.overElementVes.get().movingItemIsOverAttach.set(true);
      MouseActionState.get().moveOver_attachHitboxElement = visualElementToPath(hitInfo.overElementVes.get());
    } else {
      MouseActionState.get().moveOver_attachHitboxElement = null;
    }

    // update move over attach composite state.
    if (MouseActionState.get().moveOver_attachCompositeHitboxElement != null) {
      VesCache.get(MouseActionState.get().moveOver_attachCompositeHitboxElement!)!.get().movingItemIsOverAttachComposite.set(false);
    }
    if (hitInfo.hitboxType & HitboxType.AttachComposite) {
      hitInfo.overElementVes.get().movingItemIsOverAttachComposite.set(true);
      MouseActionState.get().moveOver_attachCompositeHitboxElement = visualElementToPath(hitInfo.overElementVes.get());
    } else {
      MouseActionState.get().moveOver_attachCompositeHitboxElement = null;
    }

    if (VesCache.get(MouseActionState.get().moveOver_scaleDefiningElement!)!.get().displayItem != hitInfo.overPositionableVe!.displayItem) {
      moveActiveItemToPage(desktopStore, hitInfo.overPositionableVe!, desktopPosPx, Child, false);
    }

    if (isTable(hitInfo.overContainerVe!.displayItem)) {
      handleOverTable(desktopStore, hitInfo.overContainerVe!, desktopPosPx);
    }

    const deltaBl = {
      x: deltaPx.x * MouseActionState.get().onePxSizeBl.x,
      y: deltaPx.y * MouseActionState.get().onePxSizeBl.y
    };

    let newPosBl = vectorAdd(MouseActionState.get().startPosBl!, deltaBl);
    newPosBl.x = Math.round(newPosBl.x * 2.0) / 2.0;
    newPosBl.y = Math.round(newPosBl.y * 2.0) / 2.0;
    const inElement = VesCache.get(MouseActionState.get().moveOver_scaleDefiningElement!)!.get().displayItem;
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
  const activeElement = VesCache.get(MouseActionState.get().activeElement!)!.get();
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
    ? { x: Math.round(activeItemDimensionsBl.w * MouseActionState.get().clickOffsetProp!.x * 2.0) / 2.0,
        y: Math.round(activeItemDimensionsBl.h * MouseActionState.get().clickOffsetProp!.y * 2.0) / 2.0 }
    : { x: 0, y: 0 };
  const startPosBl = vectorSubtract(mousePointBl, clickOffsetInActiveItemBl);
  const newItemPosGr = { x: startPosBl.x * GRID_SIZE, y: startPosBl.y * GRID_SIZE };
  MouseActionState.get().startPx = desktopPx;
  MouseActionState.get().startPosBl = startPosBl;
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
      MouseActionState.get().newPlaceholderItem = placeholderItem;
    }
    MouseActionState.get().startAttachmentsItem = parent;
  }

  arrange(desktopStore);

  let done = false;
  findVisualElements(desktopStore, activeElementItemId, activeElementLinkItemMaybeId).forEach(ve => {
    if (ve.get().parentPath == moveToPath) {
      MouseActionState.get().activeElement = visualElementToPath(ve.get());
      let boundsPx = VesCache.get(MouseActionState.get().activeElement)!.get().boundsPx;
      MouseActionState.get().onePxSizeBl = {
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
      MouseActionState.get().moveOver_scaleDefiningElement = visualElementToPath(ve.get());
      done = true;
    }
  });
  if (!done) { panic(); }
}

export function moveActiveItemOutOfTable(desktopStore: DesktopStoreContextModel, shouldCreateLink: boolean) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElement!)!.get();
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
      MouseActionState.get().activeElement = visualElementToPath(ve.get());
      let boundsPx = VesCache.get(MouseActionState.get().activeElement)!.get().boundsPx;
      MouseActionState.get().onePxSizeBl = {
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


export function mouseDoubleClickHandler(
  desktopStore: DesktopStoreContextModel,
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
