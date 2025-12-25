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

import { ATTACH_AREA_SIZE_PX, DOCK_GAP_PX, NATURAL_BLOCK_SIZE_PX, RESIZE_BOX_SIZE_PX } from "../../constants";
import { CursorEventState, MouseAction, MouseActionState } from "../../input/state";
import { Item } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asLinkItem, isLink } from "../../items/link-item";
import { isAttachmentsItem } from "../../items/base/attachments-item";
import { ArrangeAlgorithm, PageItem, asPageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { IndexAndPosition } from "../../store/StoreProvider_PerVe";
import { zeroBoundingBoxTopLeft } from "../../util/geometry";
import { VisualElementSignal } from "../../util/signals";
import { HitboxFlags, HitboxFns } from "../hitbox";
import { initiateLoadChildItemsMaybe, initiateLoadItemMaybe } from "../load";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeItem } from "./item";


export const renderDockMaybe = (
  store: StoreContextModel,
  parentPath: VisualElementPath): VisualElementSignal | null => {

  if (store.user.getUserMaybe() == null) {
    return null;
  }

  if (itemState.get(store.user.getUser().dockPageId) == null) {
    initiateLoadItemMaybe(store, store.user.getUser().dockPageId);
    return null;
  }

  const dockPageId = store.user.getUser().dockPageId;
  initiateLoadChildItemsMaybe(store, { itemId: dockPageId, linkIdMaybe: null });

  const dockPage = asPageItem(itemState.get(store.user.getUser().dockPageId)!);
  const dockPath = VeFns.addVeidToPath({ itemId: dockPageId, linkIdMaybe: null }, parentPath);

  let movingItemInThisPage = null;
  if (!MouseActionState.empty() && (MouseActionState.get().action == MouseAction.Moving)) {
    movingItemInThisPage = VeFns.treeItemFromPath(MouseActionState.get().activeElementPath);
    if (movingItemInThisPage!.parentId != dockPage.id) {
      movingItemInThisPage = null;
    }
  }

  const dockWidthPx = store.getCurrentDockWidthPx();

  let yCurrentPx = 0;
  const dockChildren = [];
  for (let i = 0; i < dockPage.computed_children.length; ++i) {
    const childId = dockPage.computed_children[i];
    const childItem = itemState.get(childId)!;
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;

    if (movingItemInThisPage && childItem.id == movingItemInThisPage!.id) {
      continue;
    }

    let wPx = dockWidthPx - DOCK_GAP_PX * 3;
    if (wPx < 0) { wPx = 0; }
    const cellBoundsPx = { x: DOCK_GAP_PX * 1.25, y: 0, w: wPx, h: dockWidthPx * 10 };
    const geometry = ItemFns.calcGeometry_InCell(childItem, cellBoundsPx, false, false, true, false, false, false, false, true, store.smallScreenMode());

    const hasAttachHb = geometry.hitboxes.some(hb => (hb.type & HitboxFlags.Attach) !== 0);
    if (!hasAttachHb && isAttachmentsItem(childItem)) {
      const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);
      geometry.hitboxes.push(
        HitboxFns.create(
          HitboxFlags.Attach,
          { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }
        )
      );
    }

    let viewportOffsetPx = 0;
    if (geometry.viewportBoundsPx) {
      viewportOffsetPx = geometry.viewportBoundsPx.y - geometry.boundsPx.y;
    }

    geometry.boundsPx.y = DOCK_GAP_PX + yCurrentPx;
    if (geometry.viewportBoundsPx) {
      geometry.viewportBoundsPx.y = geometry.boundsPx.y + viewportOffsetPx;
    }
    yCurrentPx += geometry.boundsPx.h + DOCK_GAP_PX;

    if (dockWidthPx > NATURAL_BLOCK_SIZE_PX.w * 2 + 1) {
      const ves = arrangeItem(
        store, dockPath, ArrangeAlgorithm.Dock, childItem, actualLinkItemMaybe, geometry,
        ArrangeItemFlags.IsDockRoot | ArrangeItemFlags.RenderChildrenAsFull);
      dockChildren.push(ves);
    }
  }
  yCurrentPx += DOCK_GAP_PX;

  if (movingItemInThisPage) {
    const actualLinkItemMaybe = isLink(movingItemInThisPage) ? asLinkItem(movingItemInThisPage) : null;

    const mouseDesktopPosPx = CursorEventState.getLatestDesktopPx(store);
    const cellGeometry = ItemFns.calcGeometry_Natural(movingItemInThisPage, mouseDesktopPosPx);
    const ves = arrangeItem(
      store, dockPath, ArrangeAlgorithm.Dock, movingItemInThisPage, actualLinkItemMaybe, cellGeometry,
      ArrangeItemFlags.IsDockRoot | ArrangeItemFlags.RenderChildrenAsFull);
    dockChildren.push(ves);
  }

  let trashHeightPx = 50;
  if (dockWidthPx - DOCK_GAP_PX * 2 < trashHeightPx) {
    trashHeightPx = dockWidthPx - DOCK_GAP_PX * 2;
    if (trashHeightPx < 0) { trashHeightPx = 0; }
  }

  const dockBoundsPx = {
    x: 0, y: 0,
    w: dockWidthPx,
    h: store.desktopBoundsPx().h
  };

  const resizeBoundsPx = zeroBoundingBoxTopLeft(dockBoundsPx);
  resizeBoundsPx.w = RESIZE_BOX_SIZE_PX;
  resizeBoundsPx.x = dockWidthPx - RESIZE_BOX_SIZE_PX;

  const dockSpec: VisualElementSpec = {
    displayItem: dockPage,
    linkItemMaybe: null,
    flags: VisualElementFlags.IsDock | VisualElementFlags.ShowChildren,
    _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
    boundsPx: dockBoundsPx,
    viewportBoundsPx: dockBoundsPx,
    childAreaBoundsPx: zeroBoundingBoxTopLeft(dockBoundsPx),
    hitboxes: [
      HitboxFns.create(HitboxFlags.HorizontalResize, resizeBoundsPx),
    ],
    parentPath,
  };

  const dockRelationships: VisualElementRelationships = {
    childrenVes: dockChildren,
  };

  if (itemState.get(store.user.getUser().trashPageId) == null) {
    initiateLoadItemMaybe(store, store.user.getUser().trashPageId);
  } else {
    const trashPage = asPageItem(itemState.get(store.user.getUser().trashPageId)!);
    const trashBoundsPx = {
      x: DOCK_GAP_PX,
      y: store.desktopBoundsPx().h - trashHeightPx - DOCK_GAP_PX * 2,
      w: dockWidthPx - DOCK_GAP_PX * 2,
      h: trashHeightPx,
    }
    const innerBoundsPx = zeroBoundingBoxTopLeft(trashBoundsPx);
    const trashVisualElementSpec: VisualElementSpec = {
      displayItem: trashPage,
      linkItemMaybe: null,
      flags: VisualElementFlags.IsTrash,
      _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
      boundsPx: trashBoundsPx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.OpenPopup, innerBoundsPx),
      ],
      parentPath: dockPath,
    };
    const trashRelationships: VisualElementRelationships = {};

    if (dockWidthPx > 25) {
      const trashPath = VeFns.addVeidToPath({ itemId: trashPage.id, linkIdMaybe: null }, dockPath);
      dockChildren.push(VesCache.full_createOrRecycleVisualElementSignal(trashVisualElementSpec, trashRelationships, trashPath));
    }
  }

  return VesCache.full_createOrRecycleVisualElementSignal(dockSpec, dockRelationships, dockPath);
}

