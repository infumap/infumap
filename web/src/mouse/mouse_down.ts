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

import { POPUP_TOOLBAR_WIDTH_BL } from "../constants";
import { AttachmentsItem, asAttachmentsItem } from "../items/base/attachments-item";
import { Item } from "../items/base/item";
import { calcSizeForSpatialBl } from "../items/base/item-polymorphism";
import { CompositeItem, asCompositeItem, isComposite } from "../items/composite-item";
import { asPageItem } from "../items/page-item";
import { isTable } from "../items/table-item";
import { arrange } from "../layout/arrange";
import { HitboxType } from "../layout/hitbox";
import { switchToPage, updateHref } from "../layout/navigation";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VisualElementFlags, VeFns } from "../layout/visual-element";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { itemState } from "../store/ItemState";
import { UserStoreContextModel } from "../store/UserStoreProvider";
import { desktopPxFromMouseEvent, isInside } from "../util/geometry";
import { getHitInfo } from "./hit";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { DialogMoveState, MouseAction, MouseActionState } from "./state";


export const MOUSE_LEFT = 0;
export const MOUSE_RIGHT = 2;


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
    console.warn("unsupported mouse button: " + ev.button);
  }
}


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
      DialogMoveState.set({ lastMousePosPx: desktopPosPx });
      return;
    }

    desktopStore.setEditDialogInfo(null);
    return;
  }

  const hitInfo = getHitInfo(desktopStore, desktopPosPx, [], false);
  if (hitInfo.hitboxType == HitboxType.None) {
    if (hitInfo.overElementVes.get().flags & VisualElementFlags.Popup) {
      switchToPage(desktopStore, userStore, VeFns.getVeid(hitInfo.overElementVes.get()), true);
    } else {
      arrange(desktopStore);
    }
    MouseActionState.set(null);
    return;
  }

  const startPosBl = null;
  const startWidthBl = null;
  const startHeightBl = null;
  const startPx = desktopPosPx;
  const activeItem = hitInfo.overElementVes.get().linkItemMaybe != null
    ? itemState.getItem(hitInfo.overElementVes.get().linkItemMaybe!.id)!
    : itemState.getItem(hitInfo.overElementVes.get().displayItem.id)!;
  let boundsOnDesktopPx = VeFns.veBoundsRelativeToDesktopPx(hitInfo.overElementVes.get());
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
      const compositeBoundsOnDesktopPx = VeFns.veBoundsRelativeToDesktopPx(hitInfo.overContainerVe!);
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
  MouseActionState.set({
    activeRoot: VeFns.veToPath(hitInfo.rootVe.flags & VisualElementFlags.Popup ? VesCache.get(hitInfo.rootVe.parentPath!)!.get() : hitInfo.rootVe),
    activeElement: VeFns.veToPath(hitInfo.overElementVes.get()),
    activeCompositeElementMaybe: hitInfo.compositeHitboxTypeMaybe ? VeFns.veToPath(hitInfo.overContainerVe!) : null,
    moveOver_containerElement: null,
    moveOver_attachHitboxElement: null,
    moveOver_attachCompositeHitboxElement: null,
    moveOver_scaleDefiningElement: VeFns.veToPath(
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
  });
}


function calcStartCompositeItemMaybe(activeItem: Item): CompositeItem | null {
  if (activeItem == null) { return null; }
  if (activeItem.parentId == null) { return null; }
  if (activeItem.relationshipToParent != RelationshipToParent.Child) { return null; }
  let parent = itemState.getItem(activeItem.parentId)!;
  if (parent.parentId == null) { return null; }
  if (!isComposite(parent)) { return null; }
  return asCompositeItem(parent);
}


function calcStartTableAttachmentsItemMaybe(activeItem: Item): AttachmentsItem | null {
  if (activeItem == null) { return null; }
  if (activeItem.parentId == null) { return null; }
  if (activeItem.relationshipToParent != RelationshipToParent.Attachment) { return null; }
  let parent = itemState.getItem(activeItem.parentId)!;
  if (parent.parentId == null) { return null; }
  let parentParent = itemState.getItem(parent.parentId)!;
  if (!isTable(parentParent)) { return null; }
  return asAttachmentsItem(parent);
}


export function mouseRightDownHandler(
    desktopStore: DesktopStoreContextModel,
    userStore: UserStoreContextModel,
    _ev: MouseEvent) {

  if (desktopStore.contextMenuInfo()) {
    desktopStore.setContextMenuInfo(null);
    mouseMove_handleNoButtonDown(desktopStore);
    return;
  }

  if (desktopStore.editDialogInfo() != null) {
    desktopStore.setEditDialogInfo(null);
    mouseMove_handleNoButtonDown(desktopStore);
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
