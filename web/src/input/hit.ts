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

import { isComposite } from "../items/composite-item";
import { isPage } from "../items/page-item";
import { isTable } from "../items/table-item";
import { HitboxMeta, HitboxFlags } from "../layout/hitbox";
import { VesCache } from "../layout/ves-cache";
import { VisualElement, VisualElementFlags, VeFns } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { Vector, cloneVector, getBoundingBoxTopLeft, isInside, offsetBoundingBoxTopLeftBy, vectorAdd, vectorSubtract } from "../util/geometry";
import { assert, panic } from "../util/lang";
import { VisualElementSignal } from "../util/signals";
import { Uid } from "../util/uid";


export interface HitInfo {
  hitboxType: HitboxFlags,                    // the intersected hitbox flags of overElement.
  compositeHitboxTypeMaybe: HitboxFlags,      // if the item hit was inside a composite container, the intersected hitbox flags of the composite container, else None.
  rootVe: VisualElement,                     // the first fully editable page directly under the specified position.
  overElementVes: VisualElementSignal,       // the visual element under the specified position.
  overElementMeta: HitboxMeta | null,        // meta data from the hit hitbox of the visual element under specified position.
  overContainerVe: VisualElement | null,     // the visual element of the container immediately under the specified position.
  overPositionableVe: VisualElement | null,  // the visual element that defines scaling/positioning immediately under the specified position (for a table this is it's parent page).
}


export function getHitInfo(
    store: StoreContextModel,
    posOnDesktopPx: Vector,
    ignoreItems: Array<Uid>,
    ignoreAttachments: boolean): HitInfo {

  const topLevelVisualElement: VisualElement = store.topLevelVisualElement.get();
  const topLevelVeid = store.history.currentPage()!;
  const posRelativeToTopLevelVisualElementPx = vectorAdd(
    posOnDesktopPx, {
      x: store.perItem.getPageScrollXProp(topLevelVeid) * (topLevelVisualElement.childAreaBoundsPx!.w - topLevelVisualElement.boundsPx.w),
      y: store.perItem.getPageScrollYProp(topLevelVeid) * (topLevelVisualElement.childAreaBoundsPx!.h - topLevelVisualElement.boundsPx.h)
    });

  // Root is either the top level page, or popup if mouse is over the popup, list page type selected page or dock page.
  const {
    rootVisualElementSignal,
    rootVisualElement,
    posRelativeToRootVisualElementPx,
    hitMaybe } = determineRoot(store, topLevelVisualElement, posRelativeToTopLevelVisualElementPx, posOnDesktopPx);
  if (hitMaybe) { return hitMaybe!; } // if a root hitbox was hit.

  let hitboxType = HitboxFlags.None;
  for (let i=0; i<rootVisualElement.hitboxes.length; ++i) {
    if (isInside(posRelativeToRootVisualElementPx, rootVisualElement.hitboxes[i].boundsPx)) {
      hitboxType |= rootVisualElement.hitboxes[i].type;
    }
  }
  if (hitboxType != HitboxFlags.None) {
    return finalize(hitboxType, HitboxFlags.None, rootVisualElement, rootVisualElementSignal, null);
  }

  for (let i=rootVisualElement.childrenVes.length-1; i>=0; --i) {
    const childVisualElementSignal = rootVisualElement.childrenVes[i];
    const childVisualElement = childVisualElementSignal.get();

    if (childVisualElement.flags & VisualElementFlags.IsDock) { continue; }

    // attachments take precedence.
    if (!ignoreAttachments) {
      const posRelativeToChildElementPx = vectorSubtract(posRelativeToRootVisualElementPx, { x: childVisualElement.boundsPx.x, y: childVisualElement.boundsPx.y });
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
          const noAttachmentResult = getHitInfo(store, posOnDesktopPx, ignoreItems, true);
          return {
            hitboxType,
            compositeHitboxTypeMaybe: HitboxFlags.None,
            rootVe: rootVisualElement,
            overElementVes: attachmentVisualElementSignal,
            overElementMeta: meta,
            overContainerVe: noAttachmentResult.overContainerVe,
            overPositionableVe: noAttachmentResult.overPositionableVe
          };
        }
      }
    }

    if (!isInside(posRelativeToRootVisualElementPx, childVisualElement.boundsPx)) {
      continue;
    }

    if (isTable(childVisualElement.displayItem) && !(childVisualElement.flags & VisualElementFlags.LineItem) && childVisualElement.childAreaBoundsPx == null) {
      console.error("A table visual element unexpectedly had no childAreaBoundsPx set.", childVisualElement);
    }

    const insideTableHit = handleInsideTableMaybe(store, childVisualElement, childVisualElementSignal, rootVisualElement, posRelativeToRootVisualElementPx, ignoreItems, ignoreAttachments, posOnDesktopPx);
    if (insideTableHit != null) { return insideTableHit; }

    const insideCompositeHit = handleInsideCompositeMaybe(childVisualElement, childVisualElementSignal, rootVisualElement, posRelativeToRootVisualElementPx, ignoreItems);
    if (insideCompositeHit != null) { return insideCompositeHit; }

    // handle inside any other item (including pages that are sized such that they can't be clicked in).
    let hitboxType = HitboxFlags.None;
    let meta = null;
    for (let j=childVisualElement.hitboxes.length-1; j>=0; --j) {
      if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(childVisualElement.hitboxes[j].boundsPx, getBoundingBoxTopLeft(childVisualElement.boundsPx)))) {
        hitboxType |= childVisualElement.hitboxes[j].type;
        if (childVisualElement.hitboxes[j].meta != null) { meta = childVisualElement.hitboxes[j].meta; }
      }
    }
    if (!ignoreItems.find(a => a == childVisualElement.displayItem.id)) {
      return finalize(hitboxType, HitboxFlags.None, rootVisualElement, rootVisualElement.childrenVes[i], meta);
    }
  }

  return finalize(HitboxFlags.None, HitboxFlags.None, rootVisualElement, rootVisualElementSignal, null);
}


