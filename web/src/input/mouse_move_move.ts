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

import { GRID_SIZE } from "../constants";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { PositionalItem, asPositionalItem } from "../items/base/positional-item";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { LinkFns, asLinkItem, isLink } from "../items/link-item";
import { PageFns, asPageItem } from "../items/page-item";
import { PlaceholderFns } from "../items/placeholder-item";
import { TableFns, asTableItem, isTable } from "../items/table-item";
import { arrange } from "../layout/arrange";
import { HitboxFlags } from "../layout/hitbox";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VeFns, VisualElement } from "../layout/visual-element";
import { server } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { Vector, getBoundingBoxTopLeft, vectorAdd, vectorSubtract } from "../util/geometry";
import { panic } from "../util/lang";
import { getHitInfo } from "./hit";
import { CursorEventState, MouseAction, MouseActionState } from "./state";
import { asTitledItem } from "../items/base/titled-item";


export function moving_initiate(store: StoreContextModel, activeItem: PositionalItem, activeVisualElement: VisualElement, desktopPosPx: Vector) {
  const shouldCreateLink = CursorEventState.get().shiftDown;
  const parentItem = itemState.get(activeItem.parentId)!;
  if (isTable(parentItem) && activeItem.relationshipToParent == RelationshipToParent.Child) {
    moving_activeItemOutOfTable(store, shouldCreateLink);
    arrange(store);
  }
  else if (activeItem.relationshipToParent == RelationshipToParent.Attachment) {
    const hitInfo = getHitInfo(store, desktopPosPx, [], false);
    moving_activeItemToPage(store, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Attachment, shouldCreateLink);
    arrange(store);
  }
  else if (isComposite(itemState.get(activeItem.parentId)!)) {
    const hitInfo = getHitInfo(store, desktopPosPx, [], false);
    moving_activeItemToPage(store, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Child, shouldCreateLink);
    arrange(store);
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

      store.anItemIsMoving.set(true);
      const activeParentPath = VeFns.parentPath(MouseActionState.get().activeElement);
      const newLinkVeid = VeFns.veidFromId(link.id);
      MouseActionState.get().activeElement = VeFns.addVeidToPath(newLinkVeid, activeParentPath);
      MouseActionState.get().action = MouseAction.Moving; // page arrange depends on this in the grid case.
      MouseActionState.get().linkCreatedOnMoveStart = true;

      arrange(store);
    }
  }

  store.anItemIsMoving.set(true);
  MouseActionState.get().action = MouseAction.Moving;
}


