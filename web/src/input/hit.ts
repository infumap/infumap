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
import { asTitledItem, isTitledItem } from "../items/base/titled-item";
import { isComposite } from "../items/composite-item";
import { PageFns, asPageItem, isPage } from "../items/page-item";
import { isTable } from "../items/table-item";
import { HitboxMeta, HitboxFlags, HitboxFns } from "../layout/hitbox";
import { VesCache } from "../layout/ves-cache";
import { VisualElement, VisualElementFlags, VeFns } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { Vector, cloneVector, getBoundingBoxTopLeft, isInside, offsetBoundingBoxTopLeftBy, vectorAdd, vectorSubtract } from "../util/geometry";
import { assert, panic } from "../util/lang";
import { VisualElementSignal } from "../util/signals";
import { Uid } from "../util/uid";


export interface HitInfo {
  /**
   * The intersected hitbox flags of overElement.
   */
  hitboxType: HitboxFlags,

  /**
   * If the item hit was inside a composite container, the intersected hitbox flags of the composite container, else None.
   */
  compositeHitboxTypeMaybe: HitboxFlags,

  /**
   * The first fully editable page directly under the specified position.
   */
  rootVe: VisualElement,

  /**
   * The visual element under the specified position.
   */
  overElementVes: VisualElementSignal,

  /**
   * Meta data from the hit hitbox of the visual element under specified position.
   */
  overElementMeta: HitboxMeta | null,

  /**
   * The visual element of the container immediately under the specified position.
   */
  overContainerVe: VisualElement | null,

  /**
   * The visual element that defines scaling/positioning immediately under the specified position (for a table this is it's parent page).
   * This could be a non-interactive page (i.e. may be different from the root).
   */
  overPositionableVe: VisualElement | null,

  /**
   * Position in the positionable element.
   */
  overPositionGr: Vector | null,
}

