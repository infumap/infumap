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

import { AttachmentsItem, asAttachmentsItem } from "../items/base/attachments-item";
import { Item } from "../items/base/item";
import { ItemFns } from "../items/base/item-polymorphism";
import { CompositeItem, asCompositeItem, isComposite } from "../items/composite-item";
import { isTable } from "../items/table-item";
import { arrange } from "../layout/arrange";
import { HitboxFlags } from "../layout/hitbox";
import { navigateBack, navigateUp, switchToPage } from "../layout/navigation";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VisualElementFlags, VeFns } from "../layout/visual-element";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { itemState } from "../store/ItemState";
import { UserStoreContextModel } from "../store/UserStoreProvider";
import { isInside } from "../util/geometry";
import { getHitInfo } from "./hit";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { DoubleClickState, DialogMoveState, CursorEventState, MouseAction, MouseActionState, UserSettingsMoveState } from "./state";


export const MOUSE_LEFT = 0;
export const MOUSE_RIGHT = 2;


export async function mouseDownHandler(
    desktopStore: DesktopStoreContextModel,
    userStore: UserStoreContextModel,
    buttonNumber: number) {

  if (desktopStore.currentPage() == null) { return; }

  switch(buttonNumber) {
    case MOUSE_LEFT:
      mouseLeftDownHandler(desktopStore, userStore);
      return;
    case MOUSE_RIGHT:
      await mouseRightDownHandler(desktopStore, userStore);
      return;
    default:
      console.warn("unsupported mouse button: " + buttonNumber);
      return;
  }
}


export function mouseLeftDownHandler(
    desktopStore: DesktopStoreContextModel,
    userStore: UserStoreContextModel) {

  const desktopPosPx = CursorEventState.getLatestDesktopPx();

  if (desktopStore.contextMenuInfo.get() != null) {
    DoubleClickState.preventDoubleClick();
    desktopStore.contextMenuInfo.set(null);
    return;
  }

  let dialogInfo = desktopStore.editDialogInfo.get();
  if (dialogInfo != null) {
    DoubleClickState.preventDoubleClick();
    if (isInside(desktopPosPx, dialogInfo!.desktopBoundsPx)) {
      DialogMoveState.set({ lastMousePosPx: desktopPosPx });
      return;
    }

    desktopStore.editDialogInfo.set(null);
    return;
  }

  let userSettingsInfo = desktopStore.editUserSettingsInfo.get();
  if (userSettingsInfo != null) {
    DoubleClickState.preventDoubleClick();
    if (isInside(desktopPosPx, userSettingsInfo!.desktopBoundsPx)) {
      UserSettingsMoveState.set({ lastMousePosPx: desktopPosPx });
      return;
    }

    desktopStore.editUserSettingsInfo.set(null);
    return;
  }

  const hitInfo = getHitInfo(desktopStore, desktopPosPx, [], false);
  if (hitInfo.hitboxType == HitboxFlags.None) {
    if (hitInfo.overElementVes.get().flags & VisualElementFlags.Popup) {
      DoubleClickState.preventDoubleClick();
      switchToPage(desktopStore, userStore, VeFns.veidFromVe(hitInfo.overElementVes.get()), true, false);
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
  const activeItem = VeFns.canonicalItem(hitInfo.overElementVes.get());
  let boundsOnTopLevelPagePx = VeFns.veBoundsRelativeToDestkopPx(desktopStore, hitInfo.overElementVes.get());
  let onePxSizeBl;
  if (hitInfo.overElementVes.get().flags & VisualElementFlags.Popup) {
    onePxSizeBl = {
      x: (ItemFns.calcSpatialDimensionsBl(hitInfo.overElementVes.get().linkItemMaybe!).w) / boundsOnTopLevelPagePx.w,
      y: ItemFns.calcSpatialDimensionsBl(hitInfo.overElementVes.get().linkItemMaybe!).h / boundsOnTopLevelPagePx.h };
  } else {
    if (hitInfo.compositeHitboxTypeMaybe) {
      const activeCompositeItem = VeFns.canonicalItem(hitInfo.overContainerVe!);
      const compositeBoundsOnTopLevelPagePx = VeFns.veBoundsRelativeToDestkopPx(desktopStore, hitInfo.overContainerVe!);
      onePxSizeBl = {
        x: ItemFns.calcSpatialDimensionsBl(activeCompositeItem).w / compositeBoundsOnTopLevelPagePx.w,
        y: ItemFns.calcSpatialDimensionsBl(activeCompositeItem).h / compositeBoundsOnTopLevelPagePx.h };
    } else {
      onePxSizeBl = {
        x: ItemFns.calcSpatialDimensionsBl(activeItem).w / boundsOnTopLevelPagePx.w,
        y: ItemFns.calcSpatialDimensionsBl(activeItem).h / boundsOnTopLevelPagePx.h };
    }
  }

  let clickOffsetProp = {
    x: (startPx.x - boundsOnTopLevelPagePx.x) / boundsOnTopLevelPagePx.w,
    y: (startPx.y - boundsOnTopLevelPagePx.y) / boundsOnTopLevelPagePx.h
  };
  const startAttachmentsItem = calcStartTableAttachmentsItemMaybe(activeItem);
  const startCompositeItem = calcStartCompositeItemMaybe(activeItem);
  MouseActionState.set({
    activeRoot: VeFns.veToPath(hitInfo.rootVe.flags & VisualElementFlags.Popup ? VesCache.get(hitInfo.rootVe.parentPath!)!.get() : hitInfo.rootVe),
    startActiveElementParent: hitInfo.overElementVes.get().parentPath!,
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
    linkCreatedOnMoveStart: false,
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
  let parent = itemState.get(activeItem.parentId)!;
  if (parent.parentId == null) { return null; }
  if (!isComposite(parent)) { return null; }
  return asCompositeItem(parent);
}


function calcStartTableAttachmentsItemMaybe(activeItem: Item): AttachmentsItem | null {
  if (activeItem == null) { return null; }
  if (activeItem.parentId == null) { return null; }
  if (activeItem.relationshipToParent != RelationshipToParent.Attachment) { return null; }
  let parent = itemState.get(activeItem.parentId)!;
  if (parent.parentId == null) { return null; }
  let parentParent = itemState.get(parent.parentId)!;
  if (!isTable(parentParent)) { return null; }
  return asAttachmentsItem(parent);
}


export async function mouseRightDownHandler(
    desktopStore: DesktopStoreContextModel,
    userStore: UserStoreContextModel) {

  if (desktopStore.contextMenuInfo.get()) {
    desktopStore.contextMenuInfo.set(null);
    mouseMove_handleNoButtonDown(desktopStore, userStore.getUserMaybe() != null);
    return;
  }

  if (desktopStore.editDialogInfo.get() != null) {
    desktopStore.editDialogInfo.set(null);
    mouseMove_handleNoButtonDown(desktopStore, userStore.getUserMaybe() != null);
    return;
  }

  if (desktopStore.editUserSettingsInfo.get() != null) {
    desktopStore.editUserSettingsInfo.set(null);
    mouseMove_handleNoButtonDown(desktopStore, userStore.getUserMaybe() != null);
    return;
  }

  const changedPages = navigateBack(desktopStore, userStore);
  if (!changedPages) {
    await navigateUp(desktopStore, userStore);
  }
}
