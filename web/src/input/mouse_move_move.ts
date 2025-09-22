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

import { GRID_SIZE, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX, CALENDAR_DAY_ROW_HEIGHT_BL } from "../constants";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { PositionalItem, asPositionalItem, isPositionalItem } from "../items/base/positional-item";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { LinkFns, asLinkItem, isLink } from "../items/link-item";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../items/page-item";
import { PlaceholderFns } from "../items/placeholder-item";
import { calculateCalendarPosition, encodeCalendarCombinedIndex } from "../util/calendar-layout";
import { TableFns, asTableItem, isTable } from "../items/table-item";
import { fullArrange } from "../layout/arrange";
import { HitboxFlags } from "../layout/hitbox";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VeFns, Veid, VisualElement, VisualElementFlags } from "../layout/visual-element";
import { server } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { Vector, compareVector, getBoundingBoxTopLeft, vectorAdd, vectorSubtract } from "../util/geometry";
import { assert, currentUnixTimeSeconds, panic } from "../util/lang";
import { HitInfoFns } from "./hit";
import { CursorEventState, MouseAction, MouseActionState } from "./state";
import { dockInsertIndexAndPositionFromDesktopY } from "../layout/arrange/dock";
import { asContainerItem } from "../items/base/container-item";
import { newUid } from "../util/uid";
import { maybeAddNewChildItems } from "./create";
import { isDataItem } from "../items/base/data-item";
import createJustifiedLayout from "justified-layout";
import { createJustifyOptions } from "../layout/arrange/page_justified";




