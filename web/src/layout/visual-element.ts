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

import { BoundingBox, vectorAdd, getBoundingBoxTopLeft } from "../util/geometry";
import { Hitbox } from "./hitbox";
import { Item, EMPTY_ITEM } from "../items/base/item";
import { BooleanSignal, NumberSignal, VisualElementSignal, createBooleanSignal, createNumberSignal } from "../util/signals";
import { LinkItem } from "../items/link-item";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { EMPTY_UID, Uid } from "../util/uid";
import { panic } from "../util/lang";
import { isTable } from "../items/table-item";


export type VisualElementPath = string;

export interface VisualElement {
  // The item to be visually depicted. If the VisualElement corresponds to a link item, "item" is the
  // linked-to item unless this is invalid or unknown, in which case "item" is the link item.
  item: Item,
  // If the visual element corresponds to a link item, a reference to that.
  linkItemMaybe: LinkItem | null,

  // If set, the element is currently being resized, and these were the original bounds.
  resizingFromBoundsPx: BoundingBox | null,

  isSelected: boolean,             // the item is selected.
  isLineItem: boolean,             // render as a line item (like in a table), not deskop item.
  isDetailed: boolean,             // the visual element has detail / can be interacted with.
  isPopup: boolean,                // the visual element is a popup (and thus also a page).
  isRoot: boolean                  // render as a root level page (popup, list page, top level page).
  isInsideTable: boolean,          // the visual element is inside a table.
  isAttachment: boolean,           // the visual element is an attachment.
  isDragOverPositioning: boolean,  // an item dragged over the container is positioned according to the mouse position (thus visual element is also always a page).

  // boundsPx and childAreaBoundsPx are relative to containing visual element's childAreaBoundsPx.
  boundsPx: BoundingBox,
  childAreaBoundsPx: BoundingBox | null,

  oneBlockWidthPx: number | null,  // for line items only.

  row: number | null,  // set only if inside table. the actual row number - i.e. not necessarily the visible row number.
  col: number | null,  // set only if inside table.

  // higher index => higher precedence.
  hitboxes: Array<Hitbox>,

  children: Array<VisualElementSignal>,
  attachments: Array<VisualElementSignal>,
  parent: VisualElementSignal | null,

  mouseIsOver: BooleanSignal,
  mouseIsOverOpenPopup: BooleanSignal,

  movingItemIsOver: BooleanSignal,            // for containers only.
  movingItemIsOverAttach: BooleanSignal,      // for attachment items only.
  moveOverRowNumber: NumberSignal,            // for tables only.
  moveOverColAttachmentNumber: NumberSignal,  // for tables only.
}

/**
 * Used when there is no top level visual element. This makes typing much easier to deal with
 * than using VisualElement | null
 */
export const NONE_VISUAL_ELEMENT: VisualElement = {
  item: EMPTY_ITEM,
  linkItemMaybe: null,
  resizingFromBoundsPx: null,
  isSelected: false,
  isLineItem: false,
  isDetailed: false,
  isPopup: false,
  isRoot: false,
  isInsideTable: false,
  isAttachment: false,
  isDragOverPositioning: false,
  boundsPx: { x: 0, y: 0, w: 0, h: 0 },
  childAreaBoundsPx: null,
  oneBlockWidthPx: null,
  col: null,
  row: null,
  hitboxes: [],
  children: [],
  attachments: [],
  parent: null,

  mouseIsOver: createBooleanSignal(false),
  mouseIsOverOpenPopup: createBooleanSignal(false),

  movingItemIsOver: createBooleanSignal(false),
  movingItemIsOverAttach: createBooleanSignal(false),
  moveOverRowNumber: createNumberSignal(-1),
  moveOverColAttachmentNumber: createNumberSignal(-1),
};

export interface VisualElementOverride {
  item: Item,
  linkItemMaybe?: LinkItem | null,
  isSelected?: boolean,
  isLineItem?: boolean,
  isPopup?: boolean,
  isRoot?: boolean,
  isDetailed?: boolean,
  isInsideTable?: boolean
  isAttachment?: boolean,
  isDragOverPositioning?: boolean,
  boundsPx: BoundingBox,
  childAreaBoundsPx?: BoundingBox,
  oneBlockWidthPx?: number,
  col?: number,
  row?: number,
  hitboxes?: Array<Hitbox>,
  parent?: VisualElementSignal,
  children?: Array<VisualElementSignal>,
  attachments?: Array<VisualElementSignal>,
}


