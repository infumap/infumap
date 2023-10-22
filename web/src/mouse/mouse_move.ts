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
import { HitboxFlags } from "../layout/hitbox";
import { server } from "../server";
import { ItemFns } from "../items/base/item-polymorphism";
import { allowHalfBlockWidth, asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asPageItem, PageFns } from "../items/page-item";
import { TableFns, asTableItem, isTable } from "../items/table-item";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { vectorAdd, getBoundingBoxTopLeft, desktopPxFromMouseEvent, isInside, vectorSubtract, Vector, boundingBoxFromPosSize } from "../util/geometry";
import { panic } from "../util/lang";
import { VisualElement, VisualElementFlags, VeFns } from "../layout/visual-element";
import { editDialogSizePx } from "../components/overlay/edit/EditDialog";
import { VisualElementSignal } from "../util/signals";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { getHitInfo } from "./hit";
import { asPositionalItem } from "../items/base/positional-item";
import { PlaceholderFns } from "../items/placeholder-item";
import { LinkFns, asLinkItem, isLink } from "../items/link-item";
import { itemState } from "../store/ItemState";
import { VesCache } from "../layout/ves-cache";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { MouseAction, MouseActionState, LastMouseMoveEventState, TouchOrMouseEvent, DialogMoveState, UserSettingsMoveState } from "./state";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { arrange } from "../layout/arrange";
import { UserStoreContextModel } from "../store/UserStoreProvider";
import { editUserSettingsSizePx } from "../components/overlay/UserSettings";


let lastMouseOverVes: VisualElementSignal | null = null;
let lastMouseOverOpenPopupVes: VisualElementSignal | null = null;


export function mouseMoveHandler(desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel) {
  if (desktopStore.currentPage() == null) { return; }

  const hasUser = userStore.getUserMaybe() != null;

  const ev = LastMouseMoveEventState.get();
  const desktopPosPx = desktopPxFromMouseEvent(ev);

  // It is necessary to handle dialog moving at the global level, because sometimes the mouse position may
  // get outside the dialog area when being moved quickly.
  if (desktopStore.editDialogInfo() != null) {
    if (DialogMoveState.get() != null) {
      let currentMousePosPx = desktopPxFromMouseEvent(ev);
      let changePx = vectorSubtract(currentMousePosPx, DialogMoveState.get()!.lastMousePosPx!);
      desktopStore.setEditDialogInfo(({
        item: desktopStore.editDialogInfo()!.item,
        desktopBoundsPx: boundingBoxFromPosSize(vectorAdd(getBoundingBoxTopLeft(desktopStore.editDialogInfo()!.desktopBoundsPx), changePx), { ...editDialogSizePx })
      }));
      DialogMoveState.get()!.lastMousePosPx = currentMousePosPx;
      return;
    }
    if (isInside(desktopPosPx, desktopStore.editDialogInfo()!.desktopBoundsPx)) {
      mouseMove_handleNoButtonDown(desktopStore, hasUser);
      return;
    }
  }
  if (desktopStore.editUserSettingsInfo() != null) {
    if (UserSettingsMoveState.get() != null) {
      let currentMousePosPx = desktopPxFromMouseEvent(ev);
      let changePx = vectorSubtract(currentMousePosPx, UserSettingsMoveState.get()!.lastMousePosPx!);
      desktopStore.setEditUserSettingsInfo(({
        desktopBoundsPx: boundingBoxFromPosSize(vectorAdd(getBoundingBoxTopLeft(desktopStore.editUserSettingsInfo()!.desktopBoundsPx), changePx), { ...editUserSettingsSizePx })
      }));
      UserSettingsMoveState.get()!.lastMousePosPx = currentMousePosPx;
      return;
    }
    if (isInside(desktopPosPx, desktopStore.editUserSettingsInfo()!.desktopBoundsPx)) {
      mouseMove_handleNoButtonDown(desktopStore, hasUser);
      return;
    }
  }

  if (MouseActionState.empty()) {
    mouseMove_handleNoButtonDown(desktopStore, hasUser);
    return;
  }

  let deltaPx = vectorSubtract(desktopPosPx, MouseActionState.get().startPx!);

  changeMouseActionStateMaybe(deltaPx, desktopStore, desktopPosPx, hasUser, ev);

  switch (MouseActionState.get().action) {
    case MouseAction.Ambiguous:
      return;
    case MouseAction.Resizing:
      mouseAction_resizing(deltaPx, desktopStore);
      return;
    case MouseAction.ResizingPopup:
      mouseAction_resizingPopup(deltaPx, desktopStore);
      return;
    case MouseAction.ResizingColumn:
      mouseAction_resizingColumn(deltaPx, desktopStore);
      return;
    case MouseAction.MovingPopup:
      mouseAction_movingPopup(deltaPx, desktopStore);
      return;
    case MouseAction.Moving:
      mouseAction_moving(deltaPx, desktopPosPx, desktopStore);
      return;
    default:
      panic();
  }
}


