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

import { isComposite } from "../../items/composite-item";
import { isFlipCard } from "../../items/flipcard-item";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { isTable } from "../../items/table-item";
import { HitboxFlags, HitboxFns } from "../../layout/hitbox";
import { VesCache } from "../../layout/ves-cache";
import { VisualElement, VisualElementFlags, VeFns } from "../../layout/visual-element";
import { StoreContextModel } from "../../store/StoreProvider";
import { Vector, getBoundingBoxTopLeft, isInside, vectorAdd, vectorSubtract } from "../../util/geometry";
import { assert, panic } from "../../util/lang";
import { VisualElementSignal } from "../../util/signals";
import { Uid } from "../../util/uid";
import { HitInfo, RootInfo } from "./types";
import { HitBuilder } from "./builder";
import { HitHandlers } from "./handlers";
import { findAttachmentHit, isIgnored, scanHitboxes, toChildBoundsLocalFromViewport, toInnerAttachmentLocalInComposite } from "./utils";

export type { HitInfo } from "./types";

export const HitInfoFns = {
  getHitVe: (hitInfo: HitInfo): VisualElement => {
    if (hitInfo.overVes) { return hitInfo.overVes.get(); }
    return hitInfo.rootVes.get();
  },
  getHitVes: (hitInfo: HitInfo): VisualElementSignal => {
    if (hitInfo.overVes) { return hitInfo.overVes; }
    return hitInfo.rootVes;
  },
  getOverContainerVe: (hitInfo: HitInfo, ignoreItems: Array<Uid> | Set<Uid> = []): VisualElement => {
    const ignoredSet: Set<Uid> = Array.isArray(ignoreItems) ? new Set(ignoreItems) : ignoreItems;
    if (hitInfo.overVes) {
      if (isTable(hitInfo.subRootVe?.displayItem as any)) {
        if (hitInfo.hitboxType & HitboxFlags.Click) {
          if (!isIgnored(hitInfo.subRootVe!.displayItem.id, ignoredSet)) { return hitInfo.subRootVe!; }
        }
      }
      if (!isIgnored(hitInfo.overVes!.get().displayItem.id, ignoredSet)) { return hitInfo.overVes.get(); }
    }
    if (hitInfo.subSubRootVe && !isIgnored(hitInfo.subSubRootVe!.displayItem.id, ignoredSet)) { return hitInfo.subSubRootVe; }
    if (hitInfo.subRootVe && !isIgnored(hitInfo.subRootVe!.displayItem.id, ignoredSet)) { return hitInfo.subRootVe; }
    if (!isIgnored(hitInfo.rootVes.get().displayItem.id, ignoredSet)) { return hitInfo.rootVes.get(); }
    return hitInfo.rootVes.get();
  },
  getContainerImmediatelyUnderOverVe: (hitInfo: HitInfo): VisualElement => {
    if (hitInfo.subSubRootVe) { return hitInfo.subSubRootVe; }
    if (hitInfo.subRootVe) { return hitInfo.subRootVe; }
    return hitInfo.rootVes.get();
  },
  getCompositeContainerVe: (hitInfo: HitInfo): VisualElement | null => {
    if (hitInfo.overVes && isComposite(hitInfo.overVes.get().displayItem)) { return hitInfo.overVes.get(); }
    if (hitInfo.subSubRootVe && isComposite(hitInfo.subSubRootVe.displayItem)) { return hitInfo.subSubRootVe; }
    if (hitInfo.subRootVe && isComposite(hitInfo.subRootVe.displayItem)) { return hitInfo.subRootVe; }
    return null;
  },
  getTableContainerVe: (hitInfo: HitInfo): VisualElement | null => {
    if (hitInfo.overVes && isTable(hitInfo.overVes!.get().displayItem)) { return hitInfo.overVes.get(); }
    if (hitInfo.subSubRootVe && isTable(hitInfo.subSubRootVe.displayItem)) { return hitInfo.subSubRootVe; }
    if (hitInfo.subRootVe && isTable(hitInfo.subRootVe.displayItem)) { return hitInfo.subRootVe; }
    return null;
  },
  isOverTableInComposite: (hitInfo: HitInfo): boolean => {
    return (HitInfoFns.getTableContainerVe(hitInfo) != null) && (HitInfoFns.getCompositeContainerVe(hitInfo) != null);
  },
  toDebugString: (hitInfo: HitInfo): string => {
    let result = "";
    if (hitInfo.overVes == null) {
      result += "overVes: null\n";
    } else {
      const overVe = hitInfo.overVes.get();
      result += `overVes: [${overVe.displayItem.id}] [x: ${overVe.boundsPx.x}, y: ${overVe.boundsPx.y}, w: ${overVe.boundsPx.w}, h: ${overVe.boundsPx.h}]\n`;
    }
    result += `rootVe: (${hitInfo.rootVes.get().displayItem.id})\n`;
    const subRootVe = hitInfo.subRootVe;
    result += `subRootVe: ${subRootVe ? subRootVe.displayItem.id : "null"}\n`;
    const subSubRootVe = hitInfo.subSubRootVe;
    result += `subSubRootVe: ${subSubRootVe ? subSubRootVe.displayItem.id : "null"}\n`;
    const parentRootVe = hitInfo.parentRootVe;
    result += `parentRootVe: ${parentRootVe ? parentRootVe.displayItem.id : "null"}\n`;
    result += "hitboxType: " + HitboxFns.hitboxFlagsToString(hitInfo.hitboxType) + "\n";
    result += "compositeHitboxType: " + HitboxFns.hitboxFlagsToString(hitInfo.compositeHitboxTypeMaybe) + "\n";
    if (!hitInfo.overElementMeta) { result += "overElementMeta: null\n"; }
    result += "debugCreatedAt: " + hitInfo.debugCreatedAt + "\n";
    return result;
  },
  hit: (store: StoreContextModel, posOnDesktopPx: Vector, ignoreItems: Array<Uid>, canHitEmbeddedInteractive: boolean): HitInfo => {
    const ignoreSet = new Set<Uid>(ignoreItems);
    return getHitInfo(store, posOnDesktopPx, ignoreSet, canHitEmbeddedInteractive);
  }
};