export function moving_initiate(store: StoreContextModel, activeItem: PositionalItem, activeVisualElement: VisualElement, desktopPosPx: Vector) {
  const isActiveLinkItem = isLink(activeItem);
  const shiftWantsClone = CursorEventState.get().shiftDown && !isDataItem(activeVisualElement.displayItem);
  const shouldCreateLink = CursorEventState.get().ctrlDown || (shiftWantsClone && isActiveLinkItem);
  const shouldClone = shiftWantsClone && !isActiveLinkItem; // For link items, shift behaves like ctrl (create link)
  const parentItem = itemState.get(activeItem.parentId)!;
      if (isTable(parentItem) && activeItem.relationshipToParent == RelationshipToParent.Child) {
      moving_activeItemOutOfTable(store, shouldCreateLink, shouldClone);
      fullArrange(store);
    }
    else if (activeItem.relationshipToParent == RelationshipToParent.Attachment) {
      const hitInfo = HitInfoFns.hit(store, desktopPosPx, [], false);
      moving_activeItemToPage(store, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Attachment, shouldCreateLink, shouldClone);
      fullArrange(store);
    }
    else if (isComposite(itemState.get(activeItem.parentId)!)) {
      const hitInfo = HitInfoFns.hit(store, desktopPosPx, [activeItem.id], false);
      moving_activeItemToPage(store, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Child, shouldCreateLink, shouldClone);
      fullArrange(store);
    }
  else {
    MouseActionState.get().startPosBl = {
      x: activeItem.spatialPositionGr.x / GRID_SIZE,
      y: activeItem.spatialPositionGr.y / GRID_SIZE
    };

    // Setup group move if the active item is part of the current selection set
    const selected = store.overlay.selectedVeids.get();
    if (selected && selected.length > 0) {
      const isActiveSelected = selected.some(v => {
        const veid = VeFns.veidFromVe(activeVisualElement);
        return v.itemId === veid.itemId && v.linkIdMaybe === veid.linkIdMaybe;
      });
      if (isActiveSelected) {
        const group = selected
          .map(v => ({ veid: v, item: itemState.get(v.linkIdMaybe ? v.linkIdMaybe : v.itemId)! }))
          .filter(e => isPositionalItem(e.item))
          .map(e => ({
            veid: e.veid,
            startPosGr: (e.item as PositionalItem).spatialPositionGr,
            parentId: (e.item as PositionalItem).parentId,
          }));
        MouseActionState.get().groupMoveItems = group;
      } else {
        MouseActionState.get().groupMoveItems = undefined;
      }
    } else {
      MouseActionState.get().groupMoveItems = undefined;
    }

    if (shouldClone) {
      const toClone = activeVisualElement.displayItem;
      const cloned = ItemFns.fromObject(ItemFns.toObject(toClone), null);
      cloned.id = newUid();
      cloned.creationDate = currentUnixTimeSeconds();
      cloned.lastModifiedDate = currentUnixTimeSeconds();
      cloned.dateTime = currentUnixTimeSeconds();
      cloned.ordering = itemState.newOrderingAtEndOfChildren(cloned.parentId);
      itemState.add(cloned);
      server.addItem(cloned, null, store.general.networkStatus);
      if (isPositionalItem(cloned)) {
        maybeAddNewChildItems(store, asPositionalItem(cloned));
      }

      const activeParentPath = VeFns.parentPath(MouseActionState.get().activeElementPath);
      const newLinkVeid = VeFns.veidFromId(cloned.id);
      MouseActionState.get().activeElementPath = VeFns.addVeidToPath(newLinkVeid, activeParentPath);
      const updatedSignal = VesCache.get(MouseActionState.get().activeElementPath) ?? MouseActionState.get().activeElementSignalMaybe;
      MouseActionState.get().activeElementSignalMaybe = updatedSignal;
      if (updatedSignal) {
        MouseActionState.get().activeLinkIdMaybe = updatedSignal.get().actualLinkItemMaybe?.id ?? updatedSignal.get().linkItemMaybe?.id ?? null;
        MouseActionState.get().activeLinkedDisplayItemMaybe = MouseActionState.get().activeLinkIdMaybe ? updatedSignal.get().displayItem : null;
      }
      MouseActionState.get().action = MouseAction.Moving; // page arrange depends on this in the grid case.
      MouseActionState.get().linkCreatedOnMoveStart = false;

      // Preserve calendar page scroll position during fullArrange
      const parentPageVeid = VeFns.veidFromPath(activeParentPath);
      const parentPage = itemState.get(parentPageVeid.itemId)!;
      let savedScrollY = null;
      let savedScrollX = null;
      if (isPage(parentPage) && asPageItem(parentPage).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
        savedScrollY = store.perItem.getPageScrollYProp(parentPageVeid);
        savedScrollX = store.perItem.getPageScrollXProp(parentPageVeid);
      }

      fullArrange(store);

      // Restore calendar page scroll position
      if (savedScrollY !== null && savedScrollX !== null) {
        store.perItem.setPageScrollYProp(parentPageVeid, savedScrollY);
        store.perItem.setPageScrollXProp(parentPageVeid, savedScrollX);
      }
    }
    else if (shouldCreateLink && !isLink(activeVisualElement.displayItem)) {
      const link = LinkFns.createFromItem(
        activeVisualElement.displayItem,
        activeItem.parentId,
        RelationshipToParent.Child,
        itemState.newOrderingDirectlyAfterChild(activeItem.parentId, activeItem.id));
      link.spatialPositionGr = activeItem.spatialPositionGr;
      if (activeVisualElement.linkItemMaybe) {
        link.spatialWidthGr = activeVisualElement.linkItemMaybe.spatialWidthGr;
        link.spatialHeightGr = activeVisualElement.linkItemMaybe.spatialHeightGr;
      } else {
        if (isXSizableItem(activeVisualElement.displayItem)) {
          link.spatialWidthGr = asXSizableItem(activeVisualElement.displayItem).spatialWidthGr;
        }
        if (isYSizableItem(activeVisualElement.displayItem)) {
          link.spatialHeightGr = asYSizableItem(activeVisualElement.displayItem).spatialHeightGr;
        }
      }
      itemState.add(link);
      server.addItem(link, null, store.general.networkStatus);

      const activeParentPath = VeFns.parentPath(MouseActionState.get().activeElementPath);
      const newLinkVeid = VeFns.veidFromId(link.id);
      MouseActionState.get().activeElementPath = VeFns.addVeidToPath(newLinkVeid, activeParentPath);
      const updatedSignal = VesCache.get(MouseActionState.get().activeElementPath) ?? MouseActionState.get().activeElementSignalMaybe;
      MouseActionState.get().activeElementSignalMaybe = updatedSignal;
      if (updatedSignal) {
        MouseActionState.get().activeLinkIdMaybe = updatedSignal.get().actualLinkItemMaybe?.id ?? updatedSignal.get().linkItemMaybe?.id ?? null;
        MouseActionState.get().activeLinkedDisplayItemMaybe = MouseActionState.get().activeLinkIdMaybe ? updatedSignal.get().displayItem : null;
      }
      MouseActionState.get().action = MouseAction.Moving; // page arrange depends on this in the grid case.
      MouseActionState.get().linkCreatedOnMoveStart = true;

      // Preserve calendar page scroll position during fullArrange
      const parentPageVeid = VeFns.veidFromPath(activeParentPath);
      const parentPage = itemState.get(parentPageVeid.itemId)!;
      let savedScrollY = null;
      let savedScrollX = null;
      if (isPage(parentPage) && asPageItem(parentPage).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
        savedScrollY = store.perItem.getPageScrollYProp(parentPageVeid);
        savedScrollX = store.perItem.getPageScrollXProp(parentPageVeid);
      }

      fullArrange(store);

      // Restore calendar page scroll position
      if (savedScrollY !== null && savedScrollX !== null) {
        store.perItem.setPageScrollYProp(parentPageVeid, savedScrollY);
        store.perItem.setPageScrollXProp(parentPageVeid, savedScrollX);
      }
    }

    if (MouseActionState.get().hitboxTypeOnMouseDown & HitboxFlags.ContentEditable) {
      let selection = window.getSelection();
      if (selection != null) { selection.removeAllRanges(); }
      (document.activeElement! as HTMLElement).blur();
    }
  }

  // if it is a selected list page that is moving, change the selected item.
  if (isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
    const parentPath = VeFns.parentPath(MouseActionState.get().activeElementPath);
    const selected = store.perItem.getSelectedListPageItem(VeFns.veidFromPath(parentPath));

    if (selected && VeFns.compareVeids(selected, VeFns.veidFromPath(MouseActionState.get().activeElementPath) ) === 0) {
      const children = asPageItem(parentItem).computed_children;
      let foundIdx = -1;
      for (let i=0; i<children.length; i++) {
        const child = itemState.get(children[i])!;
        if (isLink(child)) {
          const link = asLinkItem(child);
          const linkToId = LinkFns.getLinkToId(link);
          const linkVeid = VeFns.veidFromItems(itemState.get(linkToId)!, link);
          if (VeFns.compareVeids(linkVeid, selected) === 0) {
            foundIdx = i;
            break;
          }
        } else {
          const veid = { itemId: children[i], linkIdMaybe: null };
          if (VeFns.compareVeids(veid, selected) === 0) {
            foundIdx = i;
            break;
          }
        }
      }

      if (foundIdx != -1) {
        let newSelectedIdx = foundIdx;
        if (foundIdx > 0) {
          newSelectedIdx = foundIdx - 1;
        }
        if (newSelectedIdx >= children.length - 1) {
          newSelectedIdx = -1;
        }

        const child = itemState.get(children[newSelectedIdx])!;
        let veid: Veid = { itemId: children[newSelectedIdx]!, linkIdMaybe: null };
        if (isLink(child)) {
          const link = asLinkItem(child);
          const linkToId = LinkFns.getLinkToId(link);
          veid = VeFns.veidFromItems(itemState.get(linkToId)!, link);
        }
        store.perItem.setSelectedListPageItem(VeFns.veidFromPath(parentPath), veid);
      }
    }
  }

  store.anItemIsMoving.set(true);
  MouseActionState.get().action = MouseAction.Moving;
}


