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
import { isContainer } from "../items/base/container-item";
import { asTitledItem, isTitledItem } from "../items/base/titled-item";
import { isComposite } from "../items/composite-item";
import { isFlipCard } from "../items/flipcard-item";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../items/page-item";
import { isTable } from "../items/table-item";
import { HitboxMeta, HitboxFlags, HitboxFns } from "../layout/hitbox";
import { VesCache } from "../layout/ves-cache";
import { VisualElement, VisualElementFlags, VeFns } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { Vector, cloneVector, getBoundingBoxTopLeft, isInside, offsetBoundingBoxTopLeftBy, vectorAdd, vectorSubtract } from "../util/geometry";
import { assert, panic } from "../util/lang";
import { VisualElementSignal } from "../util/signals";
import { Uid } from "../util/uid";


/**
 * Information pertaining to the current visual state under a specific screen pixel position.
 * The result of a call to HitInfoFns.hit.
 * 
 * rootVe, subRootVe, subSubRootVe and overVes are always different elements (or null).
 * Use helper methods in HitInfoFns to derive the required VE from these.
 */
export interface HitInfo {

  /**
   * The highest hit visual element, or null if that is rootVe.
   */
  overVes: VisualElementSignal | null,

  /**
   * The highest fully editable page directly under the specified position.
   */
  rootVes: VisualElementSignal,

  /**
   * If overVes is not directly in rootVe, the container directly above rootVe that it is in.
   */
  subRootVe: VisualElement | null,

  /**
   * If overVes is not directly in rootVe, or the container above it (subRootVe), the container directly above that that it is in.
   */
  subSubRootVe: VisualElement | null,

  /**
   * If rootVes has a parent (which is not the umbrella ve), then that.
   */
  parentRootVe: VisualElement | null,

  /**
   * The intersected hitbox flags of overVes.
   */
  hitboxType: HitboxFlags,

  /**
   * If the item hit was inside a composite container, the intersected hitbox flags of the composite container, else None.
   */
  compositeHitboxTypeMaybe: HitboxFlags,

  /**
   * Meta data from the hit hitbox of the visual element under specified position.
   */
  overElementMeta: HitboxMeta | null,


  /**
   * The visual element that defines scaling/positioning immediately under the specified position (for a table this is it's parent page).
   * This could be a non-interactive page (i.e. may be different from the root).
   *
   * TODO: make this derived.
   */
  overPositionableVe: VisualElement | null,

  /**
   * Position in the positionable element.
   */
  overPositionGr: Vector | null,

  /**
   * A string that identifies the point in the code the HitInfo was created. Useful for debugging.
   */
  debugCreatedAt: string,
}


/**
 * HitInfo Helper functions.
 */
export const HitInfoFns = {

  /**
   * The visual element that was hit - the over element, or root if there is none.
   */
  getHitVe: (hitInfo: HitInfo): VisualElement => {
    if (hitInfo.overVes) { return hitInfo.overVes.get(); }
    return hitInfo.rootVes.get();
  },

  /**
   * The visual element signal that was hit - the over element, or root if there is none.
   */
  getHitVes: (hitInfo: HitInfo): VisualElementSignal => {
    if (hitInfo.overVes) { return hitInfo.overVes; }
    return hitInfo.rootVes;
  },

  /**
   * The top most container element (including if this was the hit element)
   */
  getOverContainerVe: (hitInfo: HitInfo, ignoreItems: Array<Uid> | Set<Uid> = []): VisualElement => {
    const ignoredSet: Set<Uid> = Array.isArray(ignoreItems) ? new Set(ignoreItems) : ignoreItems;
    if (hitInfo.overVes) {
      if (isContainer(hitInfo.overVes.get().displayItem)) {
        if (hitInfo.subRootVe && isTable(hitInfo.subRootVe!.displayItem)) {
          if (hitInfo.hitboxType & HitboxFlags.Click) {
            if (!isIgnored(hitInfo.subRootVe!.displayItem.id, ignoredSet)) {
              return hitInfo.subRootVe;
            }
          }
        }
        if (!isIgnored(hitInfo.overVes!.get().displayItem.id, ignoredSet)) {
          return hitInfo.overVes.get();
        }
      }
    }
    if (hitInfo.subSubRootVe && !isIgnored(hitInfo.subSubRootVe!.displayItem.id, ignoredSet)) {
      return hitInfo.subSubRootVe;
    }
    if (hitInfo.subRootVe && !isIgnored(hitInfo.subRootVe!.displayItem.id, ignoredSet)) {
      return hitInfo.subRootVe;
    }
    if (!isIgnored(hitInfo.rootVes.get().displayItem.id, ignoredSet)) {
      return hitInfo.rootVes.get();
    }
    // Fallback: if everything is ignored, return rootVes anyway to avoid null
    return hitInfo.rootVes.get();
  },

  /**
   * The visual element container immediately under the hit element.
   */
  getContainerImmediatelyUnderOverVe: (hitInfo: HitInfo): VisualElement => {
    if (hitInfo.subSubRootVe) { return hitInfo.subSubRootVe; }
    if (hitInfo.subRootVe) { return hitInfo.subRootVe; }
    return hitInfo.rootVes.get();
  },

  /**
   * Gets the composite container under the hit point, or null if there is none.
   */
  getCompositeContainerVe: (hitInfo: HitInfo): VisualElement | null => {
    if (hitInfo.overVes && isComposite(hitInfo.overVes.get().displayItem)) { return hitInfo.overVes.get(); }
    if (hitInfo.subSubRootVe && isComposite(hitInfo.subSubRootVe.displayItem)) { return hitInfo.subSubRootVe; }
    if (hitInfo.subRootVe && isComposite(hitInfo.subRootVe.displayItem)) { return hitInfo.subRootVe; }
    return null;
  },

  /**
   * Gets the table container under the hit point, or null if there is none.
   */
  getTableContainerVe: (hitInfo: HitInfo): VisualElement | null => {
    if (hitInfo.overVes && isTable(hitInfo.overVes!.get().displayItem)) { return hitInfo.overVes.get(); }
    if (hitInfo.subSubRootVe && isTable(hitInfo.subSubRootVe.displayItem)) { return hitInfo.subSubRootVe; }
    if (hitInfo.subRootVe && isTable(hitInfo.subRootVe.displayItem)) { return hitInfo.subRootVe; }
    return null;
  },

  /**
   * Whether or not the hit point is over a table (or child of the table) inside a composite.
   */
  isOverTableInComposite: (hitInfo: HitInfo): boolean => {
    return (HitInfoFns.getTableContainerVe(hitInfo) != null) && (HitInfoFns.getCompositeContainerVe(hitInfo) != null);
  },

  toDebugString: (hitInfo: HitInfo): string => {
    let result = "";

    if (hitInfo.overVes == null) {
      result += "overVes: null\n";
    } else {
      const overVe = hitInfo.overVes.get();
      if (isTitledItem(overVe.displayItem)) {
        result += "overVes: '" + asTitledItem(overVe.displayItem).title + "' (" + overVe.displayItem.id + ")  ";
      } else {
        result += "overVes: [N/A] (" + overVe.displayItem.id + ")  ";
      }
      result += `[x: ${overVe.boundsPx.x}, y: ${overVe.boundsPx.y}, w: ${overVe.boundsPx.w}, h: ${overVe.boundsPx.h}]\n`;
    }

    if (isPage(hitInfo.rootVes.get().displayItem)) {
      result += "rootVe: '" + asPageItem(hitInfo.rootVes.get().displayItem).title + "' (" + hitInfo.rootVes.get().displayItem.id + ")\n";
    } else {
      result += "rootVe: '[flipcard]' (" + hitInfo.rootVes.get().displayItem.id + ")\n";
    }

    const subRootVe = hitInfo.subRootVe;
    if (!subRootVe) {
      result += "subRootVe: null\n";
    } else {
      if (isTitledItem(subRootVe.displayItem)) {
        result += "subRootVe: '" + asTitledItem(subRootVe.displayItem).title + "' (" + subRootVe.displayItem.id + ")\n";
      } else {
        result += "subRootVe: [" + subRootVe.displayItem.itemType + "] (" + subRootVe.displayItem.id + ")\n";
      }
    }

    const subSubRootVe = hitInfo.subSubRootVe;
    if (!subSubRootVe) {
      result += "subSubRootVe: null\n";
    } else {
      if (isTitledItem(subSubRootVe.displayItem)) {
        result += "subSubRootVe: '" + asTitledItem(subSubRootVe.displayItem).title + "' (" + subSubRootVe.displayItem.id + ")\n";
      } else {
        result += "subSubRootVe: [" + subSubRootVe.displayItem.itemType + "] (" + subSubRootVe.displayItem.id + ")\n";
      }
    }

    const parentRootVe = hitInfo.parentRootVe;
    if (!parentRootVe) {
      result += "parentRootVe: null\n";
    } else {
      if (isTitledItem(parentRootVe.displayItem)) {
        result += "parentRootVe: '" + asTitledItem(parentRootVe.displayItem).title + "' (" + parentRootVe.displayItem.id + ")\n";
      } else {
        result += "parentRootVe: [" + parentRootVe.displayItem.itemType + "] (" + parentRootVe.displayItem.id + ")\n";
      }
    }

    result += "hitboxType: " + HitboxFns.hitboxFlagsToString(hitInfo.hitboxType) + "\n";

    result += "compositeHitboxType: " + HitboxFns.hitboxFlagsToString(hitInfo.compositeHitboxTypeMaybe) + "\n";

    if (!hitInfo.overElementMeta) {
      result += "overElementMeta: null\n";
    } else {
      result += "overElementMeta: " + HitboxFns.hitboxMetaToString(hitInfo.overElementMeta) + "\n";
    }

    const overPositionableVe = hitInfo.overPositionableVe;
    if (!overPositionableVe) {
      result += "overPositionableVe: null\n";
    } else {
      if (isTitledItem(overPositionableVe.displayItem)) {
        result += "overPositionableVe: '" + asTitledItem(overPositionableVe.displayItem).title + "' (" + overPositionableVe.displayItem.id + ")\n";
      } else {
        result += "overPositionableVe: [" + overPositionableVe.displayItem.itemType + "] (" + overPositionableVe.displayItem.id + ")\n";
      }
    }

    if (!hitInfo.overPositionGr) {
      result += "overPositionGr: null\n";
    } else {
      result += "overPositionGr: (" + hitInfo.overPositionGr!.x + ", " + hitInfo.overPositionGr!.y + ")\n";
    }

    result += "debugCreatedAt: " + hitInfo.debugCreatedAt + "\n";

    return result;
  },

  /**
   * Intersect posOnDesktopPx with the cached visual element state.
   */
  hit: (store: StoreContextModel,
        posOnDesktopPx: Vector,
        ignoreItems: Array<Uid>,
        canHitEmbeddedInteractive: boolean): HitInfo => {
    const ignoreSet = new Set<Uid>(ignoreItems);
    return getHitInfo(store, posOnDesktopPx, ignoreSet, false, canHitEmbeddedInteractive);
  }
};