interface RootInfo {
  rootVisualElementSignal: VisualElementSignal,
  rootVisualElement: VisualElement,
  posRelativeToRootVisualElementPx: Vector,
  hitMaybe: HitInfo | null
}

function determineRoot(
    store: StoreContextModel,
    topLevelVisualElement: VisualElement,
    // this may be scrolled, so not be the same as posOnDesktopPx.
    posRelativeToTopLevelVisualElementPx: Vector,
    // does not incorporate page scroll.
    posOnDesktopPx: Vector): RootInfo {

  let rootVisualElement = topLevelVisualElement;
  let posRelativeToRootVisualElementPx = posRelativeToTopLevelVisualElementPx;
  let rootVisualElementSignal = store.topLevelVisualElement;

  if (topLevelVisualElement.childrenVes.length == 0) {
    return { rootVisualElementSignal, rootVisualElement, posRelativeToRootVisualElementPx, hitMaybe: null };
  }

  const dockRootMaybe = determineIfDockRoot(topLevelVisualElement, posOnDesktopPx);
  if (dockRootMaybe != null) { return dockRootMaybe!; }

  posOnDesktopPx = cloneVector(posOnDesktopPx)!;
  posOnDesktopPx.x = posOnDesktopPx.x - store.dockWidthPx.get();

  posRelativeToRootVisualElementPx = cloneVector(posRelativeToRootVisualElementPx)!;
  posRelativeToRootVisualElementPx.x = posRelativeToRootVisualElementPx.x - store.dockWidthPx.get();


  let done = false;

  if (topLevelVisualElement.popupVes) {
    const newRootVesMaybe = topLevelVisualElement.popupVes!;
    const newRootVeMaybe = newRootVesMaybe.get();

    const popupPosRelativeToTopLevelVisualElementPx = (newRootVeMaybe.flags & VisualElementFlags.Fixed)
      ? posOnDesktopPx
      : posRelativeToRootVisualElementPx;

    if (isInside(popupPosRelativeToTopLevelVisualElementPx, newRootVeMaybe.boundsPx)) {
      rootVisualElementSignal = newRootVesMaybe;
      rootVisualElement = newRootVeMaybe;
      const popupVeid = VeFns.veidFromPath(store.history.currentPopupSpec()!.vePath);
      const scrollYPx = isPage(rootVisualElement.displayItem)
        ? store.perItem.getPageScrollYProp(popupVeid) * (rootVisualElement.childAreaBoundsPx!.h - rootVisualElement.boundsPx.h)
        : 0;
      const scrollXPx = isPage(rootVisualElement.displayItem)
        ? store.perItem.getPageScrollXProp(popupVeid) * (rootVisualElement.childAreaBoundsPx!.w - rootVisualElement.boundsPx.w)
        : 0;
      posRelativeToRootVisualElementPx = vectorSubtract(popupPosRelativeToTopLevelVisualElementPx, { x: rootVisualElement.boundsPx.x, y: rootVisualElement.boundsPx.y });
      let hitboxType = HitboxFlags.None;
      for (let j=rootVisualElement.hitboxes.length-1; j>=0; --j) {
        if (isInside(posRelativeToRootVisualElementPx, rootVisualElement.hitboxes[j].boundsPx)) {
          hitboxType |= rootVisualElement.hitboxes[j].type;
        }
      }
      if (hitboxType != HitboxFlags.None) {
        return { rootVisualElementSignal, rootVisualElement, posRelativeToRootVisualElementPx, hitMaybe: finalize(hitboxType, HitboxFlags.None, rootVisualElement, rootVisualElementSignal, null) };
      }
      posRelativeToRootVisualElementPx = vectorSubtract(
        popupPosRelativeToTopLevelVisualElementPx,
        { x: rootVisualElement.childAreaBoundsPx!.x - scrollXPx,
          y: rootVisualElement.childAreaBoundsPx!.y - scrollYPx });
      done = true;
    }
  }

  if (!done && topLevelVisualElement.selectedVes) {
    const newRootVesMaybe = topLevelVisualElement.selectedVes!;
    const newRootVeMaybe = newRootVesMaybe.get();

    if (isInside(posRelativeToRootVisualElementPx, newRootVeMaybe.boundsPx)) {
      rootVisualElementSignal = newRootVesMaybe;
      rootVisualElement = newRootVeMaybe;
      const selected = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(VeFns.veidFromVe(topLevelVisualElement)));
      const scrollPropY = store.perItem.getPageScrollYProp(selected);
      posRelativeToRootVisualElementPx = vectorSubtract(
        posRelativeToRootVisualElementPx,
        { x: rootVisualElement.childAreaBoundsPx!.x,
          y: rootVisualElement.childAreaBoundsPx!.y - scrollPropY * (rootVisualElement.childAreaBoundsPx!.h - rootVisualElement.boundsPx.h)})
      let hitboxType = HitboxFlags.None;
      for (let j=rootVisualElement.hitboxes.length-1; j>=0; --j) {
        if (isInside(posRelativeToRootVisualElementPx, rootVisualElement.hitboxes[j].boundsPx)) {
          hitboxType |= rootVisualElement.hitboxes[j].type;
        }
      }

      if (hitboxType != HitboxFlags.None) {
        return { rootVisualElementSignal, rootVisualElement, posRelativeToRootVisualElementPx, hitMaybe: finalize(hitboxType, HitboxFlags.None, rootVisualElement, rootVisualElementSignal, null) };
      }
    }
  }

  return { rootVisualElementSignal, rootVisualElement, posRelativeToRootVisualElementPx, hitMaybe: null };
}