export function mouseAction_moving(deltaPx: Vector, desktopPosPx: Vector, store: StoreContextModel) {
  const activeVisualElementSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeVisualElementSignal) {
    store.anItemIsMoving.set(false);
    return;
  }
  const activeVisualElement = activeVisualElementSignal.get();
  const activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  let ignoreIds = [activeVisualElement.displayItem.id];
  if (isComposite(activeVisualElement.displayItem)) {
    const compositeItem = asCompositeItem(activeVisualElement.displayItem);
    for (let childId of compositeItem.computed_children) {
      ignoreIds.push(childId);
      const item = itemState.get(childId);
      if (isLink(item)) {
        ignoreIds.push(LinkFns.getLinkToId(asLinkItem(item!)));
      }
    }
  }

  const hitInfo = HitInfoFns.hit(store, desktopPosPx, ignoreIds, MouseActionState.get().hitEmbeddedInteractive);

  // update move over element state.
  if (MouseActionState.get().moveOver_containerElement == null ||
      MouseActionState.get().moveOver_containerElement! != VeFns.veToPath(HitInfoFns.getOverContainerVe(hitInfo, ignoreIds))) {
    if (MouseActionState.get().moveOver_containerElement != null) {
      const veMaybe = VesCache.get(MouseActionState.get().moveOver_containerElement!);
      if (veMaybe) {
        store.perVe.setMovingItemIsOver(VeFns.veToPath(veMaybe!.get()), false);
      }
    }

    store.perVe.setMovingItemIsOver(VeFns.veToPath(HitInfoFns.getOverContainerVe(hitInfo, ignoreIds)), true);
    MouseActionState.get().moveOver_containerElement = VeFns.veToPath(HitInfoFns.getOverContainerVe(hitInfo, ignoreIds));
  }

  // update move over attach state.
  if (MouseActionState.get().moveOver_attachHitboxElement != null) {
    const ve = VesCache.get(MouseActionState.get().moveOver_attachHitboxElement!)!.get();
    store.perVe.setMovingItemIsOverAttach(VeFns.veToPath(ve), false);
  }
  if (hitInfo.hitboxType & HitboxFlags.Attach) {
    store.perVe.setMovingItemIsOverAttach(VeFns.veToPath(hitInfo.overVes!.get()), true);
    MouseActionState.get().moveOver_attachHitboxElement = VeFns.veToPath(hitInfo.overVes!.get());
  } else {
    MouseActionState.get().moveOver_attachHitboxElement = null;
  }

  // update move over attach composite state.
  if (MouseActionState.get().moveOver_attachCompositeHitboxElement != null) {
    const ve = VesCache.get(MouseActionState.get().moveOver_attachCompositeHitboxElement!)!.get();
    store.perVe.setMovingItemIsOverAttachComposite(VeFns.veToPath(ve), false);
  }
  if (hitInfo.hitboxType & HitboxFlags.AttachComposite) {
    store.perVe.setMovingItemIsOverAttachComposite(VeFns.veToPath(hitInfo.overVes!.get()), true);
    MouseActionState.get().moveOver_attachCompositeHitboxElement = VeFns.veToPath(hitInfo.overVes!.get());
  } else {
    MouseActionState.get().moveOver_attachCompositeHitboxElement = null;
  }

  if (VesCache.get(MouseActionState.get().moveOver_scaleDefiningElement!)!.get().displayItem != hitInfo.overPositionableVe!.displayItem) {
    moving_activeItemToPage(store, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Child, false, false);
    fullArrange(store);
    return;
  }

  const tableContainerVeMaybe = HitInfoFns.getTableContainerVe(hitInfo);
  if (tableContainerVeMaybe) {
    moving_handleOverTable(store, tableContainerVeMaybe, desktopPosPx);
  }

  const deltaBl = {
    x: deltaPx.x * MouseActionState.get().onePxSizeBl.x,
    y: deltaPx.y * MouseActionState.get().onePxSizeBl.y
  };

  let newPosBl = vectorAdd(MouseActionState.get().startPosBl!, deltaBl);
  newPosBl.x = Math.round(newPosBl.x * 2.0) / 2.0;
  newPosBl.y = Math.round(newPosBl.y * 2.0) / 2.0;
  const inElementVe = VesCache.get(MouseActionState.get().moveOver_scaleDefiningElement!)!.get();
  const inElement = inElementVe.displayItem;
  const dimBl = PageFns.calcInnerSpatialDimensionsBl(asPageItem(inElement));
  if (newPosBl.x < 0.0) { newPosBl.x = 0.0; }
  if (newPosBl.y < 0.0) { newPosBl.y = 0.0; }
  if (newPosBl.x > dimBl.w - 0.5) { newPosBl.x = dimBl.w - 0.5; }
  if (newPosBl.y > dimBl.h - 0.5) { newPosBl.y = dimBl.h - 0.5; }
  const newPosGr = { x: newPosBl.x * GRID_SIZE, y: newPosBl.y * GRID_SIZE };

  if (asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Grid) {
    const xAdj = (inElementVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) ||
                 (inElementVe.flags & VisualElementFlags.Popup)
      ? store.getCurrentDockWidthPx()
      : 0.0;
    const xOffsetPx = desktopPosPx.x - (inElementVe.viewportBoundsPx!.x + xAdj);
    const yOffsetPx = desktopPosPx.y - inElementVe.viewportBoundsPx!.y;
    const veid = VeFns.veidFromVe(inElementVe);
    const scrollYPx = store.perItem.getPageScrollYProp(veid)
      * (inElementVe.childAreaBoundsPx!.h - inElementVe.viewportBoundsPx!.h);
    const scrollXPx = store.perItem.getPageScrollXProp(veid)
      * (inElementVe.childAreaBoundsPx!.w - inElementVe.viewportBoundsPx!.w);
    const cellX = Math.floor((xOffsetPx + scrollXPx) / inElementVe.cellSizePx!.w);
    const cellY = Math.floor((yOffsetPx + scrollYPx) / inElementVe.cellSizePx!.h);
    let index = cellY * asPageItem(inElement).gridNumberOfColumns + cellX;
    const numChildren = asContainerItem(inElement).computed_children.length;
    if (index >= numChildren) { index = numChildren - 1; } // numChildren is inclusive of the moving item so -1.
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), index);
  }

  else if (asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Justified) {
    const moveOverIndex = calculateJustifiedMoveOverIndex(store, inElementVe, activeItem, desktopPosPx);
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), moveOverIndex);
  }

  else if (asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.List) {
    // TODO (HIGH): consider list scroll position.
    const numChildren = asContainerItem(inElement).computed_children.length;
    const yOffsetPx = desktopPosPx.y - inElementVe.viewportBoundsPx!.y - LIST_PAGE_TOP_PADDING_PX;
    let index = Math.round(yOffsetPx / LINE_HEIGHT_PX);
    if (index < 0) { index = 0; }
    if (index >= numChildren) { index = numChildren - 1; } // numChildren is inclusive of the moving item, so -1.
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), index);
  }

  else if (asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
    // Calculate which month and day the mouse is over using scaled childAreaBoundsPx
    const position = calculateCalendarPosition(desktopPosPx, inElementVe, store);
    const combinedIndex = encodeCalendarCombinedIndex(position.month, position.day);
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), combinedIndex);
  }

  const dockWidthPx = store.getCurrentDockWidthPx();

  if (inElementVe.flags & VisualElementFlags.IsDock) {
    const indexAndPosition = dockInsertIndexAndPositionFromDesktopY(store, asPageItem(inElement), activeItem, dockWidthPx, desktopPosPx.y);
    store.perVe.setMoveOverIndexAndPosition(VeFns.veToPath(inElementVe), indexAndPosition);
  }

  if (asPageItem(inElement).arrangeAlgorithm != ArrangeAlgorithm.SpatialStretch || compareVector(newPosGr, activeItem.spatialPositionGr) != 0) {
    const group = MouseActionState.get().groupMoveItems;
    if (group && group.length > 0) {
      const veidActive = VeFns.veidFromVe(activeVisualElement);
      const activeEntry = group.find(g => g.veid.itemId === veidActive.itemId && g.veid.linkIdMaybe === veidActive.linkIdMaybe);
      const deltaFromStart = {
        x: newPosGr.x - (activeEntry ? activeEntry.startPosGr.x : activeItem.spatialPositionGr.x),
        y: newPosGr.y - (activeEntry ? activeEntry.startPosGr.y : activeItem.spatialPositionGr.y),
      };
      for (const g of group) {
        const itm = asPositionalItem(itemState.get(g.veid.linkIdMaybe ? g.veid.linkIdMaybe : g.veid.itemId)!);
        if (itm.parentId === activeItem.parentId) {
          itm.spatialPositionGr = { x: g.startPosGr.x + deltaFromStart.x, y: g.startPosGr.y + deltaFromStart.y };
        }
      }
      fullArrange(store);
    } else {
      activeItem.spatialPositionGr = newPosGr;
      fullArrange(store);
    }
  }
}