interface RootInfo {
  parentRootVe: VisualElement | null,
  rootVes: VisualElementSignal,
  rootVe: VisualElement,
  posRelativeToRootVeViewportPx: Vector,
  posRelativeToRootVeBoundsPx: Vector,
  hitMaybe: HitInfo | null
}

/**
 * If rootInfo has a hit and it is not ignored by id, return it; otherwise null.
 */
function returnIfHitAndNotIgnored(rootInfo: RootInfo, ignoreItems: Set<Uid>): HitInfo | null {
  if (rootInfo.hitMaybe) {
    const overVes = rootInfo.hitMaybe.overVes;
    if (overVes == null) { return rootInfo.hitMaybe; }
    if (!isIgnored(overVes.get().displayItem.id, ignoreItems)) { return rootInfo.hitMaybe; }
  }
  return null;
}

/** Utility: fast ignore check. */
function isIgnored(id: Uid, ignoreItems: Set<Uid>): boolean {
  return ignoreItems.has(id);
}

/**
 * Utility: scan a VE's hitboxes at a local position.
 * If offsetTopLeft is provided, hitboxes are first offset by that top-left.
 */
function scanHitboxes(
    ve: VisualElement,
    localPos: Vector,
    offsetTopLeft?: Vector): { flags: HitboxFlags, meta: HitboxMeta | null } {
  let flags = HitboxFlags.None;
  let meta: HitboxMeta | null = null;
  for (let i = ve.hitboxes.length - 1; i >= 0; --i) {
    const hbBounds = typeof offsetTopLeft === 'undefined'
      ? ve.hitboxes[i].boundsPx
      : offsetBoundingBoxTopLeftBy(ve.hitboxes[i].boundsPx, offsetTopLeft);
    if (isInside(localPos, hbBounds)) {
      flags |= ve.hitboxes[i].type;
      if (ve.hitboxes[i].meta != null) { meta = ve.hitboxes[i].meta; }
    }
  }
  return { flags, meta };
}

/**
 * Utility: find the first attachment that hits at localPos, honoring ignoreItems.
 * If reverse is true, iterate attachments from back to front.
 */
function findAttachmentHit(
    attachmentsVes: Array<VisualElementSignal>,
    localPos: Vector,
    ignoreItems: Set<Uid>,
    reverse: boolean): { attachmentVes: VisualElementSignal, flags: HitboxFlags, meta: HitboxMeta | null } | null {
  if (attachmentsVes.length === 0) { return null; }
  const start = reverse ? attachmentsVes.length - 1 : 0;
  const end = reverse ? -1 : attachmentsVes.length;
  const step = reverse ? -1 : 1;
  for (let i = start; i !== end; i += step) {
    const attachmentVes = attachmentsVes[i];
    const attachmentVe = attachmentVes.get();
    if (!isInside(localPos, attachmentVe.boundsPx)) { continue; }
    if (isIgnored(attachmentVe.displayItem.id, ignoreItems)) { continue; }
    const { flags, meta } = scanHitboxes(
      attachmentVe,
      localPos,
      getBoundingBoxTopLeft(attachmentVe.boundsPx)
    );
    return { attachmentVes, flags, meta };
  }
  return null;
}

/**
 * Coordinate helper: child bounds-local from a parent viewport-local position.
 */
function toChildBoundsLocalFromViewport(parentViewportLocalPos: Vector, childVe: VisualElement): Vector {
  return vectorSubtract(parentViewportLocalPos, { x: childVe.boundsPx.x, y: childVe.boundsPx.y });
}

/**
 * Coordinate helper: composite child area local from parent bounds-local pos.
 */
function toCompositeChildAreaPos(compositeVe: VisualElement, parentBoundsLocalPos: Vector): Vector {
  return vectorSubtract(parentBoundsLocalPos, { x: compositeVe.boundsPx!.x, y: compositeVe.boundsPx!.y });
}

/**
 * Coordinate helper: table child area local from parent bounds-local pos.
 */
function toTableChildAreaPos(
    store: StoreContextModel,
    tableVe: VisualElement,
    tableChildVe: VisualElement,
    parentBoundsLocalPos: Vector): Vector {
  const tableBlockHeightPx = tableChildVe.boundsPx.h;
  return vectorSubtract(
    parentBoundsLocalPos,
    { x: tableVe.viewportBoundsPx!.x,
      y: tableVe.viewportBoundsPx!.y - store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVe)) * tableBlockHeightPx }
  );
}

/**
 * Coordinate helper: inner element local for attachments inside a composite child.
 */
function toInnerAttachmentLocalInComposite(
    parentChildVe: VisualElement,
    innerVe: VisualElement,
    parentViewportLocalPos: Vector): Vector {
  return vectorSubtract(parentViewportLocalPos, { x: parentChildVe.boundsPx.x, y: parentChildVe.boundsPx.y + innerVe.boundsPx.y });
}

