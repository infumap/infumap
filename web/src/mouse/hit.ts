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

import { asPageItem, isPage } from "../items/page-item";
import { asTableItem, isTable } from "../items/table-item";
import { HitboxType } from "../layout/hitbox";
import { VisualElement } from "../layout/visual-element";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { Vector, getBoundingBoxTopLeft, isInside, offsetBoundingBoxTopLeftBy, vectorAdd, vectorSubtract } from "../util/geometry";
import { assert, panic } from "../util/lang";
import { VisualElementSignal } from "../util/signals";
import { Uid } from "../util/uid";


interface HitInfo {
  hitboxType: HitboxType,
  overElementVes: VisualElementSignal,       // the visual element under the specified position.
  overContainerVe: VisualElement | null,     // the visual element of the container immediately under the specified position.
  overPositionableVe: VisualElement | null,  // the visual element that defines scaling/positioning immediately under the specified position.
}


export function getHitInfo(
    desktopStore: DesktopStoreContextModel,
    posOnDesktopPx: Vector,
    ignoreItems: Array<Uid>,
    ignoreAttachments: boolean): HitInfo {

  function finalize(hitboxType: HitboxType, overElementVes: VisualElementSignal): HitInfo {
    const overVe = overElementVes.get();
    if (overVe.isInsideTable) {
      assert(isTable(overVe.parent!.get().item), "visual element marked as inside table, is not in fact inside a table.");
      const parentTableVe = overVe.parent!.get();
      const tableParentPageVe = parentTableVe.parent!.get();
      assert(isPage(tableParentPageVe.item), "the parent of a table that has a visual element child, is not a page.");
      assert(tableParentPageVe.isDragOverPositioning, "page containing table does not drag in positioning.");
      return { hitboxType, overElementVes, overContainerVe: parentTableVe, overPositionableVe: tableParentPageVe };
    }

    if (isTable(overVe.item)) {
      assert(isPage(overVe.parent!.get().item), "the parent of a table visual element that is not inside a table is not a page.");
      assert(overVe.parent!.get().isDragOverPositioning, "page containing table does not allow drag in positioning.");
      return { hitboxType, overElementVes, overContainerVe: overVe, overPositionableVe: overVe.parent!.get() };
    }

    if (isPage(overVe.item) && overVe.isDragOverPositioning) {
      return { hitboxType, overElementVes, overContainerVe: overVe, overPositionableVe: overVe };
    }

    const overVeParent = overVe.parent!.get();
    assert(isPage(overVe.parent!.get().item), "parent of non-container item not in page is not a page.");
    assert(overVe.parent!.get().isDragOverPositioning, "parent of non-container does not allow drag in positioning.");
    if (isPage(overVe.item)) {
      return { hitboxType, overElementVes, overContainerVe: overVe, overPositionableVe: overVeParent };
    }
    return { hitboxType, overElementVes, overContainerVe: overVeParent, overPositionableVe: overVeParent };
  }

  const topLevelVisualElement: VisualElement = desktopStore.topLevelVisualElement();
  const topLevelPage = asPageItem(topLevelVisualElement!.item);
  const posRelativeToTopLevelVisualElementPx = vectorAdd(posOnDesktopPx, { x: topLevelPage.scrollXPx.get(), y: topLevelPage.scrollYPx.get() });

  // Root is either the top level page, or popup if mouse is over the popup.
  let rootVisualElement = topLevelVisualElement;
  let posRelativeToRootVisualElementPx = posRelativeToTopLevelVisualElementPx;
  let rootVisualElementSignal = { get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement };
  if (topLevelVisualElement.children.length > 0) {
    // The visual element of the popup, if there is one, is always the last of the children.
    const popupVeMaybe = topLevelVisualElement.children[topLevelVisualElement.children.length-1].get();
    if (popupVeMaybe.isPopup &&
        isInside(posRelativeToTopLevelVisualElementPx, popupVeMaybe.boundsPx)) {
      rootVisualElementSignal = topLevelVisualElement.children[rootVisualElement.children.length-1];
      rootVisualElement = rootVisualElementSignal.get();
      posRelativeToRootVisualElementPx = vectorSubtract(posRelativeToTopLevelVisualElementPx, { x: rootVisualElement.boundsPx.x, y: rootVisualElement.boundsPx.y });
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
        for (let j=attachmentVisualElement.hitboxes.length-1; j>=0; --j) {
          if (isInside(posRelativeToChildElementPx, offsetBoundingBoxTopLeftBy(attachmentVisualElement.hitboxes[j].boundsPx, getBoundingBoxTopLeft(attachmentVisualElement.boundsPx)))) {
            hitboxType |= attachmentVisualElement.hitboxes[j].type;
          }
        }
        if (!ignoreItems.find(a => a == attachmentVisualElement.item.id)) {
          const noAttachmentResult = getHitInfo(desktopStore, posOnDesktopPx, ignoreItems, true);
          return { hitboxType, overElementVes: attachmentVisualElementSignal, overContainerVe: noAttachmentResult.overContainerVe, overPositionableVe: noAttachmentResult.overPositionableVe };
        }
      }
    }

    if (!isInside(posRelativeToRootVisualElementPx, childVisualElement.boundsPx)) {
      continue;
    }

    // handle inside table child area.
    if (isTable(childVisualElement.item) && isInside(posRelativeToRootVisualElementPx, childVisualElement.childAreaBoundsPx!)) {
      const tableVisualElementSignal = childVisualElementSignal;
      const tableVisualElement = childVisualElement;

      // resize hitbox of table takes precedence over everything in the child area.
      let resizeHitbox = tableVisualElement.hitboxes[tableVisualElement.hitboxes.length-1];
      if (resizeHitbox.type != HitboxType.Resize) { panic(); }
      if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(tableVisualElement.boundsPx!)))) {
        return finalize(HitboxType.Resize, tableVisualElementSignal);
      }

      let tableItem = asTableItem(tableVisualElement.item);

      for (let j=0; j<tableVisualElement.children.length; ++j) {
        const tableChildVes = tableVisualElement.children[j];
        const tableChildVe = tableChildVes.get();
        const tableBlockHeightPx = tableChildVe.boundsPx.h;
        const posRelativeToTableChildAreaPx = vectorSubtract(
          posRelativeToRootVisualElementPx,
          { x: tableVisualElement.childAreaBoundsPx!.x, y: tableVisualElement.childAreaBoundsPx!.y - tableItem.scrollYProp.get() * tableBlockHeightPx }
        );
        if (isInside(posRelativeToTableChildAreaPx, tableChildVe.boundsPx)) {
          let hitboxType = HitboxType.None;
          for (let k=tableChildVe.hitboxes.length-1; k>=0; --k) {
            if (isInside(posRelativeToTableChildAreaPx, offsetBoundingBoxTopLeftBy(tableChildVe.hitboxes[k].boundsPx, getBoundingBoxTopLeft(tableChildVe.boundsPx)))) {
              hitboxType |= tableChildVe.hitboxes[k].type;
            }
          }
          if (!ignoreItems.find(a => a == tableChildVe.item.id)) {
            return finalize(hitboxType, tableChildVes);
          }
        }
      }
    }

    // handle inside any other item (including pages, which can't be clicked in).
    let hitboxType = HitboxType.None;
    for (let j=childVisualElement.hitboxes.length-1; j>=0; --j) {
      if (isInside(posRelativeToRootVisualElementPx, offsetBoundingBoxTopLeftBy(childVisualElement.hitboxes[j].boundsPx, getBoundingBoxTopLeft(childVisualElement.boundsPx)))) {
        hitboxType |= childVisualElement.hitboxes[j].type;
      }
    }
    if (!ignoreItems.find(a => a == childVisualElement.item.id)) {
      return finalize(hitboxType, rootVisualElement.children[i]);
    }
  }

  return finalize(HitboxType.None, rootVisualElementSignal);
}
