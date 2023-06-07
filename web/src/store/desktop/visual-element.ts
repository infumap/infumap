/*
  Copyright (C) 2023 The Infumap Authors
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

import { BoundingBox, vectorAdd, getBoundingBoxTopLeft, cloneBoundingBox } from "../../util/geometry";
import { Hitbox } from "./hitbox";
import { Item, EMPTY_ITEM } from "./items/base/item";
import { BooleanSignal, NumberSignal, VisualElementSignal, createBooleanSignal, createNumberSignal } from "../../util/signals";
import { LinkItem } from "./items/link-item";
import { DesktopStoreContextModel } from "./DesktopStoreProvider";
import { EMPTY_UID, Uid } from "../../util/uid";
import { panic } from "../../util/lang";


export type VisualElementPath = string;

export interface VisualElement {
  item: Item,

  // If the VisualElement corresponds to a link item, "item" is the linked-to item, and
  // "linkItemMaybe" is the link item itself.
  linkItemMaybe: LinkItem | null,

  // If set, the element is currently being resized, and these were the original bounds.
  resizingFromBoundsPx: BoundingBox | null,

  isInteractive: boolean,          // the visual element can be interacted with.
  isPopup: boolean,                // the visual element is a popup (and thus also a page).
  isInsideTable: boolean,          // the visual element is inside a table.
  isAttachment: boolean,           // the visual element is an attachment.
  isDragOverPositioning: boolean,  // an item dragged over the container is positioned according to the mouse position (thus visual element is also always a page).

  // boundsPx and childAreaBoundsPx are relative to containing visual element's childAreaBoundsPx.
  boundsPx: BoundingBox,
  childAreaBoundsPx: BoundingBox | null,

  // higher index => higher precedence.
  hitboxes: Array<Hitbox>,

  children: Array<VisualElementSignal>,
  attachments: Array<VisualElementSignal>,
  parent: VisualElementSignal | null,

  mouseIsOver: BooleanSignal,

  movingItemIsOver: BooleanSignal,       // for containers only.
  movingItemIsOverAttach: BooleanSignal, // for attachment items only.
  moveOverRowNumber: NumberSignal,       // for tables only.
}


/**
 * Used when there is no top level visual element. This makes typing much easier to deal with
 * than using VisualElement | null
 */
export const NONE_VISUAL_ELEMENT: VisualElement = {
  item: EMPTY_ITEM,
  linkItemMaybe: null,
  resizingFromBoundsPx: null,
  isInteractive: false,
  isPopup: false,
  isInsideTable: false,
  isAttachment: false,
  isDragOverPositioning: false,
  boundsPx: { x: 0, y: 0, w: 0, h: 0 },
  childAreaBoundsPx: null,
  hitboxes: [],
  children: [],
  attachments: [],
  parent: null,

  mouseIsOver: createBooleanSignal(false),
  movingItemIsOver: createBooleanSignal(false),
  movingItemIsOverAttach: createBooleanSignal(false),
  moveOverRowNumber: createNumberSignal(-1),
};

export function createVisualElement(override: any): VisualElement {
  let result: any = {
    item: EMPTY_ITEM,
    linkItemMaybe: null,
    resizingFromBoundsPx: null,
    isInteractive: false,
    isPopup: false,
    isInsideTable: false,
    isAttachment: false,
    isDragOverPositioning: false,
    boundsPx: { x: 0, y: 0, w: 0, h: 0 },
    childAreaBoundsPx: null,
    hitboxes: [],
    children: [],
    attachments: [],
    parent: null,

    mouseIsOver: createBooleanSignal(false),
    movingItemIsOver: createBooleanSignal(false),
    movingItemIsOverAttach: createBooleanSignal(false),
    moveOverRowNumber: createNumberSignal(-1),
  };
  const allPropertyNames = Object.getOwnPropertyNames(result);
  const overridePropertyNames = Object.getOwnPropertyNames(override);
  overridePropertyNames.forEach(name => {
    if (!allPropertyNames.find(e => e == name)) { panic(); }
    result[name] = override[name];
  });
  return result;
}

export function visualElementToPathString(visualElement: VisualElement): VisualElementPath {
  function impl(visualElement: VisualElement, current: string): string {
    const ve = visualElement;
    if (current != "") { current += "-"; }
    current += ve.item.id;
    if (ve.linkItemMaybe != null) {
      current += "[" + ve.linkItemMaybe!.id + "]";
    }
    if (ve.parent == null) { return current; }
    return impl(ve.parent.get(), current);
  }

  return impl(visualElement, "");
}

export function visualElementSignalFromPathString(
    desktopStore: DesktopStoreContextModel, pathString: VisualElementPath): VisualElementSignal {
  const parts = pathString.split("-");
  let ves = { get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement };
  let { itemId } = getIds(parts[parts.length-1]);
  if (ves.get().item.id != itemId) { panic(); }

  for (let i=parts.length-2; i>=0; --i) {
    let ve = ves.get();
    let { itemId, linkId } = getIds(parts[i]);
    let done: boolean = false;
    for (let j=0; j<ve.children.length && !done; ++j) {
      if (ve.children[j].get().item.id == itemId &&
          (ve.children[j].get().linkItemMaybe == null ? null : ve.children[j].get().linkItemMaybe!.id) == linkId) {
        ves = ve.children[j];
        done = true;
      }
    }
    for (let j=0; j<ve.attachments.length && !done; ++j) {
      if (ve.attachments[j].get().item.id == itemId &&
          (ve.attachments[j].get().linkItemMaybe == null ? null : ve.attachments[j].get().linkItemMaybe!.id) == linkId) {
        ves = ve.attachments[j];
        done = true;
      }
    }
    if (!done) {
      panic!();
    }
  }

  return ves;
}

export function itemIdFromVisualElementPath(pathString: VisualElementPath): Uid {
  const parts = pathString.split("-");
  let { itemId } = getIds(parts[0]);
  return itemId;
}

function getIds(part: string): { itemId: Uid, linkId: Uid | null } {
  let itemId = part;
  let linkId = null;
  if (part.length == EMPTY_UID.length * 2 + 2) {
    itemId = part.substring(0, EMPTY_UID.length);
    linkId = part.substring(EMPTY_UID.length+1, part.length-1);
  } else if (part.length != EMPTY_UID.length) {
    panic();
  }
  return { itemId, linkId };
}

export function visualElementDesktopBoundsPx(visualElement: VisualElement): BoundingBox {
  let ve: VisualElement | null = visualElement;
  let r = { x: 0, y: 0 };
  while (ve != null) {
    r = vectorAdd(r, getBoundingBoxTopLeft(ve.boundsPx));
    ve = ve.parent == null ? null : ve.parent!.get();
  }
  return { x: r.x, y: r.y, w: visualElement.boundsPx.w, h: visualElement.boundsPx.h };
}