function getHitInfo(
    store: StoreContextModel,
    posOnDesktopPx: Vector,
    ignoreItems: Set<Uid>,
    ignoreAttachments: boolean,
    canHitEmbeddedInteractive: boolean): HitInfo {

  const umbrellaVe: VisualElement = store.umbrellaVisualElement.get();
  assert(umbrellaVe.childrenVes.length == 1, "expecting umbrella visual element to have exactly one child");

  // Root is either:
  //  - The top level page, or
  //  - The (page) popup if open and the mouse is over it, or
  //    - Note: non-page popup are handled explicitly immediately here.
  //  - The selected page in a list page, or
  //  - The dock page, or
  //  - An embedded root.
  //  - A flipcard root.
  //
  // progressively narrow it down:

  let rootInfo = determineTopLevelRoot(store, umbrellaVe, posOnDesktopPx);
  const hitTop = returnIfHitAndNotIgnored(rootInfo, ignoreItems);
  if (hitTop) { return hitTop; }

  type RootResolver = (info: RootInfo) => RootInfo;
  const resolvers: Array<RootResolver> = [
    (info) => hitPagePopupRootMaybe(store, info, posOnDesktopPx, canHitEmbeddedInteractive),
    (info) => hitNonPagePopupMaybe(store, info, posOnDesktopPx, canHitEmbeddedInteractive, ignoreItems, ignoreAttachments),
    (info) => hitPageSelectedRootMaybe(store, info, posOnDesktopPx, canHitEmbeddedInteractive),
    (info) => hitEmbeddedRootMaybe(store, info, ignoreItems, canHitEmbeddedInteractive),
    (info) => hitFlipCardRootMaybe(info, ignoreItems),
  ];

  for (const resolve of resolvers) {
    rootInfo = resolve(rootInfo);
    const hit = returnIfHitAndNotIgnored(rootInfo, ignoreItems);
    if (hit) { return hit; }
  }

  return getHitInfoUnderRoot(store, posOnDesktopPx, ignoreItems, ignoreAttachments, canHitEmbeddedInteractive, rootInfo);
}


function getHitInfoUnderRoot(
    store: StoreContextModel,
    posOnDesktopPx: Vector,
    ignoreItems: Set<Uid>,
    ignoreAttachments: boolean,
    canHitEmbeddedInteractive: boolean,
    rootInfo: RootInfo): HitInfo {

  const {
    parentRootVe,
    rootVes,
    rootVe,
    posRelativeToRootVeViewportPx
  } = rootInfo;

  for (let i=rootVe.childrenVes.length-1; i>=0; --i) {
    const hitMaybe = hitChildMaybe(store, posOnDesktopPx, rootVes, parentRootVe, posRelativeToRootVeViewportPx, rootVe.childrenVes[i], ignoreItems, ignoreAttachments, canHitEmbeddedInteractive);
    if (hitMaybe) {
      return hitMaybe;
    }
  }

  if (rootVe.selectedVes) {
    const hitMaybe = hitChildMaybe(store, posOnDesktopPx, rootVes, parentRootVe, posRelativeToRootVeViewportPx, rootVe.selectedVes, ignoreItems, ignoreAttachments, canHitEmbeddedInteractive);
    if (hitMaybe) { return hitMaybe; }
  }

  return finalize(HitboxFlags.None, HitboxFlags.None, parentRootVe, rootVes, rootVes, null, posRelativeToRootVeViewportPx, canHitEmbeddedInteractive, "getHitInfoUnderRoot");
}


function hitChildMaybe(
    store: StoreContextModel,
    posOnDesktopPx: Vector,
    rootVes: VisualElementSignal,
    parentRootVe: VisualElement | null,
    posRelativeToRootVeViewportPx: Vector,
    childVes: VisualElementSignal,
    ignoreItems: Set<Uid>,
    ignoreAttachments: boolean,
    canHitEmbeddedInteractive: boolean): HitInfo | null {

  const childVe = childVes.get();

  if (childVe.flags & VisualElementFlags.IsDock) { return null; }

  // attachments take precedence.
  if (!ignoreAttachments) {

    if (isComposite(childVe.displayItem)) {
      for (let i=0; i<childVe.childrenVes.length; ++i) {
        let ve = childVe.childrenVes[i].get();
        const posRelativeToChildElementPx = toInnerAttachmentLocalInComposite(childVe, ve, posRelativeToRootVeViewportPx);
        const hit = findAttachmentHit(ve.attachmentsVes, posRelativeToChildElementPx, ignoreItems, false);
        if (hit) {
          const noAttachmentResult = getHitInfo(store, posOnDesktopPx, ignoreItems, true, canHitEmbeddedInteractive);
          return {
            overVes: hit.attachmentVes,
            rootVes,
            subRootVe: noAttachmentResult.subRootVe,
            subSubRootVe: noAttachmentResult.subSubRootVe,
            parentRootVe,
            hitboxType: hit.flags,
            compositeHitboxTypeMaybe: HitboxFlags.None,
            overElementMeta: hit.meta,
            overPositionableVe: noAttachmentResult.overPositionableVe,
            overPositionGr: noAttachmentResult.overPositionGr,
            debugCreatedAt: "hitChildMaybe1",
          };
        }
      }
    }

    const posRelativeToChildElementPx = toChildBoundsLocalFromViewport(posRelativeToRootVeViewportPx, childVe);
    {
      const hit = findAttachmentHit(childVe.attachmentsVes, posRelativeToChildElementPx, ignoreItems, true);
      if (hit) {
        const noAttachmentResult = getHitInfo(store, posOnDesktopPx, ignoreItems, true, canHitEmbeddedInteractive);
        return {
          overVes: hit.attachmentVes,
          rootVes,
          subRootVe: noAttachmentResult.subRootVe,
          subSubRootVe: noAttachmentResult.subSubRootVe,
          parentRootVe,
          hitboxType: hit.flags,
          compositeHitboxTypeMaybe: HitboxFlags.None,
          overElementMeta: hit.meta,
          overPositionableVe: noAttachmentResult.overPositionableVe,
          overPositionGr: noAttachmentResult.overPositionGr,
          debugCreatedAt: "hitChildMaybe1",
        };
      }
    }
  }

  if (!isInside(posRelativeToRootVeViewportPx, childVe.boundsPx)) {
    return null;
  }

  if (isTable(childVe.displayItem) && !(childVe.flags & VisualElementFlags.LineItem) && childVe.childAreaBoundsPx == null) {
    console.error("A table visual element unexpectedly had no childAreaBoundsPx set.", childVe);
  }

  const insideTableHit = handleInsideTableMaybe(store, childVe, childVes, parentRootVe, rootVes, posRelativeToRootVeViewportPx, ignoreItems, ignoreAttachments, posOnDesktopPx);
  if (insideTableHit != null) { return insideTableHit; }

  const insideCompositeHit = handleInsideCompositeMaybe(store, childVe, childVes, parentRootVe, rootVes, posRelativeToRootVeViewportPx, ignoreItems, posOnDesktopPx, ignoreAttachments);
  if (insideCompositeHit != null) { return insideCompositeHit; }

  // handle inside any other item (including pages that are sized such that they can't be clicked in).
  const { flags: hitboxType, meta } = scanHitboxes(childVe, posRelativeToRootVeViewportPx, getBoundingBoxTopLeft(childVe.boundsPx));
  if (!isIgnored(childVe.displayItem.id, ignoreItems)) {
    return finalize(hitboxType, HitboxFlags.None, parentRootVe, rootVes, childVes, meta, posRelativeToRootVeViewportPx, canHitEmbeddedInteractive, "hitChildMaybe");
  }

  return null;
}


/**
 * @param posOnDesktopPx does not incorporate page scroll.
 */
