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

import { GRID_SIZE, LINE_HEIGHT_PX } from "../constants";
import { asAttachmentsItem, calcSpatialAttachmentInsertIndex } from "../items/base/attachments-item";
import { itemCanMove } from "../items/base/capabilities-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { PositionalItem, asPositionalItem, isPositionalItem } from "../items/base/positional-item";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { asFileItem, isFile } from "../items/file-item";
import { LinkFns, asLinkItem, isLink } from "../items/link-item";
import { asNoteItem, isNote } from "../items/note-item";
import { asPasswordItem, isPassword } from "../items/password-item";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../items/page-item";
import { PlaceholderFns } from "../items/placeholder-item";
import { calculateCalendarPosition, encodeCalendarCombinedIndex } from "../util/calendar-layout";
import { TableFns, asTableItem, isTable } from "../items/table-item";
import { arrangeNow } from "../layout/arrange";
import { HitboxFlags } from "../layout/hitbox";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VeFns, VisualElement, VisualElementFlags, VisualElementPath } from "../layout/visual-element";
import { server } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { Vector, compareVector, getBoundingBoxTopLeft, vectorAdd, vectorSubtract } from "../util/geometry";
import { assert, currentUnixTimeSeconds, panic } from "../util/lang";
import { HitInfoFns } from "./hit";
import { resolveInternalMoveTarget, resolveMoveTargetPageVe } from "./move_target";
import { CursorEventState, MouseAction, MouseActionState } from "./state";
import { dockInsertIndexAndPositionFromDockChildAreaY, getDockScrollYPx } from "../layout/arrange/dock";
import { asContainerItem } from "../items/base/container-item";
import { newUid } from "../util/uid";
import { isDataItem } from "../items/base/data-item";
import createJustifiedLayout from "justified-layout";
import { calcJustifiedPagePaddingPx } from "../layout/arrange/justified_metrics";
import { createJustifyOptions } from "../layout/arrange/page_justified";
import { stackedInsertionIndexFromChildAreaPx, stackedInsertionIndexFromDesktopPx } from "../layout/stacked-insertion";
import { calculateMoveToPagePositionGr, moveGroupToChildParentPreservingOffsets } from "./move_group";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../layout/arrange/page_list";




function captureMoveRollbackSnapshot(store: StoreContextModel, activeVisualElement: VisualElement, activeItem: PositionalItem) {
  const activeVeid = VeFns.veidFromVe(activeVisualElement);
  const selected = store.overlay.selectedVeids.get();
  const activeSelected = selected?.some(v => (
    v.itemId === activeVeid.itemId && v.linkIdMaybe === activeVeid.linkIdMaybe
  )) ?? false;

  const itemIds = activeSelected && selected != null
    ? selected.map(v => v.linkIdMaybe ? v.linkIdMaybe : v.itemId)
    : [activeItem.id];

  const seen = new Set<string>();
  const snapshot = itemIds
    .map(id => itemState.get(id))
    .filter((item): item is PositionalItem => item != null && isPositionalItem(item))
    .filter(item => {
      if (seen.has(item.id)) { return false; }
      seen.add(item.id);
      return true;
    })
    .map(item => ({
      id: item.id,
      parentId: item.parentId,
      relationshipToParent: item.relationshipToParent,
      ordering: new Uint8Array(item.ordering),
      spatialPositionGr: { ...item.spatialPositionGr },
      dateTime: item.dateTime,
      rollbackFlags: isNote(item)
        ? asNoteItem(item).flags
        : isFile(item)
          ? asFileItem(item).flags
          : isPassword(item)
            ? asPasswordItem(item).flags
            : null,
    }));

  MouseActionState.setMoveRollback(snapshot);
}

function movingChildIdFromVe(visualElement: VisualElement): string {
  return visualElement.actualLinkItemMaybe?.id ?? visualElement.displayItem.id;
}

