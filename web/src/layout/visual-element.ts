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

import { BoundingBox, vectorAdd, getBoundingBoxTopLeft, Vector, Dimensions, cloneBoundingBox } from "../util/geometry";
import { Hitbox } from "./hitbox";
import { Item, EMPTY_ITEM } from "../items/base/item";
import { BooleanSignal, NumberSignal, VisualElementSignal, createBooleanSignal, createNumberSignal } from "../util/signals";
import { LinkItem, asLinkItem, isLink, LinkFns } from "../items/link-item";
import { StoreContextModel } from "../store/StoreProvider";
import { EMPTY_UID, Uid } from "../util/uid";
import { assert, panic } from "../util/lang";
import { asTableItem, isTable } from "../items/table-item";
import { VesCache } from "./ves-cache";
import { itemState } from "../store/ItemState";
import { RelationshipToParent } from "./relationship-to-parent";
import { GRID_SIZE, Z_INDEX_ITEMS, Z_INDEX_MOVING, Z_INDEX_POPUP } from "../constants";
import { isPage } from "../items/page-item";
import { PopupType } from "../store/StoreProvider_History";
import { ArrangeItemFlags } from "./arrange/item";


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
  None                    = 0x00000,
  Selected                = 0x00001, // The item is selected.
  HasToolbarFocus         = 0x00002, // The item has toolbar focus.
  LineItem                = 0x00004, // Render as a line item (like in a table), not deskop item.
  Detailed                = 0x00008, // The visual element has detail / can be interacted with.
  InsideTable             = 0x00010, // The visual element is inside a table.
  Attachment              = 0x00020, // The visual element is an attachment.
  ShowChildren            = 0x00040, // Children are visible and an item dragged over the container (page) is positioned according to the mouse position.
  Fixed                   = 0x00080, // positioning is fixed, not absolute.
  InsideCompositeOrDoc    = 0x00100, // The visual element is inside a composite item.
  ZAbove                  = 0x00200, // Render above everything else (except moving).
  Moving                  = 0x00400, // Render the visual element partially transparent and on top of everything else.
  IsDock                  = 0x00800, // render the page as the dock.
  IsTrash                 = 0x01000, // render the page as the trash icon.
  UmbrellaPage            = 0x02000, // the very top level page.
  Popup                   = 0x04000, // Is a popped up something (page or image or anything).
  TopLevelRoot            = 0x08000, // The top most page root element.
  ListPageRoot            = 0x10000, // Is the root item in a list page.
  EmbededInteractiveRoot  = 0x20000, // Is an embedded interactive page.
  DockItem                = 0x40000, // Is an item inside the dock.
}

export function veFlagIsRoot(flags: VisualElementFlags): boolean {
  return !!(flags & VisualElementFlags.TopLevelRoot |
            flags & VisualElementFlags.Popup |
            flags & VisualElementFlags.ListPageRoot |
            flags & VisualElementFlags.EmbededInteractiveRoot);
}

/**
 * Specifies a visual element, corresponding to a rendered item in the visual tree.
 */
export interface VisualElement {
  /**
   * The item to be visually depicted. If the VisualElement corresponds to a link item, 'displayItem' is the
   * linked-to item unless this is invalid or unknown, in which case 'item' is the link item itself.
   */
  displayItem: Item,

  /**
   * If the visual element corresponds to a link item, a reference to that. If the visual element is a popup
   * or selected item in a list page, this will be the popup or selection link item (not the actually selected
   * user link item, if there is one).
   */
  linkItemMaybe: LinkItem | null,

  /**
   * The actual link item (if there is one), never the popup or selected link.
   */
  actualLinkItemMaybe: LinkItem | null,

  /**
   * Various flags that indicate how the visual element should be rendered.
   */
  flags: VisualElementFlags,

  /**
   * The flags used during arrangement when creating the visual element. This gives context to allow for
   * easy rearrangement. TODO: it's a bit messy to have this here. Maybe the visual element flags and
   * arrangement flags would be better combined.
   */
  arrangeFlags: ArrangeItemFlags,

  /**
   * If set, the element is currently being resized, and these were the original bounds.
   */
  resizingFromBoundsPx: BoundingBox | null,

  /**
   * The complete bounds of the visual element, relative to the containing visual element's childAreaBoundsPx.
   */
  boundsPx: BoundingBox,

  /**
   * The (outer) bounds of the part of the visual element that contains child visual elements.
   */
  viewportBoundsPx: BoundingBox | null,

  /**
   * The (inner) bounds of the part of the visual element that contains child visual elements.
   * This may be larger than viewportBoundsPx, if the area scrolls.
   */
  childAreaBoundsPx: BoundingBox | null,