function determineTopLevelRoot(
    store: StoreContextModel,
    umbrellaVe: VisualElement,
    posOnDesktopPx: Vector): RootInfo {

  if (umbrellaVe.childrenVes.length != 1) {
    panic("expected umbrellaVisualElement to have a child");
  }

  const dockRootMaybe = determineIfDockRoot(umbrellaVe, posOnDesktopPx);
  if (dockRootMaybe != null) {
    return dockRootMaybe;
  }

  let currentPageVe = umbrellaVe.childrenVes[0].get();
  let currentPageVes = umbrellaVe.childrenVes[0];
  const currentPageVeid = store.history.currentPageVeid()!;

  let posRelativeToTopLevelVePx = null;
  if (asPageItem(currentPageVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
    if (posOnDesktopPx.x - store.getCurrentDockWidthPx() < currentPageVe.listViewportBoundsPx!.w) {
      posRelativeToTopLevelVePx = vectorAdd(
        posOnDesktopPx, {
          x: 0,
          y: store.perItem.getPageScrollYProp(currentPageVeid) * (currentPageVe.listChildAreaBoundsPx!.h - currentPageVe.boundsPx.h)
        });
    }
  }

  if (posRelativeToTopLevelVePx == null) {
    posRelativeToTopLevelVePx = vectorAdd(
      posOnDesktopPx, {
        x: store.perItem.getPageScrollXProp(currentPageVeid) * (currentPageVe.childAreaBoundsPx!.w - currentPageVe.boundsPx.w),
        y: store.perItem.getPageScrollYProp(currentPageVeid) * (currentPageVe.childAreaBoundsPx!.h - currentPageVe.boundsPx.h)
      });
  }

  let posRelativeToRootVeBoundsPx = cloneVector(posRelativeToTopLevelVePx)!;
  const dockWidthPx = store.getCurrentDockWidthPx();
  posRelativeToRootVeBoundsPx.x = posRelativeToRootVeBoundsPx.x - dockWidthPx;
  let posRelativeToRootVeViewportPx = cloneVector(posRelativeToRootVeBoundsPx)!;

  return ({
    parentRootVe: null,
    rootVes: currentPageVes,
    rootVe: currentPageVe,
    posRelativeToRootVeBoundsPx,
    posRelativeToRootVeViewportPx,
    hitMaybe: null
  });
}


/**
 * @param posOnDesktopPx does not incorporate page scroll.
 */
function hitNonPagePopupMaybe(
    store: StoreContextModel,
    parentRootInfo: RootInfo,
    posOnDesktopPx: Vector,
    canHitEmbeddedInteractive: boolean,
    ignoreItems: Set<Uid>,
    ignoreAttachments: boolean): RootInfo {

  let rootVe = parentRootInfo.rootVe;

  if (!rootVe.popupVes) { return parentRootInfo; }
  // Page case is handled already.
  if (isPage(rootVe.popupVes.get().displayItem)) { return parentRootInfo; }

  let rootVes = parentRootInfo.rootVes;
  let posRelativeToRootVeBoundsPx = parentRootInfo.posRelativeToRootVeBoundsPx

  posOnDesktopPx = cloneVector(posOnDesktopPx)!;
  posOnDesktopPx.x = posOnDesktopPx.x + store.getCurrentDockWidthPx();

  const popupRootVesMaybe = rootVe.popupVes!;
  const popupRootVeMaybe = popupRootVesMaybe.get();

  const popupPosRelativeToTopLevelVePx =
    (popupRootVeMaybe.flags & VisualElementFlags.Fixed)
      ? { x: posOnDesktopPx.x - store.getCurrentDockWidthPx(), y: posOnDesktopPx.y }
      : posRelativeToRootVeBoundsPx;

  if (!isInside(popupPosRelativeToTopLevelVePx, popupRootVeMaybe.boundsPx)) {
    return parentRootInfo;
  }

  rootVes = popupRootVesMaybe;
  rootVe = popupRootVeMaybe;

  posRelativeToRootVeBoundsPx = vectorSubtract(
    popupPosRelativeToTopLevelVePx,
    { x: rootVe.boundsPx.x, y: rootVe.boundsPx.y });

  let posRelativeToRootVeViewportPx = vectorSubtract(
      popupPosRelativeToTopLevelVePx,
      isPage(popupRootVeMaybe.displayItem)
        ? getBoundingBoxTopLeft(rootVe.viewportBoundsPx!)
        : getBoundingBoxTopLeft(rootVe.boundsPx));

  const { flags: hitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, posRelativeToRootVeBoundsPx);


  if (isTable(rootVe.displayItem)) {

    if (hitboxType != HitboxFlags.None && hitboxType != HitboxFlags.Move && !isIgnored(rootVe.displayItem.id, ignoreItems)) {
      return ({
        parentRootVe: parentRootInfo.parentRootVe,
        rootVes,
        rootVe,
        posRelativeToRootVeBoundsPx,
        posRelativeToRootVeViewportPx,
        hitMaybe: finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, rootVes, rootVes, hitboxMeta, posRelativeToRootVeBoundsPx, canHitEmbeddedInteractive, "hitNonPagePopupMaybe1")
      });
    }

    for (let j=0; j<rootVe.childrenVes.length; ++j) {
      // TODO (low): should be able to move this up a level.
      const tableChildVes = rootVe.childrenVes[j];
      const tableChildVe = tableChildVes.get();
      const tableBlockHeightPx = tableChildVe.boundsPx.h;
      const posRelativeToTableChildAreaPx = vectorSubtract(
        posRelativeToRootVeBoundsPx,
        { x: 0.0,
          y: (rootVe.viewportBoundsPx!.y - rootVe.boundsPx.y) - store.perItem.getTableScrollYPos(VeFns.veidFromVe(rootVe)) * tableBlockHeightPx }
      );

      if (!ignoreAttachments) {
        const attHit = findAttachmentHit(tableChildVe.attachmentsVes, posRelativeToTableChildAreaPx, ignoreItems, false);
        if (attHit) {
          const noAttachmentResult = getHitInfo(store, posOnDesktopPx, ignoreItems, true, canHitEmbeddedInteractive);
          parentRootInfo.hitMaybe = {
            overVes: attHit.attachmentVes,
            rootVes,
            subRootVe: rootVe,
            subSubRootVe: null,
            parentRootVe: parentRootInfo.parentRootVe,
            hitboxType: attHit.flags,
            compositeHitboxTypeMaybe: HitboxFlags.None,
            overElementMeta: attHit.meta,
            overPositionableVe: parentRootInfo.rootVe,
            overPositionGr: null,
            debugCreatedAt: "hitNonPagePopupMaybe-table-attachment",
          };
          return parentRootInfo;
        }
      }

        if (isInside(posRelativeToTableChildAreaPx, tableChildVe.boundsPx)) {
        const { flags: hitboxType, meta } = scanHitboxes(tableChildVe, posRelativeToTableChildAreaPx, getBoundingBoxTopLeft(tableChildVe.boundsPx));
        if (!isIgnored(tableChildVe.displayItem.id, ignoreItems)) {
          parentRootInfo.hitMaybe = finalize(hitboxType, HitboxFlags.None, parentRootInfo.parentRootVe, rootVes, tableChildVes, meta, posRelativeToRootVeBoundsPx, canHitEmbeddedInteractive, "hitNonPagePopupMaybe-table-child");
          return parentRootInfo;
        }
      }
    }

    if (hitboxType != HitboxFlags.None && !isIgnored(rootVe.displayItem.id, ignoreItems)) {
      return ({
        parentRootVe: parentRootInfo.parentRootVe,
        rootVes,
        rootVe,
        posRelativeToRootVeBoundsPx,
        posRelativeToRootVeViewportPx,
        hitMaybe: finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, rootVes, rootVes, hitboxMeta, posRelativeToRootVeBoundsPx, canHitEmbeddedInteractive, "hitNonPagePopupMaybe1")
      });
    }

    return parentRootInfo;
  }

  for (let i=rootVe.childrenVes.length-1; i>=0; --i) {
    const hitMaybe = hitChildMaybe(store, posOnDesktopPx, rootVes, parentRootInfo.parentRootVe, posRelativeToRootVeViewportPx, rootVe.childrenVes[i], ignoreItems, ignoreAttachments, canHitEmbeddedInteractive);
    if (hitMaybe) {
      parentRootInfo.hitMaybe = hitMaybe;
      return parentRootInfo;
    }
  }

  if (hitboxType != HitboxFlags.None && !isIgnored(rootVe.displayItem.id, ignoreItems)) {
    return ({
      parentRootVe: parentRootInfo.parentRootVe,
      rootVes,
      rootVe,
      posRelativeToRootVeBoundsPx,
      posRelativeToRootVeViewportPx,
      hitMaybe: finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, rootVes, rootVes, hitboxMeta, posRelativeToRootVeBoundsPx, canHitEmbeddedInteractive, "hitNonPagePopupMaybe1")
    });
  }

  console.debug("TODO: understand and handle this case better.");
  return parentRootInfo;
}

