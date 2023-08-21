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

import { isPage } from "../items/page-item";
import { isTable } from "../items/table-item";
import { HitboxMeta, HitboxType } from "../layout/hitbox";
import { VesCache } from "../layout/ves-cache";
import { VisualElement, dragOverPositioningFlagSet, fixedFlagSet, getVeid, insideTableFlagSet, lineItemFlagSet, popupFlagSet, rootFlagSet } from "../layout/visual-element";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { Vector, getBoundingBoxTopLeft, isInside, offsetBoundingBoxTopLeftBy, vectorAdd, vectorSubtract } from "../util/geometry";
import { assert, panic } from "../util/lang";
import { VisualElementSignal } from "../util/signals";
import { Uid } from "../util/uid";


export interface HitInfo {
  hitboxType: HitboxType,
  rootVe: VisualElement,                     // the first fully editable page directly under the specified position.
  overElementVes: VisualElementSignal,       // the visual element under the specified position.
  overElementMeta: HitboxMeta | null,        // meta data from the hit hitbox of the visual element under specified position.
  overContainerVe: VisualElement | null,     // the visual element of the container immediately under the specified position.
  overPositionableVe: VisualElement | null,  // the visual element that defines scaling/positioning immediately under the specified position (for a table this is it's parent page).
}