export function hitInfoToString(hitInfo: HitInfo): string {
  let result = "hitboxType: " + HitboxFns.hitboxFlagsToString(hitInfo.hitboxType) + "\n";

  result += "compositeHitboxType: " + HitboxFns.hitboxFlagsToString(hitInfo.compositeHitboxTypeMaybe) + "\n";

  result += "rootVe: '" + asPageItem(hitInfo.rootVe.displayItem).title + "' (" + hitInfo.rootVe.displayItem.id + ")\n";

  const overVe = hitInfo.overElementVes.get();
  if (isTitledItem(overVe.displayItem)) {
    result += "overElementVes: '" + asTitledItem(overVe.displayItem).title + "' (" + overVe.displayItem.id + ")\n";
  } else {
    result += "overElementVes: [N/A] (" + overVe.displayItem.id + ")\n";
  }

  if (!hitInfo.overElementMeta) {
    result += "overElementMeta: null\n";
  } else {
    result += "overElementMeta: " + HitboxFns.hitboxMetaToString(hitInfo.overElementMeta) + "\n";
  }

  const overContainerVe = hitInfo.overContainerVe;
  if (!overContainerVe) {
    result += "overContainerVe: null\n";
  } else {
    if (isTitledItem(overContainerVe.displayItem)) {
      result += "overContainerVe: '" + asTitledItem(overContainerVe.displayItem).title + "' (" + overContainerVe.displayItem.id + ")\n";
    } else {
      result += "overContainerVe: [" + overContainerVe.displayItem.itemType + "] (" + overContainerVe.displayItem.id + ")\n";
    }
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

  return result;
}


interface RootInfo {
  rootVisualElementSignal: VisualElementSignal,
  rootVisualElement: VisualElement,
  posRelativeToRootVisualElementViewportPx: Vector,
  posRelativeToRootVisualElementBoundsPx: Vector,
  hitMaybe: HitInfo | null
}


/**
 * Intersect posOnDesktopPx with the cached visual element state.
 */
export function getHitInfo(
    store: StoreContextModel,
    posOnDesktopPx: Vector,
    ignoreItems: Array<Uid>,
    ignoreAttachments: boolean,
    canHitEmbeddedInteractive: boolean): HitInfo {

  const umbrellaVisualElement: VisualElement = store.umbrellaVisualElement.get();
  assert(umbrellaVisualElement.childrenVes.length == 1, "expecting umbrella visual element to have exactly one child");

  const currentPageVeid = store.history.currentPageVeid()!;
  const currentPageVe = umbrellaVisualElement.childrenVes[0].get();
  const posRelativeToTopLevelVisualElementPx = vectorAdd(
    posOnDesktopPx, {
      x: store.perItem.getPageScrollXProp(currentPageVeid) * (currentPageVe.childAreaBoundsPx!.w - currentPageVe.boundsPx.w),
      y: store.perItem.getPageScrollYProp(currentPageVeid) * (currentPageVe.childAreaBoundsPx!.h - currentPageVe.boundsPx.h)
    });

  // Root is either:
  //  - the top level page, or
  //  - the popup if open and the mouse is over it, or
  //  - the selected page in a list page, or
  //  - dock page, or
  //  - an embedded root.

  // progressively narrow it down:

  let rootInfo = determineTopLevelRoot(store, umbrellaVisualElement, posRelativeToTopLevelVisualElementPx, posOnDesktopPx);
  if (rootInfo.hitMaybe) {
    if (!ignoreItems.find(a => a == rootInfo.hitMaybe!.overElementVes.get().displayItem.id)) {
      return rootInfo.hitMaybe!; // hit a root hitbox, done already.
    }
  }

  rootInfo = determinePopupOrSelectedRootMaybe(store, rootInfo, posOnDesktopPx, canHitEmbeddedInteractive);
  if (rootInfo.hitMaybe) {
    if (!ignoreItems.find(a => a == rootInfo.hitMaybe!.overElementVes.get().displayItem.id)) {
      return rootInfo.hitMaybe!; // hit a root hitbox, done already.
    }
  }

  rootInfo = determineEmbeddedRootMaybe(store, rootInfo, canHitEmbeddedInteractive);
  if (rootInfo.hitMaybe) {
    if (!ignoreItems.find(a => a == rootInfo.hitMaybe!.overElementVes.get().displayItem.id)) {
      return rootInfo.hitMaybe!; // hit a root hitbox, done already.
    }
  }

  return getHitInfoWithRootInfo(store, posOnDesktopPx, ignoreItems, ignoreAttachments, canHitEmbeddedInteractive, rootInfo);
}


function getHitInfoWithRootInfo(
    store: StoreContextModel,
    posOnDesktopPx: Vector,
    ignoreItems: Array<Uid>,
    ignoreAttachments: boolean,
    canHitEmbeddedInteractive: boolean,
    rootInfo: RootInfo) {

  let {
    rootVisualElementSignal,
    rootVisualElement,
    posRelativeToRootVisualElementViewportPx
  } = rootInfo;

  for (let i=rootVisualElement.childrenVes.length-1; i>=0; --i) {
    const hitMaybe = hitChildMaybe(store, posOnDesktopPx, rootVisualElement, posRelativeToRootVisualElementViewportPx, rootVisualElement.childrenVes[i], ignoreItems, ignoreAttachments, canHitEmbeddedInteractive);
    if (hitMaybe) { return hitMaybe; }
  }

  if (rootVisualElement.selectedVes) {
    const hitMaybe = hitChildMaybe(store, posOnDesktopPx, rootVisualElement, posRelativeToRootVisualElementViewportPx, rootVisualElement.selectedVes, ignoreItems, ignoreAttachments, canHitEmbeddedInteractive);
    if (hitMaybe) { return hitMaybe; }
  }

  return finalize(HitboxFlags.None, HitboxFlags.None, rootVisualElement, rootVisualElementSignal, null, posRelativeToRootVisualElementViewportPx, canHitEmbeddedInteractive);
}


function hitChildMaybe(
    store: StoreContextModel,
    posOnDesktopPx: Vector,
    rootVisualElement: VisualElement,
    posRelativeToRootVisualElementViewportPx: Vector,
    childVisualElementSignal: VisualElementSignal,
    ignoreItems: Array<Uid>,
    ignoreAttachments: boolean,
    canHitEmbeddedInteractive: boolean) {

  const childVisualElement = childVisualElementSignal.get();

  if (childVisualElement.flags & VisualElementFlags.IsDock) { return null; }

  // attachments take precedence.
  if (!ignoreAttachments) {
    const posRelativeToChildElementPx = vectorSubtract(posRelativeToRootVisualElementViewportPx, { x: childVisualElement.boundsPx.x, y: childVisualElement.boundsPx.y });
    for (let j=childVisualElement.attachmentsVes.length-1; j>=0; j--) {
      const attachmentVisualElementSignal = childVisualElement.attachmentsVes[j];
      const attachmentVisualElement = attachmentVisualElementSignal.get();
      if (!isInside(posRelativeToChildElementPx, attachmentVisualElement.boundsPx)) {
        continue;
      }
      let hitboxType = HitboxFlags.None;
      let meta = null;
      for (let j=attachmentVisualElement.hitboxes.length-1; j>=0; --j) {
        if (isInside(posRelativeToChildElementPx, offsetBoundingBoxTopLeftBy(attachmentVisualElement.hitboxes[j].boundsPx, getBoundingBoxTopLeft(attachmentVisualElement.boundsPx)))) {
          hitboxType |= attachmentVisualElement.hitboxes[j].type;
          if (attachmentVisualElement.hitboxes[j].meta != null) { meta = attachmentVisualElement.hitboxes[j].meta; }
        }
      }
      if (!ignoreItems.find(a => a == attachmentVisualElement.displayItem.id)) {
        const noAttachmentResult = getHitInfo(store, posOnDesktopPx, ignoreItems, true, canHitEmbeddedInteractive);
        return {
          hitboxType,
          compositeHitboxTypeMaybe: HitboxFlags.None,
          rootVe: rootVisualElement,
          overElementVes: attachmentVisualElementSignal,
          overElementMeta: meta,
          overContainerVe: noAttachmentResult.overContainerVe,
          overPositionableVe: noAttachmentResult.overPositionableVe,
          overPositionGr: noAttachmentResult.overPositionGr,
        };
      }
    }
  }

  if (!isInside(posRelativeToRootVisualElementViewportPx, childVisualElement.boundsPx)) {
    return null;
  }

  if (isTable(childVisualElement.displayItem) && !(childVisualElement.flags & VisualElementFlags.LineItem) && childVisualElement.childAreaBoundsPx == null) {
    console.error("A table visual element unexpectedly had no childAreaBoundsPx set.", childVisualElement);
  }

  const insideTableHit = handleInsideTableMaybe(store, childVisualElement, childVisualElementSignal, rootVisualElement, posRelativeToRootVisualElementViewportPx, ignoreItems, ignoreAttachments, posOnDesktopPx);
  if (insideTableHit != null) { return insideTableHit; }

  const insideCompositeHit = handleInsideCompositeMaybe(store, childVisualElement, childVisualElementSignal, rootVisualElement, posRelativeToRootVisualElementViewportPx, ignoreItems, posOnDesktopPx, ignoreAttachments);
  if (insideCompositeHit != null) { return insideCompositeHit; }

  // handle inside any other item (including pages that are sized such that they can't be clicked in).
  let hitboxType = HitboxFlags.None;
  let meta = null;
  for (let j=childVisualElement.hitboxes.length-1; j>=0; --j) {
    if (isInside(posRelativeToRootVisualElementViewportPx, offsetBoundingBoxTopLeftBy(childVisualElement.hitboxes[j].boundsPx, getBoundingBoxTopLeft(childVisualElement.boundsPx)))) {
      hitboxType |= childVisualElement.hitboxes[j].type;
      if (childVisualElement.hitboxes[j].meta != null) { meta = childVisualElement.hitboxes[j].meta; }
    }
  }
  if (!ignoreItems.find(a => a == childVisualElement.displayItem.id)) {
    return finalize(hitboxType, HitboxFlags.None, rootVisualElement, childVisualElementSignal, meta, posRelativeToRootVisualElementViewportPx, canHitEmbeddedInteractive);
  }
}


/**
 * @param posRelativeToTopLevelVisualElementPx the top level ve may be scrolled, so this is not necessarily the same as posOnDesktopPx.
 * @param posOnDesktopPx does not incorporate page scroll.
 */
function determineTopLevelRoot(
    store: StoreContextModel,
    umbrellaVisualElement: VisualElement,
    posRelativeToTopLevelVisualElementPx: Vector,
    posOnDesktopPx: Vector): RootInfo {

  if (umbrellaVisualElement.childrenVes.length != 1) {
    panic("expected umbrellaVisualElement to have a child");
  }

  let rootVisualElement = umbrellaVisualElement.childrenVes[0].get();
  let posRelativeToRootVisualElementBoundsPx = posRelativeToTopLevelVisualElementPx;
  let posRelativeToRootVisualElementViewportPx = posRelativeToTopLevelVisualElementPx;
  let rootVisualElementSignal = umbrellaVisualElement.childrenVes[0];

  if (rootVisualElement.childrenVes.length == 0) {
    return ({
      rootVisualElementSignal,
      rootVisualElement,
      posRelativeToRootVisualElementBoundsPx,
      posRelativeToRootVisualElementViewportPx,
      hitMaybe: null
    });
  }

  const dockRootMaybe = determineIfDockRoot(umbrellaVisualElement, posOnDesktopPx);
  if (dockRootMaybe != null) { return dockRootMaybe; }

  posRelativeToRootVisualElementBoundsPx = cloneVector(posRelativeToRootVisualElementBoundsPx)!;
  posRelativeToRootVisualElementBoundsPx.x = posRelativeToRootVisualElementBoundsPx.x - store.getCurrentDockWidthPx();
  posRelativeToRootVisualElementViewportPx = cloneVector(posRelativeToRootVisualElementBoundsPx)!;

  return ({
    rootVisualElementSignal,
    rootVisualElement,
    posRelativeToRootVisualElementBoundsPx,
    posRelativeToRootVisualElementViewportPx,
    hitMaybe: null
  });
}


/**
 * @param posOnDesktopPx does not incorporate page scroll.
 */
function determinePopupOrSelectedRootMaybe(
    store: StoreContextModel,
    topRootInfo: RootInfo,
    posOnDesktopPx: Vector,
    canHitEmbeddedInteractive: boolean): RootInfo {

  let rootVisualElement = topRootInfo.rootVisualElement;
  let rootVisualElementSignal = topRootInfo.rootVisualElementSignal;
  let posRelativeToRootVisualElementBoundsPx = topRootInfo.posRelativeToRootVisualElementBoundsPx

  let changedRoot = false;

  if (rootVisualElement.popupVes) {
    posOnDesktopPx = cloneVector(posOnDesktopPx)!;
    posOnDesktopPx.x = posOnDesktopPx.x + store.getCurrentDockWidthPx();

    const popupRootVesMaybe = rootVisualElement.popupVes!;
    const popupRootVeMaybe = popupRootVesMaybe.get();

    const popupPosRelativeToTopLevelVisualElementPx =
      (popupRootVeMaybe.flags & VisualElementFlags.Fixed)
        ? { x: posOnDesktopPx.x - store.getCurrentDockWidthPx(), y: posOnDesktopPx.y }
        : posRelativeToRootVisualElementBoundsPx;

    if (isInside(popupPosRelativeToTopLevelVisualElementPx, popupRootVeMaybe.boundsPx)) {
      rootVisualElementSignal = popupRootVesMaybe;
      rootVisualElement = popupRootVeMaybe;
      const popupVeid = store.history.currentPopupSpec()!.actualVeid;
      const scrollYPx = isPage(rootVisualElement.displayItem)
        ? store.perItem.getPageScrollYProp(popupVeid) * (rootVisualElement.childAreaBoundsPx!.h - rootVisualElement.boundsPx.h)
        : 0;
      const scrollXPx = isPage(rootVisualElement.displayItem)
        ? store.perItem.getPageScrollXProp(popupVeid) * (rootVisualElement.childAreaBoundsPx!.w - rootVisualElement.boundsPx.w)
        : 0;
      posRelativeToRootVisualElementBoundsPx = vectorSubtract(
        popupPosRelativeToTopLevelVisualElementPx,
        { x: rootVisualElement.boundsPx.x, y: rootVisualElement.boundsPx.y });

      let posRelativeToRootVisualElementViewportPx = vectorSubtract(
          popupPosRelativeToTopLevelVisualElementPx,
          isPage(popupRootVeMaybe.displayItem)
            ? getBoundingBoxTopLeft(rootVisualElement.viewportBoundsPx!)
            : getBoundingBoxTopLeft(rootVisualElement.boundsPx));

      let hitboxType = HitboxFlags.None;
      for (let j=rootVisualElement.hitboxes.length-1; j>=0; --j) {
        if (isInside(posRelativeToRootVisualElementBoundsPx, rootVisualElement.hitboxes[j].boundsPx)) {
          hitboxType |= rootVisualElement.hitboxes[j].type;
        }
      }
      if (hitboxType != HitboxFlags.None) {
        return ({
          rootVisualElementSignal,
          rootVisualElement,
          posRelativeToRootVisualElementBoundsPx,
          posRelativeToRootVisualElementViewportPx,
          hitMaybe: finalize(hitboxType, HitboxFlags.None, rootVisualElement, rootVisualElementSignal, null, posRelativeToRootVisualElementBoundsPx, canHitEmbeddedInteractive)
        });
      }
      posRelativeToRootVisualElementBoundsPx = vectorSubtract(
        popupPosRelativeToTopLevelVisualElementPx,
        { x: rootVisualElement.boundsPx!.x - scrollXPx,
          y: rootVisualElement.boundsPx!.y - scrollYPx });
      changedRoot = true;
    }
  }

  if (!changedRoot && rootVisualElement.selectedVes != null) {
    const newRootVesMaybe = rootVisualElement.selectedVes!;
    const newRootVeMaybe = newRootVesMaybe.get();

    if (isPage(newRootVeMaybe.displayItem)) {
      if (isInside(posRelativeToRootVisualElementBoundsPx, newRootVeMaybe.boundsPx)) {
        rootVisualElementSignal = newRootVesMaybe;
        rootVisualElement = newRootVeMaybe;
        let veid = VeFns.actualVeidFromVe(newRootVeMaybe);
        const scrollPropX = store.perItem.getPageScrollXProp(veid);
        const scrollPropY = store.perItem.getPageScrollYProp(veid);
        posRelativeToRootVisualElementBoundsPx = vectorSubtract(
          posRelativeToRootVisualElementBoundsPx,
          { x: rootVisualElement.viewportBoundsPx!.x - scrollPropX * (rootVisualElement.childAreaBoundsPx!.w - rootVisualElement.boundsPx.w),
            y: rootVisualElement.viewportBoundsPx!.y - scrollPropY * (rootVisualElement.childAreaBoundsPx!.h - rootVisualElement.boundsPx.h)})
        let hitboxType = HitboxFlags.None;
        for (let j=rootVisualElement.hitboxes.length-1; j>=0; --j) {
          if (isInside(posRelativeToRootVisualElementBoundsPx, rootVisualElement.hitboxes[j].boundsPx)) {
            hitboxType |= rootVisualElement.hitboxes[j].type;
          }
        }

        if (hitboxType != HitboxFlags.None) {
          return ({
            rootVisualElementSignal,
            rootVisualElement,
            posRelativeToRootVisualElementBoundsPx,
            posRelativeToRootVisualElementViewportPx: posRelativeToRootVisualElementBoundsPx,
            hitMaybe: finalize(hitboxType, HitboxFlags.None, rootVisualElement, rootVisualElementSignal, null, posRelativeToRootVisualElementBoundsPx, canHitEmbeddedInteractive)
          });
        }

        changedRoot = true;
      }
    }
  }

  let hitboxType = HitboxFlags.None;
  for (let j=rootVisualElement.hitboxes.length-1; j>=0; --j) {
    if (isInside(posRelativeToRootVisualElementBoundsPx, rootVisualElement.hitboxes[j].boundsPx)) {
      hitboxType |= rootVisualElement.hitboxes[j].type;
    }
  }
  let hitMaybe = null;
  if (hitboxType != HitboxFlags.None) {
    hitMaybe = finalize(hitboxType, HitboxFlags.None, rootVisualElement, rootVisualElementSignal, null, posRelativeToRootVisualElementBoundsPx, canHitEmbeddedInteractive);
  }

  const posRelativeToRootVisualElementViewportPx = cloneVector(posRelativeToRootVisualElementBoundsPx)!;
  posRelativeToRootVisualElementViewportPx.y = posRelativeToRootVisualElementViewportPx.y - (rootVisualElement.boundsPx.h - rootVisualElement.viewportBoundsPx!.h);

  let result = {
    rootVisualElementSignal,
    rootVisualElement,
    posRelativeToRootVisualElementBoundsPx,
    posRelativeToRootVisualElementViewportPx,
    hitMaybe
  };

  if (changedRoot && rootVisualElement.selectedVes) {
    return determinePopupOrSelectedRootMaybe(store, result, posOnDesktopPx, canHitEmbeddedInteractive);
  }

  return result;
}


function determineEmbeddedRootMaybe(
    store: StoreContextModel,
    topRootInfo: RootInfo,
    canHitEmbeddedInteractive: boolean): RootInfo {

  const {
    rootVisualElement,
    posRelativeToRootVisualElementViewportPx,
  } = topRootInfo;

  for (let i=0; i<rootVisualElement.childrenVes.length; ++i) {
    const childVes = rootVisualElement.childrenVes[i];
    const childVe = childVes.get();
    if (!(childVe.flags & VisualElementFlags.EmbededInteractiveRoot)) {
      continue;
    }

    if (isInside(posRelativeToRootVisualElementViewportPx, childVe.boundsPx!)) {
      const childVeid = VeFns.veidFromVe(childVe);

      const scrollPropX = store.perItem.getPageScrollXProp(childVeid);
      const scrollPropY = store.perItem.getPageScrollYProp(childVeid);

      const newPosRelativeToRootVisualElementViewportPx = vectorSubtract(
        posRelativeToRootVisualElementViewportPx,
        { x: childVe.viewportBoundsPx!.x - scrollPropX * (childVe.childAreaBoundsPx!.w - childVe.viewportBoundsPx!.w),
          y: childVe.viewportBoundsPx!.y - scrollPropY * (childVe.childAreaBoundsPx!.h - childVe.viewportBoundsPx!.h)});

      const newPosRelativeToRootVisualElementBoundsPx = vectorSubtract(
        posRelativeToRootVisualElementViewportPx,
        { x: childVe.boundsPx.x - scrollPropX * (childVe.childAreaBoundsPx!.w - childVe.viewportBoundsPx!.w),
          y: childVe.boundsPx.y - scrollPropY * (childVe.childAreaBoundsPx!.h - childVe.viewportBoundsPx!.h)});

      let hitboxType = HitboxFlags.None;
      for (let j=childVe.hitboxes.length-1; j>=0; --j) {
        if (isInside(newPosRelativeToRootVisualElementBoundsPx, childVe.hitboxes[j].boundsPx)) {
          hitboxType |= childVe.hitboxes[j].type;
        }
      }

      return ({
        rootVisualElementSignal: childVes,
        rootVisualElement: childVe,
        posRelativeToRootVisualElementViewportPx: newPosRelativeToRootVisualElementViewportPx,
        posRelativeToRootVisualElementBoundsPx: newPosRelativeToRootVisualElementBoundsPx,
        hitMaybe: hitboxType != HitboxFlags.None
          ? finalize(hitboxType, HitboxFlags.None, childVe, childVes, null, newPosRelativeToRootVisualElementViewportPx, canHitEmbeddedInteractive)
          : null
      })
    }
  }

  return topRootInfo;
}


function determineIfDockRoot(umbrellaVisualElement: VisualElement, posOnDesktopPx: Vector): RootInfo | null {
  if (umbrellaVisualElement.dockVes == null) { return null; }

  let dockVes = umbrellaVisualElement.dockVes;
  const dockVe = dockVes.get();
  if (!isInside(posOnDesktopPx, dockVe.boundsPx)) { return null; }

  const posRelativeToRootVisualElementPx = vectorSubtract(posOnDesktopPx, { x: dockVe.boundsPx.x, y: dockVe.boundsPx.y });

  let hitboxType = HitboxFlags.None;
  for (let j=dockVe.hitboxes.length-1; j>=0; --j) {
    if (isInside(posRelativeToRootVisualElementPx, dockVe.hitboxes[j].boundsPx)) {
      hitboxType |= dockVe.hitboxes[j].type;
    }
  }
  if (hitboxType != HitboxFlags.None) {
    return ({
      rootVisualElementSignal: dockVes,
      rootVisualElement: dockVe,
      posRelativeToRootVisualElementBoundsPx: posRelativeToRootVisualElementPx,
      posRelativeToRootVisualElementViewportPx: posRelativeToRootVisualElementPx,
      hitMaybe: finalize(hitboxType, HitboxFlags.None, dockVe, dockVes, null, posRelativeToRootVisualElementPx, false)
    });
  }

  return ({
    rootVisualElementSignal: dockVes,
    rootVisualElement: dockVe,
    posRelativeToRootVisualElementBoundsPx: posRelativeToRootVisualElementPx,
    posRelativeToRootVisualElementViewportPx: posRelativeToRootVisualElementPx,
    hitMaybe: null
  });
}


function handleInsideTableMaybe(
    store: StoreContextModel,
    childVisualElement: VisualElement, childVisualElementSignal: VisualElementSignal,
    rootVisualElement: VisualElement,
    posRelativeToRootVisualElementPx: Vector,
    ignoreItems: Array<Uid>,
    ignoreAttachments: boolean,
    posOnDesktopPx: Vector): HitInfo | null {

  if (!isTable(childVisualElement.displayItem)) { return null; }
  if (childVisualElement.flags & VisualElementFlags.LineItem) { return null; }
  if (!isInside(posRelativeToRootVisualElementPx, childVisualElement.viewportBoundsPx!)) { return null; }

  const tableVisualElementSignal = childVisualElementSignal;
  const tableVisualElement = childVisualElement;

  // resize hitbox of table takes precedence over everything in the child area.
  const resizeHitbox = tableVisualElement.hitboxes[tableVisualElement.hitboxes.length-1];
  if (resizeHitbox.type != HitboxFlags.Resize) { panic("Last table hitbox type is not Resize."); }
  if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(tableVisualElement.boundsPx!)))) {
    return finalize(HitboxFlags.Resize, HitboxFlags.None, rootVisualElement, tableVisualElementSignal, resizeHitbox.meta, posRelativeToRootVisualElementPx, false);
  }
  // col resize also takes precedence over anything in the child area.
  for (let j=tableVisualElement.hitboxes.length-2; j>=0; j--) {
    const hb = tableVisualElement.hitboxes[j];
    if (hb.type != HitboxFlags.HorizontalResize) { break; }
    if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(hb.boundsPx, getBoundingBoxTopLeft(tableVisualElement.boundsPx!)))) {
      return finalize(HitboxFlags.HorizontalResize, HitboxFlags.None, rootVisualElement, tableVisualElementSignal, hb.meta, posRelativeToRootVisualElementPx, false);
    }
  }

  for (let j=0; j<tableVisualElement.childrenVes.length; ++j) {
    const tableChildVes = tableVisualElement.childrenVes[j];
    const tableChildVe = tableChildVes.get();
    const tableBlockHeightPx = tableChildVe.boundsPx.h;

    const posRelativeToTableChildAreaPx = vectorSubtract(
      posRelativeToRootVisualElementPx,
      { x: tableVisualElement.viewportBoundsPx!.x,
        y: tableVisualElement.viewportBoundsPx!.y - store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVisualElement)) * tableBlockHeightPx }
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
        return finalize(hitboxType, HitboxFlags.None, rootVisualElement, tableChildVes, meta, posRelativeToRootVisualElementPx, false);
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
              hitboxType,
              compositeHitboxTypeMaybe: HitboxFlags.None,
              rootVe: rootVisualElement,
              overElementVes: attachmentVes,
              overElementMeta: meta,
              overContainerVe: noAttachmentResult.overContainerVe,
              overPositionableVe: noAttachmentResult.overPositionableVe,
              overPositionGr: noAttachmentResult.overPositionGr,
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
    childVisualElement: VisualElement,
    childVisualElementSignal: VisualElementSignal,
    rootVisualElement: VisualElement,
    posRelativeToRootVisualElementPx: Vector,
    ignoreItems: Array<Uid>,
    posOnDesktopPx: Vector,
    ignoreAttachments: boolean): HitInfo | null {

  if (!isComposite(childVisualElement.displayItem)) { return null; }
  if (childVisualElement.flags & VisualElementFlags.LineItem) { return null; }
  if (!isInside(posRelativeToRootVisualElementPx, childVisualElement.boundsPx!)) { return null; }

  const compositeVes = childVisualElementSignal;
  const compositeVe = childVisualElement;

  // resize hitbox of table takes precedence over everything in the child area.
  const resizeHitbox = compositeVe.hitboxes[compositeVe.hitboxes.length-1];
  if (resizeHitbox.type != HitboxFlags.Resize) { panic("Last composite hitbox type is not Resize."); }
  if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(compositeVe.boundsPx!)))) {
    return finalize(HitboxFlags.Resize, HitboxFlags.None, rootVisualElement, compositeVes, resizeHitbox.meta, posRelativeToRootVisualElementPx, false);
  }

  // for the composite case, also hit the container, even if a child is also hit.
  let compositeHitboxType = HitboxFlags.None;
  let compositeMeta = null;
  for (let k=compositeVe.hitboxes.length-1; k>=0; --k) {
    if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(compositeVe.hitboxes[k].boundsPx, getBoundingBoxTopLeft(compositeVe.boundsPx!)))) {
      compositeHitboxType |= compositeVe.hitboxes[k].type;
      if (compositeVe.hitboxes[k].meta != null) { compositeMeta = compositeVe.hitboxes[k].meta; }
    }
  }

  for (let j=0; j<compositeVe.childrenVes.length; ++j) {
    const compositeChildVes = compositeVe.childrenVes[j];
    const compositeChildVe = compositeChildVes.get();
    const posRelativeToCompositeChildAreaPx = vectorSubtract(
      posRelativeToRootVisualElementPx, { x: compositeVe.boundsPx!.x, y: compositeVe.boundsPx!.y });
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
        const insideTableHit = handleInsideTableInCompositeMaybe(store, rootVisualElement, compositeChildVe, compositeChildVes, ignoreItems, posRelativeToRootVisualElementPx, posRelativeToCompositeChildAreaPx, posOnDesktopPx, ignoreAttachments);
        if (insideTableHit != null) { return insideTableHit; }
      }

      if (hitboxType == HitboxFlags.None) {
        // if inside a composite child, but didn't hit any hitboxes, then hit the composite, not the child.
        if (!ignoreItems.find(a => a == compositeVe.displayItem.id)) {
          return finalize(compositeHitboxType, HitboxFlags.None, rootVisualElement, compositeVes, meta, posRelativeToRootVisualElementPx, false);
        }
      } else {
        if (!ignoreItems.find(a => a == compositeChildVe.displayItem.id)) {
          return finalize(hitboxType, compositeHitboxType, rootVisualElement, compositeChildVes, meta, posRelativeToRootVisualElementPx, false);
        }
      }
    }
  }

  return null;
}

