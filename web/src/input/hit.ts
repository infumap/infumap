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
  getOverContainerVe: (hitInfo: HitInfo): VisualElement => {
    if (hitInfo.overVes) {
      if (isContainer(hitInfo.overVes.get().displayItem)) {
        if (hitInfo.subRootVe && isTable(hitInfo.subRootVe!.displayItem)) {
          if (hitInfo.hitboxType & HitboxFlags.Click) {
            return hitInfo.subRootVe;
          }
        }
        return hitInfo.overVes.get();
      }
    }
    if (hitInfo.subSubRootVe) { return hitInfo.subSubRootVe; }
    if (hitInfo.subRootVe) { return hitInfo.subRootVe; }
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

    result += "rootVe: '" + asPageItem(hitInfo.rootVes.get().displayItem).title + "' (" + hitInfo.rootVes.get().displayItem.id + ")\n";

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
    return getHitInfo(store, posOnDesktopPx, ignoreItems, false, canHitEmbeddedInteractive);
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


function getHitInfo(
    store: StoreContextModel,
    posOnDesktopPx: Vector,
    ignoreItems: Array<Uid>,
    ignoreAttachments: boolean,
    canHitEmbeddedInteractive: boolean): HitInfo {

  const umbrellaVe: VisualElement = store.umbrellaVisualElement.get();
  assert(umbrellaVe.childrenVes.length == 1, "expecting umbrella visual element to have exactly one child");

  // Root is either:
  //  - The top level page, or
  //  - The popup if open and the mouse is over it, or
  //  - The selected page in a list page, or
  //  - The dock page, or
  //  - An embedded root.
  //
  // progressively narrow it down:

  let rootInfo = determineTopLevelRoot(store, umbrellaVe, posOnDesktopPx);
  if (rootInfo.hitMaybe) {
    if (rootInfo.hitMaybe!.overVes == null || !ignoreItems.find(a => a == rootInfo.hitMaybe!.overVes!.get().displayItem.id)) {
      return rootInfo.hitMaybe!; // hit a root hitbox, done already.
    }
  }

  rootInfo = determinePopupOrSelectedRootMaybe(store, rootInfo, posOnDesktopPx, canHitEmbeddedInteractive);
  if (rootInfo.hitMaybe) {
    if (rootInfo.hitMaybe!.overVes == null || !ignoreItems.find(a => a == rootInfo.hitMaybe!.overVes!.get().displayItem.id)) {
      return rootInfo.hitMaybe!; // hit a root hitbox, done already.
    }
  }

  rootInfo = determineEmbeddedRootMaybe(store, rootInfo, ignoreItems, canHitEmbeddedInteractive);
  if (rootInfo.hitMaybe) {
    if (rootInfo.hitMaybe!.overVes == null || !ignoreItems.find(a => a == rootInfo.hitMaybe!.overVes!.get().displayItem.id)) {
      return rootInfo.hitMaybe!; // hit a root hitbox, done already.
    }
  }

  return getHitInfoUnderRoot(store, posOnDesktopPx, ignoreItems, ignoreAttachments, canHitEmbeddedInteractive, rootInfo);
}


function getHitInfoUnderRoot(
    store: StoreContextModel,
    posOnDesktopPx: Vector,
    ignoreItems: Array<Uid>,
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
    ignoreItems: Array<Uid>,
    ignoreAttachments: boolean,
    canHitEmbeddedInteractive: boolean): HitInfo | null {

  const childVe = childVes.get();

  if (childVe.flags & VisualElementFlags.IsDock) { return null; }

  // attachments take precedence.
  if (!ignoreAttachments) {
    const posRelativeToChildElementPx = vectorSubtract(posRelativeToRootVeViewportPx, { x: childVe.boundsPx.x, y: childVe.boundsPx.y });
    for (let j=childVe.attachmentsVes.length-1; j>=0; j--) {
      const attachmentVes = childVe.attachmentsVes[j];
      const attachmentVe = attachmentVes.get();
      if (!isInside(posRelativeToChildElementPx, attachmentVe.boundsPx)) {
        continue;
      }
      let hitboxType = HitboxFlags.None;
      let meta = null;
      for (let j=attachmentVe.hitboxes.length-1; j>=0; --j) {
        if (isInside(posRelativeToChildElementPx, offsetBoundingBoxTopLeftBy(attachmentVe.hitboxes[j].boundsPx, getBoundingBoxTopLeft(attachmentVe.boundsPx)))) {
          hitboxType |= attachmentVe.hitboxes[j].type;
          if (attachmentVe.hitboxes[j].meta != null) { meta = attachmentVe.hitboxes[j].meta; }
        }
      }
      if (!ignoreItems.find(a => a == attachmentVe.displayItem.id)) {
        const noAttachmentResult = getHitInfo(store, posOnDesktopPx, ignoreItems, true, canHitEmbeddedInteractive);
        return {
          overVes: attachmentVes,
          rootVes,
          subRootVe: noAttachmentResult.subRootVe,
          subSubRootVe: noAttachmentResult.subSubRootVe,
          parentRootVe,
          hitboxType,
          compositeHitboxTypeMaybe: HitboxFlags.None,
          overElementMeta: meta,
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
  let hitboxType = HitboxFlags.None;
  let meta = null;
  for (let j=childVe.hitboxes.length-1; j>=0; --j) {
    if (isInside(posRelativeToRootVeViewportPx, offsetBoundingBoxTopLeftBy(childVe.hitboxes[j].boundsPx, getBoundingBoxTopLeft(childVe.boundsPx)))) {
      hitboxType |= childVe.hitboxes[j].type;
      if (childVe.hitboxes[j].meta != null) { meta = childVe.hitboxes[j].meta; }
    }
  }
  if (!ignoreItems.find(a => a == childVe.displayItem.id)) {
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

  let rootVe = umbrellaVe.childrenVes[0].get();
  let rootVes = umbrellaVe.childrenVes[0];

  if (rootVe.childrenVes.length == 0) {
    return ({
      parentRootVe: null,
      rootVes,
      rootVe,
      posRelativeToRootVeBoundsPx: posOnDesktopPx,
      posRelativeToRootVeViewportPx: posOnDesktopPx,
      hitMaybe: null
    });
  }

  const currentPageVeid = store.history.currentPageVeid()!;
  const currentPageVe = umbrellaVe.childrenVes[0].get();

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
  posRelativeToRootVeBoundsPx.x = posRelativeToRootVeBoundsPx.x - store.getCurrentDockWidthPx();
  let posRelativeToRootVeViewportPx = cloneVector(posRelativeToRootVeBoundsPx)!;

  return ({
    parentRootVe: null,
    rootVes,
    rootVe,
    posRelativeToRootVeBoundsPx,
    posRelativeToRootVeViewportPx,
    hitMaybe: null
  });
}


/**
 * @param posOnDesktopPx does not incorporate page scroll.
 */
function determinePopupOrSelectedRootMaybe(
    store: StoreContextModel,
    parentRootInfo: RootInfo,
    posOnDesktopPx: Vector,
    canHitEmbeddedInteractive: boolean): RootInfo {

  let rootVe = parentRootInfo.rootVe;
  let rootVes = parentRootInfo.rootVes;
  let posRelativeToRootVeBoundsPx = parentRootInfo.posRelativeToRootVeBoundsPx

  let changedRoot = false;

  if (rootVe.popupVes) {
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

      let hitboxType = HitboxFlags.None;
      for (let j=rootVe.hitboxes.length-1; j>=0; --j) {
        if (isInside(posRelativeToRootVeBoundsPx, rootVe.hitboxes[j].boundsPx)) {
          hitboxType |= rootVe.hitboxes[j].type;
        }
      }
      if (hitboxType != HitboxFlags.None) {
        return ({
          parentRootVe: parentRootInfo.rootVe,
          rootVes,
          rootVe,
          posRelativeToRootVeBoundsPx,
          posRelativeToRootVeViewportPx,
          hitMaybe: finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, rootVes, rootVes, null, posRelativeToRootVeBoundsPx, canHitEmbeddedInteractive, "determinePopupOrSelectedRootMaybe1")
        });
      }
      posRelativeToRootVeBoundsPx = vectorSubtract(
        popupPosRelativeToTopLevelVePx,
        { x: rootVe.boundsPx!.x - scrollXPx,
          y: rootVe.boundsPx!.y - scrollYPx });
      changedRoot = true;
    }
  }

  if (!changedRoot && rootVe.selectedVes != null) {
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

        let hitboxType = HitboxFlags.None;
        for (let j=rootVe.hitboxes.length-1; j>=0; --j) {
          if (isInside(posRelativeToRootVeBoundsPx, rootVe.hitboxes[j].boundsPx)) {
            hitboxType |= rootVe.hitboxes[j].type;
          }
        }

        if (hitboxType != HitboxFlags.None) {
          return ({
            parentRootVe: parentRootInfo.rootVe,
            rootVes,
            rootVe,
            posRelativeToRootVeBoundsPx,
            posRelativeToRootVeViewportPx: posRelativeToRootVeBoundsPx,
            hitMaybe: finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, rootVes, rootVes, null, posRelativeToRootVeBoundsPx, canHitEmbeddedInteractive, "determinePopupOrSelectedRootMaybe2")
          });
        }

        changedRoot = true;
      }
    }
  }

  let hitboxType = HitboxFlags.None;
  for (let j=rootVe.hitboxes.length-1; j>=0; --j) {
    if (isInside(posRelativeToRootVeBoundsPx, rootVe.hitboxes[j].boundsPx)) {
      hitboxType |= rootVe.hitboxes[j].type;
    }
  }
  let hitMaybe = null;
  if (hitboxType != HitboxFlags.None) {
    hitMaybe = finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, rootVes, rootVes, null, posRelativeToRootVeBoundsPx, canHitEmbeddedInteractive, "determinePopupOrSelectedRootMaybe3");
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
    return determinePopupOrSelectedRootMaybe(store, result, posOnDesktopPx, canHitEmbeddedInteractive);
  }

  return result;
}