  /**
   * The bounds of the table the element is inside, if it's inside a table.
   */
  tableDimensionsPx: Dimensions | null,

  /**
   * The indentation of the row of the element (due to expansion of child containers), if it's inside a table.
   */
  indentBl: number | null,

  /**
   * Size of a 1x1 bl block in pixels. Not set in all cases.
   */
  blockSizePx: Dimensions | null,

  /**
   * Size of one grid cell. Set only in the case of grid pages.
   */
  cellSizePx: Dimensions | null,

  row: number | null,  // Set only if inside table. the actual row number - i.e. not necessarily the visible row number.
  col: number | null,  // Set only if inside table.

  /**
   * The number of grid rows. Set only in the case of grid pages.
   */
  numRows: number | null,

  hitboxes: Array<Hitbox>,  // higher index => higher precedence.

  parentPath: VisualElementPath | null,

  evaluatedTitle: string | null,

  /**
   * Anything from displayItem that would require a re-render if changed.
   * Manage this explicitly to avoid a costly comparison of all displayItem properties.
   */
  displayItemFingerprint: string,

  childrenVes: Array<VisualElementSignal>,
  attachmentsVes: Array<VisualElementSignal>,
  popupVes: VisualElementSignal | null,
  selectedVes: VisualElementSignal | null,
  dockVes: VisualElementSignal | null,

  /**
   * The table row number corresponding to the childrenVes with the same index.
   */
  tableVesRows: Array<number> | null,
}


/**
 * Sentinal value used when there is no top level visual element. This makes typing much easier to deal with
 * than using VisualElement | null
 */
export const NONE_VISUAL_ELEMENT: VisualElement = {
  displayItem: EMPTY_ITEM(),
  linkItemMaybe: null,
  actualLinkItemMaybe: null,
  flags: VisualElementFlags.None,
  arrangeFlags: ArrangeItemFlags.None,
  resizingFromBoundsPx: null,
  boundsPx: { x: 0, y: 0, w: 0, h: 0 },
  childAreaBoundsPx: null,
  tableDimensionsPx: null,
  indentBl: null,
  viewportBoundsPx: null,
  blockSizePx: null,
  col: null,
  row: null,
  cellSizePx: null,
  numRows: null,
  hitboxes: [],

  childrenVes: [],
  attachmentsVes: [],
  popupVes: null,
  selectedVes: null,
  dockVes: null,

  tableVesRows: null,

  parentPath: null,
  evaluatedTitle: null,

  displayItemFingerprint: "",
};


/**
 * Specification for a visual element to be created.
 */
export interface VisualElementSpec {
  displayItem: Item,
  displayItemFingerprint?: string,
  linkItemMaybe?: LinkItem | null,
  actualLinkItemMaybe?: LinkItem | null,
  flags?: VisualElementFlags,
  arrangeFlags?: ArrangeItemFlags,
  boundsPx: BoundingBox,
  childAreaBoundsPx?: BoundingBox,
  viewportBoundsPx?: BoundingBox,
  tableDimensionsPx?: Dimensions,
  indentBl?: number,
  blockSizePx?: Dimensions,
  col?: number,
  row?: number,
  cellSizePx?: Dimensions,
  numRows?: number,
  hitboxes?: Array<Hitbox>,
  parentPath?: VisualElementPath,

  childrenVes?: Array<VisualElementSignal>,
  tableVesRows?: Array<number>,
  attachmentsVes?: Array<VisualElementSignal>,
  popupVes?: VisualElementSignal | null,
  selectedVes?: VisualElementSignal | null,
  dockVes?: VisualElementSignal | null,
}