/**
 * @param posOnDesktopPx does not incorporate page scroll.
 */
function hitPagePopupRootMaybe(
    store: StoreContextModel,
    parentRootInfo: RootInfo,
    posOnDesktopPx: Vector,
    canHitEmbeddedInteractive: boolean): RootInfo {

  let rootVe = parentRootInfo.rootVe;
  let rootVes = parentRootInfo.rootVes;
  let posRelativeToRootVeBoundsPx = parentRootInfo.posRelativeToRootVeBoundsPx

  let changedRoot = false;

  if (rootVe.popupVes && isPage(rootVe.popupVes.get().displayItem)) {
    posOnDesktopPx = cloneVector(posOnDesktopPx)!;
    posOnDesktopPx.x = posOnDesktopPx.x + store.getCurrentDockWidthPx();

    const popupRootVesMaybe = rootVe.popupVes!;
    const popupRootVeMaybe = popupRootVesMaybe.get();

    const popupPosRelativeToTopLevelVePx =
      (popupRootVeMaybe.flags & VisualElementFlags.Fixed)
        ? { x: posOnDesktopPx.x - store.getCurrentDockWidthPx(), y: posOnDesktopPx.y }
        : posRelativeToRootVeBoundsPx;

    if (isInside(popupPosRelativeToTopLevelVePx, popupRootVeMaybe.boundsPx)) {
      rootVes = popupRootVesMaybe;
      rootVe = popupRootVeMaybe;
      const popupVeid = store.history.currentPopupSpec()!.actualVeid;
      const scrollYPx = isPage(rootVe.displayItem)
        ? store.perItem.getPageScrollYProp(popupVeid) * (rootVe.childAreaBoundsPx!.h - rootVe.boundsPx.h)
        : 0;
      const scrollXPx = isPage(rootVe.displayItem)
        ? store.perItem.getPageScrollXProp(popupVeid) * (rootVe.childAreaBoundsPx!.w - rootVe.boundsPx.w)
        : 0;
      posRelativeToRootVeBoundsPx = vectorSubtract(
        popupPosRelativeToTopLevelVePx,
        { x: rootVe.boundsPx.x, y: rootVe.boundsPx.y });

      let posRelativeToRootVeViewportPx = vectorSubtract(
          popupPosRelativeToTopLevelVePx,
          isPage(popupRootVeMaybe.displayItem)
            ? getBoundingBoxTopLeft(rootVe.viewportBoundsPx!)
            : getBoundingBoxTopLeft(rootVe.boundsPx));

  const { flags: hitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, posRelativeToRootVeBoundsPx);
      if (hitboxType != HitboxFlags.None) {
        return ({
          parentRootVe: parentRootInfo.rootVe,
          rootVes,
          rootVe,
          posRelativeToRootVeBoundsPx,
          posRelativeToRootVeViewportPx,
          hitMaybe: finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, rootVes, rootVes, hitboxMeta, posRelativeToRootVeBoundsPx, canHitEmbeddedInteractive, "determinePopupOrSelectedRootMaybe1")
        });
      }
      posRelativeToRootVeBoundsPx = vectorSubtract(
        popupPosRelativeToTopLevelVePx,
        { x: rootVe.boundsPx!.x - scrollXPx,
          y: rootVe.boundsPx!.y - scrollYPx });
      changedRoot = true;
    }
  }

  const { flags: hitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, posRelativeToRootVeBoundsPx);
  let hitMaybe = null;
  if (hitboxType != HitboxFlags.None) {
    hitMaybe = finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, rootVes, rootVes, hitboxMeta, posRelativeToRootVeBoundsPx, canHitEmbeddedInteractive, "determinePopupOrSelectedRootMaybe3");
  }

  const posRelativeToRootVeViewportPx = cloneVector(posRelativeToRootVeBoundsPx)!;
  posRelativeToRootVeViewportPx.y = posRelativeToRootVeViewportPx.y - (rootVe.boundsPx.h - rootVe.viewportBoundsPx!.h);

  let result: RootInfo = {
    parentRootVe: parentRootInfo.rootVe,
    rootVes,
    rootVe,
    posRelativeToRootVeBoundsPx,
    posRelativeToRootVeViewportPx,
    hitMaybe
  };

  if (changedRoot && rootVe.selectedVes) {
    return hitPageSelectedRootMaybe(store, result, posOnDesktopPx, canHitEmbeddedInteractive);
  }

  return result;
}



/**
 * @param posOnDesktopPx does not incorporate page scroll.
 */
function hitPageSelectedRootMaybe(
  store: StoreContextModel,
  parentRootInfo: RootInfo,
  posOnDesktopPx: Vector,
  canHitEmbeddedInteractive: boolean): RootInfo {

let rootVe = parentRootInfo.rootVe;
let rootVes = parentRootInfo.rootVes;
let posRelativeToRootVeBoundsPx = parentRootInfo.posRelativeToRootVeBoundsPx

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

      let done = false;
      if (asPageItem(newRootVeMaybe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
        if (posRelativeToRootVeBoundsPx.x > newRootVeMaybe.listViewportBoundsPx!.x &&
            posRelativeToRootVeBoundsPx.x < newRootVeMaybe.listViewportBoundsPx!.x + newRootVeMaybe!.listViewportBoundsPx!.w) {
          posRelativeToRootVeBoundsPx = vectorSubtract(
            posRelativeToRootVeBoundsPx, {
              x: rootVe.viewportBoundsPx!.x,
              y: rootVe.viewportBoundsPx!.y - scrollPropY * (newRootVeMaybe.listChildAreaBoundsPx!.h - newRootVeMaybe.boundsPx.h)
            });
          done = true;
        }
      }

      if (!done) {
        posRelativeToRootVeBoundsPx = vectorSubtract(
          posRelativeToRootVeBoundsPx, {
            x: rootVe.viewportBoundsPx!.x - scrollPropX * (rootVe.childAreaBoundsPx!.w - rootVe.boundsPx.w),
            y: rootVe.viewportBoundsPx!.y - scrollPropY * (rootVe.childAreaBoundsPx!.h - rootVe.boundsPx.h)
          });
      }

      const { flags: hitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, posRelativeToRootVeBoundsPx);

      if (hitboxType != HitboxFlags.None) {
        return ({
          parentRootVe: parentRootInfo.rootVe,
          rootVes,
          rootVe,
          posRelativeToRootVeBoundsPx,
          posRelativeToRootVeViewportPx: posRelativeToRootVeBoundsPx,
          hitMaybe: finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, rootVes, rootVes, hitboxMeta, posRelativeToRootVeBoundsPx, canHitEmbeddedInteractive, "determinePopupOrSelectedRootMaybe2")
        });
      }

      changedRoot = true;
    }
  }
}

  const { flags: hitboxType, meta: hitboxMeta } = scanHitboxes(rootVe, posRelativeToRootVeBoundsPx);
let hitMaybe = null;
if (hitboxType != HitboxFlags.None) {
  hitMaybe = finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, rootVes, rootVes, hitboxMeta, posRelativeToRootVeBoundsPx, canHitEmbeddedInteractive, "determinePopupOrSelectedRootMaybe3");
}

const posRelativeToRootVeViewportPx = cloneVector(posRelativeToRootVeBoundsPx)!;
posRelativeToRootVeViewportPx.y = posRelativeToRootVeViewportPx.y - (rootVe.boundsPx.h - rootVe.viewportBoundsPx!.h);

let result: RootInfo = {
  parentRootVe: parentRootInfo.rootVe,
  rootVes,
  rootVe,
  posRelativeToRootVeBoundsPx,
  posRelativeToRootVeViewportPx,
  hitMaybe
};

if (changedRoot && rootVe.selectedVes) {
  return hitPageSelectedRootMaybe(store, result, posOnDesktopPx, canHitEmbeddedInteractive);
}

return result;
}