function determineIfDockRoot(topLevelVisualElement: VisualElement, posOnDesktopPx: Vector): RootInfo | null {

  if (topLevelVisualElement.dockVes == null) {
    return null;
  }
  let dockVes = topLevelVisualElement.dockVes;

  const dockVe = dockVes.get();

  if (!isInside(posOnDesktopPx, dockVe.boundsPx)) { return null; }

  const posRelativeToRootVisualElementPx = vectorSubtract(posOnDesktopPx, { x: dockVe.childAreaBoundsPx!.x, y: dockVe.childAreaBoundsPx!.y });

  let hitboxType = HitboxFlags.None;
  for (let j=dockVe.hitboxes.length-1; j>=0; --j) {
    if (isInside(posRelativeToRootVisualElementPx, dockVe.hitboxes[j].boundsPx)) {
      hitboxType |= dockVe.hitboxes[j].type;
    }
  }
  if (hitboxType != HitboxFlags.None) {
    return { rootVisualElementSignal: dockVes, rootVisualElement: dockVe, posRelativeToRootVisualElementPx, hitMaybe: finalize(hitboxType, HitboxFlags.None, dockVe, dockVes, null) };
  }

  return { rootVisualElementSignal: dockVes, rootVisualElement: dockVe, posRelativeToRootVisualElementPx, hitMaybe: null };
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
  if (!isInside(posRelativeToRootVisualElementPx, childVisualElement.childAreaBoundsPx!)) { return null; }

  const tableVisualElementSignal = childVisualElementSignal;
  const tableVisualElement = childVisualElement;

  // resize hitbox of table takes precedence over everything in the child area.
  const resizeHitbox = tableVisualElement.hitboxes[tableVisualElement.hitboxes.length-1];
  if (resizeHitbox.type != HitboxFlags.Resize) { panic("Last table hitbox type is not Resize."); }
  if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(tableVisualElement.boundsPx!)))) {
    return finalize(HitboxFlags.Resize, HitboxFlags.None, rootVisualElement, tableVisualElementSignal, resizeHitbox.meta);
  }
  // col resize also takes precedence over anything in the child area.
  for (let j=tableVisualElement.hitboxes.length-2; j>=0; j--) {
    const hb = tableVisualElement.hitboxes[j];
    if (hb.type != HitboxFlags.HorizontalResize) { break; }
    if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(hb.boundsPx, getBoundingBoxTopLeft(tableVisualElement.boundsPx!)))) {
      return finalize(HitboxFlags.HorizontalResize, HitboxFlags.None, rootVisualElement, tableVisualElementSignal, hb.meta);
    }
  }

  for (let j=0; j<tableVisualElement.childrenVes.length; ++j) {
    const tableChildVes = tableVisualElement.childrenVes[j];
    const tableChildVe = tableChildVes.get();
    const tableBlockHeightPx = tableChildVe.boundsPx.h;
    const posRelativeToTableChildAreaPx = vectorSubtract(
      posRelativeToRootVisualElementPx,
      { x: tableVisualElement.childAreaBoundsPx!.x,
        y: tableVisualElement.childAreaBoundsPx!.y - store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVisualElement)) * tableBlockHeightPx }
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
        return finalize(hitboxType, HitboxFlags.None, rootVisualElement, tableChildVes, meta);
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
            const noAttachmentResult = getHitInfo(store, posOnDesktopPx, ignoreItems, true);
            return {
              hitboxType,
              compositeHitboxTypeMaybe: HitboxFlags.None,
              rootVe: rootVisualElement,
              overElementVes: attachmentVes,
              overElementMeta: meta,
              overContainerVe: noAttachmentResult.overContainerVe,
              overPositionableVe: noAttachmentResult.overPositionableVe
            };
          }
        }
      }
    }
  }

  return null;
}