function parentVe(ve: VisualElement): VisualElement {
  return VesCache.get(ve.parentPath!)!.get();
}

function returnIfHitAndNotIgnored(rootInfo: RootInfo, ignoreItems: Set<Uid>): HitInfo | null {
  if (rootInfo.hitMaybe) {
    const overVes = rootInfo.hitMaybe.overVes;
    if (overVes == null) { return rootInfo.hitMaybe; }
    if (!isIgnored(overVes.get().displayItem.id, ignoreItems)) { return rootInfo.hitMaybe; }
  }
  return null;
}


export function getHitInfo(
  store: StoreContextModel,
  posOnDesktopPx: Vector,
  ignoreItems: Set<Uid>,
  canHitEmbeddedInteractive: boolean,
): HitInfo {
  const umbrellaVe: VisualElement = store.umbrellaVisualElement.get();
  assert(umbrellaVe.childrenVes.length == 1, "expecting umbrella visual element to have exactly one child");
  let rootInfo = determineTopLevelRoot(store, umbrellaVe, posOnDesktopPx);
  const hitTop = returnIfHitAndNotIgnored(rootInfo, ignoreItems);
  if (hitTop) { return hitTop; }
  type RootResolver = (info: RootInfo) => RootInfo;
  const resolvers: Array<RootResolver> = [
    (info) => hitPagePopupRootMaybe(store, info, posOnDesktopPx, canHitEmbeddedInteractive),
    (info) => hitNonPagePopupMaybe(store, info, posOnDesktopPx, canHitEmbeddedInteractive, ignoreItems),
    (info) => hitPageSelectedRootMaybe(store, info, posOnDesktopPx, canHitEmbeddedInteractive),
    (info) => hitEmbeddedRootMaybe(store, info, ignoreItems, canHitEmbeddedInteractive),
    (info) => hitFlipCardRootMaybe(info, ignoreItems),
  ];
  for (const resolve of resolvers) {
    rootInfo = resolve(rootInfo);
    const hit = returnIfHitAndNotIgnored(rootInfo, ignoreItems);
    if (hit) { return hit; }
  }
  return getHitInfoUnderRoot(store, posOnDesktopPx, ignoreItems, canHitEmbeddedInteractive, rootInfo);
}