export function getHitInfo(
    desktopStore: DesktopStoreContextModel,
    posOnDesktopPx: Vector,
    ignoreItems: Array<Uid>,
    ignoreAttachments: boolean): HitInfo {

  // calculate overContainerVe and overPositionableVe.
  function finalize(hitboxType: HitboxType, rootVe: VisualElement, overElementVes: VisualElementSignal, overElementMeta: HitboxMeta | null): HitInfo {
    const overVe = overElementVes.get();
    if (insideTableFlagSet(overVe)) {
      assert(isTable(VesCache.get(overVe.parentPath!)!.get().displayItem), "a visual element marked as inside table, is not in fact inside a table.");
      const parentTableVe = VesCache.get(overVe.parentPath!)!.get();
      const tableParentPageVe = VesCache.get(parentTableVe.parentPath!)!.get();
      assert(isPage(tableParentPageVe.displayItem), "the parent of a table that has a visual element child, is not a page.");
      assert(dragOverPositioningFlagSet(tableParentPageVe), "page containing table is not marked as drag in positioning.");
      return { hitboxType, rootVe, overElementVes, overElementMeta, overContainerVe: parentTableVe, overPositionableVe: tableParentPageVe };
    }

    if (isTable(overVe.displayItem)) {
      assert(isPage(VesCache.get(overVe.parentPath!)!.get().displayItem), "the parent of a table visual element that is not inside a table is not a page.");
      assert(dragOverPositioningFlagSet(VesCache.get(overVe.parentPath!)!.get()), "a page containing a table does not allow drag in positioning.");
      return { hitboxType, rootVe, overElementVes, overElementMeta, overContainerVe: overVe, overPositionableVe: VesCache.get(overVe.parentPath!)!.get() };
    }

    if (isPage(overVe.displayItem) && dragOverPositioningFlagSet(overVe)) {
      return { hitboxType, rootVe, overElementVes, overElementMeta, overContainerVe: overVe, overPositionableVe: overVe };
    }

    const overVeParent = VesCache.get(overVe.parentPath!)!.get();
    assert(isPage(VesCache.get(overVe.parentPath!)!.get().displayItem), "the parent of a non-container item not in page is not a page.");
    assert(dragOverPositioningFlagSet(VesCache.get(overVe.parentPath!)!.get()), `the parent '${VesCache.get(overVe.parentPath!)!.get().displayItem.id}' of a non-container does not allow drag in positioning.`);
    if (isPage(overVe.displayItem)) {
      return { hitboxType, rootVe, overElementVes, overElementMeta, overContainerVe: overVe, overPositionableVe: overVeParent };
    }
    return { hitboxType, rootVe, overElementVes, overElementMeta, overContainerVe: overVeParent, overPositionableVe: overVeParent };
  }

  const topLevelVisualElement: VisualElement = desktopStore.topLevelVisualElement();
  const posRelativeToTopLevelVisualElementPx = vectorAdd(posOnDesktopPx, { x: desktopStore.getPageScrollXPx(getVeid(topLevelVisualElement)), y: desktopStore.getPageScrollYPx(getVeid(topLevelVisualElement)) });

  // Root is either the top level page, or popup if mouse is over the popup, or selected page.
  let rootVisualElement = topLevelVisualElement;
  let posRelativeToRootVisualElementPx = posRelativeToTopLevelVisualElementPx;
  let rootVisualElementSignal = desktopStore.topLevelVisualElementSignal();
  if (topLevelVisualElement.children.length > 0) {
    // The visual element of the popup or selected list item, if there is one, is always the last of the children.
    const newRootVeMaybe = topLevelVisualElement.children[topLevelVisualElement.children.length-1].get();
    const popupPosRelativeToTopLevelVisualElementPx = popupFlagSet(newRootVeMaybe) && fixedFlagSet(newRootVeMaybe)
      ? posOnDesktopPx : posRelativeToRootVisualElementPx;
    if (popupFlagSet(newRootVeMaybe) &&
        isInside(popupPosRelativeToTopLevelVisualElementPx, newRootVeMaybe.boundsPx)) {
      rootVisualElementSignal = topLevelVisualElement.children[rootVisualElement.children.length-1];
      rootVisualElement = rootVisualElementSignal.get();
      posRelativeToRootVisualElementPx = vectorSubtract(popupPosRelativeToTopLevelVisualElementPx, { x: rootVisualElement.boundsPx.x, y: rootVisualElement.boundsPx.y });
      let hitboxType = HitboxType.None;
      for (let j=rootVisualElement.hitboxes.length-1; j>=0; --j) {
        if (isInside(posRelativeToRootVisualElementPx, rootVisualElement.hitboxes[j].boundsPx)) {
          hitboxType |= rootVisualElement.hitboxes[j].type;
        }
      }
      if (hitboxType != HitboxType.None) {
        return finalize(hitboxType, rootVisualElement, rootVisualElementSignal, null);
      }
      posRelativeToRootVisualElementPx = vectorSubtract(popupPosRelativeToTopLevelVisualElementPx, { x: rootVisualElement.childAreaBoundsPx!.x, y: rootVisualElement.childAreaBoundsPx!.y });
    } else if (rootFlagSet(newRootVeMaybe) &&
        isInside(posRelativeToTopLevelVisualElementPx, newRootVeMaybe.boundsPx)) {
      rootVisualElementSignal = topLevelVisualElement.children[rootVisualElement.children.length-1];
      rootVisualElement = rootVisualElementSignal.get();
      posRelativeToRootVisualElementPx = vectorSubtract(posRelativeToTopLevelVisualElementPx, { x: rootVisualElement.childAreaBoundsPx!.x, y: rootVisualElement.childAreaBoundsPx!.y });
    }
  }

  for (let i=rootVisualElement.children.length-1; i>=0; --i) {
    const childVisualElementSignal = rootVisualElement.children[i];
    const childVisualElement = childVisualElementSignal.get();

    // attachments take precedence.
    if (!ignoreAttachments) {
      const posRelativeToChildElementPx = vectorSubtract(posRelativeToRootVisualElementPx, { x: childVisualElement.boundsPx.x, y: childVisualElement.boundsPx.y });
      for (let j=childVisualElement.attachments.length-1; j>=0; j--) {
        const attachmentVisualElementSignal = childVisualElement.attachments[j];
        const attachmentVisualElement = attachmentVisualElementSignal.get();
        if (!isInside(posRelativeToChildElementPx, attachmentVisualElement.boundsPx)) {
          continue;
        }
        let hitboxType = HitboxType.None;
        let meta = null;
        for (let j=attachmentVisualElement.hitboxes.length-1; j>=0; --j) {
          if (isInside(posRelativeToChildElementPx, offsetBoundingBoxTopLeftBy(attachmentVisualElement.hitboxes[j].boundsPx, getBoundingBoxTopLeft(attachmentVisualElement.boundsPx)))) {
            hitboxType |= attachmentVisualElement.hitboxes[j].type;
            if (attachmentVisualElement.hitboxes[j].meta != null) { meta = attachmentVisualElement.hitboxes[j].meta; }
          }
        }
        if (!ignoreItems.find(a => a == attachmentVisualElement.displayItem.id)) {
          const noAttachmentResult = getHitInfo(desktopStore, posOnDesktopPx, ignoreItems, true);
          return { hitboxType, rootVe: rootVisualElement, overElementVes: attachmentVisualElementSignal, overElementMeta: meta, overContainerVe: noAttachmentResult.overContainerVe, overPositionableVe: noAttachmentResult.overPositionableVe };
        }
      }
    }

    if (!isInside(posRelativeToRootVisualElementPx, childVisualElement.boundsPx)) {
      continue;
    }

    if (isTable(childVisualElement.displayItem) && !lineItemFlagSet(childVisualElement) && childVisualElement.childAreaBoundsPx == null) {
      console.error("A table visual element unexpectedly had no childAreaBoundsPx set.", childVisualElement);
    }

    // handle inside table child area.
    if (isTable(childVisualElement.displayItem) &&
        !lineItemFlagSet(childVisualElement) &&
        isInside(posRelativeToRootVisualElementPx, childVisualElement.childAreaBoundsPx!)) {
      const tableVisualElementSignal = childVisualElementSignal;
      const tableVisualElement = childVisualElement;

      // resize hitbox of table takes precedence over everything in the child area.
      const resizeHitbox = tableVisualElement.hitboxes[tableVisualElement.hitboxes.length-1];
      if (resizeHitbox.type != HitboxType.Resize) { panic(); }
      if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(tableVisualElement.boundsPx!)))) {
        return finalize(HitboxType.Resize, rootVisualElement, tableVisualElementSignal, resizeHitbox.meta);
      }
      // col resize also takes precedence over anything in the child area.
      for (let j=tableVisualElement.hitboxes.length-2; j>=0; j--) {
        const hb = tableVisualElement.hitboxes[j];
        if (hb.type != HitboxType.ColResize) { break; }
        if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(hb.boundsPx, getBoundingBoxTopLeft(tableVisualElement.boundsPx!)))) {
          return finalize(HitboxType.ColResize, rootVisualElement, tableVisualElementSignal, hb.meta);
        }
      }

      for (let j=0; j<tableVisualElement.children.length; ++j) {
        const tableChildVes = tableVisualElement.children[j];
        const tableChildVe = tableChildVes.get();
        const tableBlockHeightPx = tableChildVe.boundsPx.h;
        const posRelativeToTableChildAreaPx = vectorSubtract(
          posRelativeToRootVisualElementPx,
          { x: tableVisualElement.childAreaBoundsPx!.x,
            y: tableVisualElement.childAreaBoundsPx!.y - desktopStore.getTableScrollYPos(getVeid(tableVisualElement)) * tableBlockHeightPx }
        );
        if (isInside(posRelativeToTableChildAreaPx, tableChildVe.boundsPx)) {
          let hitboxType = HitboxType.None;
          let meta = null;
          for (let k=tableChildVe.hitboxes.length-1; k>=0; --k) {
            if (isInside(posRelativeToTableChildAreaPx, offsetBoundingBoxTopLeftBy(tableChildVe.hitboxes[k].boundsPx, getBoundingBoxTopLeft(tableChildVe.boundsPx)))) {
              hitboxType |= tableChildVe.hitboxes[k].type;
              if (tableChildVe.hitboxes[k].meta != null) { meta = tableChildVe.hitboxes[k].meta; }
            }
          }
          if (!ignoreItems.find(a => a == tableChildVe.displayItem.id)) {
            return finalize(hitboxType, rootVisualElement, tableChildVes, meta);
          }
        }
        if (!ignoreAttachments) {
          for (let k=0; k<tableChildVe.attachments.length; ++k) {
            const attachmentVes = tableChildVe.attachments[k];
            const attachmentVe = attachmentVes.get();
            if (isInside(posRelativeToTableChildAreaPx, attachmentVe.boundsPx)) {
              let hitboxType = HitboxType.None;
              let meta = null;
              for (let l=attachmentVe.hitboxes.length-1; l>=0; --l) {
                if (isInside(posRelativeToTableChildAreaPx, offsetBoundingBoxTopLeftBy(attachmentVe.hitboxes[l].boundsPx, getBoundingBoxTopLeft(attachmentVe.boundsPx)))) {
                  hitboxType |= attachmentVe.hitboxes[l].type;
                  if (attachmentVe.hitboxes[l].meta != null) { meta = attachmentVe.hitboxes[l].meta; }
                }
              }
              if (!ignoreItems.find(a => a == attachmentVe.displayItem.id)) {
                const noAttachmentResult = getHitInfo(desktopStore, posOnDesktopPx, ignoreItems, true);
                return { hitboxType, rootVe: rootVisualElement, overElementVes: attachmentVes, overElementMeta: meta, overContainerVe: noAttachmentResult.overContainerVe, overPositionableVe: noAttachmentResult.overPositionableVe };
              }
            }
          }
        }
      }
    }

    // handle inside any other item (including pages, which can't be clicked in).
    let hitboxType = HitboxType.None;
    let meta = null;
    for (let j=childVisualElement.hitboxes.length-1; j>=0; --j) {
      if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(childVisualElement.hitboxes[j].boundsPx, getBoundingBoxTopLeft(childVisualElement.boundsPx)))) {
        hitboxType |= childVisualElement.hitboxes[j].type;
        if (childVisualElement.hitboxes[j].meta != null) { meta = childVisualElement.hitboxes[j].meta; }
      }
    }
    if (!ignoreItems.find(a => a == childVisualElement.displayItem.id)) {
      return finalize(hitboxType, rootVisualElement, rootVisualElement.children[i], meta);
    }
  }

  return finalize(HitboxType.None, rootVisualElement, rootVisualElementSignal, null);
}