function handleInsideCompositeMaybe(
    childVisualElement: VisualElement, childVisualElementSignal: VisualElementSignal,
    rootVisualElement: VisualElement,
    posRelativeToRootVisualElementPx: Vector,
    ignoreItems: Array<Uid>): HitInfo | null {

  if (!isComposite(childVisualElement.displayItem)) { return null; }
  if (childVisualElement.flags & VisualElementFlags.LineItem) { return null; }
  if (!isInside(posRelativeToRootVisualElementPx, childVisualElement.childAreaBoundsPx!)) { return null; }

  const compositeVes = childVisualElementSignal;
  const compositeVe = childVisualElement;

  // resize hitbox of table takes precedence over everything in the child area.
  const resizeHitbox = compositeVe.hitboxes[compositeVe.hitboxes.length-1];
  if (resizeHitbox.type != HitboxFlags.Resize) { panic("Last composite hitbox type is not Resize."); }
  if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(compositeVe.boundsPx!)))) {
    return finalize(HitboxFlags.Resize, HitboxFlags.None, rootVisualElement, compositeVes, resizeHitbox.meta);
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
      posRelativeToRootVisualElementPx, { x: compositeVe.childAreaBoundsPx!.x, y: compositeVe.childAreaBoundsPx!.y });
    if (isInside(posRelativeToCompositeChildAreaPx, compositeChildVe.boundsPx)) {
      let hitboxType = HitboxFlags.None;
      let meta = null;
      for (let k=compositeChildVe.hitboxes.length-1; k>=0; --k) {
        if (isInside(posRelativeToCompositeChildAreaPx, offsetBoundingBoxTopLeftBy(compositeChildVe.hitboxes[k].boundsPx, getBoundingBoxTopLeft(compositeChildVe.boundsPx)))) {
          hitboxType |= compositeChildVe.hitboxes[k].type;
          if (compositeChildVe.hitboxes[k].meta != null) { meta = compositeChildVe.hitboxes[k].meta; }
        }
      }

      if (hitboxType == HitboxFlags.None) {
        // if inside a composite child, but didn't hit any hitboxes, then hit the composite, not the child.
        if (!ignoreItems.find(a => a == compositeVe.displayItem.id)) {
          return finalize(compositeHitboxType, HitboxFlags.None, rootVisualElement, compositeVes, meta);
        }
      } else {
        if (!ignoreItems.find(a => a == compositeChildVe.displayItem.id)) {
          return finalize(hitboxType, compositeHitboxType, rootVisualElement, compositeChildVes, meta);
        }
      }
    }
  }

  return null;
}