function hitFlipCardRootMaybe(
    parentRootInfo: RootInfo,
    ignoreItems: Set<Uid>): RootInfo {

  const {
    rootVe,
    posRelativeToRootVeViewportPx,
  } = parentRootInfo;

  for (let i=0; i<rootVe.childrenVes.length; ++i) {
    const childVes = rootVe.childrenVes[i];
    const childVe = childVes.get();

    if (isIgnored(childVe.displayItem.id, ignoreItems)) { continue; }
    if (!isFlipCard(childVe.displayItem)) { continue; }

    if (isInside(posRelativeToRootVeViewportPx, childVe.viewportBoundsPx!)) {
      const newPosRelativeToRootVeViewportPx = vectorSubtract(
        posRelativeToRootVeViewportPx,
        { x: childVe.viewportBoundsPx!.x, y: childVe.viewportBoundsPx!.y });

      const newPosRelativeToRootVeBoundsPx = vectorSubtract(
        posRelativeToRootVeViewportPx,
        { x: childVe.boundsPx.x, y: childVe.boundsPx.y });

  const { flags: hitboxType } = scanHitboxes(childVe, newPosRelativeToRootVeBoundsPx);

      if (hitboxType) {
        return ({
          parentRootVe: parentRootInfo.rootVe,
          rootVes: childVes,
          rootVe: childVe,
          posRelativeToRootVeViewportPx: newPosRelativeToRootVeViewportPx,
          posRelativeToRootVeBoundsPx: newPosRelativeToRootVeBoundsPx,
          hitMaybe: finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, childVes, childVes, null, newPosRelativeToRootVeViewportPx, true, "determineFlipCardRootMaybe")
        });
      }

      const pageVes = childVe.childrenVes[0];
      return ({
        parentRootVe: childVe,
        rootVes: pageVes,
        rootVe: pageVes.get(),
        posRelativeToRootVeViewportPx: newPosRelativeToRootVeViewportPx,
        posRelativeToRootVeBoundsPx: newPosRelativeToRootVeBoundsPx,
        hitMaybe: null
      });
    }
  }

  return parentRootInfo;
}

function hitEmbeddedRootMaybe(
    store: StoreContextModel,
    parentRootInfo: RootInfo,
    ignoreItems: Set<Uid>,
    canHitEmbeddedInteractive: boolean): RootInfo {

  const {
    rootVe,
    posRelativeToRootVeViewportPx,
  } = parentRootInfo;

  for (let i=0; i<rootVe.childrenVes.length; ++i) {
    const childVes = rootVe.childrenVes[i];
    const childVe = childVes.get();

    if (isIgnored(childVe.displayItem.id, ignoreItems)) { continue; }
    if (!(childVe.flags & VisualElementFlags.EmbeddedInteractiveRoot)) { continue; }

    if (isInside(posRelativeToRootVeViewportPx, childVe.boundsPx!)) {
      const childVeid = VeFns.veidFromVe(childVe);

      const scrollPropX = store.perItem.getPageScrollXProp(childVeid);
      const scrollPropY = store.perItem.getPageScrollYProp(childVeid);

      const newPosRelativeToRootVeViewportPx = vectorSubtract(
        posRelativeToRootVeViewportPx,
        { x: childVe.viewportBoundsPx!.x - scrollPropX * (childVe.childAreaBoundsPx!.w - childVe.viewportBoundsPx!.w),
          y: childVe.viewportBoundsPx!.y - scrollPropY * (childVe.childAreaBoundsPx!.h - childVe.viewportBoundsPx!.h)});

      const newPosRelativeToRootVeBoundsPx = vectorSubtract(
        posRelativeToRootVeViewportPx,
        { x: childVe.boundsPx.x - scrollPropX * (childVe.childAreaBoundsPx!.w - childVe.viewportBoundsPx!.w),
          y: childVe.boundsPx.y - scrollPropY * (childVe.childAreaBoundsPx!.h - childVe.viewportBoundsPx!.h)});

      const { flags: hitboxType } = scanHitboxes(childVe, newPosRelativeToRootVeBoundsPx);

      return ({
        parentRootVe: parentRootInfo.rootVe,
        rootVes: childVes,
        rootVe: childVe,
        posRelativeToRootVeViewportPx: newPosRelativeToRootVeViewportPx,
        posRelativeToRootVeBoundsPx: newPosRelativeToRootVeBoundsPx,
        hitMaybe: hitboxType != HitboxFlags.None
          ? finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, childVes, childVes, null, newPosRelativeToRootVeViewportPx, canHitEmbeddedInteractive, "determineEmbeddedRootMaybe")
          : null
      });
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
    return ({
      parentRootVe: null,
      rootVes: dockVes,
      rootVe: dockVe,
      posRelativeToRootVeBoundsPx: posRelativeToRootVePx,
      posRelativeToRootVeViewportPx: posRelativeToRootVePx,
      hitMaybe: finalize(hitboxType, HitboxFlags.None, null, dockVes, dockVes, null, posRelativeToRootVePx, false, "determineIfDockRoot")
    });
  }

  return ({
    parentRootVe: null,
    rootVes: dockVes,
    rootVe: dockVe,
    posRelativeToRootVeBoundsPx: posRelativeToRootVePx,
    posRelativeToRootVeViewportPx: posRelativeToRootVePx,
    hitMaybe: null
  });
}


function handleInsideTableMaybe(
    store: StoreContextModel,
    childVe: VisualElement,
    childVes: VisualElementSignal,
    parentRootVe: VisualElement | null,
    rootVes: VisualElementSignal,
    posRelativeToRootVePx: Vector,
    ignoreItems: Set<Uid>,
    ignoreAttachments: boolean,
    posOnDesktopPx: Vector): HitInfo | null {

  if (!isTable(childVe.displayItem)) { return null; }
  if (childVe.flags & VisualElementFlags.LineItem) { return null; }
  if (!isInside(posRelativeToRootVePx, childVe.viewportBoundsPx!)) { return null; }

  const tableVes = childVes;
  const tableVe = childVe;

  // resize hitbox of table takes precedence over everything in the child area.
  const resizeHitbox = tableVe.hitboxes[tableVe.hitboxes.length-1];
  if (resizeHitbox.type != HitboxFlags.Resize) { panic("Last table hitbox type is not Resize."); }
  if (isInside(posRelativeToRootVePx, offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(tableVe.boundsPx!)))) {
    return finalize(HitboxFlags.Resize, HitboxFlags.None, parentRootVe, rootVes, tableVes, resizeHitbox.meta, posRelativeToRootVePx, false, "handleInsideTableMaybe1");
  }
  // col resize also takes precedence over anything in the child area.
  for (let j=tableVe.hitboxes.length-2; j>=0; j--) {
    const hb = tableVe.hitboxes[j];
    if (hb.type != HitboxFlags.HorizontalResize) { break; }
    if (isInside(posRelativeToRootVePx, offsetBoundingBoxTopLeftBy(hb.boundsPx, getBoundingBoxTopLeft(tableVe.boundsPx!)))) {
      return finalize(HitboxFlags.HorizontalResize, HitboxFlags.None, parentRootVe, rootVes, tableVes, hb.meta, posRelativeToRootVePx, false, "handleInsideTableMaybe2");
    }
  }

  for (let j=0; j<tableVe.childrenVes.length; ++j) {
    const tableChildVes = tableVe.childrenVes[j];
    const tableChildVe = tableChildVes.get();
    const tableBlockHeightPx = tableChildVe.boundsPx.h;

    const posRelativeToTableChildAreaPx = toTableChildAreaPos(store, tableVe, tableChildVe, posRelativeToRootVePx);
    if (isInside(posRelativeToTableChildAreaPx, tableChildVe.boundsPx)) {
      let hitboxType = HitboxFlags.None;
      let meta = null;
      for (let k=tableChildVe.hitboxes.length-1; k>=0; --k) {
        if (isInside(posRelativeToTableChildAreaPx, offsetBoundingBoxTopLeftBy(tableChildVe.hitboxes[k].boundsPx, getBoundingBoxTopLeft(tableChildVe.boundsPx)))) {
          hitboxType |= tableChildVe.hitboxes[k].type;
          if (tableChildVe.hitboxes[k].meta != null) { meta = tableChildVe.hitboxes[k].meta; }
        }
      }
    if (!isIgnored(tableChildVe.displayItem.id, ignoreItems)) {
        if (!isIgnored(tableVe.displayItem.id, ignoreItems)) {
          return finalize(hitboxType, HitboxFlags.None, parentRootVe, rootVes, tableChildVes, meta, posRelativeToRootVePx, false, "handleInsideTableMaybe3");
        }
      }
    }
    if (!ignoreAttachments) {
      const hit = findAttachmentHit(tableChildVe.attachmentsVes, posRelativeToTableChildAreaPx, ignoreItems, false);
      if (hit) {
        const noAttachmentResult = getHitInfo(store, posOnDesktopPx, ignoreItems, true, false);
        return {
          overVes: hit.attachmentVes,
          parentRootVe: parentRootVe,
          rootVes: rootVes,
          subRootVe: tableVe,
          subSubRootVe: null,
          hitboxType: hit.flags,
          compositeHitboxTypeMaybe: HitboxFlags.None,
          overElementMeta: hit.meta,
          overPositionableVe: noAttachmentResult.overPositionableVe,
          overPositionGr: noAttachmentResult.overPositionGr,
          debugCreatedAt: "handleInsideTableMaybe (attachment)",
        };
      }
    }
  }

  return null;
}