export function mouseAction_moving(deltaPx: Vector, desktopPosPx: Vector, store: StoreContextModel) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElement)!.get();
  const activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));

  let ignoreIds = [activeVisualElement.displayItem.id];
  if (isComposite(activeVisualElement.displayItem)) {
    const compositeItem = asCompositeItem(activeVisualElement.displayItem);
    for (let childId of compositeItem.computed_children) { ignoreIds.push(childId); }
  }
  const hitInfo = getHitInfo(store, desktopPosPx, ignoreIds, false);

  // update move over element state.
  if (MouseActionState.get().moveOver_containerElement == null ||
      MouseActionState.get().moveOver_containerElement! != VeFns.veToPath(hitInfo.overContainerVe!)) {
    if (MouseActionState.get().moveOver_containerElement != null) {
      const veMaybe = VesCache.get(MouseActionState.get().moveOver_containerElement!);
      if (veMaybe) {
        veMaybe!.get().movingItemIsOver.set(false);
      }
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
    moving_activeItemToPage(store, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Child, false);
    arrange(store);
    return;
  }

  if (isTable(hitInfo.overContainerVe!.displayItem)) {
    moving_handleOverTable(store, hitInfo.overContainerVe!, desktopPosPx);
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
  arrange(store);
}


function moving_handleOverTable(store: StoreContextModel, overContainerVe: VisualElement, desktopPx: Vector) {
  const { insertRow, attachmentPos } = TableFns.tableModifiableColRow(store, overContainerVe, desktopPx);
  overContainerVe.moveOverRowNumber.set(insertRow);

  const tableItem = asTableItem(overContainerVe.displayItem);
  const childItem = itemState.get(tableItem.computed_children[insertRow]);
  if (isAttachmentsItem(childItem) || (isLink(childItem) && isAttachmentsItem(itemState.get(LinkFns.getLinkToId(asLinkItem(childItem!))!)))) {
    overContainerVe.moveOverColAttachmentNumber.set(attachmentPos);
  } else {
    overContainerVe.moveOverColAttachmentNumber.set(-1);
  }
}


function moving_activeItemToPage(store: StoreContextModel, moveToVe: VisualElement, desktopPx: Vector, relationshipToParent: string, shouldCreateLink: boolean) {
  const activeElement = VesCache.get(MouseActionState.get().activeElement!)!.get();
  const canonicalActiveItem = asPositionalItem(VeFns.canonicalItem(activeElement));

  const pagePx = VeFns.desktopPxToTopLevelPagePx(store, desktopPx);

  const moveToPage = asPageItem(moveToVe.displayItem);
  let moveToPageAbsoluteBoundsPx;
  if (moveToVe.parentPath == null) {
    // moveToVe is top level page is a special case - the only one where it's appropropriate
    // for dimensions to be that of clientAreaBounds not boundsPx.
    moveToPageAbsoluteBoundsPx = moveToVe.childAreaBoundsPx!;
  } else {
    moveToPageAbsoluteBoundsPx = VeFns.veBoundsRelativeToDestkopPx(store, moveToVe);
  }

  const moveToPageInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(moveToPage);
  const mousePointBl = {
    x: Math.round((pagePx.x - moveToPageAbsoluteBoundsPx.x) / moveToPageAbsoluteBoundsPx.w * moveToPageInnerSizeBl.w * 2.0) / 2.0,
    y: Math.round((pagePx.y - moveToPageAbsoluteBoundsPx.y) / moveToPageAbsoluteBoundsPx.h * moveToPageInnerSizeBl.h * 2.0) / 2.0
  };

  const activeItemDimensionsBl = ItemFns.calcSpatialDimensionsBl(canonicalActiveItem);
  const clickOffsetInActiveItemBl = relationshipToParent == RelationshipToParent.Child
    ? { x: Math.round(activeItemDimensionsBl.w * MouseActionState.get().clickOffsetProp!.x * 2.0) / 2.0,
        y: Math.round(activeItemDimensionsBl.h * MouseActionState.get().clickOffsetProp!.y * 2.0) / 2.0 }
    : { x: 0, y: 0 };
  const startPosBl = vectorSubtract(mousePointBl, clickOffsetInActiveItemBl);
  const newItemPosGr = { x: startPosBl.x * GRID_SIZE, y: startPosBl.y * GRID_SIZE };
  if (moveToVe.parentPath == null) {
    MouseActionState.get().startPx = desktopPx;
  } else {
    MouseActionState.get().startPx = pagePx;
  }
  MouseActionState.get().startPosBl = startPosBl;
  const moveToPath = VeFns.veToPath(moveToVe);

  if (shouldCreateLink && !isLink(activeElement.displayItem)) {
    const link = LinkFns.createFromItem(activeElement.displayItem, RelationshipToParent.Child, itemState.newOrderingAtEndOfChildren(moveToPage.id));
    link.parentId = moveToPage.id;
    link.spatialPositionGr = newItemPosGr;
    itemState.add(link);
    server.addItem(link, null);
    arrange(store); // TODO (LOW): avoid this arrange i think by determining the new activeElement path without the fine.
    let ve = VesCache.find({ itemId: activeElement.displayItem.id, linkIdMaybe: link.id});
    if (ve.length != 1) { panic("moving_activeItemToPage: could not find element."); }
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


function moving_activeItemOutOfTable(store: StoreContextModel, shouldCreateLink: boolean) {
  const activeVisualElement = VesCache.get(MouseActionState.get().activeElement!)!.get();
  const tableVisualElement = VesCache.get(activeVisualElement.parentPath!)!.get();
  const activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));

  const tableItem = asTableItem(tableVisualElement.displayItem);
  const tableBlockHeightPx = tableVisualElement.boundsPx.h / (tableItem.spatialHeightGr / GRID_SIZE);
  let itemPosInTablePx = getBoundingBoxTopLeft(activeVisualElement.boundsPx);
  itemPosInTablePx.y -= store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVisualElement)) * tableBlockHeightPx;
  const tableVe = VesCache.get(activeVisualElement.parentPath!)!.get();
  const tableParentVe = VesCache.get(tableVe.parentPath!)!.get();

  const moveToPage = asPageItem(tableParentVe.displayItem);
  let moveToPageAbsoluteBoundsPx;
  if (tableParentVe.parentPath == null) {
    moveToPageAbsoluteBoundsPx = tableParentVe.childAreaBoundsPx!;
  } else {
    moveToPageAbsoluteBoundsPx = VeFns.veBoundsRelativeToDestkopPx(store, tableParentVe);
  }
  const moveToPageInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(moveToPage);

  const itemPosInPagePx = CursorEventState.getLatestDesktopPx();
  itemPosInPagePx.x -= store.dockWidthPx.get();
  const tableParentPage = asPageItem(tableParentVe.displayItem);
  const itemPosInPageGr = {
    x: itemPosInPagePx.x / tableParentVe!.childAreaBoundsPx!.w * tableParentPage.innerSpatialWidthGr,
    y: itemPosInPagePx.y / tableParentVe!.childAreaBoundsPx!.h * PageFns.calcInnerSpatialDimensionsBl(tableParentPage).h * GRID_SIZE
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
    arrange(store); // TODO (LOW): avoid this arrange i think by determining the new activeElement path without the fine.
    let ve = VesCache.find({ itemId: activeVisualElement.displayItem.id, linkIdMaybe: link.id});
    if (ve.length != 1) { panic("moving_activeItemOutOfTable: could not find element."); }
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