export function dockInsertIndexAndPositionFromDesktopY(store: StoreContextModel, dockItem: PageItem, movingItem: Item, dockWidthPx: number, desktopYPx: number): IndexAndPosition {
  let positionIndex = 0;
  let yCurrentPx = 0;
  for (let i = 0; i < dockItem.computed_children.length; ++i) {
    positionIndex = i;
    const childId = dockItem.computed_children[i];
    const childItem = itemState.get(childId)!;

    if (childItem.id == movingItem!.id) {
      continue;
    }

    let wPx = dockWidthPx - DOCK_GAP_PX * 3;
    if (wPx < 0) { wPx = 0; }
    const cellBoundsPx = { x: DOCK_GAP_PX * 1.25, y: 0, w: wPx, h: dockWidthPx * 10 };
    const geometry = ItemFns.calcGeometry_InCell(childItem, cellBoundsPx, false, false, true, false, false, false, false, true, store.smallScreenMode());

    let viewportOffsetPx = 0;
    if (geometry.viewportBoundsPx) {
      viewportOffsetPx = geometry.viewportBoundsPx.y - geometry.boundsPx.y;
    }

    geometry.boundsPx.y = DOCK_GAP_PX + yCurrentPx;
    if (geometry.viewportBoundsPx) {
      geometry.viewportBoundsPx.y = geometry.boundsPx.y + viewportOffsetPx;
    }

    const newYPx = yCurrentPx + geometry.boundsPx.h + DOCK_GAP_PX;
    if (newYPx > desktopYPx) { break; }
    yCurrentPx = newYPx;
  }

  return { index: positionIndex, position: yCurrentPx + 1 };
}
