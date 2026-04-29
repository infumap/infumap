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
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { isSearch } from "../../items/search-item";
import { isTable } from "../../items/table-item";
import { isContainer } from "../../items/base/container-item";
import { HitboxFlags, HitboxFns } from "../../layout/hitbox";
import { getDockScrollYPx } from "../../layout/arrange/dock";
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
import { findAttachmentHit, isIgnored, isInsideBoundsOrAllowedHitbox, scanHitboxes, toChildBoundsLocalFromViewport, toInnerAttachmentLocalInComposite } from "./utils";

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
      // Prefer the nearest container ancestor of the directly-over element
      // so drops target containers instead of leaf items (important in dock).
      let candidate = hitInfo.overVes.get();
      while (candidate && (!isContainer(candidate.displayItem) || (candidate.flags & VisualElementFlags.LineItem))) {
        if (!candidate.parentPath) { break; }
        const parent = VesCache.current.readNode(candidate.parentPath)!;
        candidate = parent;
      }
      if (candidate && !isIgnored(candidate.displayItem.id, ignoredSet)) { return candidate; }
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
  hit: (store: StoreContextModel, posOnDesktopPx: Vector, ignoreItems: Array<Uid>, canHitEmbeddedInteractive: boolean, allowOutsideBoundsHitboxes: boolean = true): HitInfo => {
    const ignoreSet = new Set<Uid>(ignoreItems);
    return getHitInfo(store, posOnDesktopPx, ignoreSet, canHitEmbeddedInteractive, allowOutsideBoundsHitboxes);
  }
};

function parentVe(ve: VisualElement): VisualElement {
  return VesCache.current.readNode(ve.parentPath!)!;
}

function isListPageVe(ve: VisualElement): boolean {
  if (!isPage(ve.displayItem)) { return false; }
  return (ve.linkItemMaybe?.overrideArrangeAlgorithm ?? asPageItem(ve.displayItem).arrangeAlgorithm) == ArrangeAlgorithm.List;
}

function hasPopupAncestor(ve: VisualElement): boolean {
  let parentPath = ve.parentPath;
  while (parentPath != null) {
    const parent = VesCache.current.readNode(parentPath);
    if (!parent) { return false; }
    if (parent.flags & VisualElementFlags.Popup) { return true; }
    parentPath = parent.parentPath;
  }
  return false;
}

function selectedPopupListRootHitboxType(rootVe: VisualElement, hitboxType: HitboxFlags): HitboxFlags {
  if (!(rootVe.flags & VisualElementFlags.ListPageRoot) || !hasPopupAncestor(rootVe)) {
    return hitboxType;
  }

  return (hitboxType & ~(HitboxFlags.OpenPopup | HitboxFlags.ShowPointer)) as HitboxFlags;
}

