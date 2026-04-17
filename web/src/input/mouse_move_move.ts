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
import { arrangeNow } from "../layout/arrange";
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
import { dockInsertIndexAndPositionFromDockChildAreaY, getDockScrollYPx } from "../layout/arrange/dock";
import { asContainerItem } from "../items/base/container-item";
import { newUid } from "../util/uid";
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
    arrangeNow(store, "moving-init-out-of-table");
  }
  else if (activeItem.relationshipToParent == RelationshipToParent.Attachment) {
    const hitInfo = HitInfoFns.hit(store, desktopPosPx, [], false, false);
    moving_activeItemToPage(store, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Attachment, shouldCreateLink, shouldClone);
    arrangeNow(store, "moving-init-out-of-attachment");
  }
  else if (isComposite(itemState.get(activeItem.parentId)!)) {
    const hitInfo = HitInfoFns.hit(store, desktopPosPx, [activeItem.id], false, false);
    moving_activeItemToPage(store, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Child, shouldCreateLink, shouldClone);
    arrangeNow(store, "moving-init-out-of-composite");
  }
  else {
    const renderedStartPosBl = spatialStartPosBlFromRenderedVe(activeVisualElement);
    MouseActionState.setStartPosBl(renderedStartPosBl ?? {
      x: activeItem.spatialPositionGr.x / GRID_SIZE,
      y: activeItem.spatialPositionGr.y / GRID_SIZE
    });

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
            startPosGr: (() => {
              const renderedVe = VesCache.current.findNodes(e.veid)[0];
              const renderedPosBl = renderedVe ? spatialStartPosBlFromRenderedVe(renderedVe) : null;
              return renderedPosBl
                ? { x: renderedPosBl.x * GRID_SIZE, y: renderedPosBl.y * GRID_SIZE }
                : (e.item as PositionalItem).spatialPositionGr;
            })(),
            parentId: (e.item as PositionalItem).parentId,
          }));
        MouseActionState.setGroupMoveItems(group);
      } else {
        MouseActionState.setGroupMoveItems(undefined);
      }
    } else {
      MouseActionState.setGroupMoveItems(undefined);
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

      const activeParentPath = VeFns.parentPath(MouseActionState.getActiveElementPath()!);
      const newLinkVeid = VeFns.veidFromId(cloned.id);
      MouseActionState.setActiveElementPath(VeFns.addVeidToPath(newLinkVeid, activeParentPath));
      MouseActionState.setAction(MouseAction.Moving); // page arrange depends on this in the grid case.
      MouseActionState.setLinkCreatedOnMoveStart(false);

      // Preserve calendar page scroll position during synchronous arrange.
      const parentPageVeid = VeFns.veidFromPath(activeParentPath);
      const parentPage = itemState.get(parentPageVeid.itemId)!;
      let savedScrollY = null;
      let savedScrollX = null;
      if (isPage(parentPage) && asPageItem(parentPage).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
        savedScrollY = store.perItem.getPageScrollYProp(parentPageVeid);
        savedScrollX = store.perItem.getPageScrollXProp(parentPageVeid);
      }

      arrangeNow(store, "moving-init-clone-current-page");

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

      const activeParentPath = VeFns.parentPath(MouseActionState.getActiveElementPath()!);
      const newLinkVeid = VeFns.veidFromId(link.id);
      MouseActionState.setActiveElementPath(VeFns.addVeidToPath(newLinkVeid, activeParentPath));
      MouseActionState.setAction(MouseAction.Moving); // page arrange depends on this in the grid case.
      MouseActionState.setLinkCreatedOnMoveStart(true);

      // Preserve calendar page scroll position during synchronous arrange.
      const parentPageVeid = VeFns.veidFromPath(activeParentPath);
      const parentPage = itemState.get(parentPageVeid.itemId)!;
      let savedScrollY = null;
      let savedScrollX = null;
      if (isPage(parentPage) && asPageItem(parentPage).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
        savedScrollY = store.perItem.getPageScrollYProp(parentPageVeid);
        savedScrollX = store.perItem.getPageScrollXProp(parentPageVeid);
      }

      arrangeNow(store, "moving-init-link-current-page");

      // Restore calendar page scroll position
      if (savedScrollY !== null && savedScrollX !== null) {
        store.perItem.setPageScrollYProp(parentPageVeid, savedScrollY);
        store.perItem.setPageScrollXProp(parentPageVeid, savedScrollX);
      }
    }

    if (MouseActionState.hitboxTypeIncludes(HitboxFlags.ContentEditable)) {
      let selection = window.getSelection();
      if (selection != null) { selection.removeAllRanges(); }
      (document.activeElement! as HTMLElement).blur();
    }
  }

  // if it is a selected list page that is moving, change the selected item.
  if (isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
    const parentPath = VeFns.parentPath(MouseActionState.getActiveElementPath()!);
    const selected = store.perItem.getSelectedListPageItem(VeFns.veidFromPath(parentPath));

    if (selected && VeFns.compareVeids(selected, VeFns.veidFromPath(MouseActionState.getActiveElementPath()!)) === 0) {
      const children = asPageItem(parentItem).computed_children;
      let foundIdx = -1;
      for (let i = 0; i < children.length; i++) {
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

  if (isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
    const itemDate = new Date(activeItem.dateTime * 1000);
    const month = itemDate.getMonth() + 1;
    const day = itemDate.getDate();
    store.movingItemSourceCalendarInfo.set({ pageItemId: parentItem.id, combinedIndex: encodeCalendarCombinedIndex(month, day) });
  } else {
    store.movingItemSourceCalendarInfo.set(null);
  }

  store.anItemIsMoving.set(true);
  MouseActionState.setAction(MouseAction.Moving);
}

function spatialStartPosBlFromRenderedVe(visualElement: VisualElement): Vector | null {
  if (!(visualElement.flags & VisualElementFlags.Detailed) || !visualElement.parentPath) { return null; }

  const parentVe = VesCache.current.readNode(visualElement.parentPath);
  if (!parentVe || !isPage(parentVe.displayItem) || !parentVe.childAreaBoundsPx) { return null; }

  const parentPage = asPageItem(parentVe.displayItem);
  if (parentPage.arrangeAlgorithm != ArrangeAlgorithm.SpatialStretch) { return null; }

  const parentInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(parentPage);
  return {
    x: visualElement.boundsPx.x / parentVe.childAreaBoundsPx.w * parentInnerSizeBl.w,
    y: visualElement.boundsPx.y / parentVe.childAreaBoundsPx.h * parentInnerSizeBl.h,
  };
}

function resolveMoveTargetPageVe(moveToVe: VisualElement): VisualElement {
  let candidate: VisualElement | null = moveToVe;
  while (candidate) {
    if (isPage(candidate.displayItem)) { return candidate; }
    if (!candidate.parentPath) { break; }
    candidate = VesCache.current.readNode(candidate.parentPath)!;
  }
  panic(`unexpected move target type: ${moveToVe.displayItem.itemType}`);
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

  const hitInfo = HitInfoFns.hit(store, desktopPosPx, ignoreIds, MouseActionState.usesEmbeddedInteractiveHitTesting(), false);

  // update move over element state.
  const moveOverContainerPath = VeFns.veToPath(HitInfoFns.getOverContainerVe(hitInfo, ignoreIds));
  if (MouseActionState.getMoveOverContainerPath() == null ||
    MouseActionState.getMoveOverContainerPath()! != moveOverContainerPath) {
    if (MouseActionState.getMoveOverContainerPath() != null) {
      const veMaybe = MouseActionState.readMoveOverContainer();
      if (veMaybe) {
        store.perVe.setMovingItemIsOver(VeFns.veToPath(veMaybe), false);
      }
    }

    store.perVe.setMovingItemIsOver(moveOverContainerPath, true);
    MouseActionState.setMoveOverContainerPath(moveOverContainerPath);
  }

  // update move over attach state.
  if (MouseActionState.getMoveOverAttachHitboxPath() != null) {
    const ve = MouseActionState.readMoveOverAttachHitbox()!;
    store.perVe.setMovingItemIsOverAttach(VeFns.veToPath(ve), false);
    store.perVe.setMoveOverAttachmentIndex(VeFns.veToPath(ve), -1);
  }
  if (hitInfo.hitboxType & HitboxFlags.Attach) {
    const attachVe = hitInfo.overVes!.get();
    const attachVePath = VeFns.veToPath(attachVe);
    store.perVe.setMovingItemIsOverAttach(attachVePath, true);
    MouseActionState.setMoveOverAttachHitboxPath(attachVePath);

    // Calculate which attachment slot the mouse is over
    const attachItem = asAttachmentsItem(attachVe.displayItem);
    const veBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, attachVe);
    const innerSizeBl = ItemFns.calcSpatialDimensionsBl(attachVe.displayItem);
    const blockSizePx = veBoundsPx.w / innerSizeBl.w;

    // Mouse position relative to right edge of item
    const mouseXFromRight = veBoundsPx.x + veBoundsPx.w - desktopPosPx.x;
    // Calculate which slot (0 = rightmost, 1 = next, etc.)
    // Add 0.5 blocks so the transition happens at the midpoint of each attachment slot
    const slotIndex = Math.floor((mouseXFromRight + blockSizePx * 0.5) / blockSizePx);
    // Clamp to reasonable range (0 to existing attachments count)
    const maxIndex = attachItem.computed_attachments.length;
    const clampedIndex = Math.max(0, Math.min(slotIndex, maxIndex));

    store.perVe.setMoveOverAttachmentIndex(attachVePath, clampedIndex);
  } else {
    MouseActionState.setMoveOverAttachHitboxPath(null);
  }

  // update move over attach composite state.
  if (MouseActionState.getMoveOverAttachCompositePath() != null) {
    const ve = MouseActionState.readMoveOverAttachComposite()!;
    store.perVe.setMovingItemIsOverAttachComposite(VeFns.veToPath(ve), false);
  }
  if (hitInfo.hitboxType & HitboxFlags.AttachComposite) {
    const attachCompositeVe = hitInfo.overVes!.get();
    const attachCompositeTargetIsAlreadyInComposite =
      attachCompositeVe.displayItem.parentId != null &&
      isComposite(itemState.get(attachCompositeVe.displayItem.parentId)!);

    if (!attachCompositeTargetIsAlreadyInComposite) {
      store.perVe.setMovingItemIsOverAttachComposite(VeFns.veToPath(attachCompositeVe), true);
      MouseActionState.setMoveOverAttachCompositePath(VeFns.veToPath(attachCompositeVe));
    } else {
      MouseActionState.setMoveOverAttachCompositePath(null);
    }
  } else {
    MouseActionState.setMoveOverAttachCompositePath(null);
  }

  const hitMoveTargetVe = resolveMoveTargetPageVe(hitInfo.overPositionableVe!);
  if (MouseActionState.readScaleDefiningElement()!.displayItem != hitMoveTargetVe.displayItem) {
    moving_activeItemToPage(store, hitMoveTargetVe, desktopPosPx, RelationshipToParent.Child, false, false);
    arrangeNow(store, "moving-enter-new-container");
    return;
  }

  const tableContainerVeMaybe = HitInfoFns.getTableContainerVe(hitInfo);
  if (tableContainerVeMaybe) {
    moving_handleOverTable(store, tableContainerVeMaybe, desktopPosPx);
  } else {
    const moveOverContainerVe = MouseActionState.readMoveOverContainer()!;
    if (isComposite(moveOverContainerVe.displayItem)) {
      moving_handleOverComposite(store, moveOverContainerVe, desktopPosPx);
    }
  }

  const onePxSizeBl = MouseActionState.getOnePxSizeBl()!;
  const deltaBl = {
    x: deltaPx.x * onePxSizeBl.x,
    y: deltaPx.y * onePxSizeBl.y
  };

  let newPosBl = vectorAdd(MouseActionState.getStartPosBl()!, deltaBl);
  newPosBl.x = Math.round(newPosBl.x * 2.0) / 2.0;
  newPosBl.y = Math.round(newPosBl.y * 2.0) / 2.0;
  const inElementVe = MouseActionState.readScaleDefiningElement()!;
  const inElement = inElementVe.displayItem;
  const dimBl = PageFns.calcInnerSpatialDimensionsBl(asPageItem(inElement));
  if (newPosBl.x < 0.0) { newPosBl.x = 0.0; }
  if (newPosBl.y < 0.0) { newPosBl.y = 0.0; }
  if (newPosBl.x > dimBl.w - 0.5) { newPosBl.x = dimBl.w - 0.5; }
  if (newPosBl.y > dimBl.h - 0.5) { newPosBl.y = dimBl.h - 0.5; }
  const newPosGr = { x: newPosBl.x * GRID_SIZE, y: newPosBl.y * GRID_SIZE };

  if (asPageItem(inElement).arrangeAlgorithm != ArrangeAlgorithm.Calendar) {
    store.movingItemTargetCalendarInfo.set(null);
  }

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
    store.movingItemTargetCalendarInfo.set({ pageItemId: inElement.id, combinedIndex });
  }

  if (inElementVe.flags & VisualElementFlags.IsDock) {
    const dockScrollYPx = getDockScrollYPx(store, inElementVe);
    const dockChildAreaYPx = desktopPosPx.y - inElementVe.boundsPx.y + dockScrollYPx;
    const indexAndPosition = dockInsertIndexAndPositionFromDockChildAreaY(
      store,
      asPageItem(inElement),
      activeItem,
      inElementVe.viewportBoundsPx!.w,
      dockChildAreaYPx,
    );
    store.perVe.setMoveOverIndexAndPosition(VeFns.veToPath(inElementVe), indexAndPosition);
  }

  if (asPageItem(inElement).arrangeAlgorithm != ArrangeAlgorithm.SpatialStretch || compareVector(newPosGr, activeItem.spatialPositionGr) != 0) {
    const group = MouseActionState.getGroupMoveItems();
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
      arrangeNow(store, "moving-update-group-position");
    } else {
      activeItem.spatialPositionGr = newPosGr;
      arrangeNow(store, "moving-update-position");
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

function moving_handleOverComposite(store: StoreContextModel, overContainerVe: VisualElement, desktopPx: Vector) {
  assert(isComposite(overContainerVe.displayItem), "overContainerVe is not a composite");
  const activeItemId = MouseActionState.getActiveVisualElement()?.displayItem.id ?? null;
  const compositeChildren = VesCache.render.getChildren(VeFns.veToPath(overContainerVe))()
    .filter(childVe => childVe.get().displayItem.id !== activeItemId);
  let insertIndex = compositeChildren.length;
  for (let i = 0; i < compositeChildren.length; ++i) {
    const childVe = compositeChildren[i].get();
    const childBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, childVe);
    if (desktopPx.y < childBoundsPx.y + childBoundsPx.h / 2) {
      insertIndex = i;
      break;
    }
  }
  store.perVe.setMoveOverIndex(VeFns.veToPath(overContainerVe), insertIndex);
}


function moving_activeItemToPage(store: StoreContextModel, moveToVe: VisualElement, desktopPx: Vector, relationshipToParent: string, shouldCreateLink: boolean, shouldClone: boolean) {
  const activeSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeSignal) {
    store.anItemIsMoving.set(false);
    return;
  }
  const activeElement = activeSignal.get();
  const treeActiveItem = asPositionalItem(VeFns.treeItem(activeElement));
  moveToVe = resolveMoveTargetPageVe(moveToVe);

  const pagePx = VeFns.desktopPxToTopLevelPagePx(store, desktopPx);

  const moveToPage = asPageItem(moveToVe.displayItem);
  const moveToPageAbsoluteBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, moveToVe);

  const moveToPageInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(moveToPage);

  const mousePointBl = {
    x: Math.round((pagePx.x - moveToPageAbsoluteBoundsPx.x) / moveToPageAbsoluteBoundsPx.w * moveToPageInnerSizeBl.w * 2.0) / 2.0,
    y: Math.round((pagePx.y - moveToPageAbsoluteBoundsPx.y) / moveToPageAbsoluteBoundsPx.h * moveToPageInnerSizeBl.h * 2.0) / 2.0
  };

  const activeItemDimensionsBl = ItemFns.calcSpatialDimensionsBl(treeActiveItem);
  const clickOffsetProp = MouseActionState.getClickOffsetProp()!;
  const clickOffsetInActiveItemBl = relationshipToParent == RelationshipToParent.Child
    ? {
      x: Math.round(activeItemDimensionsBl.w * clickOffsetProp.x * 2.0) / 2.0,
      y: Math.round(activeItemDimensionsBl.h * clickOffsetProp.y * 2.0) / 2.0
    }
    : { x: 0, y: 0 };
  const startPosBl = vectorSubtract(mousePointBl, clickOffsetInActiveItemBl);
  const newItemPosGr = { x: startPosBl.x * GRID_SIZE, y: startPosBl.y * GRID_SIZE };
  if (moveToVe.parentPath == null) {
    MouseActionState.setStartPx(desktopPx);
  } else {
    MouseActionState.setStartPx(pagePx);
  }
  MouseActionState.setStartPosBl(startPosBl);
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

    const clonedVeid = VeFns.veidFromId(cloned.id);
    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(clonedVeid, moveToPath));
    MouseActionState.setLinkCreatedOnMoveStart(false);


  } else if (shouldCreateLink && !isLink(activeElement.displayItem)) {
    const link = LinkFns.createFromItem(activeElement.displayItem, moveToPage.id, RelationshipToParent.Child, itemState.newOrderingAtEndOfChildren(moveToPage.id));
    link.spatialPositionGr = newItemPosGr;
    if (activeElement.linkItemMaybe) {
      link.spatialWidthGr = activeElement.linkItemMaybe.spatialWidthGr;
      link.spatialHeightGr = activeElement.linkItemMaybe.spatialHeightGr;
    }
    itemState.add(link);
    server.addItem(link, null, store.general.networkStatus);
    const newLinkVeid = { itemId: activeElement.displayItem.id, linkIdMaybe: link.id };
    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(newLinkVeid, moveToPath));
    MouseActionState.setLinkCreatedOnMoveStart(true);

  } else {
    if (relationshipToParent == RelationshipToParent.Attachment) {
      const oldActiveItemOrdering = treeActiveItem.ordering;
      const parent = asAttachmentsItem(itemState.get(treeActiveItem.parentId)!);
      const isLast = parent.computed_attachments[asAttachmentsItem(parent).computed_attachments.length - 1] == treeActiveItem.id;
      if (!isLast) {
        const placeholderItem = PlaceholderFns.create(treeActiveItem.ownerId, parent.id, RelationshipToParent.Attachment, oldActiveItemOrdering);
        itemState.add(placeholderItem);
        MouseActionState.setNewPlaceholderItem(placeholderItem);
      }
      MouseActionState.setStartAttachmentsItem(parent);
    }

    treeActiveItem.spatialPositionGr = newItemPosGr;
    itemState.moveToNewParent(treeActiveItem, moveToPage.id, RelationshipToParent.Child);

    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(VeFns.veidFromVe(activeElement), moveToPath));
  }

  MouseActionState.setOnePxSizeBl({
    x: moveToPageInnerSizeBl.w / moveToVe.childAreaBoundsPx!.w,
    y: moveToPageInnerSizeBl.h / moveToVe.childAreaBoundsPx!.h
  });

  MouseActionState.setScaleDefiningElementPath(moveToPath);
}


