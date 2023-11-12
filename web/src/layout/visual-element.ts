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

import { BoundingBox, vectorAdd, getBoundingBoxTopLeft, Vector } from "../util/geometry";
import { Hitbox } from "./hitbox";
import { Item, EMPTY_ITEM } from "../items/base/item";
import { BooleanSignal, NumberSignal, VisualElementSignal, createBooleanSignal, createNumberSignal } from "../util/signals";
import { LinkItem, asLinkItem, isLink, LinkFns } from "../items/link-item";
import { DesktopStoreContextModel, PopupType } from "../store/DesktopStoreProvider";
import { EMPTY_UID, Uid } from "../util/uid";
import { assert, panic } from "../util/lang";
import { asTableItem, isTable } from "../items/table-item";
import { VesCache } from "./ves-cache";
import { itemState } from "../store/ItemState";
import { RelationshipToParent } from "./relationship-to-parent";
import { GRID_SIZE, Z_INDEX_ITEMS, Z_INDEX_MOVING, Z_INDEX_POPUP } from "../constants";
import { isPage } from "../items/page-item";


/**
 * Uniquely identifies a visual element and it's hierarchical context as displayed.
 */
export type VisualElementPath = string;


/**
 * Uniquely identifies a visual element (without hierarchical context).
 */
export type Veid = {
  /**
   * The item to be visually depicted. If the VisualElement corresponds to a link item, itemId is the
   * linked-to item unless this is invalid or unknown, in which case itemId is the link item itself.
   */
  itemId: Uid,

  /**
   * If the visual element corresponds to a link item, a reference to that.
   */
  linkIdMaybe: Uid | null
}

export const EMPTY_VEID: Veid = {
  itemId: EMPTY_UID,
  linkIdMaybe: null
};


export enum VisualElementFlags {
  None                 = 0x0000,
  Selected             = 0x0001, // The item is selected.
  HasToolbarFocus      = 0x0002, // The item has toolbar focus.
  LineItem             = 0x0004, // Render as a line item (like in a table), not deskop item.
  Detailed             = 0x0008, // The visual element has detail / can be interacted with.
  Popup                = 0x0010, // The visual element is a popped up page or image.
  Root                 = 0x0020, // Render as a root level page (popup, list page, top level page).
  ListPageRootItem     = 0x0040, // Is the root item in a list page.
  InsideTable          = 0x0080, // The visual element is inside a table.
  Attachment           = 0x0100, // The visual element is an attachment.
  ShowChildren         = 0x0200, // Children are visible and an item dragged over the container (page) is positioned according to the mouse position.
  Fixed                = 0x0400, // positioning is fixed, not absolute.
  InsideComposite      = 0x0800, // The visual element is inside a composite item.
  ZAbove               = 0x1000, // Render above everything else (except moving).
  Moving               = 0x2000, // Render the visual element partially transparent and on top of everything else.
}

function visualElementFlagsToString(visualElementFlags: VisualElementFlags): string {
  let result = "";
  if (visualElementFlags & VisualElementFlags.Selected) { result += "Selected "; }
  if (visualElementFlags & VisualElementFlags.LineItem) { result += "LineItem "; }
  if (visualElementFlags & VisualElementFlags.Detailed) { result += "Detailed "; }
  if (visualElementFlags & VisualElementFlags.Popup) { result += "Popup "; }
  if (visualElementFlags & VisualElementFlags.Root) { result += "Root "; }
  if (visualElementFlags & VisualElementFlags.InsideTable) { result += "InsideTable "; }
  if (visualElementFlags & VisualElementFlags.Attachment) { result += "Attachment "; }
  if (visualElementFlags & VisualElementFlags.ShowChildren) { result += "ShowChildren "; }
  if (visualElementFlags & VisualElementFlags.Fixed) { result += "Fixed "; }
  if (visualElementFlags & VisualElementFlags.InsideComposite) { result += "InsideComposite "; }
  if (visualElementFlags & VisualElementFlags.ZAbove) { result += "ZAbove "; }
  if (visualElementFlags & VisualElementFlags.Moving) { result += "Moving "; }
  return result;
}