function moving_handleOverTable(store: StoreContextModel, overContainerVe: VisualElement, desktopPx: Vector) {
  assert(isTable(overContainerVe.displayItem), "overContainerVe is not a table");
  const { insertRow, attachmentPos } = TableFns.tableModifiableColRow(store, overContainerVe, desktopPx);
  store.perVe.setMoveOverRowNumber(VeFns.veToPath(overContainerVe), insertRow);

  const tableItem = asTableItem(overContainerVe.displayItem);
  const childItem = itemState.get(tableItem.computed_children[insertRow]);
  if (isAttachmentsItem(childItem) || (isLink(childItem) && isAttachmentsItem(itemState.get(LinkFns.getLinkToId(asLinkItem(childItem!))!)))) {
    store.perVe.setMoveOverColAttachmentNumber(VeFns.veToPath(overContainerVe), attachmentPos);
  } else {
    store.perVe.setMoveOverColAttachmentNumber(VeFns.veToPath(overContainerVe), -1);
  }
}


function moving_activeItemToPage(store: StoreContextModel, moveToVe: VisualElement, desktopPx: Vector, relationshipToParent: string, shouldCreateLink: boolean, shouldClone: boolean) {
  const activeSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeSignal) {
    store.anItemIsMoving.set(false);
    return;
  }
  const activeElement = activeSignal.get();
  const treeActiveItem = asPositionalItem(VeFns.treeItem(activeElement));

  const pagePx = VeFns.desktopPxToTopLevelPagePx(store, desktopPx);

  const moveToPage = asPageItem(moveToVe.displayItem);
  const moveToPageAbsoluteBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, moveToVe);

  const moveToPageInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(moveToPage);

  const mousePointBl = {
    x: Math.round((pagePx.x - moveToPageAbsoluteBoundsPx.x) / moveToPageAbsoluteBoundsPx.w * moveToPageInnerSizeBl.w * 2.0) / 2.0,
    y: Math.round((pagePx.y - moveToPageAbsoluteBoundsPx.y) / moveToPageAbsoluteBoundsPx.h * moveToPageInnerSizeBl.h * 2.0) / 2.0
  };

  const activeItemDimensionsBl = ItemFns.calcSpatialDimensionsBl(treeActiveItem);
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

  if (shouldClone && isPositionalItem(activeElement.displayItem)) {
    const toClone = activeElement.displayItem;
    const cloned = asPositionalItem(ItemFns.fromObject(ItemFns.toObject(toClone), null));
    cloned.id = newUid();
    cloned.creationDate = currentUnixTimeSeconds();
    cloned.lastModifiedDate = currentUnixTimeSeconds();
    cloned.dateTime = currentUnixTimeSeconds();
    cloned.ordering = itemState.newOrderingAtEndOfChildren(cloned.parentId);
    cloned.spatialPositionGr = newItemPosGr;
    cloned.parentId = moveToPage.id;
    itemState.add(cloned);
    server.addItem(cloned, null, store.general.networkStatus);
    maybeAddNewChildItems(store, asPositionalItem(cloned));

    fullArrange(store);
    let ve = VesCache.findSingle({ itemId: cloned.id, linkIdMaybe: null });
    MouseActionState.get().activeElementPath = VeFns.veToPath(ve.get());
    MouseActionState.get().activeElementSignalMaybe = ve;
    MouseActionState.get().activeLinkIdMaybe = ve.get().actualLinkItemMaybe?.id ?? ve.get().linkItemMaybe?.id ?? null;
    MouseActionState.get().activeLinkedDisplayItemMaybe = MouseActionState.get().activeLinkIdMaybe ? ve.get().displayItem : null;
    MouseActionState.get().linkCreatedOnMoveStart = false;


  } else if (shouldCreateLink && !isLink(activeElement.displayItem)) {
    const link = LinkFns.createFromItem(activeElement.displayItem, moveToPage.id, RelationshipToParent.Child, itemState.newOrderingAtEndOfChildren(moveToPage.id));
    link.spatialPositionGr = newItemPosGr;
    if (activeElement.linkItemMaybe) {
      link.spatialWidthGr = activeElement.linkItemMaybe.spatialWidthGr;
      link.spatialHeightGr = activeElement.linkItemMaybe.spatialHeightGr;
    }
    itemState.add(link);
    server.addItem(link, null, store.general.networkStatus);
    fullArrange(store); // TODO (LOW): avoid this arrange i think by determining the new activeElement path without the fine.
    let ve = VesCache.findSingle({ itemId: activeElement.displayItem.id, linkIdMaybe: link.id });
    MouseActionState.get().activeElementPath = VeFns.veToPath(ve.get());
    MouseActionState.get().activeElementSignalMaybe = ve;
    MouseActionState.get().activeLinkIdMaybe = ve.get().actualLinkItemMaybe?.id ?? ve.get().linkItemMaybe?.id ?? null;
    MouseActionState.get().activeLinkedDisplayItemMaybe = MouseActionState.get().activeLinkIdMaybe ? ve.get().displayItem : null;
    MouseActionState.get().linkCreatedOnMoveStart = true;

  } else {
    if (relationshipToParent == RelationshipToParent.Attachment) {
      const oldActiveItemOrdering = treeActiveItem.ordering;
      const parent = asAttachmentsItem(itemState.get(treeActiveItem.parentId)!);
      const isLast = parent.computed_attachments[asAttachmentsItem(parent).computed_attachments.length-1] == treeActiveItem.id;
      if (!isLast) {
        const placeholderItem = PlaceholderFns.create(treeActiveItem.ownerId, parent.id, RelationshipToParent.Attachment, oldActiveItemOrdering);
        itemState.add(placeholderItem);
        MouseActionState.get().newPlaceholderItem = placeholderItem;
      }
      MouseActionState.get().startAttachmentsItem = parent;
    }

    treeActiveItem.spatialPositionGr = newItemPosGr;
    itemState.moveToNewParent(treeActiveItem, moveToPage.id, RelationshipToParent.Child);

    MouseActionState.get().activeElementPath = VeFns.addVeidToPath(VeFns.veidFromVe(activeElement), moveToPath);
    const refreshedSignal = VesCache.get(MouseActionState.get().activeElementPath) ?? activeSignal;
    MouseActionState.get().activeElementSignalMaybe = refreshedSignal;
    if (refreshedSignal) {
      MouseActionState.get().activeLinkIdMaybe = refreshedSignal.get().actualLinkItemMaybe?.id ?? refreshedSignal.get().linkItemMaybe?.id ?? null;
      MouseActionState.get().activeLinkedDisplayItemMaybe = MouseActionState.get().activeLinkIdMaybe ? refreshedSignal.get().displayItem : null;
    }
  }

  MouseActionState.get().onePxSizeBl = {
    x: moveToPageInnerSizeBl.w / moveToVe.childAreaBoundsPx!.w,
    y: moveToPageInnerSizeBl.h / moveToVe.childAreaBoundsPx!.h
  };

  MouseActionState.get().moveOver_scaleDefiningElement = moveToPath;
}