function changeMouseActionStateMaybe(
    deltaPx: Vector,
    desktopStore: DesktopStoreContextModel,
    desktopPosPx: Vector,
    hasUser: boolean,
    ev: TouchOrMouseEvent) {
  if (MouseActionState.get().action != MouseAction.Ambiguous) { return; }
  if (!hasUser) { return; }

  if (!(Math.abs(deltaPx.x) > MOUSE_MOVE_AMBIGUOUS_PX || Math.abs(deltaPx.y) > MOUSE_MOVE_AMBIGUOUS_PX)) {
    return;
  }

  let activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
  let activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));

  if ((MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Resize) > 0) {
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

  } else if (((MouseActionState.get().hitboxTypeOnMouseDown & HitboxFlags.Move) > 0) ||
             ((MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown & HitboxFlags.Move))) {
    if (!(MouseActionState.get().hitboxTypeOnMouseDown & HitboxFlags.Move) &&
        (MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown & HitboxFlags.Move)) {
      // if the composite move hitbox is hit, but not the child, then swap out the active element.
      MouseActionState.get().hitboxTypeOnMouseDown = MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown!;
      MouseActionState.get().activeElement = MouseActionState.get().activeCompositeElementMaybe!;
      activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
      activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));
    }
    MouseActionState.get().startWidthBl = null;
    MouseActionState.get().startHeightBl = null;
    if (activeVisualElement.flags & VisualElementFlags.Popup) {
      desktopStore.setItemIsMoving(true);
      MouseActionState.get().action = MouseAction.MovingPopup;
      const activeRoot = VesCache.get(MouseActionState.get().activeRoot)!.get().displayItem;
      const popupPositionGr = PageFns.getPopupPositionGr(asPageItem(activeRoot));
      MouseActionState.get().startPosBl = { x: popupPositionGr.x / GRID_SIZE, y: popupPositionGr.y / GRID_SIZE };
    } else {
      const shouldCreateLink = ev.shiftDown;
      const parentItem = itemState.get(activeItem.parentId)!;
      if (isTable(parentItem) && activeItem.relationshipToParent == RelationshipToParent.Child) {
        moving_activeItemOutOfTable(desktopStore, shouldCreateLink);
        arrange(desktopStore);
      }
      else if (activeItem.relationshipToParent == RelationshipToParent.Attachment) {
        const hitInfo = getHitInfo(desktopStore, desktopPosPx, [], false);
        moving_activeItemToPage(desktopStore, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Attachment, shouldCreateLink);
        arrange(desktopStore);
      }
      else if (isComposite(itemState.get(activeItem.parentId)!)) {
        const hitInfo = getHitInfo(desktopStore, desktopPosPx, [], false);
        moving_activeItemToPage(desktopStore, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Child, shouldCreateLink);
        arrange(desktopStore);
      }
      else {
        MouseActionState.get().startPosBl = {
          x: activeItem.spatialPositionGr.x / GRID_SIZE,
          y: activeItem.spatialPositionGr.y / GRID_SIZE
        };
        if (shouldCreateLink && !isLink(activeVisualElement.displayItem)) {
          const link = LinkFns.createFromItem(
            activeVisualElement.displayItem,
            RelationshipToParent.Child,
            itemState.newOrderingDirectlyAfterChild(activeItem.parentId, activeItem.id));
          link.parentId = activeItem.parentId;
          link.spatialPositionGr = activeItem.spatialPositionGr;
          if (isXSizableItem(activeVisualElement.displayItem)) {
            link.spatialWidthGr = asXSizableItem(activeVisualElement.displayItem).spatialWidthGr;
          }
          if (isYSizableItem(activeVisualElement.displayItem)) {
            link.spatialHeightGr = asYSizableItem(activeVisualElement.displayItem).spatialHeightGr;
          }
          itemState.add(link);
          server.addItem(link, null);

          desktopStore.setItemIsMoving(true);
          const activeParentPath = VeFns.parentPath(MouseActionState.get().activeElement);
          const newLinkVeid = VeFns.veidFromId(link.id);
          MouseActionState.get().activeElement = VeFns.addVeidToPath(newLinkVeid, activeParentPath);
          MouseActionState.get().action = MouseAction.Moving; // page arrange depends on this in the grid case.
          MouseActionState.get().linkCreatedOnMoveStart = true;

          arrange(desktopStore);
        }
      }
      desktopStore.setItemIsMoving(true);
      MouseActionState.get().action = MouseAction.Moving;
    }

  } else if ((MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.ColResize) > 0) {
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


function mouseAction_resizing(deltaPx: Vector, desktopStore: DesktopStoreContextModel) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
  const activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));

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
}