function moving_activeItemOutOfTable(store: StoreContextModel, shouldCreateLink: boolean, shouldClone: boolean) {
  const activeSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeSignal) {
    store.anItemIsMoving.set(false);
    return;
  }
  const activeVisualElement = activeSignal.get();
  const tableVisualElement = MouseActionState.readVisualElement(activeVisualElement.parentPath)!;
  const activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  const tableItem = asTableItem(tableVisualElement.displayItem);
  const tableBlockHeightPx = tableVisualElement.boundsPx.h / (tableItem.spatialHeightGr / GRID_SIZE);
  let itemPosInTablePx = getBoundingBoxTopLeft(activeVisualElement.boundsPx);
  itemPosInTablePx.y -= store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVisualElement)) * tableBlockHeightPx;
  const tableVe = MouseActionState.readVisualElement(activeVisualElement.parentPath)!;
  const tableParentVe = MouseActionState.readVisualElement(tableVe.parentPath)!;

  let moveToPage;
  let moveToPageVe;
  if (isPage(tableParentVe.displayItem)) {
    moveToPageVe = tableParentVe;
    moveToPage = asPageItem(tableParentVe.displayItem);
  } else if (isComposite(tableParentVe.displayItem)) {
    moveToPageVe = MouseActionState.readVisualElement(tableParentVe.parentPath)!;
    moveToPage = asPageItem(moveToPageVe.displayItem);
  } else {
    panic("unexpected table parent type: " + tableParentVe.displayItem.itemType);
  }

  const moveToPageAbsoluteBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, moveToPageVe);
  const moveToPageInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(moveToPage);

  const desktopPx = CursorEventState.getLatestDesktopPx(store);
  const pagePx = VeFns.desktopPxToTopLevelPagePx(store, desktopPx);
  const itemPosInPagePx = {
    x: pagePx.x - moveToPageAbsoluteBoundsPx.x,
    y: pagePx.y - moveToPageAbsoluteBoundsPx.y
  };

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

    const clonedVeid = VeFns.veidFromId(cloned.id);
    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(clonedVeid, VeFns.veToPath(moveToPageVe)));
    MouseActionState.setLinkCreatedOnMoveStart(false);

  } else if (shouldCreateLink && !isLink(activeVisualElement.displayItem)) {
    const link = LinkFns.createFromItem(activeVisualElement.displayItem, moveToPage.id, RelationshipToParent.Child, itemState.newOrderingAtEndOfChildren(moveToPage.id));
    link.spatialPositionGr = itemPosInPageQuantizedGr;
    if (activeVisualElement.linkItemMaybe) {
      link.spatialWidthGr = activeVisualElement.linkItemMaybe.spatialWidthGr;
      link.spatialHeightGr = activeVisualElement.linkItemMaybe.spatialHeightGr;
    }
    itemState.add(link);
    server.addItem(link, null, store.general.networkStatus);
    MouseActionState.setClickOffsetProp({ x: 0.0, y: 0.0 });
    const newLinkVeid = { itemId: activeVisualElement.displayItem.id, linkIdMaybe: link.id };
    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(newLinkVeid, VeFns.veToPath(moveToPageVe)));
    MouseActionState.setLinkCreatedOnMoveStart(true);

  } else {
    activeItem.spatialPositionGr = itemPosInPageQuantizedGr;
    itemState.moveToNewParent(activeItem, moveToPage.id, RelationshipToParent.Child);
    // Set active element to the moved item within the new page path
    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(VeFns.veidFromVe(activeVisualElement), VeFns.veToPath(moveToPageVe)));
  }

  MouseActionState.setOnePxSizeBl({
    x: moveToPageInnerSizeBl.w / moveToPageVe.childAreaBoundsPx!.w,
    y: moveToPageInnerSizeBl.h / moveToPageVe.childAreaBoundsPx!.h
  });

  MouseActionState.setStartPosBl({ x: itemPosInPageQuantizedGr.x / GRID_SIZE, y: itemPosInPageQuantizedGr.y / GRID_SIZE });
  MouseActionState.setScaleDefiningElementPath(VeFns.veToPath(moveToPageVe));
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