function moving_activeItemOutOfTable(store: StoreContextModel, shouldCreateLink: boolean, shouldClone: boolean) {
  const activeSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeSignal) {
    store.anItemIsMoving.set(false);
    return;
  }
  const activeVisualElement = activeSignal.get();
  const tableVisualElement = VesCache.get(activeVisualElement.parentPath!)!.get();
  const activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  const tableItem = asTableItem(tableVisualElement.displayItem);
  const tableBlockHeightPx = tableVisualElement.boundsPx.h / (tableItem.spatialHeightGr / GRID_SIZE);
  let itemPosInTablePx = getBoundingBoxTopLeft(activeVisualElement.boundsPx);
  itemPosInTablePx.y -= store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVisualElement)) * tableBlockHeightPx;
  const tableVe = VesCache.get(activeVisualElement.parentPath!)!.get();
  const tableParentVe = VesCache.get(tableVe.parentPath!)!.get();

  let moveToPage;
  let moveToPageVe;
  if (isPage(tableParentVe.displayItem)) {
    moveToPageVe = tableParentVe;
    moveToPage = asPageItem(tableParentVe.displayItem);
  } else if (isComposite(tableParentVe.displayItem)) {
    moveToPageVe = VesCache.get(tableParentVe.parentPath!)!.get();
    moveToPage = asPageItem(moveToPageVe.displayItem);
  } else {
    panic("unexpected table parent type: " + tableParentVe.displayItem.itemType);
  }

  const moveToPageAbsoluteBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, moveToPageVe);
  const moveToPageInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(moveToPage);

  const itemPosInPagePx = CursorEventState.getLatestDesktopPx(store);
  itemPosInPagePx.x -= store.getCurrentDockWidthPx();
  itemPosInPagePx.y += moveToPageAbsoluteBoundsPx.y;
  itemPosInPagePx.x += moveToPageAbsoluteBoundsPx.x - store.getCurrentDockWidthPx();

  let itemPosInPageGr;
  if (moveToPageVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
    itemPosInPagePx.x -= moveToPageVe.viewportBoundsPx!.x * 2;
    itemPosInPagePx.y -= moveToPageVe.viewportBoundsPx!.y * 2; // TODO (low): * 2 gives correct behavior, but i didn't reason through why.
    itemPosInPageGr = {
      x: itemPosInPagePx.x / moveToPageVe.viewportBoundsPx!.w * moveToPage.innerSpatialWidthGr,
      y: itemPosInPagePx.y / moveToPageVe.viewportBoundsPx!.h * PageFns.calcInnerSpatialDimensionsBl(moveToPage).h * GRID_SIZE
    };
  } else {
    itemPosInPageGr = {
      x: itemPosInPagePx.x / moveToPageAbsoluteBoundsPx.w * moveToPage.innerSpatialWidthGr,
      y: itemPosInPagePx.y / moveToPageAbsoluteBoundsPx.h * PageFns.calcInnerSpatialDimensionsBl(moveToPage).h * GRID_SIZE
    };
  }

  const itemPosInPageQuantizedGr = {
    x: Math.round(itemPosInPageGr.x / (GRID_SIZE / 2.0)) / 2.0 * GRID_SIZE,
    y: Math.round(itemPosInPageGr.y / (GRID_SIZE / 2.0)) / 2.0 * GRID_SIZE
  };

  if (shouldClone && isPositionalItem(activeVisualElement.displayItem)) {
    const toClone = activeVisualElement.displayItem;
    const cloned = asPositionalItem(ItemFns.fromObject(ItemFns.toObject(toClone), null));
    cloned.id = newUid();
    cloned.creationDate = currentUnixTimeSeconds();
    cloned.lastModifiedDate = currentUnixTimeSeconds();
    cloned.dateTime = currentUnixTimeSeconds();
    cloned.ordering = itemState.newOrderingAtEndOfChildren(cloned.parentId);
    cloned.spatialPositionGr = itemPosInPageQuantizedGr;
    cloned.parentId = moveToPage.id;
    itemState.add(cloned);
    server.addItem(cloned, null, store.general.networkStatus);
    maybeAddNewChildItems(store, asPositionalItem(cloned));

    fullArrange(store);
    let ve = VesCache.findSingle({ itemId: cloned.id, linkIdMaybe: null });
    MouseActionState.get().activeElementPath = VeFns.veToPath(ve.get());
    MouseActionState.get().activeElementSignalMaybe = ve;
    MouseActionState.get().activeLinkIdMaybe = ve.get().actualLinkItemMaybe?.id ?? ve.get().linkItemMaybe?.id ?? null;
    MouseActionState.get().activeLinkedDisplayItemMaybe = MouseActionState.get().activeLinkIdMaybe ? ve.get().displayItem : null;
    MouseActionState.get().linkCreatedOnMoveStart = false;

    fullArrange(store);

  } else if (shouldCreateLink && !isLink(activeVisualElement.displayItem)) {
    const link = LinkFns.createFromItem(activeVisualElement.displayItem, moveToPage.id, RelationshipToParent.Child, itemState.newOrderingAtEndOfChildren(moveToPage.id));
    link.spatialPositionGr = itemPosInPageQuantizedGr;
    if (activeVisualElement.linkItemMaybe) {
      link.spatialWidthGr = activeVisualElement.linkItemMaybe.spatialWidthGr;
      link.spatialHeightGr = activeVisualElement.linkItemMaybe.spatialHeightGr;
    }
    itemState.add(link);
    server.addItem(link, null, store.general.networkStatus);
    fullArrange(store); // TODO (LOW): avoid this arrange i think by determining the new activeElement path without the fine.
    let ve = VesCache.findSingle({ itemId: activeVisualElement.displayItem.id, linkIdMaybe: link.id });
    MouseActionState.get().clickOffsetProp = { x: 0.0, y: 0.0 };
    MouseActionState.get().activeElementPath = VeFns.veToPath(ve.get());
    MouseActionState.get().activeElementSignalMaybe = ve;
    MouseActionState.get().activeLinkIdMaybe = ve.get().actualLinkItemMaybe?.id ?? ve.get().linkItemMaybe?.id ?? null;
    MouseActionState.get().activeLinkedDisplayItemMaybe = MouseActionState.get().activeLinkIdMaybe ? ve.get().displayItem : null;
    MouseActionState.get().linkCreatedOnMoveStart = true;

  } else {
    activeItem.spatialPositionGr = itemPosInPageQuantizedGr;
    itemState.moveToNewParent(activeItem, moveToPage.id, RelationshipToParent.Child);
    // Set active element to the moved item within the new page path
    MouseActionState.get().activeElementPath = VeFns.addVeidToPath(VeFns.veidFromVe(activeVisualElement), VeFns.veToPath(moveToPageVe));
    const refreshedSignal = VesCache.get(MouseActionState.get().activeElementPath) ?? activeSignal;
    MouseActionState.get().activeElementSignalMaybe = refreshedSignal;
    if (refreshedSignal) {
      MouseActionState.get().activeLinkIdMaybe = refreshedSignal.get().actualLinkItemMaybe?.id ?? refreshedSignal.get().linkItemMaybe?.id ?? null;
      MouseActionState.get().activeLinkedDisplayItemMaybe = MouseActionState.get().activeLinkIdMaybe ? refreshedSignal.get().displayItem : null;
    }
  }

  MouseActionState.get().onePxSizeBl = {
    x: moveToPageInnerSizeBl.w / moveToPageVe.childAreaBoundsPx!.w,
    y: moveToPageInnerSizeBl.h / moveToPageVe.childAreaBoundsPx!.h
  };

  MouseActionState.get().startPosBl = { x: itemPosInPageQuantizedGr.x / GRID_SIZE, y: itemPosInPageQuantizedGr.y / GRID_SIZE };
  MouseActionState.get().moveOver_scaleDefiningElement = VeFns.veToPath(moveToPageVe);
}