/**
 * Specifies a visual element, corresponding to a rendered item in the visual tree.
 */
export interface VisualElement {
  /**
   * The item to be visually depicted. If the VisualElement corresponds to a link item, 'item' is the
   * linked-to item unless this is invalid or unknown, in which case 'item' is the link item itself.
   */
  displayItem: Item,

  /**
   * If the visual element corresponds to a link item, a reference to that.
   */
  linkItemMaybe: LinkItem | null,

  /**
   * Various flags that indicate how the visual element should be rendered.
   */
  flags: VisualElementFlags,

  /**
   * If set, the element is currently being resized, and these were the original bounds.
   */
  resizingFromBoundsPx: BoundingBox | null,

  /**
   * The bounds of the visual element, relative to the containing visual element's childAreaBoundsPx.
   */
  boundsPx: BoundingBox,

  /**
   * The bounds of the part of the visual element that contains child visual elements.
   * This may be larger than boundsPx, if the area scrolls.
   */
  childAreaBoundsPx: BoundingBox | null,

  /**
   * The bounds of the title element (page items only).
   */
  titleBoundsPx: BoundingBox | null,

  /**
   * Size of a 1x1 bl block in pixels. Set for line items only.
   */
  oneBlockWidthPx: number | null,

  row: number | null,  // Set only if inside table. the actual row number - i.e. not necessarily the visible row number.
  col: number | null,  // Set only if inside table.

  hitboxes: Array<Hitbox>,  // higher index => higher precedence.

  parentPath: VisualElementPath | null,

  evaluatedTitle: string | null,

  /**
   * Anything from displayItem that would require a re-render if changed.
   * Manage this explicitly to avoid a costly comparison of all displayItem properties.
   */
  displayItemFingerprint: string,

  children: Array<VisualElementSignal>,
  attachments: Array<VisualElementSignal>,

  mouseIsOver: BooleanSignal,
  mouseIsOverOpenPopup: BooleanSignal,

  movingItemIsOver: BooleanSignal,                // for containers only.
  movingItemIsOverAttach: BooleanSignal,          // for attachment items only.
  movingItemIsOverAttachComposite: BooleanSignal, //
  moveOverRowNumber: NumberSignal,                // for tables only.
  moveOverColAttachmentNumber: NumberSignal,      // for tables only.
}


/**
 * Sentinal value used when there is no top level visual element. This makes typing much easier to deal with
 * than using VisualElement | null
 */
export const NONE_VISUAL_ELEMENT: VisualElement = {
  displayItem: EMPTY_ITEM(),
  linkItemMaybe: null,
  flags: VisualElementFlags.None,
  resizingFromBoundsPx: null,
  boundsPx: { x: 0, y: 0, w: 0, h: 0 },
  childAreaBoundsPx: null,
  oneBlockWidthPx: null,
  titleBoundsPx: null,
  col: null,
  row: null,
  hitboxes: [],
  children: [],
  attachments: [],
  parentPath: null,
  evaluatedTitle: null,

  displayItemFingerprint: "",

  mouseIsOver: createBooleanSignal(false),
  mouseIsOverOpenPopup: createBooleanSignal(false),

  movingItemIsOver: createBooleanSignal(false),
  movingItemIsOverAttach: createBooleanSignal(false),
  movingItemIsOverAttachComposite: createBooleanSignal(false),
  moveOverRowNumber: createNumberSignal(-1),
  moveOverColAttachmentNumber: createNumberSignal(-1),
};


/**
 * Specification for a visual element to be created.
 */
export interface VisualElementSpec {
  displayItem: Item,
  displayItemFingerprint?: string,
  linkItemMaybe?: LinkItem | null,
  flags?: VisualElementFlags,
  boundsPx: BoundingBox,
  childAreaBoundsPx?: BoundingBox,
  oneBlockWidthPx?: number,
  titleBoundsPx?: BoundingBox,
  col?: number,
  row?: number,
  hitboxes?: Array<Hitbox>,
  parentPath?: VisualElementPath,
  children?: Array<VisualElementSignal>,
  attachments?: Array<VisualElementSignal>,
}