function moveRollbackOrderingForChild(childId: string): Uint8Array | null {
  const rollback = MouseActionState.getMoveRollback()?.find(entry => entry.id == childId);
  return rollback ? new Uint8Array(rollback.ordering) : null;
}

function normalizeMovingListPageSelectedMainVe(
  store: StoreContextModel,
  activeVisualElement: VisualElement,
  desktopPosPx: Vector,
): VisualElement {
  if (activeVisualElement.linkItemMaybe?.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM || activeVisualElement.parentPath == null) {
    return activeVisualElement;
  }

  const parentVe = MouseActionState.readVisualElement(activeVisualElement.parentPath);
  const parentViewportBoundsPx = parentVe != null
    ? VeFns.veViewportBoundsRelativeToDesktopPx(store, parentVe)
    : null;
  const proxyBoundsPx = parentViewportBoundsPx != null
    ? {
      x: parentViewportBoundsPx.x + activeVisualElement.boundsPx.x,
      y: parentViewportBoundsPx.y + activeVisualElement.boundsPx.y,
      w: activeVisualElement.boundsPx.w,
      h: activeVisualElement.boundsPx.h,
    }
    : VeFns.veBoundsRelativeToDesktopPx(store, activeVisualElement);
  const movingDimensionsBl = ItemFns.calcSpatialDimensionsBl(VeFns.treeItem(activeVisualElement));
  MouseActionState.setClickOffsetProp({
    x: Math.max(0, Math.min(1, (desktopPosPx.x - proxyBoundsPx.x) / Math.max(1, movingDimensionsBl.w * LINE_HEIGHT_PX))),
    y: Math.max(0, Math.min(1, (desktopPosPx.y - proxyBoundsPx.y) / Math.max(1, movingDimensionsBl.h * LINE_HEIGHT_PX))),
  });

  const actualChildPath = VeFns.addVeidToPath(VeFns.actualVeidFromVe(activeVisualElement), activeVisualElement.parentPath);
  MouseActionState.setActiveElementPath(actualChildPath);
  return MouseActionState.readVisualElement(actualChildPath) ?? activeVisualElement;
}

function preserveListSelectionWhenMovingSelectedChild(
  store: StoreContextModel,
  listPageVe: VisualElement | null,
  movingVe: VisualElement,
  originalOrderingMaybe: Uint8Array | null,
) {
  if (!listPageVe || !isPage(listPageVe.displayItem)) { return; }
  const listPage = asPageItem(listPageVe.displayItem);
  if (listPage.arrangeAlgorithm != ArrangeAlgorithm.List) { return; }

  const movingVeid = VeFns.actualVeidFromVe(movingVe);
  const movingChildId = movingChildIdFromVe(movingVe);
  const renderedSelectedVe = VesCache.current.readSelected(VeFns.veToPath(listPageVe));
  PageFns.moveListPageSelectionOffChild(
    store,
    listPage,
    [VeFns.actualVeidFromVe(listPageVe), VeFns.veidFromVe(listPageVe), { itemId: listPage.id, linkIdMaybe: null }],
    movingVeid,
    movingChildId,
    originalOrderingMaybe,
    renderedSelectedVe != null && VeFns.compareVeids(VeFns.actualVeidFromVe(renderedSelectedVe), movingVeid) == 0,
  );
}