function calculateJustifiedMoveOverIndex(store: StoreContextModel, inElementVe: VisualElement, activeItem: PositionalItem, desktopPosPx: Vector): number {
  const pageItem = asPageItem(inElementVe.displayItem);
  const containerItem = asContainerItem(inElementVe.displayItem);

  const xAdj = (inElementVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) ||
               (inElementVe.flags & VisualElementFlags.Popup)
    ? store.getCurrentDockWidthPx()
    : 0.0;
  const xOffsetPx = desktopPosPx.x - (inElementVe.viewportBoundsPx!.x + xAdj);
  const yOffsetPx = desktopPosPx.y - inElementVe.viewportBoundsPx!.y;

  // Account for scroll position
  const veid = VeFns.veidFromVe(inElementVe);
  const scrollYPx = store.perItem.getPageScrollYProp(veid)
    * (inElementVe.childAreaBoundsPx!.h - inElementVe.viewportBoundsPx!.h);
  const scrollXPx = store.perItem.getPageScrollXProp(veid)
    * (inElementVe.childAreaBoundsPx!.w - inElementVe.viewportBoundsPx!.w);

  const mousePagePosPx = {
    x: xOffsetPx + scrollXPx,
    y: yOffsetPx + scrollYPx
  };

  const dims = [];
  const items = [];
  for (let i = 0; i < containerItem.computed_children.length; ++i) {
    const item = itemState.get(containerItem.computed_children[i])!;
    if (item.id === activeItem.id) {
      continue;
    }
    const dimensions = ItemFns.calcSpatialDimensionsBl(item);
    dims.push({ width: dimensions.w, height: dimensions.h });
    items.push(item);
  }

  const movingItemDimensions = ItemFns.calcSpatialDimensionsBl(activeItem);
  const movingItemDim = { width: movingItemDimensions.w, height: movingItemDimensions.h };

  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let insertIdx = 0; insertIdx <= dims.length; insertIdx++) {
    const testDims = [...dims];
    testDims.splice(insertIdx, 0, movingItemDim);

    const layout = createJustifiedLayout(testDims, createJustifyOptions(inElementVe.boundsPx.w, pageItem.justifiedRowAspect));

    if (layout.boxes.length > insertIdx) {
      const box = layout.boxes[insertIdx];
      const itemCenterPx = {
        x: box.left + box.width / 2,
        y: box.top + box.height / 2
      };

      const dx = mousePagePosPx.x - itemCenterPx.x;
      const dy = mousePagePosPx.y - itemCenterPx.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = insertIdx;
      }
    }
  }

  return bestIndex;
}