export const VeFns = {

  /**
   * Create a visual element from the provided spec.
   */
  create: (override: VisualElementSpec): VisualElement => {
    let result: VisualElement = {
      displayItem: EMPTY_ITEM(),
      linkItemMaybe: null,
      actualLinkItemMaybe: null,
      flags: VisualElementFlags.None,
      arrangeFlags: ArrangeItemFlags.None,
      resizingFromBoundsPx: null,
      boundsPx: { x: 0, y: 0, w: 0, h: 0 },
      childAreaBoundsPx: null,
      viewportBoundsPx: null,
      tableDimensionsPx: null,
      indentBl: null,
      blockSizePx: null,
      col: null,
      row: null,
      cellSizePx: null,
      numRows: null,
      hitboxes: [],
      childrenVes: [],
      attachmentsVes: [],
      popupVes: null,
      selectedVes: null,
      dockVes: null,
      tableVesRows: null,

      parentPath: null,
      evaluatedTitle: null,

      displayItemFingerprint: "",
    };

    overrideVeFields(result, override);

    return result;
  },

  /**
   * Sets all properties of the provided ve to the default, then overwrites with the
   * provided override. Retains the existing sub-signals - mouseIsOver etc.
   */
  clearAndOverwrite: (ve: VisualElement, override: VisualElementSpec) => {
    ve.displayItem = EMPTY_ITEM();
    ve.linkItemMaybe = null;
    ve.actualLinkItemMaybe = null;
    ve.flags = VisualElementFlags.None;
    ve.arrangeFlags = ArrangeItemFlags.None;
    ve.resizingFromBoundsPx = null;
    ve.boundsPx = { x: 0, y: 0, w: 0, h: 0 };
    ve.childAreaBoundsPx = null;
    ve.viewportBoundsPx = null;
    ve.tableDimensionsPx = null;
    ve.indentBl = null;
    ve.blockSizePx = null;
    ve.col = null;
    ve.row = null;
    ve.cellSizePx = null;
    ve.numRows = null;
    ve.hitboxes = [];
    ve.childrenVes = [];
    ve.attachmentsVes = [];
    ve.popupVes = null;
    ve.selectedVes = null;
    ve.dockVes = null;
    ve.tableVesRows = null;

    ve.parentPath = null;
    ve.evaluatedTitle = null;

    ve.displayItemFingerprint = "";

    overrideVeFields(ve, override);
    return ve;
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

  actualVeidFromVe: (visualElement: VisualElement): Veid => {
    return ({
      itemId: visualElement.displayItem.id,
      linkIdMaybe: visualElement.actualLinkItemMaybe == null ? null : visualElement.actualLinkItemMaybe.id
    });
  },

  canonicalItem: (visualElement: VisualElement): Item => {
    return visualElement.linkItemMaybe != null
      ? visualElement.linkItemMaybe!
      : visualElement.displayItem;
  },

  canonicalItemFromPath: (visualElementPath: VisualElementPath): Item | null => {
    const veid = VeFns.veidFromPath(visualElementPath);
    let item;
    if (veid.linkIdMaybe) {
      item = itemState.get(veid.linkIdMaybe);
    } else {
      item = itemState.get(veid.itemId);
    }
    return item;
  },

  canonicalItemFromVeid: (veid: Veid): Item | null => {
    let item;
    if (veid.linkIdMaybe) {
      item = itemState.get(veid.linkIdMaybe);
    } else {
      item = itemState.get(veid.itemId);
    }
    return item;
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

  pathDepth: (path: VisualElementPath): number => {
    let parts = path.split("-");
    return parts.length;
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

  actualVeidFromPath: (path: VisualElementPath): Veid => {
    const ves = VesCache.get(path)!;
    return VeFns.actualVeidFromVe(ves.get());
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

  veBoundsRelativeToDestkopPx: (store: StoreContextModel, visualElement: VisualElement): BoundingBox => {
    let ve: VisualElement | null = visualElement;
    if (ve.parentPath == null) {
      return cloneBoundingBox(ve.boundsPx)!;
    }

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
        r.y -= blockHeightPx * store.perItem.getTableScrollYPos(VeFns.veidFromVe(ve));
        // skip the item that is a child of the table - the attachment ve is relative to the table.
        // TODO (LOW): it would be better if the attachment were relative to the item, not the table.
        ve = VesCache.get(ve.parentPath!)!.get();
      }
    }

    ve = VesCache.get(ve.parentPath!)!.get();
    while (ve != null) {
      r = vectorAdd(r, getBoundingBoxTopLeft(ve.viewportBoundsPx ? ve.viewportBoundsPx : ve.boundsPx));
      if (isTable(ve.displayItem)) {
        const tableItem = asTableItem(ve.displayItem);
        const fullHeightBl = tableItem.spatialHeightGr / GRID_SIZE;
        const blockHeightPx = ve.boundsPx.h / fullHeightBl;
        r.y -= blockHeightPx * store.perItem.getTableScrollYPos(VeFns.veidFromVe(ve));
      } else if (isPage(ve.displayItem)) {
        let adjY = 0.0;
        let adjX = 0.0;
        if (ve.flags & VisualElementFlags.Popup) {
          const popupSpec = store.history.currentPopupSpec()!;
          assert(popupSpec.type == PopupType.Page, "veBoundsRelativeToDesktopPx: popup spec type not page.");
          adjY = (ve.childAreaBoundsPx!.h - ve.boundsPx.h) * store.perItem.getPageScrollYProp(popupSpec.actualVeid);
          adjX = (ve.childAreaBoundsPx!.w - ve.boundsPx.w) * store.perItem.getPageScrollXProp(popupSpec.actualVeid);
        } else {
          if (ve.flags & VisualElementFlags.ShowChildren) {
            adjY = (ve.childAreaBoundsPx!.h - ve.boundsPx.h) * store.perItem.getPageScrollYProp(VeFns.actualVeidFromVe(ve));
            adjX = (ve.childAreaBoundsPx!.w - ve.boundsPx.w) * store.perItem.getPageScrollXProp(VeFns.actualVeidFromVe(ve));
          }
        }
        r.x -= adjX;
        r.y -= adjY;
      }
      ve = ve.parentPath == null ? null : VesCache.get(ve.parentPath!)!.get();
    }

    return { x: r.x, y: r.y, w: visualElement.boundsPx.w, h: visualElement.boundsPx.h };
  },

  desktopPxToTopLevelPagePx: (store: StoreContextModel, desktopPosPx: Vector): Vector => {
    const ve = store.umbrellaVisualElement.get();
    const adjY = (ve.childAreaBoundsPx!.h - ve.boundsPx.h) * store.perItem.getPageScrollYProp(VeFns.veidFromVe(ve));
    const adjX = (ve.childAreaBoundsPx!.w - ve.boundsPx.w) * store.perItem.getPageScrollXProp(VeFns.veidFromVe(ve));
    return ({
      x: desktopPosPx.x + adjX,
      y: desktopPosPx.y + adjY
    });
  },

  printCurrentVisualElementTree: (store: StoreContextModel) => {
    printRecursive(store.umbrellaVisualElement.get(), 0, "c");
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
  for (let i=0; i<visualElement.childrenVes.length; ++i) {
    printRecursive(visualElement.childrenVes[i].get(), level + 1, "c");
  }
  for (let i=0; i<visualElement.attachmentsVes.length; ++i) {
    printRecursive(visualElement.attachmentsVes[i].get(), level + 1, "a");
  }
}


function overrideVeFields(result: VisualElement, override: VisualElementSpec) {
  result.displayItem = override.displayItem;

  if (typeof(override.linkItemMaybe) != 'undefined') { result.linkItemMaybe = override.linkItemMaybe; }
  if (typeof(override.actualLinkItemMaybe) != 'undefined') { result.actualLinkItemMaybe = override.actualLinkItemMaybe; }
  if (typeof(override.flags) != 'undefined') { result.flags = override.flags; }
  if (typeof(override.arrangeFlags) != 'undefined') { result.arrangeFlags = override.arrangeFlags; }
  if (typeof(override.boundsPx) != 'undefined') { result.boundsPx = override.boundsPx; }
  if (typeof(override.childAreaBoundsPx) != 'undefined') { result.childAreaBoundsPx = override.childAreaBoundsPx; }
  if (typeof(override.viewportBoundsPx) != 'undefined') { result.viewportBoundsPx = override.viewportBoundsPx; }
  if (typeof(override.tableDimensionsPx) != 'undefined') { result.tableDimensionsPx = override.tableDimensionsPx; }
  if (typeof(override.indentBl) != 'undefined') { result.indentBl = override.indentBl; }
  if (typeof(override.blockSizePx) != 'undefined') { result.blockSizePx = override.blockSizePx; }
  if (typeof(override.col) != 'undefined') { result.col = override.col; }
  if (typeof(override.row) != 'undefined') { result.row = override.row; }
  if (typeof(override.cellSizePx) != 'undefined') { result.cellSizePx = override.cellSizePx; }
  if (typeof(override.numRows) != 'undefined') { result.numRows = override.numRows; }
  if (typeof(override.hitboxes) != 'undefined') { result.hitboxes = override.hitboxes; }
  if (typeof(override.parentPath) != 'undefined') { result.parentPath = override.parentPath; }
  if (typeof(override.displayItemFingerprint) != 'undefined') { result.displayItemFingerprint = override.displayItemFingerprint; }
  if (typeof(override.childrenVes) != 'undefined') { result.childrenVes = override.childrenVes; }
  if (typeof(override.tableVesRows) != 'undefined') { result.tableVesRows = override.tableVesRows; }
  if (typeof(override.attachmentsVes) != 'undefined') { result.attachmentsVes = override.attachmentsVes; }
  if (typeof(override.popupVes) != 'undefined') { result.popupVes = override.popupVes; }
  if (typeof(override.selectedVes) != 'undefined') { result.selectedVes = override.selectedVes; }
  if (typeof(override.dockVes) != 'undefined') { result.dockVes = override.dockVes; }

  if (isTable(result.displayItem) && (result.flags & VisualElementFlags.Detailed) && result.childAreaBoundsPx == null) {
    console.error("A detailed table visual element was created without childAreaBoundsPx set.", result);
    console.trace();
  }
  // TODO (LOW): some additional sanity checking here would help catch arrange bugs.
}