function mouseAction_resizingPopup(deltaPx: Vector, desktopStore: DesktopStoreContextModel) {
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
}


function mouseAction_resizingColumn(deltaPx: Vector, desktopStore: DesktopStoreContextModel) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
  const activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));

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
}


function mouseAction_movingPopup(deltaPx: Vector, desktopStore: DesktopStoreContextModel) {
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
}


function mouseAction_moving(deltaPx: Vector, desktopPosPx: Vector, desktopStore: DesktopStoreContextModel) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
  const activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));

  let ignoreIds = [activeVisualElement.displayItem.id];
  if (isComposite(activeVisualElement.displayItem)) {
    const compositeItem = asCompositeItem(activeVisualElement.displayItem);
    for (let childId of compositeItem.computed_children) { ignoreIds.push(childId); }
  }
  const hitInfo = getHitInfo(desktopStore, desktopPosPx, ignoreIds, false);

  // update move over element state.
  if (MouseActionState.get().moveOver_containerElement == null ||
    MouseActionState.get().moveOver_containerElement! != VeFns.veToPath(hitInfo.overContainerVe!)) {
    if (MouseActionState.get().moveOver_containerElement != null) {
      VesCache.get(MouseActionState.get().moveOver_containerElement!)!.get().movingItemIsOver.set(false);
    }
    hitInfo.overContainerVe!.movingItemIsOver.set(true);
    MouseActionState.get().moveOver_containerElement = VeFns.veToPath(hitInfo.overContainerVe!);
  }

  // update move over attach state.
  if (MouseActionState.get().moveOver_attachHitboxElement != null) {
    VesCache.get(MouseActionState.get().moveOver_attachHitboxElement!)!.get().movingItemIsOverAttach.set(false);
  }
  if (hitInfo.hitboxType & HitboxFlags.Attach) {
    hitInfo.overElementVes.get().movingItemIsOverAttach.set(true);
    MouseActionState.get().moveOver_attachHitboxElement = VeFns.veToPath(hitInfo.overElementVes.get());
  } else {
    MouseActionState.get().moveOver_attachHitboxElement = null;
  }

  // update move over attach composite state.
  if (MouseActionState.get().moveOver_attachCompositeHitboxElement != null) {
    VesCache.get(MouseActionState.get().moveOver_attachCompositeHitboxElement!)!.get().movingItemIsOverAttachComposite.set(false);
  }
  if (hitInfo.hitboxType & HitboxFlags.AttachComposite) {
    hitInfo.overElementVes.get().movingItemIsOverAttachComposite.set(true);
    MouseActionState.get().moveOver_attachCompositeHitboxElement = VeFns.veToPath(hitInfo.overElementVes.get());
  } else {
    MouseActionState.get().moveOver_attachCompositeHitboxElement = null;
  }

  if (VesCache.get(MouseActionState.get().moveOver_scaleDefiningElement!)!.get().displayItem != hitInfo.overPositionableVe!.displayItem) {
    moving_activeItemToPage(desktopStore, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Child, false);
    arrange(desktopStore);
    return;
  }

  if (isTable(hitInfo.overContainerVe!.displayItem)) {
    moving_handleOverTable(desktopStore, hitInfo.overContainerVe!, desktopPosPx);
  }

  const deltaBl = {
    x: deltaPx.x * MouseActionState.get().onePxSizeBl.x,
    y: deltaPx.y * MouseActionState.get().onePxSizeBl.y
  };

  let newPosBl = vectorAdd(MouseActionState.get().startPosBl!, deltaBl);
  newPosBl.x = Math.round(newPosBl.x * 2.0) / 2.0;
  newPosBl.y = Math.round(newPosBl.y * 2.0) / 2.0;
  const inElement = VesCache.get(MouseActionState.get().moveOver_scaleDefiningElement!)!.get().displayItem;
  const dimBl = PageFns.calcInnerSpatialDimensionsBl(asPageItem(inElement));
  if (newPosBl.x < 0.0) { newPosBl.x = 0.0; }
  if (newPosBl.y < 0.0) { newPosBl.y = 0.0; }
  if (newPosBl.x > dimBl.w - 0.5) { newPosBl.x = dimBl.w - 0.5; }
  if (newPosBl.y > dimBl.h - 0.5) { newPosBl.y = dimBl.h - 0.5; }
  activeItem.spatialPositionGr = { x: newPosBl.x * GRID_SIZE, y: newPosBl.y * GRID_SIZE };
  arrange(desktopStore);
}