function popupListTitleTargetPathMaybe(rootVe: VisualElement, titleLocalPos: Vector): string | null {
  if (!isListPageVe(rootVe) || !rootVe.listViewportBoundsPx) { return null; }
  const headerHeightPx = rootVe.boundsPx.h - (rootVe.viewportBoundsPx?.h ?? rootVe.boundsPx.h);
  if (headerHeightPx <= 0 || titleLocalPos.y < 0 || titleLocalPos.y >= headerHeightPx) { return null; }

  const rootPath = VeFns.veToPath(rootVe);
  let currentLeftPx = 0;
  let currentWidthPx = rootVe.listViewportBoundsPx.w;
  if (titleLocalPos.x >= currentLeftPx && titleLocalPos.x < currentLeftPx + currentWidthPx) {
    return rootPath;
  }

  currentLeftPx += currentWidthPx;
  let currentVes = VesCache.render.getSelected(rootPath)();
  while (currentVes != null) {
    const selectedVe = currentVes.get();
    if (!isPage(selectedVe.displayItem) || !selectedVe.viewportBoundsPx) { return null; }

    const selectedPath = VeFns.veToPath(selectedVe);
    if (isListPageVe(selectedVe)) {
      currentWidthPx = selectedVe.listViewportBoundsPx?.w ?? 0;
      if (currentWidthPx <= 0) { return null; }
      if (titleLocalPos.x >= currentLeftPx && titleLocalPos.x < currentLeftPx + currentWidthPx) {
        return selectedPath;
      }
      currentLeftPx += currentWidthPx;
      currentVes = VesCache.render.getSelected(selectedPath)();
      continue;
    }

    if (titleLocalPos.x >= currentLeftPx && titleLocalPos.x <= rootVe.boundsPx.w) {
      return selectedPath;
    }
    return null;
  }

  return null;
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
  allowOutsideBoundsHitboxes: boolean = true,
): HitInfo {
  const umbrellaVe: VisualElement = store.umbrellaVisualElement.get();
  assert(VesCache.render.getChildren(VeFns.veToPath(umbrellaVe))().length == 1, "expecting umbrella visual element to have exactly one child");
  let rootInfo = determineTopLevelRoot(store, umbrellaVe, posOnDesktopPx);
  const hitTop = returnIfHitAndNotIgnored(rootInfo, ignoreItems);
  if (hitTop) { return hitTop; }
  type RootResolver = (info: RootInfo) => RootInfo;
  const resolvers: Array<RootResolver> = [
    (info) => hitPagePopupRootMaybe(store, info, posOnDesktopPx, canHitEmbeddedInteractive),
    (info) => hitNonPagePopupMaybe(store, info, posOnDesktopPx, canHitEmbeddedInteractive, ignoreItems, allowOutsideBoundsHitboxes),
    (info) => hitPageSelectedRootMaybe(store, info, posOnDesktopPx, canHitEmbeddedInteractive),
    (info) => hitEmbeddedRootMaybe(store, info, ignoreItems, canHitEmbeddedInteractive),
  ];

  const visitedRootPaths = new Set<string>();
  while (true) {
    const passStartRootPath = VeFns.veToPath(rootInfo.rootVe);
    if (visitedRootPaths.has(passStartRootPath)) { break; }
    visitedRootPaths.add(passStartRootPath);

    let rootChanged = false;
    for (const resolve of resolvers) {
      const previousRootPath = VeFns.veToPath(rootInfo.rootVe);
      rootInfo = resolve(rootInfo);
      const hit = returnIfHitAndNotIgnored(rootInfo, ignoreItems);
      if (hit) { return hit; }
      if (VeFns.veToPath(rootInfo.rootVe) != previousRootPath) {
        rootChanged = true;
      }
    }

    if (!rootChanged) { break; }
  }

  return getHitInfoUnderRoot(store, posOnDesktopPx, ignoreItems, canHitEmbeddedInteractive, rootInfo, allowOutsideBoundsHitboxes);
}