export function moving_initiate(store: StoreContextModel, activeItem: PositionalItem, activeVisualElement: VisualElement, desktopPosPx: Vector) {
  activeVisualElement = normalizeMovingListPageSelectedMainVe(store, activeVisualElement, desktopPosPx);
  activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));
  if (!itemCanMove(activeItem)) {
    return;
  }
  captureMoveRollbackSnapshot(store, activeVisualElement, activeItem);
  const isActiveLinkItem = isLink(activeItem);
  const shiftWantsClone = CursorEventState.get().shiftDown && !isDataItem(activeVisualElement.displayItem);
  const shouldCreateLink = CursorEventState.get().ctrlDown || (shiftWantsClone && isActiveLinkItem);
  const shouldClone = shiftWantsClone && !isActiveLinkItem; // For link items, shift behaves like ctrl (create link)
  const parentItem = itemState.get(activeItem.parentId)!;
  if (isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
    const movingChild = itemState.get(movingChildIdFromVe(activeVisualElement));
    preserveListSelectionWhenMovingSelectedChild(
      store,
      MouseActionState.readVisualElement(activeVisualElement.parentPath),
      activeVisualElement,
      movingChild?.ordering ? new Uint8Array(movingChild.ordering) : null,
    );
  }
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
                // Rendered bounds can drift off the persisted half-block grid due to scaling.
                // Snap them back before using them as the basis for a persisted group move.
                ? quantizeSpatialPosGr({ x: renderedPosBl.x * GRID_SIZE, y: renderedPosBl.y * GRID_SIZE })
                : quantizeSpatialPosGr((e.item as PositionalItem).spatialPositionGr);
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