export function createVisualElement(override: VisualElementOverride): VisualElement {
  let result: VisualElement = {
    item: EMPTY_ITEM,
    linkItemMaybe: null,
    resizingFromBoundsPx: null,
    isSelected: false,
    isLineItem: false,
    isDetailed: false,
    isPopup: false,
    isRoot: false,
    isInsideTable: false,
    isAttachment: false,
    isDragOverPositioning: false,
    boundsPx: { x: 0, y: 0, w: 0, h: 0 },
    childAreaBoundsPx: null,
    oneBlockWidthPx: null,
    col: null,
    row: null,
    hitboxes: [],
    children: [],
    attachments: [],
    parent: null,

    mouseIsOver: createBooleanSignal(false),
    mouseIsOverOpenPopup: createBooleanSignal(false),

    movingItemIsOver: createBooleanSignal(false),
    movingItemIsOverAttach: createBooleanSignal(false),
    moveOverRowNumber: createNumberSignal(-1),
    moveOverColAttachmentNumber: createNumberSignal(-1),
  };

  result.item = override.item;

  if (typeof(override.linkItemMaybe) != 'undefined') { result.linkItemMaybe = override.linkItemMaybe; }
  if (typeof(override.isPopup) != 'undefined') { result.isPopup = override.isPopup; }
  if (typeof(override.isRoot) != 'undefined') { result.isRoot = override.isRoot; }
  if (typeof(override.isSelected) != 'undefined') { result.isSelected = override.isSelected; }
  if (typeof(override.isLineItem) != 'undefined') { result.isLineItem = override.isLineItem; }
  if (typeof(override.isDetailed) != 'undefined') { result.isDetailed = override.isDetailed; }
  if (typeof(override.isInsideTable) != 'undefined') { result.isInsideTable = override.isInsideTable; }
  if (typeof(override.isAttachment) != 'undefined') { result.isAttachment = override.isAttachment; }
  if (typeof(override.isDragOverPositioning) != 'undefined') { result.isDragOverPositioning = override.isDragOverPositioning; }
  if (typeof(override.boundsPx) != 'undefined') { result.boundsPx = override.boundsPx; }
  if (typeof(override.childAreaBoundsPx) != 'undefined') { result.childAreaBoundsPx = override.childAreaBoundsPx; }
  if (typeof(override.oneBlockWidthPx) != 'undefined') { result.oneBlockWidthPx = override.oneBlockWidthPx; }
  if (typeof(override.col) != 'undefined') { result.col = override.col; }
  if (typeof(override.row) != 'undefined') { result.row = override.row; }
  if (typeof(override.hitboxes) != 'undefined') { result.hitboxes = override.hitboxes; }
  if (typeof(override.parent) != 'undefined') { result.parent = override.parent; }
  if (typeof(override.children) != 'undefined') { result.children = override.children; }
  if (typeof(override.attachments) != 'undefined') { result.attachments = override.attachments; }

  if (isTable(result.item) && result.isDetailed && result.childAreaBoundsPx == null) {
    console.error("A detailed table visual element was created without childAreaBoundsPx set.", result);
    console.trace();
  }
  // TODO (LOW): some additional sanity checking here would help catch arrange bugs.

  return result;
}


export function visualElementToPath(visualElement: VisualElement): VisualElementPath {
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

export function visualElementSignalFromPath(
    desktopStore: DesktopStoreContextModel,
    pathString: VisualElementPath): VisualElementSignal {
  const parts = pathString.split("-");
  let ves = desktopStore.topLevelVisualElementSignal();
  let { itemId } = getIdsFromPathPart(parts[parts.length-1]);
  if (ves.get().item.id != itemId) { panic(); }

  for (let i=parts.length-2; i>=0; --i) {
    let ve = ves.get();
    let { itemId, linkIdMaybe: linkId } = getIdsFromPathPart(parts[i]);
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
      console.error("invalid path string", pathString);
      panic!();
    }
  }

  return ves;
}

export function itemIdAndLinkIdMaybeFromVisualElementPath(pathString: VisualElementPath): { itemId: Uid, linkIdMaybe: Uid | null } {
  const parts = pathString.split("-");
  return getIdsFromPathPart(parts[0]);
}

export function itemIdFromVisualElementPath(pathString: VisualElementPath): Uid {
  const parts = pathString.split("-");
  let { itemId } = getIdsFromPathPart(parts[0]);
  return itemId;
}


function getIdsFromPathPart(part: string): { itemId: Uid, linkIdMaybe: Uid | null } {
  let itemId = part;
  let linkIdMaybe = null;
  if (part.length == EMPTY_UID.length * 2 + 2) {
    itemId = part.substring(0, EMPTY_UID.length);
    linkIdMaybe = part.substring(EMPTY_UID.length+1, part.length-1);
  } else if (part.length != EMPTY_UID.length) {
    panic();
  }
  return { itemId, linkIdMaybe };
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


export function printCurrentVisualElementTree(desktopStore: DesktopStoreContextModel) {
  printRecursive(desktopStore.topLevelVisualElement(), 0, "c");
}

function printRecursive(visualElement: VisualElement, level: number, relationship: string) {
  let indent = "";
  for (let i=0; i<level; ++i) { indent += "-"; }
  console.log(relationship + " " + indent + " [" + (visualElement.linkItemMaybe ? "link: " + visualElement.linkItemMaybe!.id : "") + "] {" + (visualElement.item ? "itemid: " + visualElement.item.id : "") + "}");
  for (let i=0; i<visualElement.children.length; ++i) {
    printRecursive(visualElement.children[i].get(), level + 1, "c");
  }
  for (let i=0; i<visualElement.attachments.length; ++i) {
    printRecursive(visualElement.attachments[i].get(), level + 1, "a");
  }
}