function moving_handleOverTable(desktopStore: DesktopStoreContextModel, overContainerVe: VisualElement, desktopPx: Vector) {
  const { insertRow, attachmentPos } = TableFns.tableModifiableColRow(desktopStore, overContainerVe, desktopPx);
  overContainerVe.moveOverRowNumber.set(insertRow);

  const tableItem = asTableItem(overContainerVe.displayItem);
  const childItem = itemState.get(tableItem.computed_children[insertRow]);
  if (isAttachmentsItem(childItem) || (isLink(childItem) && isAttachmentsItem(itemState.get(LinkFns.getLinkToId(asLinkItem(childItem!))!)))) {
    overContainerVe.moveOverColAttachmentNumber.set(attachmentPos);
  } else {
    overContainerVe.moveOverColAttachmentNumber.set(-1);
  }
}


function moving_activeItemToPage(desktopStore: DesktopStoreContextModel, moveToVe: VisualElement, desktopPx: Vector, relationshipToParent: string, shouldCreateLink: boolean) {
  const activeElement = VesCache.get(MouseActionState.get().activeElement!)!.get();
  const canonicalActiveItem = asPositionalItem(VeFns.canonicalItem(activeElement));

  const moveToPage = asPageItem(moveToVe.displayItem);
  const moveToPageAbsoluteBoundsPx = VeFns.veBoundsRelativeToDesktopPx(desktopStore, moveToVe);
  const moveToPageInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(moveToPage);
  const mousePointBl = {
    x: Math.round((desktopPx.x - moveToPageAbsoluteBoundsPx.x) / moveToPageAbsoluteBoundsPx.w * moveToPageInnerSizeBl.w * 2.0) / 2.0,
    y: Math.round((desktopPx.y - moveToPageAbsoluteBoundsPx.y) / moveToPageAbsoluteBoundsPx.h * moveToPageInnerSizeBl.h * 2.0) / 2.0
  };
  const activeItemDimensionsBl = ItemFns.calcSpatialDimensionsBl(canonicalActiveItem);
  const clickOffsetInActiveItemBl = relationshipToParent == RelationshipToParent.Child
    ? { x: Math.round(activeItemDimensionsBl.w * MouseActionState.get().clickOffsetProp!.x * 2.0) / 2.0,
        y: Math.round(activeItemDimensionsBl.h * MouseActionState.get().clickOffsetProp!.y * 2.0) / 2.0 }
    : { x: 0, y: 0 };
  const startPosBl = vectorSubtract(mousePointBl, clickOffsetInActiveItemBl);
  const newItemPosGr = { x: startPosBl.x * GRID_SIZE, y: startPosBl.y * GRID_SIZE };
  MouseActionState.get().startPx = desktopPx;
  MouseActionState.get().startPosBl = startPosBl;
  const moveToPath = VeFns.veToPath(moveToVe);

  if (shouldCreateLink && !isLink(activeElement.displayItem)) {
    const link = LinkFns.createFromItem(activeElement.displayItem, RelationshipToParent.Child, itemState.newOrderingAtEndOfChildren(moveToPage.id));
    link.parentId = moveToPage.id;
    link.spatialPositionGr = newItemPosGr;
    itemState.add(link);
    server.addItem(link, null);
    arrange(desktopStore); // TODO (LOW): avoid this arrange i think by determining the new activeElement path without the fine.
    let ve = VesCache.find({ itemId: activeElement.displayItem.id, linkIdMaybe: link.id});
    if (ve.length != 1) { panic(); }
    MouseActionState.get().activeElement = VeFns.veToPath(ve[0].get());
    MouseActionState.get().linkCreatedOnMoveStart = true;

  } else {
    if (relationshipToParent == RelationshipToParent.Attachment) {
      const oldActiveItemOrdering = canonicalActiveItem.ordering;
      const parent = asAttachmentsItem(itemState.get(canonicalActiveItem.parentId)!);
      const isLast = parent.computed_attachments[asAttachmentsItem(parent).computed_attachments.length-1] == canonicalActiveItem.id;
      if (!isLast) {
        const placeholderItem = PlaceholderFns.create(canonicalActiveItem.ownerId, parent.id, RelationshipToParent.Attachment, oldActiveItemOrdering);
        itemState.add(placeholderItem);
        MouseActionState.get().newPlaceholderItem = placeholderItem;
      }
      MouseActionState.get().startAttachmentsItem = parent;
    }

    canonicalActiveItem.spatialPositionGr = newItemPosGr;
    itemState.moveToNewParent(canonicalActiveItem, moveToPage.id, RelationshipToParent.Child);

    MouseActionState.get().activeElement = VeFns.addVeidToPath(VeFns.veidFromVe(activeElement), moveToPath);
  }

  MouseActionState.get().onePxSizeBl = {
    x: moveToPageInnerSizeBl.w / moveToPageAbsoluteBoundsPx.w,
    y: moveToPageInnerSizeBl.h / moveToPageAbsoluteBoundsPx.h
  };
  MouseActionState.get().moveOver_scaleDefiningElement = moveToPath;
}