export const VeFns = {

  /**
   * Create a visual element from the provided spec.
   */
  create: (override: VisualElementSpec): VisualElement => {
    let result: VisualElement = {
      displayItem: EMPTY_ITEM(),
      linkItemMaybe: null,
      flags: VisualElementFlags.None,
      resizingFromBoundsPx: null,
      boundsPx: { x: 0, y: 0, w: 0, h: 0 },
      childAreaBoundsPx: null,
      oneBlockWidthPx: null,
      titleBoundsPx: null,
      col: null,
      row: null,
      hitboxes: [],
      children: [],
      attachments: [],
      parentPath: null,
      evaluatedTitle: null,

      displayItemFingerprint: "",

      mouseIsOver: createBooleanSignal(false),
      mouseIsOverOpenPopup: createBooleanSignal(false),

      movingItemIsOver: createBooleanSignal(false),
      movingItemIsOverAttach: createBooleanSignal(false),
      movingItemIsOverAttachComposite: createBooleanSignal(false),
      moveOverRowNumber: createNumberSignal(-1),
      moveOverColAttachmentNumber: createNumberSignal(-1),
    };

    result.displayItem = override.displayItem;

    if (typeof(override.linkItemMaybe) != 'undefined') { result.linkItemMaybe = override.linkItemMaybe; }
    if (typeof(override.flags) != 'undefined') { result.flags = override.flags; }
    if (typeof(override.boundsPx) != 'undefined') { result.boundsPx = override.boundsPx; }
    if (typeof(override.childAreaBoundsPx) != 'undefined') { result.childAreaBoundsPx = override.childAreaBoundsPx; }
    if (typeof(override.titleBoundsPx) != 'undefined') { result.titleBoundsPx = override.titleBoundsPx; }
    if (typeof(override.oneBlockWidthPx) != 'undefined') { result.oneBlockWidthPx = override.oneBlockWidthPx; }
    if (typeof(override.col) != 'undefined') { result.col = override.col; }
    if (typeof(override.row) != 'undefined') { result.row = override.row; }
    if (typeof(override.hitboxes) != 'undefined') { result.hitboxes = override.hitboxes; }
    if (typeof(override.parentPath) != 'undefined') { result.parentPath = override.parentPath; }
    if (typeof(override.displayItemFingerprint) != 'undefined') { result.displayItemFingerprint = override.displayItemFingerprint; }
    if (typeof(override.children) != 'undefined') { result.children = override.children; }
    if (typeof(override.attachments) != 'undefined') { result.attachments = override.attachments; }

    if (isTable(result.displayItem) && (result.flags & VisualElementFlags.Detailed) && result.childAreaBoundsPx == null) {
      console.error("A detailed table visual element was created without childAreaBoundsPx set.", result);
      console.trace();
    }
    // TODO (LOW): some additional sanity checking here would help catch arrange bugs.

    return result;
  },

  veidFromItems: (item: Item, linkMaybe: LinkItem | null) => {
    return ({ itemId: item.id, linkIdMaybe: linkMaybe ? linkMaybe.id : null });
  },

  veidFromVe: (visualElement: VisualElement): Veid => {
    return ({
      itemId: visualElement.displayItem.id,
      linkIdMaybe: visualElement.linkItemMaybe == null ? null : visualElement.linkItemMaybe.id
    });
  },

  canonicalItem: (visualElement: VisualElement): Item => {
    return visualElement.linkItemMaybe != null
      ? visualElement.linkItemMaybe!
      : visualElement.displayItem;
  },

  addVeidToPath: (veid: Veid, path: VisualElementPath): VisualElementPath => {
    let current = veid.itemId;
    if (veid.linkIdMaybe != null) {
      current += "[" + veid.linkIdMaybe! + "]";
    }
    if (path != "") {
      current += "-";
    }
    current += path;
    return current;
  },

  /**
   * Create a string representing the hierarchical path of the visual element from the top level page.
   * The veid of the visual element is at the beginning of the string, that of the top level page at the end.
   */
  veToPath: (visualElement: VisualElement): VisualElementPath => {
    let current = visualElement.displayItem.id;
    if (visualElement.linkItemMaybe != null) {
      current += "[" + visualElement.linkItemMaybe!.id + "]";
    }

    if (visualElement.parentPath == null) {
      return current;
    }

    return current + "-" + visualElement.parentPath!;
  },

  parentPath: (path: VisualElementPath): VisualElementPath => {
    const pos = path.indexOf("-");
    if (pos == -1) { return ""; }
    return path.substring(pos + 1);
  },

  veidFromId: (id: Uid): Veid => {
    let item = itemState.get(id)!;
    if (isLink(item)) {
      const linkItem = asLinkItem(item);
      const linkToId = LinkFns.getLinkToId(linkItem);
      return ({ itemId: linkToId, linkIdMaybe: linkItem.id });
    }
    return ({ itemId: id, linkIdMaybe: null });
  },

  veidFromPath: (path: VisualElementPath): Veid => {
    if (path == "") { return EMPTY_VEID; }
    const parts = path.split("-");
    return getIdsFromPathPart(parts[0]);
  },

  itemIdFromPath: (path: VisualElementPath): Uid => {
    if (path == "") { return EMPTY_UID; }
    const parts = path.split("-");
    let { itemId } = getIdsFromPathPart(parts[0]);
    return itemId;
  },

  compareVeids: (a: Veid, b: Veid) => {
    if (a.itemId != b.itemId) { return 1; }
    if (a.linkIdMaybe != b.linkIdMaybe) { return 1; }
    return 0;
  },

  veBoundsRelativeToDestkopPx: (desktopStore: DesktopStoreContextModel, visualElement: VisualElement): BoundingBox => {
    let ve: VisualElement | null = visualElement;
    assert(ve.parentPath != null, "veBoundsRelativeToTopLevelPagePx: not expecting top level page.");

    let r = getBoundingBoxTopLeft(ve.boundsPx);

    // handle case of attachment in a table.
    const canonicalItem = VeFns.canonicalItem(ve);
    if (canonicalItem.relationshipToParent == RelationshipToParent.Attachment) {
      const veParent = VesCache.get(ve.parentPath!)!.get();
      const veParentParent = VesCache.get(veParent.parentPath!)!.get();
      if (isTable(veParentParent.displayItem)) {
        const tableItem = asTableItem(veParentParent.displayItem);
        const fullHeightBl = tableItem.spatialHeightGr / GRID_SIZE;
        const blockHeightPx = ve.boundsPx.h / fullHeightBl;
        r.y -= blockHeightPx * desktopStore.getTableScrollYPos(VeFns.veidFromVe(ve));
        // skip the item that is a child of the table - the attachment ve is relative to the table.
        // TODO (LOW): it would be better if the attachment were relative to the item, not the table.
        ve = VesCache.get(ve.parentPath!)!.get();
      }
    }

    ve = VesCache.get(ve.parentPath!)!.get();
    while (ve != null) {
      r = vectorAdd(r, getBoundingBoxTopLeft(ve.childAreaBoundsPx ? ve.childAreaBoundsPx : ve.boundsPx));
      if (isTable(ve.displayItem)) {
        const tableItem = asTableItem(ve.displayItem);
        const fullHeightBl = tableItem.spatialHeightGr / GRID_SIZE;
        const blockHeightPx = ve.boundsPx.h / fullHeightBl;
        r.y -= blockHeightPx * desktopStore.getTableScrollYPos(VeFns.veidFromVe(ve));
      } else if (isPage(ve.displayItem)) {
        let adjY = 0.0;
        let adjX = 0.0;
        if (ve.flags & VisualElementFlags.Popup) {
          const popupSpec = desktopStore.currentPopupSpec()!;
          assert(popupSpec.type == PopupType.Page, "veBoundsRelativeToDesktopPx: popup spec type not page.");
          adjY = (ve.childAreaBoundsPx!.h - ve.boundsPx.h) * desktopStore.getPageScrollYProp(VeFns.veidFromPath(popupSpec.vePath));
          adjX = (ve.childAreaBoundsPx!.w - ve.boundsPx.w) * desktopStore.getPageScrollXProp(VeFns.veidFromPath(popupSpec.vePath));
        } else {
          if (ve.flags & VisualElementFlags.ShowChildren) {
            adjY = (ve.childAreaBoundsPx!.h - ve.boundsPx.h) * desktopStore.getPageScrollYProp(VeFns.veidFromVe(ve));
            adjX = (ve.childAreaBoundsPx!.w - ve.boundsPx.w) * desktopStore.getPageScrollXProp(VeFns.veidFromVe(ve));
          }
        }
        r.x -= adjX;
        r.y -= adjY;
      }
      ve = ve.parentPath == null ? null : VesCache.get(ve.parentPath!)!.get();
    }

    return { x: r.x, y: r.y, w: visualElement.boundsPx.w, h: visualElement.boundsPx.h };
  },

  desktopPxToTopLevelPagePx: (desktopStore: DesktopStoreContextModel, desktopPosPx: Vector): Vector => {
    const ve = desktopStore.topLevelVisualElement.get();
    const adjY = (ve.childAreaBoundsPx!.h - ve.boundsPx.h) * desktopStore.getPageScrollYProp(VeFns.veidFromVe(ve));
    const adjX = (ve.childAreaBoundsPx!.w - ve.boundsPx.w) * desktopStore.getPageScrollXProp(VeFns.veidFromVe(ve));
    return ({
      x: desktopPosPx.x + adjX,
      y: desktopPosPx.y + adjY
    });
  },

  printCurrentVisualElementTree: (desktopStore: DesktopStoreContextModel) => {
    printRecursive(desktopStore.topLevelVisualElement.get(), 0, "c");
  },

  visualElementFlagsToString: (visualElementFlags: VisualElementFlags) => {
    return visualElementFlagsToString(visualElementFlags);
  },

  isInTable: (visualElement: VisualElement): boolean => {
    if (visualElement.parentPath == null) { return false; }
    const parent = VesCache.get(visualElement.parentPath)!.get();
    if (VeFns.canonicalItem(visualElement).relationshipToParent == RelationshipToParent.Child && isTable(parent.displayItem)) { return true; }
    if (VeFns.canonicalItem(visualElement).relationshipToParent != RelationshipToParent.Attachment) { return false; }
    const parentParent = VesCache.get(parent.parentPath!)!.get();
    return isTable(parentParent.displayItem);
  },

  zIndexStyle: (visualElement: VisualElement): string => {
    if (visualElement.flags & VisualElementFlags.Moving) { return ` z-index: ${Z_INDEX_MOVING};`; }
    if (visualElement.flags & VisualElementFlags.ZAbove) { return ` z-index: ${Z_INDEX_POPUP};`; }
    return ` z-index: ${Z_INDEX_ITEMS};`;
  },

  opacityStyle: (visualElement: VisualElement): string => {
    return visualElement.flags & VisualElementFlags.Moving ? " opacity: 0.3;" : "";
  },
}


function getIdsFromPathPart(part: string): Veid {
  let itemId = part;
  let linkIdMaybe = null;
  if (part.length == EMPTY_UID.length * 2 + 2) {
    itemId = part.substring(0, EMPTY_UID.length);
    linkIdMaybe = part.substring(EMPTY_UID.length+1, part.length-1);
  } else if (part.length != EMPTY_UID.length) {
    panic("getIdsFromPathPart: wrong uid length.");
  }
  return { itemId, linkIdMaybe };
}


function printRecursive(visualElement: VisualElement, level: number, relationship: string) {
  let indent = "";
  for (let i=0; i<level; ++i) { indent += "-"; }
  console.log(relationship + " " + indent + " [" + (visualElement.linkItemMaybe ? "link: " + visualElement.linkItemMaybe!.id : "") + "] {" + (visualElement.displayItem ? "itemid: " + visualElement.displayItem.id : "") + "}");
  for (let i=0; i<visualElement.children.length; ++i) {
    printRecursive(visualElement.children[i].get(), level + 1, "c");
  }
  for (let i=0; i<visualElement.attachments.length; ++i) {
    printRecursive(visualElement.attachments[i].get(), level + 1, "a");
  }
}