function handleInsideCompositeMaybe(
    store: StoreContextModel,
    childVe: VisualElement,
    childVes: VisualElementSignal,
    parentRootVe: VisualElement | null,
    rootVes: VisualElementSignal,
    posRelativeToRootVePx: Vector,
    ignoreItems: Set<Uid>,
    posOnDesktopPx: Vector,
    ignoreAttachments: boolean): HitInfo | null {

  if (!isComposite(childVe.displayItem)) { return null; }
  if (childVe.flags & VisualElementFlags.LineItem) { return null; }
  if (!isInside(posRelativeToRootVePx, childVe.boundsPx!)) { return null; }

  const compositeVes = childVes;
  const compositeVe = childVe;

  // resize hitbox of table takes precedence over everything in the child area.
  const resizeHitbox = compositeVe.hitboxes[compositeVe.hitboxes.length-1];
  if (resizeHitbox.type != HitboxFlags.Resize) { panic("Last composite hitbox type is not Resize."); }
  if (isInside(posRelativeToRootVePx, offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(compositeVe.boundsPx!)))) {
    return finalize(HitboxFlags.Resize, HitboxFlags.None, parentRootVe, rootVes, compositeVes, resizeHitbox.meta, posRelativeToRootVePx, false, "handleInsideCompositeMaybe1");
  }

  // for the composite case, also hit the container, even if a child is also hit.
  const { flags: compositeHitboxType, meta: _compositeMeta } = scanHitboxes(compositeVe, posRelativeToRootVePx, getBoundingBoxTopLeft(compositeVe.boundsPx!));

  for (let j=0; j<compositeVe.childrenVes.length; ++j) {
    const compositeChildVes = compositeVe.childrenVes[j];
    const compositeChildVe = compositeChildVes.get();
    const posRelativeToCompositeChildAreaPx = toCompositeChildAreaPos(compositeVe, posRelativeToRootVePx);
    if (isInside(posRelativeToCompositeChildAreaPx, compositeChildVe.boundsPx)) {
      const { flags: hitboxType, meta } = scanHitboxes(compositeChildVe, posRelativeToCompositeChildAreaPx, getBoundingBoxTopLeft(compositeChildVe.boundsPx));

        if (!isIgnored(compositeChildVe.displayItem.id, ignoreItems)) {
        const insideTableHit = handleInsideTableInCompositeMaybe(store, parentRootVe, rootVes, compositeChildVe, ignoreItems, posRelativeToRootVePx, posRelativeToCompositeChildAreaPx, posOnDesktopPx, ignoreAttachments);
        if (insideTableHit != null) { return insideTableHit; }
      }

      if (hitboxType == HitboxFlags.None && !isTable(compositeChildVe.displayItem)) {
        // if inside a composite child, but didn't hit any hitboxes, then hit the composite, not the child.
        if (!isIgnored(compositeVe.displayItem.id, ignoreItems)) {
          return finalize(compositeHitboxType, HitboxFlags.None, parentRootVe, rootVes, compositeVes, meta, posRelativeToRootVePx, false, "handleInsideCompositeMaybe2");
        }
      } else {
        if (!isIgnored(compositeChildVe.displayItem.id, ignoreItems)) {
          return finalize(hitboxType, compositeHitboxType, parentRootVe, rootVes, compositeChildVes, meta, posRelativeToRootVePx, false, "handleInsideCompositeMaybe3");
        }
      }
    }
  }

  return null;
}

function handleInsideTableInCompositeMaybe(
    store: StoreContextModel,
    parentRootVe: VisualElement | null,
    rootVes: VisualElementSignal,
    compositeChildVe: VisualElement,
    ignoreItems: Set<Uid>,
    posRelativeToRootVePx: Vector,
    posRelativeToCompositeChildAreaPx: Vector,
    posOnDesktopPx: Vector,
    ignoreAttachments: boolean): HitInfo | null {

  if (!isTable(compositeChildVe.displayItem)) { return null; }

  const tableVe = compositeChildVe;;

  for (let j=0; j<tableVe.childrenVes.length; ++j) {
    const tableChildVes = tableVe.childrenVes[j];
    const tableChildVe = tableChildVes.get();
    const tableBlockHeightPx = tableChildVe.boundsPx.h;

    const posRelativeToTableChildAreaPx = toTableChildAreaPos(store, tableVe, tableChildVe, posRelativeToCompositeChildAreaPx);
    if (isInside(posRelativeToTableChildAreaPx, tableChildVe.boundsPx)) {
      const { flags: hitboxType, meta } = scanHitboxes(tableChildVe, posRelativeToTableChildAreaPx, getBoundingBoxTopLeft(tableChildVe.boundsPx));
      if (!isIgnored(tableChildVe.displayItem.id, ignoreItems)) {
        return finalize(hitboxType, HitboxFlags.None, parentRootVe, rootVes, tableChildVes, meta, posRelativeToRootVePx, false, "handleInsideTableInCompositeMaybe1");
      }
    }

    if (!ignoreAttachments) {
      const attHit = findAttachmentHit(tableChildVe.attachmentsVes, posRelativeToTableChildAreaPx, ignoreItems, false);
      if (attHit) {
        const noAttachmentResult = getHitInfo(store, posOnDesktopPx, ignoreItems, true, false);
        return {
          overVes: attHit.attachmentVes,
          parentRootVe,
          rootVes,
          subRootVe: noAttachmentResult.subRootVe,
          subSubRootVe: tableVe,
          hitboxType: attHit.flags,
          compositeHitboxTypeMaybe: HitboxFlags.None,
          overElementMeta: attHit.meta,
          overPositionableVe: noAttachmentResult.overPositionableVe,
          overPositionGr: noAttachmentResult.overPositionGr,
          debugCreatedAt: "handleInsideTableInCompositeMaybe (attachment)",
        };
      }
    }
  }

  return null;
}