function moving_activeItemOutOfTable(desktopStore: DesktopStoreContextModel, shouldCreateLink: boolean) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElement!)!.get();
  const tableVisualElement = VesCache.get(activeVisualElement.parentPath!)!.get();
  const activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));

  const tableItem = asTableItem(tableVisualElement.displayItem);
  const tableBlockHeightPx = tableVisualElement.boundsPx.h / (tableItem.spatialHeightGr / GRID_SIZE);
  let itemPosInTablePx = getBoundingBoxTopLeft(activeVisualElement.boundsPx);
  itemPosInTablePx.y -= desktopStore.getTableScrollYPos(VeFns.veidFromVe(tableVisualElement)) * tableBlockHeightPx;
  const tableVe = VesCache.get(activeVisualElement.parentPath!)!.get();
  const tableParentVe = VesCache.get(tableVe.parentPath!)!.get();

  const moveToPage = asPageItem(tableParentVe.displayItem);
  const moveToPageAbsoluteBoundsPx = VeFns.veBoundsRelativeToDesktopPx(desktopStore, tableParentVe);
  const moveToPageInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(moveToPage);

  const tablePosInPagePx = getBoundingBoxTopLeft(tableVe.childAreaBoundsPx!);
  const itemPosInPagePx = vectorAdd(tablePosInPagePx, itemPosInTablePx);
  const tableParentPage = asPageItem(tableParentVe.displayItem);
  const itemPosInPageGr = {
    x: itemPosInPagePx.x / tableParentVe!.boundsPx.w * tableParentPage.innerSpatialWidthGr,
    y: itemPosInPagePx.y / tableParentVe!.boundsPx.h * PageFns.calcInnerSpatialDimensionsBl(tableParentPage).h * GRID_SIZE
  };
  const itemPosInPageQuantizedGr = {
    x: Math.round(itemPosInPageGr.x / (GRID_SIZE / 2.0)) / 2.0 * GRID_SIZE,
    y: Math.round(itemPosInPageGr.y / (GRID_SIZE / 2.0)) / 2.0 * GRID_SIZE
  };

  if (shouldCreateLink && !isLink(activeVisualElement.displayItem)) {
    const link = LinkFns.createFromItem(activeVisualElement.displayItem, RelationshipToParent.Child, itemState.newOrderingAtEndOfChildren(tableParentPage.id));
    link.parentId = tableParentPage.id;
    link.spatialPositionGr = itemPosInPageQuantizedGr;
    itemState.add(link);
    server.addItem(link, null);
    arrange(desktopStore); // TODO (LOW): avoid this arrange i think by determining the new activeElement path without the fine.
    let ve = VesCache.find({ itemId: activeVisualElement.displayItem.id, linkIdMaybe: link.id});
    if (ve.length != 1) { panic(); }
    MouseActionState.get().clickOffsetProp = { x: 0.0, y: 0.0 };
    MouseActionState.get().activeElement = VeFns.veToPath(ve[0].get());
    MouseActionState.get().onePxSizeBl = {
      x: moveToPageInnerSizeBl.w / moveToPageAbsoluteBoundsPx.w,
      y: moveToPageInnerSizeBl.h / moveToPageAbsoluteBoundsPx.h
    };
    MouseActionState.get().linkCreatedOnMoveStart = true;
  } else {
    activeItem.spatialPositionGr = itemPosInPageQuantizedGr;
    itemState.moveToNewParent(activeItem, tableParentPage.id, RelationshipToParent.Child);
    MouseActionState.get().activeElement = VeFns.addVeidToPath(VeFns.veidFromVe(activeVisualElement), tableVe.parentPath!);
    MouseActionState.get().onePxSizeBl = {
      x: moveToPageInnerSizeBl.w / moveToPageAbsoluteBoundsPx.w,
      y: moveToPageInnerSizeBl.h / moveToPageAbsoluteBoundsPx.h
    };
  }
  MouseActionState.get().startPosBl = { x: itemPosInPageQuantizedGr.x / GRID_SIZE, y: itemPosInPageQuantizedGr.y / GRID_SIZE };
}