function quantizeSpatialPosGr(posGr: Vector): Vector {
  return {
    x: Math.round(posGr.x / (GRID_SIZE / 2.0)) * (GRID_SIZE / 2.0),
    y: Math.round(posGr.y / (GRID_SIZE / 2.0)) * (GRID_SIZE / 2.0),
  };
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
  const tableContainerVeMaybe = HitInfoFns.getTableContainerVe(hitInfo);
  const normalizedTableMoveDesktopPx = tableContainerVeMaybe != null
    ? TableFns.normalizeMoveOverDesktopPx(store, tableContainerVeMaybe, desktopPosPx)
    : desktopPosPx;
  const isOverTableRootAttach =
    !!(hitInfo.hitboxType & HitboxFlags.Attach) &&
    hitInfo.overVes != null &&
    isTable(hitInfo.overVes.get().displayItem);
  const shouldTreatTableHeaderAsFirstRow =
    isOverTableRootAttach &&
    tableContainerVeMaybe != null &&
    normalizedTableMoveDesktopPx.y !== desktopPosPx.y;
  const tableChildContainerDropTargetPath =
    tableContainerVeMaybe != null &&
      hitInfo.overVes != null &&
      !!(hitInfo.hitboxType & HitboxFlags.OpenPopup) &&
      !!(hitInfo.overVes.get().flags & VisualElementFlags.InsideTable) &&
      isPage(hitInfo.overVes.get().displayItem)
      ? VeFns.veToPath(hitInfo.overVes.get())
      : null;
  const resolvedMoveTarget = resolveInternalMoveTarget(hitInfo, ignoreIds);
  const hasValidMoveTarget = resolvedMoveTarget.validity == "valid";
  const hitMoveTargetVe = resolvedMoveTarget.positioningPageVe;
  const hoveredPageInsideTable =
    tableContainerVeMaybe != null &&
    !!(hitMoveTargetVe.flags & VisualElementFlags.InsideTable);
  const moveTargetIsDocumentPage =
    isPage(hitMoveTargetVe.displayItem) &&
    asPageItem(hitMoveTargetVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document;

  if (!hasValidMoveTarget) {
    clearMoveOverTargetState(store);
  } else {
    // update move over element state.
    const moveOverContainerPath = moveTargetIsDocumentPage
      ? resolvedMoveTarget.positioningPagePath
      : resolvedMoveTarget.hoverContainerPath;
    if (MouseActionState.getMoveOverContainerPath() == null ||
      MouseActionState.getMoveOverContainerPath()! != moveOverContainerPath) {
      clearMoveOverContainerState(store);

      store.perVe.setMovingItemIsOver(moveOverContainerPath, true);
      MouseActionState.setMoveOverContainerPath(moveOverContainerPath);
    }

    // update move over attach state.
    clearMoveOverAttachState(store);
    if ((hitInfo.hitboxType & HitboxFlags.Attach) && !shouldTreatTableHeaderAsFirstRow) {
      const attachVe = hitInfo.overVes!.get();
      const attachVePath = VeFns.veToPath(attachVe);
      store.perVe.setMovingItemIsOverAttach(attachVePath, true);
      MouseActionState.setMoveOverAttachHitboxPath(attachVePath);

      // Calculate which attachment slot the mouse is over
      const attachItem = asAttachmentsItem(attachVe.displayItem);
      const veBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, attachVe);
      const innerSizeBl = ItemFns.calcSpatialDimensionsBl(attachVe.displayItem);
      const clampedIndex = calcSpatialAttachmentInsertIndex(
        veBoundsPx,
        innerSizeBl.w,
        desktopPosPx.x,
        attachItem.computed_attachments.length,
      );

      store.perVe.setMoveOverAttachmentIndex(attachVePath, clampedIndex);
    }

    // update move over attach composite state.
    clearMoveOverAttachCompositeState(store);
    if (!moveTargetIsDocumentPage && (hitInfo.hitboxType & HitboxFlags.AttachComposite)) {
      const attachCompositeVe = hitInfo.overVes!.get();
      const attachCompositeTargetIsAlreadyInComposite =
        attachCompositeVe.displayItem.parentId != null &&
        isComposite(itemState.get(attachCompositeVe.displayItem.parentId)!);

      if (!attachCompositeTargetIsAlreadyInComposite) {
        store.perVe.setMovingItemIsOverAttachComposite(VeFns.veToPath(attachCompositeVe), true);
        MouseActionState.setMoveOverAttachCompositePath(VeFns.veToPath(attachCompositeVe));
      }
    }

    if (!hoveredPageInsideTable && MouseActionState.readScaleDefiningElement()!.displayItem != hitMoveTargetVe.displayItem) {
      clearTableChildContainerDropTarget(store, moveOverContainerPath);
      moving_activeItemToPage(store, hitMoveTargetVe, desktopPosPx, RelationshipToParent.Child, false, false);
      arrangeNow(store, "moving-enter-new-container");
      return;
    }

    if (!moveTargetIsDocumentPage && tableContainerVeMaybe && (!isOverTableRootAttach || shouldTreatTableHeaderAsFirstRow)) {
      moving_handleOverTable(store, tableContainerVeMaybe, desktopPosPx, tableChildContainerDropTargetPath);
    } else {
      clearTableChildContainerDropTarget(store, tableContainerVeMaybe != null ? VeFns.veToPath(tableContainerVeMaybe) : null);
      const moveOverContainerVe = MouseActionState.readMoveOverContainer()!;
      if (!moveTargetIsDocumentPage && isComposite(moveOverContainerVe.displayItem)) {
        if (
          MouseActionState.getMoveOverAttachHitboxPath() != null ||
          MouseActionState.getMoveOverAttachCompositePath() != null
        ) {
          store.perVe.setMoveOverIndex(VeFns.veToPath(moveOverContainerVe), -1);
        } else {
          moving_handleOverComposite(store, moveOverContainerVe, desktopPosPx);
        }
      }
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

  if (!hasValidMoveTarget || asPageItem(inElement).arrangeAlgorithm != ArrangeAlgorithm.Calendar) {
    store.movingItemTargetCalendarInfo.set(null);
  }

  if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Grid) {
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
    const pagePaddingPx = calcJustifiedPagePaddingPx(inElementVe.childAreaBoundsPx!.w, asPageItem(inElement).justifiedRowAspect);
    const rawCellX = Math.floor((xOffsetPx + scrollXPx - pagePaddingPx) / inElementVe.cellSizePx!.w);
    const rawCellY = Math.floor((yOffsetPx + scrollYPx - pagePaddingPx) / inElementVe.cellSizePx!.h);
    const cellX = Math.max(0, Math.min(asPageItem(inElement).gridNumberOfColumns, rawCellX));
    const cellY = Math.max(0, rawCellY);
    let index = cellY * asPageItem(inElement).gridNumberOfColumns + cellX;
    const numChildren = asContainerItem(inElement).computed_children.length;
    if (index < 0) { index = 0; }
    if (index >= numChildren) { index = numChildren - 1; } // numChildren is inclusive of the moving item so -1.
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), index);
  }

  else if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Catalog) {
    const catalogChildren = VesCache.render.getNonMovingChildren(VeFns.veToPath(inElementVe))()
      .map(childVe => childVe.get());
    const moveOverIndex = stackedInsertionIndexFromDesktopPx(store, catalogChildren, desktopPosPx);
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), moveOverIndex);
  }

  else if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Justified) {
    const moveOverIndex = calculateJustifiedMoveOverIndex(store, inElementVe, activeItem, desktopPosPx);
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), moveOverIndex);
  }

  else if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.List) {
    const lineChildren = VesCache.render.getLineChildren(VeFns.veToPath(inElementVe))()
      .map(childVe => childVe.get());
    const viewportBoundsPx = VeFns.veViewportBoundsRelativeToDesktopPx(store, inElementVe);
    const scrollVeid = VeFns.actualVeidFromVe(inElementVe);
    const scrollYPx = Math.max(
      0,
      (inElementVe.listChildAreaBoundsPx?.h ?? inElementVe.childAreaBoundsPx!.h) -
      (inElementVe.listViewportBoundsPx?.h ?? inElementVe.viewportBoundsPx!.h),
    ) * store.perItem.getPageScrollYProp(scrollVeid);
    const childAreaYPx = desktopPosPx.y - viewportBoundsPx.y + scrollYPx;
    const moveOverIndex = stackedInsertionIndexFromChildAreaPx(lineChildren, childAreaYPx);
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), moveOverIndex);
  }

  else if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Document) {
    const documentChildren = VesCache.render.getNonMovingChildren(VeFns.veToPath(inElementVe))()
      .map(childVe => childVe.get());
    const moveOverIndex = stackedInsertionIndexFromDesktopPx(store, documentChildren, desktopPosPx);
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), moveOverIndex);
  }

  else if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
    // Calculate which month and day the mouse is over using scaled childAreaBoundsPx
    const position = calculateCalendarPosition(desktopPosPx, inElementVe, store);
    const combinedIndex = encodeCalendarCombinedIndex(position.month, position.day);
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), combinedIndex);
    store.movingItemTargetCalendarInfo.set({ pageItemId: inElement.id, combinedIndex });
  }

  if (hasValidMoveTarget && (inElementVe.flags & VisualElementFlags.IsDock)) {
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


function clearMoveOverContainerState(store: StoreContextModel): void {
  const moveOverContainerPath = MouseActionState.getMoveOverContainerPath();
  if (moveOverContainerPath == null) { return; }
  store.perVe.setMovingItemIsOver(moveOverContainerPath, false);
  clearTableChildContainerDropTarget(store, moveOverContainerPath);
  MouseActionState.setMoveOverContainerPath(null);
}

function clearMoveOverAttachState(store: StoreContextModel): void {
  const attachPath = MouseActionState.getMoveOverAttachHitboxPath();
  if (attachPath == null) { return; }
  store.perVe.setMovingItemIsOverAttach(attachPath, false);
  store.perVe.setMoveOverAttachmentIndex(attachPath, -1);
  MouseActionState.setMoveOverAttachHitboxPath(null);
}

function clearMoveOverAttachCompositeState(store: StoreContextModel): void {
  const attachCompositePath = MouseActionState.getMoveOverAttachCompositePath();
  if (attachCompositePath == null) { return; }
  store.perVe.setMovingItemIsOverAttachComposite(attachCompositePath, false);
  MouseActionState.setMoveOverAttachCompositePath(null);
}

function clearMoveOverTargetState(store: StoreContextModel): void {
  clearMoveOverAttachState(store);
  clearMoveOverAttachCompositeState(store);
  clearMoveOverContainerState(store);
}


function clearTableChildContainerDropTarget(store: StoreContextModel, tablePath: VisualElementPath | null): void {
  if (tablePath == null) { return; }
  store.perVe.setMoveOverChildContainerPath(tablePath, null);
}

function moving_handleOverTable(
  store: StoreContextModel,
  overContainerVe: VisualElement,
  desktopPx: Vector,
  childContainerDropTargetPath: VisualElementPath | null,
) {
  assert(isTable(overContainerVe.displayItem), "overContainerVe is not a table");
  const tablePath = VeFns.veToPath(overContainerVe);
  const { insertRow, attachmentPos } = TableFns.tableModifiableColRow(store, overContainerVe, desktopPx);
  store.perVe.setMoveOverRowNumber(tablePath, insertRow);
  store.perVe.setMoveOverChildContainerPath(tablePath, childContainerDropTargetPath);

  if (TableFns.tableAttachmentTargetAtRow(store, overContainerVe, insertRow) != null) {
    store.perVe.setMoveOverColAttachmentNumber(tablePath, attachmentPos);
  } else {
    store.perVe.setMoveOverColAttachmentNumber(tablePath, -1);
  }
}

function moving_handleOverComposite(store: StoreContextModel, overContainerVe: VisualElement, desktopPx: Vector) {
  assert(isComposite(overContainerVe.displayItem), "overContainerVe is not a composite");
  const activeItemId = MouseActionState.getActiveVisualElement()?.displayItem.id ?? null;
  const compositeChildren = VesCache.render.getChildren(VeFns.veToPath(overContainerVe))()
    .filter(childVe => childVe.get().displayItem.id !== activeItemId);
  const insertIndex = stackedInsertionIndexFromDesktopPx(
    store,
    compositeChildren.map(childVe => childVe.get()),
    desktopPx,
  );
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

  const moveToPage = asPageItem(moveToVe.displayItem);
  const clickOffsetProp = MouseActionState.getClickOffsetProp();
  const { activePosGr: newItemPosGr, startPosBl, moveToPageInnerSizeBl } = calculateMoveToPagePositionGr(
    store,
    moveToVe,
    desktopPx,
    treeActiveItem,
    relationshipToParent,
    clickOffsetProp,
  );
  const pagePx = VeFns.desktopPxToTopLevelPagePx(store, desktopPx);
  const sourceParentId = treeActiveItem.parentId;
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
    preserveListSelectionWhenMovingSelectedChild(
      store,
      moveToVe,
      activeElement,
      moveRollbackOrderingForChild(movingChildIdFromVe(activeElement)),
    );

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

    const movedGroupIds = relationshipToParent == RelationshipToParent.Child
      ? moveGroupToChildParentPreservingOffsets(
        MouseActionState.getGroupMoveItems(),
        VeFns.veidFromVe(activeElement),
        sourceParentId,
        moveToPage.id,
        newItemPosGr,
      )
      : [];

    if (movedGroupIds.length == 0) {
      treeActiveItem.spatialPositionGr = newItemPosGr;
      itemState.moveToNewParent(treeActiveItem, moveToPage.id, RelationshipToParent.Child);
    }

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

  const desktopPx = CursorEventState.getLatestDesktopPx(store);
  if (moveToPageVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
    moving_activeItemToPage(store, moveToPageVe, desktopPx, RelationshipToParent.Child, shouldCreateLink, shouldClone);
    return;
  }

  const moveToPageAbsoluteBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, moveToPageVe);
  const moveToPageInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(moveToPage);

  const pagePx = VeFns.desktopPxToTopLevelPagePx(store, desktopPx);
  const itemPosInPagePx = {
    x: pagePx.x - moveToPageAbsoluteBoundsPx.x,
    y: pagePx.y - moveToPageAbsoluteBoundsPx.y
  };

  const itemPosInPageGr = {
    x: itemPosInPagePx.x / moveToPageAbsoluteBoundsPx.w * moveToPage.innerSpatialWidthGr,
    y: itemPosInPagePx.y / moveToPageAbsoluteBoundsPx.h * PageFns.calcInnerSpatialDimensionsBl(moveToPage).h * GRID_SIZE
  };

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