function getHitInfoUnderRoot(
  store: StoreContextModel,
  posOnDesktopPx: Vector,
  ignoreItems: Set<Uid>,
  canHitEmbeddedInteractive: boolean,
  rootInfo: RootInfo,
  allowOutsideBoundsHitboxes: boolean,
): HitInfo {
  const { parentRootVe, rootVes, rootVe } = rootInfo;
  let { posRelativeToRootVeViewportPx } = rootInfo;

  // For list pages in popups/nested contexts, add the scroll offset to convert from viewport position to child area position
  // This is necessary because list children have their boundsPx in child area coordinates (not scroll-adjusted)
  const rootPageItem = asPageItem(rootVe.displayItem);
  const isListPage = rootPageItem.arrangeAlgorithm == ArrangeAlgorithm.List;

  // Check if this is the actual top-level root (parentRootVe == null)
  // For actual top-level roots, scroll is already applied in determineTopLevelRoot
  const isActualTopLevelRoot = parentRootVe == null;

  // For list pages, apply scroll offset if this is NOT the actual top-level root
  if (isListPage && rootVe.listChildAreaBoundsPx && !isActualTopLevelRoot) {
    const listVeid = VeFns.actualVeidFromVe(rootVe);
    const scrollYProp = store.perItem.getPageScrollYProp(listVeid);
    const listChildAreaH = rootVe.listChildAreaBoundsPx.h;
    const viewportH = rootVe.viewportBoundsPx!.h;
    const scrollYPx = scrollYProp * (listChildAreaH - viewportH);

    posRelativeToRootVeViewportPx = { ...posRelativeToRootVeViewportPx };
    posRelativeToRootVeViewportPx.y = posRelativeToRootVeViewportPx.y + scrollYPx;
  }

  const posRelativeToRootChildAreaPx = (() => {
    if (rootPageItem.arrangeAlgorithm != ArrangeAlgorithm.Document) {
      return posRelativeToRootVeViewportPx;
    }

    const documentContentLeftPx = Math.max(
      (rootVe.viewportBoundsPx!.w - rootVe.childAreaBoundsPx!.w) / 2,
      0,
    );

    return {
      ...posRelativeToRootVeViewportPx,
      x: posRelativeToRootVeViewportPx.x - documentContentLeftPx,
    };
  })();

  const rootVeChildren = VesCache.render.getChildren(VeFns.veToPath(rootVe))();
  for (let i = rootVeChildren.length - 1; i >= 0; --i) {
    const hitMaybe = hitChildMaybe(store, posOnDesktopPx, rootVes, parentRootVe, posRelativeToRootChildAreaPx, rootVeChildren[i], ignoreItems, canHitEmbeddedInteractive, allowOutsideBoundsHitboxes);
    if (hitMaybe) { return hitMaybe; }
  }
  const selectedVes = VesCache.render.getSelected(VeFns.veToPath(rootVe))();
  if (selectedVes) {
    const hitMaybe = hitChildMaybe(store, posOnDesktopPx, rootVes, parentRootVe, posRelativeToRootChildAreaPx, selectedVes, ignoreItems, canHitEmbeddedInteractive, allowOutsideBoundsHitboxes);
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
  allowOutsideBoundsHitboxes: boolean,
): HitInfo | null {
  const childVe = childVes.get();
  if (childVe.flags & VisualElementFlags.IsDock) { return null; }
  if ((rootVes.get().flags & VisualElementFlags.IsDock) && (childVe.flags & VisualElementFlags.IsTrash)) {
    const dockViewportLocalPosPx = {
      x: posRelativeToRootVeViewportPx.x,
      y: posRelativeToRootVeViewportPx.y - getDockScrollYPx(store, rootVes.get()),
    };
    if (!isInside(dockViewportLocalPosPx, childVe.boundsPx)) { return null; }
    const { flags: hitboxType, meta } = scanHitboxes(childVe, dockViewportLocalPosPx, getBoundingBoxTopLeft(childVe.boundsPx));
    if (!isIgnored(childVe.displayItem.id, ignoreItems)) {
      return new HitBuilder(parentRootVe, rootVes).over(childVes).hitboxes(hitboxType, HitboxFlags.None).meta(meta).pos(dockViewportLocalPosPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("hitChildMaybe-dock-trash").build();
    }
    return null;
  }
  {
    if (isComposite(childVe.displayItem)) {
      const childVeChildren = VesCache.render.getChildren(VeFns.veToPath(childVe))();
      for (let i = 0; i < childVeChildren.length; ++i) {
        let ve = childVeChildren[i].get();
        const posRelativeToChildElementPx = toInnerAttachmentLocalInComposite(childVe, ve, posRelativeToRootVeViewportPx);
        const hit = findAttachmentHit(VesCache.render.getAttachments(VeFns.veToPath(ve))(), posRelativeToChildElementPx, ignoreItems, false);
        if (hit) {
          const compositeParentVe = childVe;
          const parentOfComposite = parentVe(compositeParentVe);
          return {
            overVes: hit.attachmentVes,
            rootVes,
            subRootVe: compositeParentVe,
            subSubRootVe: parentOfComposite,
            parentRootVe,
            hitboxType: hit.flags,
            compositeHitboxTypeMaybe: HitboxFlags.None,
            overElementMeta: hit.meta,
            overPositionableVe: parentOfComposite,
            overPositionGr: { x: 0, y: 0 },
            debugCreatedAt: "hitChildMaybe1",
          };
        }
      }
    }
    const posRelativeToChildElementPx = toChildBoundsLocalFromViewport(posRelativeToRootVeViewportPx, childVe);
    const hit = findAttachmentHit(VesCache.render.getAttachments(VeFns.veToPath(childVe))(), posRelativeToChildElementPx, ignoreItems, true);
    if (hit) {
      const parent = parentVe(childVe);
      const grandparent = parentVe(parent);
      const childIsInsideCompositeOrDoc = !!(childVe.flags & VisualElementFlags.InsideCompositeOrDoc);
      return {
        overVes: hit.attachmentVes,
        rootVes,
        subRootVe: parent,
        subSubRootVe: childIsInsideCompositeOrDoc ? childVe : null,
        parentRootVe,
        hitboxType: hit.flags,
        compositeHitboxTypeMaybe: HitboxFlags.None,
        overElementMeta: hit.meta,
        overPositionableVe: childIsInsideCompositeOrDoc ? grandparent : parent,
        overPositionGr: { x: 0, y: 0 },
        debugCreatedAt: "hitChildMaybe1",
      };
    }
  }
  {
    const searchWorkspaceHit = hitSearchWorkspaceMaybe(
      store,
      posOnDesktopPx,
      rootVes,
      parentRootVe,
      posRelativeToRootVeViewportPx,
      childVes,
      ignoreItems,
      canHitEmbeddedInteractive,
      allowOutsideBoundsHitboxes,
    );
    if (searchWorkspaceHit) { return searchWorkspaceHit; }
  }
  {
    const searchWorkspaceChildPageHit = hitSearchWorkspaceChildPageMaybe(
      store,
      posOnDesktopPx,
      rootVes,
      posRelativeToRootVeViewportPx,
      childVes,
      ignoreItems,
      canHitEmbeddedInteractive,
      allowOutsideBoundsHitboxes,
    );
    if (searchWorkspaceChildPageHit) { return searchWorkspaceChildPageHit; }
  }
  if (!isInsideBoundsOrAllowedHitbox(childVe, posRelativeToRootVeViewportPx, getBoundingBoxTopLeft(childVe.boundsPx), allowOutsideBoundsHitboxes)) { return null; }
  const ctx = { store, rootVes, parentRootVe, posRelativeToRootVeViewportPx, ignoreItems, posOnDesktopPx, canHitEmbeddedInteractive, allowOutsideBoundsHitboxes };
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


function hitSearchWorkspaceMaybe(
  store: StoreContextModel,
  posOnDesktopPx: Vector,
  rootVes: VisualElementSignal,
  parentRootVe: VisualElement | null,
  posRelativeToRootVeViewportPx: Vector,
  childVes: VisualElementSignal,
  ignoreItems: Set<Uid>,
  canHitEmbeddedInteractive: boolean,
  allowOutsideBoundsHitboxes: boolean,
): HitInfo | null {
  const childVe = childVes.get();
  if (!isSearch(childVe.displayItem)) { return null; }
  if (!isInside(posRelativeToRootVeViewportPx, childVe.boundsPx)) { return null; }

  const posRelativeToSearchBoundsPx = vectorSubtract(
    posRelativeToRootVeViewportPx,
    getBoundingBoxTopLeft(childVe.boundsPx),
  );
  const searchChildren = VesCache.render.getChildren(VeFns.veToPath(childVe))();
  for (let i = searchChildren.length - 1; i >= 0; --i) {
    const hitMaybe = hitChildMaybe(
      store,
      posOnDesktopPx,
      childVes,
      rootVes.get(),
      posRelativeToSearchBoundsPx,
      searchChildren[i],
      ignoreItems,
      canHitEmbeddedInteractive,
      allowOutsideBoundsHitboxes,
    );
    if (hitMaybe) { return hitMaybe; }
  }

  return null;
}


function hitSearchWorkspaceChildPageMaybe(
  store: StoreContextModel,
  posOnDesktopPx: Vector,
  rootVes: VisualElementSignal,
  posRelativeToRootVeViewportPx: Vector,
  childVes: VisualElementSignal,
  ignoreItems: Set<Uid>,
  canHitEmbeddedInteractive: boolean,
  allowOutsideBoundsHitboxes: boolean,
): HitInfo | null {
  const childVe = childVes.get();
  if (!isPage(childVe.displayItem) || !(childVe.flags & VisualElementFlags.ShowChildren)) { return null; }
  if (!childVe.parentPath || !childVe.viewportBoundsPx || !childVe.childAreaBoundsPx) { return null; }

  const parentVe = VesCache.current.readNode(childVe.parentPath);
  if (!parentVe || !isSearch(parentVe.displayItem)) { return null; }
  if (!isInside(posRelativeToRootVeViewportPx, childVe.boundsPx)) { return null; }

  const childVeid = VeFns.actualVeidFromVe(childVe);
  const scrollPropX = store.perItem.getPageScrollXProp(childVeid);
  const scrollPropY = store.perItem.getPageScrollYProp(childVeid);
  const posRelativeToChildBoundsPx = vectorSubtract(posRelativeToRootVeViewportPx, {
    x: childVe.boundsPx.x - scrollPropX * (childVe.childAreaBoundsPx.w - childVe.viewportBoundsPx.w),
    y: childVe.boundsPx.y - scrollPropY * (childVe.childAreaBoundsPx.h - childVe.viewportBoundsPx.h),
  });
  const posRelativeToChildViewportPx = {
    ...posRelativeToChildBoundsPx,
    y: posRelativeToChildBoundsPx.y - (childVe.boundsPx.h - childVe.viewportBoundsPx.h),
  };

  const childChildren = VesCache.render.getChildren(VeFns.veToPath(childVe))();
  for (let i = childChildren.length - 1; i >= 0; --i) {
    const hitMaybe = hitChildMaybe(
      store,
      posOnDesktopPx,
      childVes,
      rootVes.get(),
      posRelativeToChildViewportPx,
      childChildren[i],
      ignoreItems,
      canHitEmbeddedInteractive,
      allowOutsideBoundsHitboxes,
    );
    if (hitMaybe) { return hitMaybe; }
  }

  const { flags: hitboxType, meta } = scanHitboxes(childVe, vectorSubtract(posRelativeToRootVeViewportPx, getBoundingBoxTopLeft(childVe.boundsPx)));
  if (hitboxType == HitboxFlags.None || isIgnored(childVe.displayItem.id, ignoreItems)) { return null; }

  return new HitBuilder(rootVes.get(), childVes)
    .over(childVes)
    .hitboxes(hitboxType, HitboxFlags.None)
    .meta(meta)
    .pos(posRelativeToChildBoundsPx)
    .allowEmbeddedInteractive(canHitEmbeddedInteractive)
    .createdAt("search-workspace-child-page")
    .build();
}


function determineTopLevelRoot(
  store: StoreContextModel,
  umbrellaVe: VisualElement,
  posOnDesktopPx: Vector,
): RootInfo {
  if (VesCache.render.getChildren(VeFns.veToPath(umbrellaVe))().length != 1) { panic("expected umbrellaVisualElement to have a child"); }
  const dockRootMaybe = determineIfDockRoot(store, umbrellaVe, posOnDesktopPx);
  if (dockRootMaybe != null) { return dockRootMaybe; }
  let currentPageVes = VesCache.render.getChildren(VeFns.veToPath(umbrellaVe))()[0];
  let currentPageVe = currentPageVes.get();
  const currentPageVeid = store.history.currentPageVeid()!;
  let posRelativeToTopLevelVePx: Vector | null = null;
  if (isPage(currentPageVe.displayItem) && asPageItem(currentPageVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
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
  allowOutsideBoundsHitboxes: boolean,
): RootInfo {
  let rootVe = parentRootInfo.rootVe;
  if (!VesCache.render.getPopup(VeFns.veToPath(rootVe))()) { return parentRootInfo; }
  if (isPage(VesCache.render.getPopup(VeFns.veToPath(rootVe))()!.get().displayItem)) { return parentRootInfo; }
  let rootVes = parentRootInfo.rootVes;
  let posRelativeToRootVeBoundsPx = parentRootInfo.posRelativeToRootVeBoundsPx;
  posOnDesktopPx = { ...posOnDesktopPx };
  posOnDesktopPx.x = posOnDesktopPx.x + store.getCurrentDockWidthPx();
  const popupRootVesMaybe = VesCache.render.getPopup(VeFns.veToPath(rootVe))()!;
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
    const rootVeChildren = VesCache.render.getChildren(VeFns.veToPath(rootVe))();
    for (let j = 0; j < rootVeChildren.length; ++j) {
      const tableChildVes = rootVeChildren[j];
      const tableChildVe = tableChildVes.get();
      const tableBlockHeightPx = tableChildVe.boundsPx.h;
      const posRelativeToTableChildAreaPx = vectorSubtract(posRelativeToRootVeBoundsPx, { x: 0.0, y: (rootVe.viewportBoundsPx!.y - rootVe.boundsPx.y) - store.perItem.getTableScrollYPos(VeFns.veidFromVe(rootVe)) * tableBlockHeightPx });
      {
        const attHit = findAttachmentHit(VesCache.render.getAttachments(VeFns.veToPath(tableChildVe))(), posRelativeToTableChildAreaPx, ignoreItems, false);
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
      if (isInsideBoundsOrAllowedHitbox(tableChildVe, posRelativeToTableChildAreaPx, getBoundingBoxTopLeft(tableChildVe.boundsPx))) {
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
  const rootVeChildren = VesCache.render.getChildren(VeFns.veToPath(rootVe))();
  for (let i = rootVeChildren.length - 1; i >= 0; --i) {
    const hitMaybe = hitChildMaybe(store, posOnDesktopPx, rootVes, parentRootInfo.parentRootVe, posRelativeToRootVeViewportPx, rootVeChildren[i], ignoreItems, canHitEmbeddedInteractive, allowOutsideBoundsHitboxes);
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
  const popupVes = VesCache.render.getPopup(VeFns.veToPath(rootVe))();
  if (popupVes && isPage(popupVes.get().displayItem)) {
    posOnDesktopPx = { ...posOnDesktopPx };
    posOnDesktopPx.x = posOnDesktopPx.x + store.getCurrentDockWidthPx();
    const popupRootVesMaybe = popupVes!;
    const popupRootVeMaybe = popupRootVesMaybe.get();
    const popupPosRelativeToTopLevelVePx = (popupRootVeMaybe.flags & VisualElementFlags.Fixed) ? { x: posOnDesktopPx.x - store.getCurrentDockWidthPx(), y: posOnDesktopPx.y } : posRelativeToRootVeBoundsPx;
    if (isInside(popupPosRelativeToTopLevelVePx, popupRootVeMaybe.boundsPx)) {
      rootVes = popupRootVesMaybe;
      rootVe = popupRootVeMaybe;
      const posRelativeToPopupBoundsPx = vectorSubtract(popupPosRelativeToTopLevelVePx, { x: rootVe.boundsPx.x, y: rootVe.boundsPx.y });
      const { flags: hitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, posRelativeToPopupBoundsPx);
      if (hitboxType != HitboxFlags.None) {
        const titleTargetPath = (hitboxType & (HitboxFlags.AnchorChild | HitboxFlags.AnchorDefault))
          ? null
          : popupListTitleTargetPathMaybe(rootVe, posRelativeToPopupBoundsPx);
        const effectiveMeta = titleTargetPath
          ? { ...(hitboxMeta ?? {}), popupTitleTargetPath: titleTargetPath }
          : hitboxMeta;
        return ({ parentRootVe: parentRootInfo.rootVe, rootVes, rootVe, posRelativeToRootVeBoundsPx: posRelativeToPopupBoundsPx, posRelativeToRootVeViewportPx: vectorSubtract(popupPosRelativeToTopLevelVePx, isPage(popupRootVeMaybe.displayItem) ? getBoundingBoxTopLeft(rootVe.viewportBoundsPx!) : getBoundingBoxTopLeft(rootVe.boundsPx)), hitMaybe: new HitBuilder(parentRootInfo.rootVe, rootVes).over(rootVes).hitboxes(hitboxType, HitboxFlags.None).meta(effectiveMeta).pos(posRelativeToPopupBoundsPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("determinePopupOrSelectedRootMaybe1").build() });
      }
      posRelativeToRootVeBoundsPx = vectorSubtract(popupPosRelativeToTopLevelVePx, { x: rootVe.boundsPx!.x, y: rootVe.boundsPx!.y });
      changedRoot = true;
    }
  }
  const { flags: scannedHitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, posRelativeToRootVeBoundsPx);
  const hitboxType = selectedPopupListRootHitboxType(rootVe, scannedHitboxType);
  let hitMaybe = null as HitInfo | null;
  if (hitboxType != HitboxFlags.None) {
    hitMaybe = new HitBuilder(parentRootInfo.rootVe, rootVes).over(rootVes).hitboxes(hitboxType, HitboxFlags.None).meta(hitboxMeta).pos(posRelativeToRootVeBoundsPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("determinePopupOrSelectedRootMaybe3").build();
  }

  // Calculate posRelativeToRootVeViewportPx - only adjust for title bar here
  // Scroll offset for list pages will be applied in getHitInfoUnderRoot
  let posRelativeToRootVeViewportPx = { ...posRelativeToRootVeBoundsPx };
  // Dock pages reserve space below the viewport for the fixed trash area, not above it.
  const rootTopInsetPx = rootVe.flags & VisualElementFlags.IsDock
    ? 0
    : (rootVe.boundsPx.h - rootVe.viewportBoundsPx!.h);
  posRelativeToRootVeViewportPx.y = posRelativeToRootVeViewportPx.y - rootTopInsetPx;

  // If root changed, parentRootVe is the previous root. Otherwise preserve the original parentRootVe.
  const effectiveParentRootVe = changedRoot ? parentRootInfo.rootVe : parentRootInfo.parentRootVe;
  let result: RootInfo = { parentRootVe: effectiveParentRootVe, rootVes, rootVe, posRelativeToRootVeBoundsPx, posRelativeToRootVeViewportPx, hitMaybe };
  if (changedRoot && VesCache.render.getSelected(VeFns.veToPath(rootVe))()) { return hitPageSelectedRootMaybe(store, result, posOnDesktopPx, canHitEmbeddedInteractive); }
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
  let posRelativeToRootVeViewportPx = parentRootInfo.posRelativeToRootVeViewportPx;
  let changedRoot = false;

  const selectedVes = VesCache.render.getSelected(VeFns.veToPath(rootVe))();
  if (selectedVes != null) {
    const newRootVesMaybe = selectedVes!;
    const newRootVeMaybe = newRootVesMaybe.get();
    if (isPage(newRootVeMaybe.displayItem)) {
      if (isInside(posRelativeToRootVeViewportPx, newRootVeMaybe.boundsPx)) {
        rootVes = newRootVesMaybe;
        rootVe = newRootVeMaybe;
        let veid = VeFns.actualVeidFromVe(newRootVeMaybe);
        const scrollPropX = store.perItem.getPageScrollXProp(veid);
        const scrollPropY = store.perItem.getPageScrollYProp(veid);

        // For all pages, use childAreaBoundsPx for scroll calculation
        // List pages have childAreaBoundsPx == viewportBoundsPx, so scrollPropY effect is 0 here
        // The actual list page scroll adjustment happens in getHitInfoUnderRoot
        posRelativeToRootVeBoundsPx = vectorSubtract(posRelativeToRootVeViewportPx, {
          x: newRootVeMaybe.boundsPx!.x - scrollPropX * (newRootVeMaybe.childAreaBoundsPx!.w - newRootVeMaybe.viewportBoundsPx!.w),
          y: newRootVeMaybe.boundsPx!.y - scrollPropY * (newRootVeMaybe.childAreaBoundsPx!.h - newRootVeMaybe.viewportBoundsPx!.h)
        });

        changedRoot = true;
      }
    }
  }
  // The root's own hitboxes (e.g. ShiftLeft) are in viewport-local coords (no scroll offset),
  // so scan them with the position relative to the root's bounds top-left, without scroll adjustment.
  const posForRootHitboxScan = changedRoot
    ? vectorSubtract(posRelativeToRootVeViewportPx, { x: rootVe.boundsPx.x, y: rootVe.boundsPx.y })
    : posRelativeToRootVeBoundsPx;
  const { flags: scannedHitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, posForRootHitboxScan);
  const hitboxType = selectedPopupListRootHitboxType(rootVe, scannedHitboxType);
  let hitMaybe = null as HitInfo | null;
  if (hitboxType != HitboxFlags.None) {
    hitMaybe = new HitBuilder(parentRootInfo.rootVe, rootVes).over(rootVes).hitboxes(hitboxType, HitboxFlags.None).meta(hitboxMeta).pos(posRelativeToRootVeBoundsPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("determinePopupOrSelectedRootMaybe3").build();
  }

  // Calculate posRelativeToRootVeViewportPx - only adjust for title bar here
  // Scroll offset for list pages will be applied in getHitInfoUnderRoot
  posRelativeToRootVeViewportPx = { ...posRelativeToRootVeBoundsPx };
  const rootTopInsetPx = rootVe.flags & VisualElementFlags.IsDock
    ? 0
    : (rootVe.boundsPx.h - rootVe.viewportBoundsPx!.h);
  posRelativeToRootVeViewportPx.y = posRelativeToRootVeViewportPx.y - rootTopInsetPx;

  // If root changed, parentRootVe is the previous root. Otherwise preserve the original parentRootVe.
  const effectiveParentRootVe = changedRoot ? parentRootInfo.rootVe : parentRootInfo.parentRootVe;
  let result: RootInfo = { parentRootVe: effectiveParentRootVe, rootVes, rootVe, posRelativeToRootVeBoundsPx, posRelativeToRootVeViewportPx, hitMaybe };
  if (changedRoot && VesCache.render.getSelected(VeFns.veToPath(rootVe))()) { return hitPageSelectedRootMaybe(store, result, posOnDesktopPx, canHitEmbeddedInteractive); }
  return result;
}


function hitEmbeddedRootMaybe(
  store: StoreContextModel,
  parentRootInfo: RootInfo,
  ignoreItems: Set<Uid>,
  canHitEmbeddedInteractive: boolean,
): RootInfo {
  const { rootVe, posRelativeToRootVeViewportPx } = parentRootInfo;
  const rootVeChildren = VesCache.render.getChildren(VeFns.veToPath(rootVe))();
  for (let i = 0; i < rootVeChildren.length; ++i) {
    const childVes = rootVeChildren[i];
    const childVe = childVes.get();
    if (isIgnored(childVe.displayItem.id, ignoreItems)) { continue; }
    if (!(childVe.flags & VisualElementFlags.EmbeddedInteractiveRoot)) { continue; }
    if (isInside(posRelativeToRootVeViewportPx, childVe.boundsPx!)) {
      const childVeid = VeFns.veidFromVe(childVe);
      const scrollPropX = store.perItem.getPageScrollXProp(childVeid);
      const scrollPropY = store.perItem.getPageScrollYProp(childVeid);
      const newPosRelativeToRootVeViewportPx = vectorSubtract(posRelativeToRootVeViewportPx, { x: childVe.viewportBoundsPx!.x - scrollPropX * (childVe.childAreaBoundsPx!.w - childVe.viewportBoundsPx!.w), y: childVe.viewportBoundsPx!.y - scrollPropY * (childVe.childAreaBoundsPx!.h - childVe.viewportBoundsPx!.h) });
      const newPosRelativeToRootVeBoundsPx = vectorSubtract(posRelativeToRootVeViewportPx, { x: childVe.boundsPx.x - scrollPropX * (childVe.childAreaBoundsPx!.w - childVe.viewportBoundsPx!.w), y: childVe.boundsPx.y - scrollPropY * (childVe.childAreaBoundsPx!.h - childVe.viewportBoundsPx!.h) });
      const { flags: hitboxType } = scanHitboxes(childVe, newPosRelativeToRootVeBoundsPx);
      return ({ parentRootVe: parentRootInfo.rootVe, rootVes: childVes, rootVe: childVe, posRelativeToRootVeViewportPx: newPosRelativeToRootVeViewportPx, posRelativeToRootVeBoundsPx: newPosRelativeToRootVeBoundsPx, hitMaybe: hitboxType != HitboxFlags.None ? new HitBuilder(parentRootInfo.rootVe, childVes).over(childVes).hitboxes(hitboxType, HitboxFlags.None).meta(null).pos(newPosRelativeToRootVeViewportPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("determineEmbeddedRootMaybe").build() : null });
    }
  }
  return parentRootInfo;
}


function determineIfDockRoot(store: StoreContextModel, umbrellaVe: VisualElement, posOnDesktopPx: Vector): RootInfo | null {
  const dockVesAccessor = VesCache.render.getDock(VeFns.veToPath(umbrellaVe));
  if (!dockVesAccessor()) { return null; }
  let dockVes = dockVesAccessor()!;
  const dockVe = dockVes.get();
  if (!isInside(posOnDesktopPx, dockVe.boundsPx)) { return null; }
  const posRelativeToDockViewportPx = vectorSubtract(posOnDesktopPx, { x: dockVe.boundsPx.x, y: dockVe.boundsPx.y });
  const { flags: hitboxType } = scanHitboxes(dockVe, posRelativeToDockViewportPx);
  if (hitboxType != HitboxFlags.None) {
    return ({ parentRootVe: null, rootVes: dockVes, rootVe: dockVe, posRelativeToRootVeBoundsPx: posRelativeToDockViewportPx, posRelativeToRootVeViewportPx: posRelativeToDockViewportPx, hitMaybe: new HitBuilder(null, dockVes).over(dockVes).hitboxes(hitboxType, HitboxFlags.None).meta(null).pos(posRelativeToDockViewportPx).allowEmbeddedInteractive(false).createdAt("determineIfDockRoot").build() });
  }
  const dockScrollYPx = getDockScrollYPx(store, dockVe);
  const posRelativeToDockChildAreaPx = vectorAdd(posRelativeToDockViewportPx, { x: 0, y: dockScrollYPx });
  return ({ parentRootVe: null, rootVes: dockVes, rootVe: dockVe, posRelativeToRootVeBoundsPx: posRelativeToDockChildAreaPx, posRelativeToRootVeViewportPx: posRelativeToDockChildAreaPx, hitMaybe: null });
}