function getHitInfoUnderRoot(
  store: StoreContextModel,
  posOnDesktopPx: Vector,
  ignoreItems: Set<Uid>,
  canHitEmbeddedInteractive: boolean,
  rootInfo: RootInfo,
): HitInfo {
  const { parentRootVe, rootVes, rootVe, posRelativeToRootVeViewportPx } = rootInfo;
  for (let i=rootVe.childrenVes.length-1; i>=0; --i) {
    const hitMaybe = hitChildMaybe(store, posOnDesktopPx, rootVes, parentRootVe, posRelativeToRootVeViewportPx, rootVe.childrenVes[i], ignoreItems, canHitEmbeddedInteractive);
    if (hitMaybe) { return hitMaybe; }
  }
  if (rootVe.selectedVes) {
    const hitMaybe = hitChildMaybe(store, posOnDesktopPx, rootVes, parentRootVe, posRelativeToRootVeViewportPx, rootVe.selectedVes, ignoreItems, canHitEmbeddedInteractive);
    if (hitMaybe) { return hitMaybe; }
  }
  return new HitBuilder(parentRootVe, rootVes).over(rootVes).hitboxes(HitboxFlags.None, HitboxFlags.None).meta(null).pos(posRelativeToRootVeViewportPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("getHitInfoUnderRoot").build();
}


function hitChildMaybe(
  store: StoreContextModel,
  posOnDesktopPx: Vector,
  rootVes: VisualElementSignal,
  parentRootVe: VisualElement | null,
  posRelativeToRootVeViewportPx: Vector,
  childVes: VisualElementSignal,
  ignoreItems: Set<Uid>,
  canHitEmbeddedInteractive: boolean,
): HitInfo | null {
  const childVe = childVes.get();
  if (childVe.flags & VisualElementFlags.IsDock) { return null; }
  {
    if (isComposite(childVe.displayItem)) {
      for (let i=0; i<childVe.childrenVes.length; ++i) {
        let ve = childVe.childrenVes[i].get();
        const posRelativeToChildElementPx = toInnerAttachmentLocalInComposite(childVe, ve, posRelativeToRootVeViewportPx);
        const hit = findAttachmentHit(ve.attachmentsVes, posRelativeToChildElementPx, ignoreItems, false);
        if (hit) {
          const compositeParentVe = childVe;
          const parentOfComposite = parentVe(compositeParentVe);
          const parentOfParent = parentVe(parentOfComposite);
          return {
            overVes: hit.attachmentVes,
            rootVes,
            subRootVe: compositeParentVe,
            subSubRootVe: parentOfComposite,
            parentRootVe,
            hitboxType: hit.flags,
            compositeHitboxTypeMaybe: HitboxFlags.None,
            overElementMeta: hit.meta,
            overPositionableVe: parentOfParent,
            overPositionGr: { x: 0, y: 0 },
            debugCreatedAt: "hitChildMaybe1",
          };
        }
      }
    }
    const posRelativeToChildElementPx = toChildBoundsLocalFromViewport(posRelativeToRootVeViewportPx, childVe);
    const hit = findAttachmentHit(childVe.attachmentsVes, posRelativeToChildElementPx, ignoreItems, true);
    if (hit) {
      const parent = parentVe(childVe);
      const grandparent = parentVe(parent);
      return {
        overVes: hit.attachmentVes,
        rootVes,
        subRootVe: parent,
        subSubRootVe: childVe.flags & VisualElementFlags.InsideCompositeOrDoc ? childVe : null,
        parentRootVe,
        hitboxType: hit.flags,
        compositeHitboxTypeMaybe: HitboxFlags.None,
        overElementMeta: hit.meta,
        overPositionableVe: grandparent,
        overPositionGr: { x: 0, y: 0 },
        debugCreatedAt: "hitChildMaybe1",
      };
    }
  }
  if (!isInside(posRelativeToRootVeViewportPx, childVe.boundsPx)) { return null; }
  const ctx = { store, rootVes, parentRootVe, posRelativeToRootVeViewportPx, ignoreItems, posOnDesktopPx, canHitEmbeddedInteractive };
  for (const handler of HitHandlers) {
    if (handler.canHandle(childVe)) {
      const res = handler.handle(childVe, childVes, ctx as any);
      if (res) { return res; }
    }
  }
  const { flags: hitboxType, meta } = scanHitboxes(childVe, posRelativeToRootVeViewportPx, getBoundingBoxTopLeft(childVe.boundsPx));
  if (!isIgnored(childVe.displayItem.id, ignoreItems)) {
    return new HitBuilder(parentRootVe, rootVes).over(childVes).hitboxes(hitboxType, HitboxFlags.None).meta(meta).pos(posRelativeToRootVeViewportPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("hitChildMaybe").build();
  }
  return null;
}


function determineTopLevelRoot(
  store: StoreContextModel,
  umbrellaVe: VisualElement,
  posOnDesktopPx: Vector,
): RootInfo {
  if (umbrellaVe.childrenVes.length != 1) { panic("expected umbrellaVisualElement to have a child"); }
  const dockRootMaybe = determineIfDockRoot(umbrellaVe, posOnDesktopPx);
  if (dockRootMaybe != null) { return dockRootMaybe; }
  let currentPageVe = umbrellaVe.childrenVes[0].get();
  let currentPageVes = umbrellaVe.childrenVes[0];
  const currentPageVeid = store.history.currentPageVeid()!;
  let posRelativeToTopLevelVePx: Vector | null = null;
  if (asPageItem(currentPageVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
    if (posOnDesktopPx.x - store.getCurrentDockWidthPx() < currentPageVe.listViewportBoundsPx!.w) {
      posRelativeToTopLevelVePx = vectorAdd(posOnDesktopPx, { x: 0, y: store.perItem.getPageScrollYProp(currentPageVeid) * (currentPageVe.listChildAreaBoundsPx!.h - currentPageVe.boundsPx.h) });
    }
  }
  if (posRelativeToTopLevelVePx == null) {
    posRelativeToTopLevelVePx = vectorAdd(posOnDesktopPx, {
      x: store.perItem.getPageScrollXProp(currentPageVeid) * (currentPageVe.childAreaBoundsPx!.w - currentPageVe.boundsPx.w),
      y: store.perItem.getPageScrollYProp(currentPageVeid) * (currentPageVe.childAreaBoundsPx!.h - currentPageVe.boundsPx.h)
    });
  }
  let posRelativeToRootVeBoundsPx = { ...posRelativeToTopLevelVePx };
  const dockWidthPx = store.getCurrentDockWidthPx();
  posRelativeToRootVeBoundsPx.x = posRelativeToRootVeBoundsPx.x - dockWidthPx;
  let posRelativeToRootVeViewportPx = { ...posRelativeToRootVeBoundsPx };
  return ({
    parentRootVe: null,
    rootVes: currentPageVes,
    rootVe: currentPageVe,
    posRelativeToRootVeBoundsPx,
    posRelativeToRootVeViewportPx,
    hitMaybe: null
  });
}


function hitNonPagePopupMaybe(
  store: StoreContextModel,
  parentRootInfo: RootInfo,
  posOnDesktopPx: Vector,
  canHitEmbeddedInteractive: boolean,
  ignoreItems: Set<Uid>,
): RootInfo {
  let rootVe = parentRootInfo.rootVe;
  if (!rootVe.popupVes) { return parentRootInfo; }
  if (isPage(rootVe.popupVes.get().displayItem)) { return parentRootInfo; }
  let rootVes = parentRootInfo.rootVes;
  let posRelativeToRootVeBoundsPx = parentRootInfo.posRelativeToRootVeBoundsPx;
  posOnDesktopPx = { ...posOnDesktopPx };
  posOnDesktopPx.x = posOnDesktopPx.x + store.getCurrentDockWidthPx();
  const popupRootVesMaybe = rootVe.popupVes!;
  const popupRootVeMaybe = popupRootVesMaybe.get();
  const popupPosRelativeToTopLevelVePx = (popupRootVeMaybe.flags & VisualElementFlags.Fixed)
    ? { x: posOnDesktopPx.x - store.getCurrentDockWidthPx(), y: posOnDesktopPx.y }
    : posRelativeToRootVeBoundsPx;
  if (!isInside(popupPosRelativeToTopLevelVePx, popupRootVeMaybe.boundsPx)) { return parentRootInfo; }
  rootVes = popupRootVesMaybe;
  rootVe = popupRootVeMaybe;
  posRelativeToRootVeBoundsPx = vectorSubtract(popupPosRelativeToTopLevelVePx, { x: rootVe.boundsPx.x, y: rootVe.boundsPx.y });
  let posRelativeToRootVeViewportPx = vectorSubtract(
    popupPosRelativeToTopLevelVePx,
    isPage(popupRootVeMaybe.displayItem) ? getBoundingBoxTopLeft(rootVe.viewportBoundsPx!) : getBoundingBoxTopLeft(rootVe.boundsPx)
  );
  const { flags: hitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, posRelativeToRootVeBoundsPx);
  if (isTable(rootVe.displayItem)) {
    if (hitboxType != HitboxFlags.None && hitboxType != HitboxFlags.Move && !isIgnored(rootVe.displayItem.id, ignoreItems)) {
      return ({
        parentRootVe: parentRootInfo.parentRootVe,
        rootVes,
        rootVe,
        posRelativeToRootVeBoundsPx,
        posRelativeToRootVeViewportPx,
        hitMaybe: new HitBuilder(parentRootInfo.rootVe, rootVes).over(rootVes).hitboxes(hitboxType, HitboxFlags.None).meta(hitboxMeta).pos(posRelativeToRootVeBoundsPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("hitNonPagePopupMaybe1").build()
      });
    }
    for (let j=0; j<rootVe.childrenVes.length; ++j) {
      const tableChildVes = rootVe.childrenVes[j];
      const tableChildVe = tableChildVes.get();
      const tableBlockHeightPx = tableChildVe.boundsPx.h;
      const posRelativeToTableChildAreaPx = vectorSubtract(posRelativeToRootVeBoundsPx, { x: 0.0, y: (rootVe.viewportBoundsPx!.y - rootVe.boundsPx.y) - store.perItem.getTableScrollYPos(VeFns.veidFromVe(rootVe)) * tableBlockHeightPx });
      {
        const attHit = findAttachmentHit(tableChildVe.attachmentsVes, posRelativeToTableChildAreaPx, ignoreItems, false);
        if (attHit) {
          const hitMaybe = {
            overVes: attHit.attachmentVes,
            rootVes,
            subRootVe: rootVe,
            subSubRootVe: null,
            parentRootVe: parentRootInfo.parentRootVe,
            hitboxType: attHit.flags,
            compositeHitboxTypeMaybe: HitboxFlags.None,
            overElementMeta: attHit.meta,
            overPositionableVe: parentRootInfo.rootVe,
            overPositionGr: { x: 0, y: 0 },
            debugCreatedAt: "hitNonPagePopupMaybe-table-attachment",
          } as HitInfo;
          return ({
            parentRootVe: parentRootInfo.parentRootVe,
            rootVes,
            rootVe,
            posRelativeToRootVeBoundsPx,
            posRelativeToRootVeViewportPx,
            hitMaybe
          });
        }
      }
      if (isInside(posRelativeToTableChildAreaPx, tableChildVe.boundsPx)) {
        const { flags: thFlags, meta } = scanHitboxes(tableChildVe, posRelativeToTableChildAreaPx, getBoundingBoxTopLeft(tableChildVe.boundsPx));
        if (!isIgnored(tableChildVe.displayItem.id, ignoreItems)) {
          const hitMaybe = new HitBuilder(parentRootInfo.parentRootVe, rootVes).over(tableChildVes).hitboxes(thFlags, HitboxFlags.None).meta(meta).pos(posRelativeToRootVeBoundsPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("hitNonPagePopupMaybe-table-child").build();
          return ({ parentRootVe: parentRootInfo.parentRootVe, rootVes, rootVe, posRelativeToRootVeBoundsPx, posRelativeToRootVeViewportPx, hitMaybe });
        }
      }
    }
    if (hitboxType != HitboxFlags.None && !isIgnored(rootVe.displayItem.id, ignoreItems)) {
      return ({ parentRootVe: parentRootInfo.parentRootVe, rootVes, rootVe, posRelativeToRootVeBoundsPx, posRelativeToRootVeViewportPx, hitMaybe: new HitBuilder(parentRootInfo.rootVe, rootVes).over(rootVes).hitboxes(hitboxType, HitboxFlags.None).meta(hitboxMeta).pos(posRelativeToRootVeBoundsPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("hitNonPagePopupMaybe1").build() });
    }
    return parentRootInfo;
  }
  for (let i=rootVe.childrenVes.length-1; i>=0; --i) {
    const hitMaybe = hitChildMaybe(store, posOnDesktopPx, rootVes, parentRootInfo.parentRootVe, posRelativeToRootVeViewportPx, rootVe.childrenVes[i], ignoreItems, canHitEmbeddedInteractive);
    if (hitMaybe) { return ({ parentRootVe: parentRootInfo.parentRootVe, rootVes, rootVe, posRelativeToRootVeBoundsPx, posRelativeToRootVeViewportPx, hitMaybe }); }
  }
  if (hitboxType != HitboxFlags.None && !isIgnored(rootVe.displayItem.id, ignoreItems)) {
    return ({ parentRootVe: parentRootInfo.parentRootVe, rootVes, rootVe, posRelativeToRootVeBoundsPx, posRelativeToRootVeViewportPx, hitMaybe: new HitBuilder(parentRootInfo.rootVe, rootVes).over(rootVes).hitboxes(hitboxType, HitboxFlags.None).meta(hitboxMeta).pos(posRelativeToRootVeBoundsPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("hitNonPagePopupMaybe1").build() });
  }
  return parentRootInfo;
}


function hitPagePopupRootMaybe(
  store: StoreContextModel,
  parentRootInfo: RootInfo,
  posOnDesktopPx: Vector,
  canHitEmbeddedInteractive: boolean,
): RootInfo {
  let rootVe = parentRootInfo.rootVe;
  let rootVes = parentRootInfo.rootVes;
  let posRelativeToRootVeBoundsPx = parentRootInfo.posRelativeToRootVeBoundsPx;
  let changedRoot = false;
  if (rootVe.popupVes && isPage(rootVe.popupVes.get().displayItem)) {
    posOnDesktopPx = { ...posOnDesktopPx };
    posOnDesktopPx.x = posOnDesktopPx.x + store.getCurrentDockWidthPx();
    const popupRootVesMaybe = rootVe.popupVes!;
    const popupRootVeMaybe = popupRootVesMaybe.get();
    const popupPosRelativeToTopLevelVePx = (popupRootVeMaybe.flags & VisualElementFlags.Fixed) ? { x: posOnDesktopPx.x - store.getCurrentDockWidthPx(), y: posOnDesktopPx.y } : posRelativeToRootVeBoundsPx;
    if (isInside(popupPosRelativeToTopLevelVePx, popupRootVeMaybe.boundsPx)) {
      rootVes = popupRootVesMaybe;
      rootVe = popupRootVeMaybe;
      const { flags: hitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, vectorSubtract(popupPosRelativeToTopLevelVePx, { x: rootVe.boundsPx.x, y: rootVe.boundsPx.y }));
      if (hitboxType != HitboxFlags.None) {
        return ({ parentRootVe: parentRootInfo.rootVe, rootVes, rootVe, posRelativeToRootVeBoundsPx: vectorSubtract(popupPosRelativeToTopLevelVePx, { x: rootVe.boundsPx.x, y: rootVe.boundsPx.y }), posRelativeToRootVeViewportPx: vectorSubtract(popupPosRelativeToTopLevelVePx, isPage(popupRootVeMaybe.displayItem) ? getBoundingBoxTopLeft(rootVe.viewportBoundsPx!) : getBoundingBoxTopLeft(rootVe.boundsPx)), hitMaybe: new HitBuilder(parentRootInfo.rootVe, rootVes).over(rootVes).hitboxes(hitboxType, HitboxFlags.None).meta(hitboxMeta).pos(vectorSubtract(popupPosRelativeToTopLevelVePx, { x: rootVe.boundsPx.x, y: rootVe.boundsPx.y })).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("determinePopupOrSelectedRootMaybe1").build() });
      }
      posRelativeToRootVeBoundsPx = vectorSubtract(popupPosRelativeToTopLevelVePx, { x: rootVe.boundsPx!.x, y: rootVe.boundsPx!.y });
      changedRoot = true;
    }
  }
  const { flags: hitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, posRelativeToRootVeBoundsPx);
  let hitMaybe = null as HitInfo | null;
  if (hitboxType != HitboxFlags.None) {
    hitMaybe = new HitBuilder(parentRootInfo.rootVe, rootVes).over(rootVes).hitboxes(hitboxType, HitboxFlags.None).meta(hitboxMeta).pos(posRelativeToRootVeBoundsPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("determinePopupOrSelectedRootMaybe3").build();
  }
  const posRelativeToRootVeViewportPx = { ...posRelativeToRootVeBoundsPx };
  posRelativeToRootVeViewportPx.y = posRelativeToRootVeViewportPx.y - (rootVe.boundsPx.h - rootVe.viewportBoundsPx!.h);
  let result: RootInfo = { parentRootVe: parentRootInfo.rootVe, rootVes, rootVe, posRelativeToRootVeBoundsPx, posRelativeToRootVeViewportPx, hitMaybe };
  if (changedRoot && rootVe.selectedVes) { return hitPageSelectedRootMaybe(store, result, posOnDesktopPx, canHitEmbeddedInteractive); }
  return result;
}


function hitPageSelectedRootMaybe(
  store: StoreContextModel,
  parentRootInfo: RootInfo,
  posOnDesktopPx: Vector,
  canHitEmbeddedInteractive: boolean,
): RootInfo {
  let rootVe = parentRootInfo.rootVe;
  let rootVes = parentRootInfo.rootVes;
  let posRelativeToRootVeBoundsPx = parentRootInfo.posRelativeToRootVeBoundsPx;
  let changedRoot = false;
  if (rootVe.selectedVes != null) {
    const newRootVesMaybe = rootVe.selectedVes!;
    const newRootVeMaybe = newRootVesMaybe.get();
    if (isPage(newRootVeMaybe.displayItem)) {
      if (isInside(posRelativeToRootVeBoundsPx, newRootVeMaybe.boundsPx)) {
        rootVes = newRootVesMaybe;
        rootVe = newRootVeMaybe;
        let veid = VeFns.actualVeidFromVe(newRootVeMaybe);
        const scrollPropX = store.perItem.getPageScrollXProp(veid);
        const scrollPropY = store.perItem.getPageScrollYProp(veid);
        posRelativeToRootVeBoundsPx = vectorSubtract(posRelativeToRootVeBoundsPx, { x: newRootVeMaybe.boundsPx!.x - scrollPropX * (newRootVeMaybe.childAreaBoundsPx!.w - newRootVeMaybe.viewportBoundsPx!.w), y: newRootVeMaybe.boundsPx!.y - scrollPropY * (newRootVeMaybe.childAreaBoundsPx!.h - newRootVeMaybe.viewportBoundsPx!.h) });
        changedRoot = true;
      }
    }
  }
  const { flags: hitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, posRelativeToRootVeBoundsPx);
  let hitMaybe = null as HitInfo | null;
  if (hitboxType != HitboxFlags.None) {
    hitMaybe = new HitBuilder(parentRootInfo.rootVe, rootVes).over(rootVes).hitboxes(hitboxType, HitboxFlags.None).meta(hitboxMeta).pos(posRelativeToRootVeBoundsPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("determinePopupOrSelectedRootMaybe3").build();
  }
  const posRelativeToRootVeViewportPx = { ...posRelativeToRootVeBoundsPx };
  posRelativeToRootVeViewportPx.y = posRelativeToRootVeViewportPx.y - (rootVe.boundsPx.h - rootVe.viewportBoundsPx!.h);
  let result: RootInfo = { parentRootVe: parentRootInfo.rootVe, rootVes, rootVe, posRelativeToRootVeBoundsPx, posRelativeToRootVeViewportPx, hitMaybe };
  return result;
}


function hitEmbeddedRootMaybe(
  store: StoreContextModel,
  parentRootInfo: RootInfo,
  ignoreItems: Set<Uid>,
  canHitEmbeddedInteractive: boolean,
): RootInfo {
  const { rootVe, posRelativeToRootVeViewportPx } = parentRootInfo;
  for (let i=0; i<rootVe.childrenVes.length; ++i) {
    const childVes = rootVe.childrenVes[i];
    const childVe = childVes.get();
    if (isIgnored(childVe.displayItem.id, ignoreItems)) { continue; }
    if (!(childVe.flags & VisualElementFlags.EmbeddedInteractiveRoot)) { continue; }
    if (isInside(posRelativeToRootVeViewportPx, childVe.boundsPx!)) {
      const childVeid = VeFns.veidFromVe(childVe);
      const scrollPropX = store.perItem.getPageScrollXProp(childVeid);
      const scrollPropY = store.perItem.getPageScrollYProp(childVeid);
      const newPosRelativeToRootVeViewportPx = vectorSubtract(posRelativeToRootVeViewportPx, { x: childVe.viewportBoundsPx!.x - scrollPropX * (childVe.childAreaBoundsPx!.w - childVe.viewportBoundsPx!.w), y: childVe.viewportBoundsPx!.y - scrollPropY * (childVe.childAreaBoundsPx!.h - childVe.viewportBoundsPx!.h)});
      const newPosRelativeToRootVeBoundsPx = vectorSubtract(posRelativeToRootVeViewportPx, { x: childVe.boundsPx.x - scrollPropX * (childVe.childAreaBoundsPx!.w - childVe.viewportBoundsPx!.w), y: childVe.boundsPx.y - scrollPropY * (childVe.childAreaBoundsPx!.h - childVe.viewportBoundsPx!.h)});
      const { flags: hitboxType } = scanHitboxes(childVe, newPosRelativeToRootVeBoundsPx);
      return ({ parentRootVe: parentRootInfo.rootVe, rootVes: childVes, rootVe: childVe, posRelativeToRootVeViewportPx: newPosRelativeToRootVeViewportPx, posRelativeToRootVeBoundsPx: newPosRelativeToRootVeBoundsPx, hitMaybe: hitboxType != HitboxFlags.None ? new HitBuilder(parentRootInfo.rootVe, childVes).over(childVes).hitboxes(hitboxType, HitboxFlags.None).meta(null).pos(newPosRelativeToRootVeViewportPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("determineEmbeddedRootMaybe").build() : null });
    }
  }
  return parentRootInfo;
}


function hitFlipCardRootMaybe(
  parentRootInfo: RootInfo,
  ignoreItems: Set<Uid>,
): RootInfo {
  const { rootVe, posRelativeToRootVeViewportPx } = parentRootInfo;
  for (let i=0; i<rootVe.childrenVes.length; ++i) {
    const childVes = rootVe.childrenVes[i];
    const childVe = childVes.get();
    if (isIgnored(childVe.displayItem.id, ignoreItems)) { continue; }
    if (!isFlipCard(childVe.displayItem)) { continue; }
    if (isInside(posRelativeToRootVeViewportPx, childVe.viewportBoundsPx!)) {
      const newPosRelativeToRootVeViewportPx = vectorSubtract(posRelativeToRootVeViewportPx, { x: childVe.viewportBoundsPx!.x, y: childVe.viewportBoundsPx!.y });
      const newPosRelativeToRootVeBoundsPx = vectorSubtract(posRelativeToRootVeViewportPx, { x: childVe.boundsPx.x, y: childVe.boundsPx.y });
      const { flags: hitboxType } = scanHitboxes(childVe, newPosRelativeToRootVeBoundsPx);
      if (hitboxType) {
        return ({ parentRootVe: parentRootInfo.rootVe, rootVes: childVes, rootVe: childVe, posRelativeToRootVeViewportPx: newPosRelativeToRootVeViewportPx, posRelativeToRootVeBoundsPx: newPosRelativeToRootVeBoundsPx, hitMaybe: new HitBuilder(parentRootInfo.rootVe, childVes).over(childVes).hitboxes(hitboxType, HitboxFlags.None).meta(null).pos(newPosRelativeToRootVeViewportPx).allowEmbeddedInteractive(true).createdAt("determineFlipCardRootMaybe").build() });
      }
      const pageVes = childVe.childrenVes[0];
      return ({ parentRootVe: childVe, rootVes: pageVes, rootVe: pageVes.get(), posRelativeToRootVeViewportPx: newPosRelativeToRootVeViewportPx, posRelativeToRootVeBoundsPx: newPosRelativeToRootVeBoundsPx, hitMaybe: null });
    }
  }
  return parentRootInfo;
}


function determineIfDockRoot(umbrellaVe: VisualElement, posOnDesktopPx: Vector): RootInfo | null {
  if (umbrellaVe.dockVes == null) { return null; }
  let dockVes = umbrellaVe.dockVes;
  const dockVe = dockVes.get();
  if (!isInside(posOnDesktopPx, dockVe.boundsPx)) { return null; }
  const posRelativeToRootVePx = vectorSubtract(posOnDesktopPx, { x: dockVe.boundsPx.x, y: dockVe.boundsPx.y });
  const { flags: hitboxType } = scanHitboxes(dockVe, posRelativeToRootVePx);
  if (hitboxType != HitboxFlags.None) {
    return ({ parentRootVe: null, rootVes: dockVes, rootVe: dockVe, posRelativeToRootVeBoundsPx: posRelativeToRootVePx, posRelativeToRootVeViewportPx: posRelativeToRootVePx, hitMaybe: new HitBuilder(null, dockVes).over(dockVes).hitboxes(hitboxType, HitboxFlags.None).meta(null).pos(posRelativeToRootVePx).allowEmbeddedInteractive(false).createdAt("determineIfDockRoot").build() });
  }
  return ({ parentRootVe: null, rootVes: dockVes, rootVe: dockVe, posRelativeToRootVeBoundsPx: posRelativeToRootVePx, posRelativeToRootVeViewportPx: posRelativeToRootVePx, hitMaybe: null });
}