function determineEmbeddedRootMaybe(
    store: StoreContextModel,
    parentRootInfo: RootInfo,
    ignoreItems: Array<Uid>,
    canHitEmbeddedInteractive: boolean): RootInfo {

  const {
    rootVe,
    posRelativeToRootVeViewportPx,
  } = parentRootInfo;

  for (let i=0; i<rootVe.childrenVes.length; ++i) {
    const childVes = rootVe.childrenVes[i];
    const childVe = childVes.get();

    if (ignoreItems.find(a => a == childVe.displayItem.id)) { continue; }
    if (!(childVe.flags & VisualElementFlags.EmbededInteractiveRoot)) { continue; }

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

      let hitboxType = HitboxFlags.None;
      for (let j=childVe.hitboxes.length-1; j>=0; --j) {
        if (isInside(newPosRelativeToRootVeBoundsPx, childVe.hitboxes[j].boundsPx)) {
          hitboxType |= childVe.hitboxes[j].type;
        }
      }

      return ({
        parentRootVe: parentRootInfo.rootVe,
        rootVes: childVes,
        rootVe: childVe,
        posRelativeToRootVeViewportPx: newPosRelativeToRootVeViewportPx,
        posRelativeToRootVeBoundsPx: newPosRelativeToRootVeBoundsPx,
        hitMaybe: hitboxType != HitboxFlags.None
          ? finalize(hitboxType, HitboxFlags.None, parentRootInfo.rootVe, childVes, childVes, null, newPosRelativeToRootVeViewportPx, canHitEmbeddedInteractive, "determineEmbeddedRootMaybe")
          : null
      })
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

  let hitboxType = HitboxFlags.None;
  for (let j=dockVe.hitboxes.length-1; j>=0; --j) {
    if (isInside(posRelativeToRootVePx, dockVe.hitboxes[j].boundsPx)) {
      hitboxType |= dockVe.hitboxes[j].type;
    }
  }
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
    ignoreItems: Array<Uid>,
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

    const posRelativeToTableChildAreaPx = vectorSubtract(
      posRelativeToRootVePx,
      { x: tableVe.viewportBoundsPx!.x,
        y: tableVe.viewportBoundsPx!.y - store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVe)) * tableBlockHeightPx }
    );
    if (isInside(posRelativeToTableChildAreaPx, tableChildVe.boundsPx)) {
      let hitboxType = HitboxFlags.None;
      let meta = null;
      for (let k=tableChildVe.hitboxes.length-1; k>=0; --k) {
        if (isInside(posRelativeToTableChildAreaPx, offsetBoundingBoxTopLeftBy(tableChildVe.hitboxes[k].boundsPx, getBoundingBoxTopLeft(tableChildVe.boundsPx)))) {
          hitboxType |= tableChildVe.hitboxes[k].type;
          if (tableChildVe.hitboxes[k].meta != null) { meta = tableChildVe.hitboxes[k].meta; }
        }
      }
      if (!ignoreItems.find(a => a == tableChildVe.displayItem.id)) {
        return finalize(hitboxType, HitboxFlags.None, parentRootVe, rootVes, tableChildVes, meta, posRelativeToRootVePx, false, "handleInsideTableMaybe3");
      }
    }
    if (!ignoreAttachments) {
      for (let k=0; k<tableChildVe.attachmentsVes.length; ++k) {
        const attachmentVes = tableChildVe.attachmentsVes[k];
        const attachmentVe = attachmentVes.get();
        if (isInside(posRelativeToTableChildAreaPx, attachmentVe.boundsPx)) {
          let hitboxType = HitboxFlags.None;
          let meta = null;
          for (let l=attachmentVe.hitboxes.length-1; l>=0; --l) {
            if (isInside(posRelativeToTableChildAreaPx, offsetBoundingBoxTopLeftBy(attachmentVe.hitboxes[l].boundsPx, getBoundingBoxTopLeft(attachmentVe.boundsPx)))) {
              hitboxType |= attachmentVe.hitboxes[l].type;
              if (attachmentVe.hitboxes[l].meta != null) { meta = attachmentVe.hitboxes[l].meta; }
            }
          }
          if (!ignoreItems.find(a => a == attachmentVe.displayItem.id)) {
            const noAttachmentResult = getHitInfo(store, posOnDesktopPx, ignoreItems, true, false);
            return {
              overVes: attachmentVes,
              parentRootVe: parentRootVe,
              rootVes: rootVes,
              subRootVe: tableVe,
              subSubRootVe: null,
              hitboxType,
              compositeHitboxTypeMaybe: HitboxFlags.None,
              overElementMeta: meta,
              overPositionableVe: noAttachmentResult.overPositionableVe,
              overPositionGr: noAttachmentResult.overPositionGr,
              debugCreatedAt: "handleInsideTableMaybe (attachment)",
            };
          }
        }
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
    ignoreItems: Array<Uid>,
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
  let compositeHitboxType = HitboxFlags.None;
  let _compositeMeta = null;
  for (let k=compositeVe.hitboxes.length-1; k>=0; --k) {
    if (isInside(posRelativeToRootVePx, offsetBoundingBoxTopLeftBy(compositeVe.hitboxes[k].boundsPx, getBoundingBoxTopLeft(compositeVe.boundsPx!)))) {
      compositeHitboxType |= compositeVe.hitboxes[k].type;
      if (compositeVe.hitboxes[k].meta != null) { _compositeMeta = compositeVe.hitboxes[k].meta; }
    }
  }

  for (let j=0; j<compositeVe.childrenVes.length; ++j) {
    const compositeChildVes = compositeVe.childrenVes[j];
    const compositeChildVe = compositeChildVes.get();
    const posRelativeToCompositeChildAreaPx = vectorSubtract(
      posRelativeToRootVePx, { x: compositeVe.boundsPx!.x, y: compositeVe.boundsPx!.y });
    if (isInside(posRelativeToCompositeChildAreaPx, compositeChildVe.boundsPx)) {
      let hitboxType = HitboxFlags.None;
      let meta = null;
      for (let k=compositeChildVe.hitboxes.length-1; k>=0; --k) {
        if (isInside(posRelativeToCompositeChildAreaPx, offsetBoundingBoxTopLeftBy(compositeChildVe.hitboxes[k].boundsPx, getBoundingBoxTopLeft(compositeChildVe.boundsPx)))) {
          hitboxType |= compositeChildVe.hitboxes[k].type;
          if (compositeChildVe.hitboxes[k].meta != null) { meta = compositeChildVe.hitboxes[k].meta; }
        }
      }

      if (!ignoreItems.find(a => a == compositeChildVe.displayItem.id)) {
        const insideTableHit = handleInsideTableInCompositeMaybe(store, parentRootVe, rootVes, compositeChildVe, ignoreItems, posRelativeToRootVePx, posRelativeToCompositeChildAreaPx, posOnDesktopPx, ignoreAttachments);
        if (insideTableHit != null) { return insideTableHit; }
      }

      if (hitboxType == HitboxFlags.None && !isTable(compositeChildVe.displayItem)) {
        // if inside a composite child, but didn't hit any hitboxes, then hit the composite, not the child.
        if (!ignoreItems.find(a => a == compositeVe.displayItem.id)) {
          return finalize(compositeHitboxType, HitboxFlags.None, parentRootVe, rootVes, compositeVes, meta, posRelativeToRootVePx, false, "handleInsideCompositeMaybe2");
        }
      } else {
        if (!ignoreItems.find(a => a == compositeChildVe.displayItem.id)) {
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
    ignoreItems: Array<Uid>,
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

    const posRelativeToTableChildAreaPx = vectorSubtract(
      posRelativeToCompositeChildAreaPx,
      { x: tableVe.viewportBoundsPx!.x,
        y: tableVe.viewportBoundsPx!.y - store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVe)) * tableBlockHeightPx }
    );
    if (isInside(posRelativeToTableChildAreaPx, tableChildVe.boundsPx)) {
      let hitboxType = HitboxFlags.None;
      let meta = null;
      for (let k=tableChildVe.hitboxes.length-1; k>=0; --k) {
        if (isInside(posRelativeToTableChildAreaPx, offsetBoundingBoxTopLeftBy(tableChildVe.hitboxes[k].boundsPx, getBoundingBoxTopLeft(tableChildVe.boundsPx)))) {
          hitboxType |= tableChildVe.hitboxes[k].type;
          if (tableChildVe.hitboxes[k].meta != null) { meta = tableChildVe.hitboxes[k].meta; }
        }
      }
      if (!ignoreItems.find(a => a == tableChildVe.displayItem.id)) {
        return finalize(hitboxType, HitboxFlags.None, parentRootVe, rootVes, tableChildVes, meta, posRelativeToRootVePx, false, "handleInsideTableInCompositeMaybe1");
      }
    }

    if (!ignoreAttachments) {
      for (let k=0; k<tableChildVe.attachmentsVes.length; ++k) {
        const attachmentVes = tableChildVe.attachmentsVes[k];
        const attachmentVe = attachmentVes.get();
        if (isInside(posRelativeToTableChildAreaPx, attachmentVe.boundsPx)) {
          let hitboxType = HitboxFlags.None;
          let meta = null;
          for (let l=attachmentVe.hitboxes.length-1; l>=0; --l) {
            if (isInside(posRelativeToTableChildAreaPx, offsetBoundingBoxTopLeftBy(attachmentVe.hitboxes[l].boundsPx, getBoundingBoxTopLeft(attachmentVe.boundsPx)))) {
              hitboxType |= attachmentVe.hitboxes[l].type;
              if (attachmentVe.hitboxes[l].meta != null) { meta = attachmentVe.hitboxes[l].meta; }
            }
          }
          if (!ignoreItems.find(a => a == attachmentVe.displayItem.id)) {
            const noAttachmentResult = getHitInfo(store, posOnDesktopPx, ignoreItems, true, false);
            return {
              overVes: attachmentVes,
              parentRootVe,
              rootVes,
              subRootVe: noAttachmentResult.subRootVe,
              subSubRootVe: tableVe,
              hitboxType,
              compositeHitboxTypeMaybe: HitboxFlags.None,
              overElementMeta: meta,
              overPositionableVe: noAttachmentResult.overPositionableVe,
              overPositionGr: noAttachmentResult.overPositionGr,
              debugCreatedAt: "handleInsideTableInCompositeMaybe (attachment)",
            };
          }
        }
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
        x: Math.round(prop.x * asPageItem(parentVe.displayItem).innerSpatialWidthGr / GRID_SIZE) * GRID_SIZE,
        y: Math.round(prop.y * asPageItem(parentVe.displayItem).innerSpatialWidthGr / asPageItem(parentVe.displayItem).naturalAspect / GRID_SIZE) * GRID_SIZE
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
      x: Math.round(prop.x * asPageItem(overVe.displayItem).innerSpatialWidthGr / GRID_SIZE) * GRID_SIZE,
      y: Math.round(prop.y * asPageItem(overVe.displayItem).innerSpatialWidthGr / asPageItem(overVe.displayItem).naturalAspect / GRID_SIZE) * GRID_SIZE
    };
    let overPositionableVe = overVe;
    if (canHitEmbeddedInteractive) {
      if (overVe.flags & VisualElementFlags.EmbededInteractiveRoot) {
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
    console.log(VeFns.toDebugString(overVe));
    VesCache.debugLog();
  }
  const overVeParent = overVeParentVes.get();
  assert(isPage(VesCache.get(overVe.parentPath!)!.get().displayItem), "the parent of a non-container item not in page is not a page.");
  assert((VesCache.get(overVe.parentPath!)!.get().flags & VisualElementFlags.ShowChildren) > 0, `the parent '${VesCache.get(overVe.parentPath!)!.get().displayItem.id}' of a non-container does not allow drag in positioning.`);
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