// calculate overContainerVe and overPositionableVe.
function finalize(hitboxType: HitboxFlags, containerHitboxType: HitboxFlags, rootVe: VisualElement, overElementVes: VisualElementSignal, overElementMeta: HitboxMeta | null): HitInfo {
  const overVe = overElementVes.get();
  if (overVe.flags & VisualElementFlags.InsideTable) {
    assert(isTable(VesCache.get(overVe.parentPath!)!.get().displayItem), "a visual element marked as inside table, is not in fact inside a table.");
    const parentTableVe = VesCache.get(overVe.parentPath!)!.get();
    const tableParentPageVe = VesCache.get(parentTableVe.parentPath!)!.get();
    assert(isPage(tableParentPageVe.displayItem), "the parent of a table that has a visual element child, is not a page.");
    assert((tableParentPageVe.flags & VisualElementFlags.ShowChildren) > 0, "page containing table is not marked as having children visible.");
    return { hitboxType, compositeHitboxTypeMaybe: containerHitboxType, rootVe, overElementVes, overElementMeta, overContainerVe: parentTableVe, overPositionableVe: tableParentPageVe };
  }

  if (isTable(overVe.displayItem)) {
    assert((VesCache.get(overVe.parentPath!)!.get().flags & VisualElementFlags.ShowChildren) > 0, "a page containing a table is not marked as having children visible.");
    return { hitboxType, compositeHitboxTypeMaybe: containerHitboxType, rootVe, overElementVes, overElementMeta, overContainerVe: overVe, overPositionableVe: VesCache.get(overVe.parentPath!)!.get() };
  }

  if (isPage(overVe.displayItem) && (overVe.flags & VisualElementFlags.ShowChildren)) {
    return { hitboxType, compositeHitboxTypeMaybe: containerHitboxType, rootVe, overElementVes, overElementMeta, overContainerVe: overVe, overPositionableVe: overVe };
  }

  if (overVe.flags & VisualElementFlags.InsideCompositeOrDoc && isComposite(VesCache.get(overVe.parentPath!)!.get().displayItem)) {
    const parentCompositeVe = VesCache.get(overVe.parentPath!)!.get();
    const compositeParentPageVe = VesCache.get(parentCompositeVe.parentPath!)!.get();
    assert(isPage(compositeParentPageVe.displayItem), "the parent of a composite that has a visual element child, is not a page.");
    assert((compositeParentPageVe.flags & VisualElementFlags.ShowChildren) > 0, "page containing composite is not marked as having children visible.");
    return { hitboxType, compositeHitboxTypeMaybe: containerHitboxType, rootVe, overElementVes, overElementMeta, overContainerVe: parentCompositeVe, overPositionableVe: compositeParentPageVe };
  }

  const overVeParent = VesCache.get(overVe.parentPath!)!.get();
  assert(isPage(VesCache.get(overVe.parentPath!)!.get().displayItem), "the parent of a non-container item not in page is not a page.");
  assert((VesCache.get(overVe.parentPath!)!.get().flags & VisualElementFlags.ShowChildren) > 0, `the parent '${VesCache.get(overVe.parentPath!)!.get().displayItem.id}' of a non-container does not allow drag in positioning.`);
  if (isPage(overVe.displayItem)) {
    return { hitboxType, compositeHitboxTypeMaybe: containerHitboxType, rootVe, overElementVes, overElementMeta, overContainerVe: overVe, overPositionableVe: overVeParent };
  }
  return { hitboxType, compositeHitboxTypeMaybe: containerHitboxType, rootVe, overElementVes, overElementMeta, overContainerVe: overVeParent, overPositionableVe: overVeParent };
}