export function mouseMove_handleNoButtonDown(desktopStore: DesktopStoreContextModel, hasUser: boolean) {
  const dialogInfo = desktopStore.editDialogInfo();
  const userSettingsInfo = desktopStore.editUserSettingsInfo();
  const contextMenuInfo = desktopStore.contextMenuInfo();
  const hasModal = dialogInfo != null || contextMenuInfo != null || userSettingsInfo != null;

  const ev = LastMouseMoveEventState.get();
  const hitInfo = getHitInfo(desktopStore, desktopPxFromMouseEvent(ev), [], false);
  const overElementVes = hitInfo.overElementVes;

  if (overElementVes != lastMouseOverVes || hasModal) {
    if (lastMouseOverVes != null) {
      lastMouseOverVes.get().mouseIsOver.set(false);
      lastMouseOverVes = null;
    }
  }

  if (overElementVes != lastMouseOverOpenPopupVes || !(hitInfo.hitboxType & HitboxFlags.OpenPopup) || hasModal) {
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
    if (hitInfo.hitboxType & HitboxFlags.OpenPopup) {
      overElementVes!.get().mouseIsOverOpenPopup.set(true);
      lastMouseOverOpenPopupVes = overElementVes;
    } else {
      overElementVes!.get().mouseIsOverOpenPopup.set(false);
    }
  }

  if (hasUser) {
    if (hitInfo.hitboxType & HitboxFlags.Resize) {
      document.body.style.cursor = "nwse-resize";
    } else if (hitInfo.hitboxType & HitboxFlags.ColResize) {
      document.body.style.cursor = "ew-resize";
    } else if ((hitInfo.hitboxType & HitboxFlags.Move) && (hitInfo.overElementVes.get().flags & VisualElementFlags.Popup)) {
      document.body.style.cursor = "move";
    } else if (hitInfo.hitboxType & HitboxFlags.Expand) {
      document.body.style.cursor = "zoom-in";
    } else {
      document.body.style.cursor = "default";
    }
  }
}