function handleInsideTableInCompositeMaybe(
    store: StoreContextModel,
    rootVe: VisualElement,
    compositeChildVe: VisualElement,
    compositeChildVes: VisualElementSignal,
    ignoreItems: Array<Uid>,
    posRelativeToRootVisualElementPx: Vector,
    posRelativeToCompositeChildAreaPx: Vector,
    posOnDesktopPx: Vector,
    ignoreAttachments: boolean) {

  if (!isTable(compositeChildVe.displayItem)) { return null; }

  // const tableVisualElementSignal = compositeChildVes;
  const tableVisualElement = compositeChildVe;;

  for (let j=0; j<tableVisualElement.childrenVes.length; ++j) {
    const tableChildVes = tableVisualElement.childrenVes[j];
    const tableChildVe = tableChildVes.get();
    const tableBlockHeightPx = tableChildVe.boundsPx.h;

    const posRelativeToTableChildAreaPx = vectorSubtract(
      posRelativeToCompositeChildAreaPx,
      { x: tableVisualElement.viewportBoundsPx!.x,
        y: tableVisualElement.viewportBoundsPx!.y - store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVisualElement)) * tableBlockHeightPx }
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
        return finalize(hitboxType, HitboxFlags.None, rootVe, tableChildVes, meta, posRelativeToRootVisualElementPx, false);
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
              hitboxType,
              compositeHitboxTypeMaybe: HitboxFlags.None,
              rootVe: rootVe,
              overElementVes: attachmentVes,
              overElementMeta: meta,
              overContainerVe: noAttachmentResult.overContainerVe,
              overPositionableVe: noAttachmentResult.overPositionableVe,
              overPositionGr: noAttachmentResult.overPositionGr,
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
    rootVe: VisualElement,
    overElementVes: VisualElementSignal,
    overElementMeta: HitboxMeta | null,
    posRelativeToRootVisualElementPx: Vector,
    canHitEmbeddedInteractive: boolean): HitInfo {

  const overVe = overElementVes.get();
  if (overVe.displayItem.id == PageFns.umbrellaPage().id) {
    return {
      hitboxType: HitboxFlags.None,
      compositeHitboxTypeMaybe: HitboxFlags.None,
      rootVe: overVe,
      overElementVes,
      overElementMeta: null,
      overContainerVe: null,
      overPositionableVe: null,
      overPositionGr: null,
    };
  }

  const overPositionGr = { x: 0, y: 0 };

  if (overVe.flags & VisualElementFlags.InsideTable) {
    assert(isTable(VesCache.get(overVe.parentPath!)!.get().displayItem), "a visual element marked as inside table, is not in fact inside a table.");
    const parentTableVe = VesCache.get(overVe.parentPath!)!.get();
    const tableParentPageVe = VesCache.get(parentTableVe.parentPath!)!.get();
    let overPositionableVe = tableParentPageVe;
    if (isComposite(tableParentPageVe.displayItem)) {
      overPositionableVe = VesCache.get(tableParentPageVe.parentPath!)!.get();
    } else {
      assert(isPage(tableParentPageVe.displayItem), "the parent of a table that has a visual element child, is not a page.");
      assert((tableParentPageVe.flags & VisualElementFlags.ShowChildren) > 0, "page containing table is not marked as having children visible.");
    }
    return {
      hitboxType,
      compositeHitboxTypeMaybe: containerHitboxType,
      rootVe,
      overElementVes,
      overElementMeta,
      overContainerVe: parentTableVe,
      overPositionableVe,
      overPositionGr,
    };
  }

  //   if overElementVes.parent is composite, then overContainerVe should alays be the composite

  if (isTable(overVe.displayItem) && !(overVe.flags & VisualElementFlags.InsideCompositeOrDoc)) {
    const parentVe = VesCache.get(overVe.parentPath!)!.get();
    let prop = {
      x: (posRelativeToRootVisualElementPx.x - parentVe.viewportBoundsPx!.x) / parentVe.childAreaBoundsPx!.w,
      y: (posRelativeToRootVisualElementPx.y - parentVe.viewportBoundsPx!.y) / parentVe.childAreaBoundsPx!.h
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
      hitboxType,
      compositeHitboxTypeMaybe: containerHitboxType,
      rootVe,
      overElementVes,
      overElementMeta,
      overContainerVe: overVe,
      overPositionableVe,
      overPositionGr,
    };
  }

  if (isPage(overVe.displayItem) && (overVe.flags & VisualElementFlags.ShowChildren) && !(overVe.flags & VisualElementFlags.InsideCompositeOrDoc)) {
    let prop = {
      x: (posRelativeToRootVisualElementPx.x - overVe.viewportBoundsPx!.x) / overVe.childAreaBoundsPx!.w,
      y: (posRelativeToRootVisualElementPx.y - overVe.viewportBoundsPx!.y) / overVe.childAreaBoundsPx!.h
    }
    if (rootVe == overVe) {
      prop = {
        x: posRelativeToRootVisualElementPx.x / overVe.childAreaBoundsPx!.w,
        y: posRelativeToRootVisualElementPx.y / overVe.childAreaBoundsPx!.h
      }
    }
    const overPositionGr = {
      x: Math.round(prop.x * asPageItem(overVe.displayItem).innerSpatialWidthGr / GRID_SIZE) * GRID_SIZE,
      y: Math.round(prop.y * asPageItem(overVe.displayItem).innerSpatialWidthGr / asPageItem(overVe.displayItem).naturalAspect / GRID_SIZE) * GRID_SIZE
    };
    let overPositionableVe = overVe;
    let overContainerVe = overVe;
    if (canHitEmbeddedInteractive) {
      if (overVe.flags & VisualElementFlags.EmbededInteractiveRoot) {
        overPositionableVe = VesCache.get(overVe.parentPath!)!.get();
        overContainerVe = VesCache.get(overVe.parentPath!)!.get();
      }
    }

    return {
      hitboxType,
      compositeHitboxTypeMaybe: containerHitboxType,
      rootVe,
      overElementVes,
      overElementMeta,
      overContainerVe,
      overPositionableVe,
      overPositionGr,
    };
  }

  if (overVe.flags & VisualElementFlags.InsideCompositeOrDoc && isComposite(VesCache.get(overVe.parentPath!)!.get().displayItem)) {
    const parentCompositeVe = VesCache.get(overVe.parentPath!)!.get();
    const compositeParentPageVe = VesCache.get(parentCompositeVe.parentPath!)!.get();
    assert(isPage(compositeParentPageVe.displayItem), "the parent of a composite that has a visual element child, is not a page.");
    assert((compositeParentPageVe.flags & VisualElementFlags.ShowChildren) > 0, "page containing composite is not marked as having children visible.");
    return {
      hitboxType,
      compositeHitboxTypeMaybe: containerHitboxType,
      rootVe,
      overElementVes,
      overElementMeta,
      overContainerVe: parentCompositeVe,
      overPositionableVe: compositeParentPageVe,
      overPositionGr,
    };
  }

  const overVeParent = VesCache.get(overVe.parentPath!)!.get();
  assert(isPage(VesCache.get(overVe.parentPath!)!.get().displayItem), "the parent of a non-container item not in page is not a page.");
  assert((VesCache.get(overVe.parentPath!)!.get().flags & VisualElementFlags.ShowChildren) > 0, `the parent '${VesCache.get(overVe.parentPath!)!.get().displayItem.id}' of a non-container does not allow drag in positioning.`);
  if (isPage(overVe.displayItem)) {
    return {
      hitboxType,
      compositeHitboxTypeMaybe: containerHitboxType,
      rootVe,
      overElementVes,
      overElementMeta,
      overContainerVe: overVe,
      overPositionableVe: overVeParent,
      overPositionGr,
    };
  }

  return {
    hitboxType,
    compositeHitboxTypeMaybe: containerHitboxType,
    rootVe,
    overElementVes,
    overElementMeta,
    overContainerVe: overVeParent,
    overPositionableVe: overVeParent,
    overPositionGr,
  };
}