function finalize(
    hitboxType: HitboxFlags,
    containerHitboxType: HitboxFlags,
    parentRootVe: VisualElement | null,
    rootVes: VisualElementSignal,
    overVes: VisualElementSignal,
    overElementMeta: HitboxMeta | null,
    posRelativeToRootVePx: Vector,
    canHitEmbeddedInteractive: boolean,
    debugCreatedAt: string): HitInfo {

  if (!overVes) { panic("finalize called with undefined overVes"); }

  const overVe = overVes.get();
  if (overVe.displayItem.id == PageFns.umbrellaPage().id) {
    return {
      overVes: null,
      rootVes: overVes,
      parentRootVe,
      subRootVe: null,
      subSubRootVe: null,
      hitboxType: HitboxFlags.None,
      compositeHitboxTypeMaybe: HitboxFlags.None,
      overElementMeta: null,
      overPositionableVe: null,
      overPositionGr: null,
      debugCreatedAt: "finalize " + debugCreatedAt + " (A)",
    };
  }

  const overPositionGr = { x: 0, y: 0 };

  if (overVe.flags & VisualElementFlags.InsideTable) {
    assert(isTable(VesCache.get(overVe.parentPath!)!.get().displayItem), "a visual element marked as inside table, is not in fact inside a table.");
    const parentTableVe = VesCache.get(overVe.parentPath!)!.get();
    const tableParentVe = VesCache.get(parentTableVe.parentPath!)!.get();
    let overPositionableVe = tableParentVe;
    if (isComposite(tableParentVe.displayItem)) {
      overPositionableVe = VesCache.get(tableParentVe.parentPath!)!.get();
      return {
        overVes,
        rootVes,
        parentRootVe,
        subRootVe: tableParentVe,
        subSubRootVe: parentTableVe,
        hitboxType,
        compositeHitboxTypeMaybe: containerHitboxType,
        overElementMeta,
        overPositionableVe,
        overPositionGr,
        debugCreatedAt: "finalize " + debugCreatedAt + " (B)",
      };
    } else {
      assert(isPage(tableParentVe.displayItem), "the parent of a table that has a visual element child, is not a page.");
      assert((tableParentVe.flags & VisualElementFlags.ShowChildren) > 0, "page containing table is not marked as having children visible.");
      return {
        overVes,
        rootVes,
        parentRootVe,
        subRootVe: parentTableVe,
        subSubRootVe: null,
        hitboxType,
        compositeHitboxTypeMaybe: HitboxFlags.None,
        overElementMeta,
        overPositionableVe,
        overPositionGr,
        debugCreatedAt: "finalize " + debugCreatedAt + " (C)",
      };
    }
  }

  if (isTable(overVe.displayItem) && !(overVe.flags & VisualElementFlags.InsideCompositeOrDoc)) {
    const parentVe = VesCache.get(overVe.parentPath!)!.get();
    let prop = {
      x: (posRelativeToRootVePx.x - parentVe.viewportBoundsPx!.x) / parentVe.childAreaBoundsPx!.w,
      y: (posRelativeToRootVePx.y - parentVe.viewportBoundsPx!.y) / parentVe.childAreaBoundsPx!.h
    }
    let overPositionGr = { x: 0, y: 0 };
    let overPositionableVe = parentVe;
    if (isPage(parentVe.displayItem)) {
      overPositionGr = {
        x: Math.round(prop.x * asPageItem(parentVe.displayItem).innerSpatialWidthGr / (GRID_SIZE / 2)) * (GRID_SIZE / 2),
        y: Math.round(prop.y * asPageItem(parentVe.displayItem).innerSpatialWidthGr / asPageItem(parentVe.displayItem).naturalAspect / (GRID_SIZE / 2)) * (GRID_SIZE / 2)
      };
    } else if (isComposite(parentVe.displayItem)) {
      overPositionableVe = VesCache.get(parentVe.parentPath!)!.get();
    } else {
      panic("unexpected table parent ve type: " + parentVe.displayItem.itemType);
    }
    return {
      overVes,
      rootVes,
      parentRootVe,
      subRootVe: null,
      subSubRootVe: null,
      hitboxType,
      compositeHitboxTypeMaybe: containerHitboxType,
      overElementMeta,
      overPositionableVe,
      overPositionGr,
      debugCreatedAt: "finalize " + debugCreatedAt + " (D)",
    };
  }

  if (isPage(overVe.displayItem) && (overVe.flags & VisualElementFlags.ShowChildren)) {
    let prop = {
      x: (posRelativeToRootVePx.x - overVe.viewportBoundsPx!.x) / overVe.childAreaBoundsPx!.w,
      y: (posRelativeToRootVePx.y - overVe.viewportBoundsPx!.y) / overVe.childAreaBoundsPx!.h
    }
    if (rootVes.get() == overVe) {
      prop = {
        x: posRelativeToRootVePx.x / overVe.childAreaBoundsPx!.w,
        y: posRelativeToRootVePx.y / overVe.childAreaBoundsPx!.h
      }
    }
    const overPositionGr = {
      x: Math.round(prop.x * asPageItem(overVe.displayItem).innerSpatialWidthGr / (GRID_SIZE / 2)) * (GRID_SIZE / 2),
      y: Math.round(prop.y * asPageItem(overVe.displayItem).innerSpatialWidthGr / asPageItem(overVe.displayItem).naturalAspect / (GRID_SIZE / 2)) * (GRID_SIZE / 2)
    };
    let overPositionableVe = overVe;
    if (canHitEmbeddedInteractive) {
      if (overVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
        overPositionableVe = VesCache.get(overVe.parentPath!)!.get();
      }
    }

    if (overVe.flags & VisualElementFlags.InsideCompositeOrDoc && isComposite(VesCache.get(overVe.parentPath!)!.get().displayItem)) {
      const parentCompositeVe = VesCache.get(overVe.parentPath!)!.get();
      const compositeParentPageVe = VesCache.get(parentCompositeVe.parentPath!)!.get();
      assert(isPage(compositeParentPageVe.displayItem), "the parent of a composite that has a visual element child, is not a page.");
      assert((compositeParentPageVe.flags & VisualElementFlags.ShowChildren) > 0, "page containing composite is not marked as having children visible.");
      return {
        overVes,
        rootVes,
        parentRootVe,
        subRootVe: parentCompositeVe,
        subSubRootVe: null,
        overPositionableVe,
        hitboxType,
        compositeHitboxTypeMaybe: containerHitboxType,
        overElementMeta,
        overPositionGr,
        debugCreatedAt: "finalize " + debugCreatedAt + " (E1)",
      };
    }

    else {
      return {
        overVes,
        rootVes,
        parentRootVe,
        subRootVe: null,
        subSubRootVe: null,
        hitboxType,
        compositeHitboxTypeMaybe: containerHitboxType,
        overElementMeta,
        overPositionableVe,
        overPositionGr,
        debugCreatedAt: "finalize " + debugCreatedAt + " (E2)",
      };
    }
  }

  if (overVe.flags & VisualElementFlags.InsideCompositeOrDoc && isComposite(VesCache.get(overVe.parentPath!)!.get().displayItem)) {
    const parentCompositeVe = VesCache.get(overVe.parentPath!)!.get();
    const compositeParentPageVe = VesCache.get(parentCompositeVe.parentPath!)!.get();
    assert(isPage(compositeParentPageVe.displayItem), "the parent of a composite that has a visual element child, is not a page.");
    assert((compositeParentPageVe.flags & VisualElementFlags.ShowChildren) > 0, "page containing composite is not marked as having children visible.");
    return {
      overVes,
      rootVes,
      parentRootVe,
      subRootVe: parentCompositeVe,
      subSubRootVe: null,
      overPositionableVe: compositeParentPageVe,
      hitboxType,
      compositeHitboxTypeMaybe: containerHitboxType,
      overElementMeta,
      overPositionGr,
      debugCreatedAt: "finalize " + debugCreatedAt + " (F)",
    };
  }

  const overVeParentVes = VesCache.get(overVe.parentPath!)!;
  if (!overVeParentVes) {
    console.error("no overVeParentVes");
    console.log(VeFns.toDebugString(overVe));
    VesCache.debugLog();
  }
  const overVeParent = overVeParentVes.get();

  assert(
    isPage(VesCache.get(overVe.parentPath!)!.get().displayItem) ||
    isFlipCard(VesCache.get(overVe.parentPath!)!.get().displayItem),
    "the parent of a non-container item not in page is not a page of flipcard.");
  assert(
    (VesCache.get(overVe.parentPath!)!.get().flags & VisualElementFlags.ShowChildren) > 0,
    `the parent '${VesCache.get(overVe.parentPath!)!.get().displayItem.id}' of a non-container does not allow drag in positioning.`);
  if (isPage(overVe.displayItem)) {
    return {
      overVes,
      rootVes,
      parentRootVe,
      subRootVe: null,
      subSubRootVe: null,
      hitboxType,
      compositeHitboxTypeMaybe: containerHitboxType,
      overElementMeta,
      overPositionableVe: overVeParent,
      overPositionGr,
      debugCreatedAt: "finalize " + debugCreatedAt + " (G)",
    };
  }

  return {
    overVes,
    rootVes,
    parentRootVe,
    subRootVe: null,
    subSubRootVe: null,
    hitboxType,
    compositeHitboxTypeMaybe: containerHitboxType,
    overElementMeta,
    overPositionableVe: overVeParent,
    overPositionGr,
    debugCreatedAt: "finalize " + debugCreatedAt + " (H)",
  };
}
