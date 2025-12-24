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
import { Item, EMPTY_ITEM, ItemType } from "../items/base/item";
import { VisualElementSignal } from "../util/signals";
import { LinkItem, asLinkItem, isLink, LinkFns } from "../items/link-item";
import { StoreContextModel } from "../store/StoreProvider";
import { EMPTY_UID, UMBRELLA_PAGE_UID, Uid } from "../util/uid";
import { assert, panic } from "../util/lang";
import { asTableItem, isTable } from "../items/table-item";
import { VesCache } from "./ves-cache";
import { itemState } from "../store/ItemState";
import { RelationshipToParent } from "./relationship-to-parent";
import { GRID_SIZE, Z_INDEX_ABOVE_TRANSLUCENT, Z_INDEX_ITEMS, Z_INDEX_MOVING, Z_INDEX_POPUP } from "../constants";
import { isPage } from "../items/page-item";
import { ArrangeItemFlags } from "./arrange/item";
import { asTitledItem, isTitledItem } from "../items/base/titled-item";


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
  None = 0x000000,
  Selected = 0x000001, // The item is selected.
  HasToolbarFocus = 0x000002, // The item has toolbar focus.
  LineItem = 0x000004, // Render as a line item (like in a table), not desktop item.
  Detailed = 0x000008, // The visual element has detail / can be interacted with.
  InsideTable = 0x000010, // The visual element is inside a table.
  Attachment = 0x000020, // The visual element is an attachment.
  ShowChildren = 0x000040, // Children are visible and an item dragged over the container (page) is positioned according to the mouse position.
  Fixed = 0x000080, // positioning is fixed, not absolute.
  InsideCompositeOrDoc = 0x000100, // The visual element is inside a composite item.
  ZAbove = 0x000200, // Render above everything else (except moving).
  Moving = 0x000400, // Render the visual element partially transparent and on top of everything else.
  IsDock = 0x000800, // render the page as the dock.
  IsTrash = 0x001000, // render the page as the trash icon.
  UmbrellaPage = 0x002000, // the very top level page.
  Popup = 0x004000, // Is a popped up something (page or image or anything).
  TopLevelRoot = 0x008000, // The top most page root element.
  ListPageRoot = 0x010000, // Is the root item in a list page.
  EmbeddedInteractiveRoot = 0x020000, // Is an embedded interactive page.
  DockItem = 0x040000, // Is an item inside the dock.
  FocusPageSelected = 0x080000, // Line item is in focussed page and selected.
  FlipCardPage = 0x100000, // A flipcard page.
  FindHighlighted = 0x200000, // The item is highlighted by find-on-page.
  SelectionHighlighted = 0x400000, // Highlighted by selection marquee.
}

export function veFlagIsRoot(flags: VisualElementFlags): boolean {
  return !!(flags & VisualElementFlags.TopLevelRoot |
    flags & VisualElementFlags.Popup |
    flags & VisualElementFlags.ListPageRoot |
    flags & VisualElementFlags.IsDock |
    flags & VisualElementFlags.EmbeddedInteractiveRoot);
}

/**
 * Returns true if the visual element is a translucent page.
 * TODO (low): this is overly complex. should review VisualElementFlags, can surely be simplified.
 */
export function isVeTranslucentPage(ve: VisualElement): boolean {
  if (!isPage(ve.displayItem)) {
    return false;
  }

  const flags = ve.flags;
  // Check if it's any of the specific page types that are NOT translucent
  if (
    flags & VisualElementFlags.UmbrellaPage ||
    flags & VisualElementFlags.FlipCardPage ||
    flags & VisualElementFlags.IsDock ||
    flags & VisualElementFlags.IsTrash ||
    flags & VisualElementFlags.Popup ||
    flags & VisualElementFlags.TopLevelRoot ||
    flags & VisualElementFlags.ListPageRoot ||
    flags & VisualElementFlags.EmbeddedInteractiveRoot
  ) {
    return false;
  }

  // Check the condition for Page_Opaque: if this is true, it's Opaque, otherwise potentially Translucent
  // Page_Opaque is rendered if: !(flags & VisualElementFlags.Detailed) || !(flags & VisualElementFlags.ShowChildren)
  // So, for it to be translucent, the opposite (Detailed AND ShowChildren) must be true.
  const isOpaqueCondition = !(flags & VisualElementFlags.Detailed) || !(flags & VisualElementFlags.ShowChildren);
  if (isOpaqueCondition) {
    return false;
  }

  // If none of the above specific types and not opaque, it's considered translucent by default in Page.tsx
  return true;
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
   * The (outer) bounds of the part of the list page visual element that contains list item visual elements.
   */
  listViewportBoundsPx: BoundingBox | null,

  /**
   * The (inner) bounds of the part of the list page visual element that contains list items.
   * This may be larger than listViewportBoundsPx, if the area scrolls.
   */
  listChildAreaBoundsPx: BoundingBox | null,

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



  // attachmentsVes: Array<VisualElementSignal>, // moved to VesCache
  // popupVes is moved to VesCache
  // selectedVes is moved to VesCache
  // dockVes: VisualElementSignal | null, // moved to VesCache

  // childrenVes is moved to VesCache
  // tableVesRows is moved to VesCache
  // focusedChildItemMaybe is moved to VesCache


  /**
   * The flags that were used during arrangement when creating the visual element. This gives
   * the required context for partial rearrangements. TODO (LOW): track this in a separate hash
   * map to keep out of this interface.
   */
  _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags,
}


/**
 * Sentinel value used when there is no top level visual element. This makes typing much easier to deal with
 * than using VisualElement | null
 */
export const NONE_VISUAL_ELEMENT: VisualElement = {
  displayItem: EMPTY_ITEM(),
  linkItemMaybe: null,
  actualLinkItemMaybe: null,
  flags: VisualElementFlags.None,
  _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
  resizingFromBoundsPx: null,
  boundsPx: { x: 0, y: 0, w: 0, h: 0 },
  childAreaBoundsPx: null,
  tableDimensionsPx: null,
  indentBl: null,
  viewportBoundsPx: null,
  listChildAreaBoundsPx: null,
  listViewportBoundsPx: null,
  blockSizePx: null,
  col: null,
  row: null,
  cellSizePx: null,
  numRows: null,
  hitboxes: [],


  // attachmentsVes: [], // moved to VesCache
  // dockVes: null, // moved to VesCache



  parentPath: null,
  evaluatedTitle: null,

  displayItemFingerprint: "",
};


/**
 * Specification for a visual element to be created.
 * 
 * This interface contains only fields that are stored directly on the VisualElement object.
 * For relationship/hierarchy data (children, attachments, popups, etc.), see VisualElementRelationships.
 */
export interface VisualElementSpec {
  displayItem: Item,
  displayItemFingerprint?: string,
  linkItemMaybe?: LinkItem | null,
  actualLinkItemMaybe?: LinkItem | null,
  flags?: VisualElementFlags,
  _arrangeFlags_useForPartialRearrangeOnly?: ArrangeItemFlags,
  boundsPx: BoundingBox,
  childAreaBoundsPx?: BoundingBox,
  viewportBoundsPx?: BoundingBox,
  listChildAreaBoundsPx?: BoundingBox,
  listViewportBoundsPx?: BoundingBox,
  tableDimensionsPx?: Dimensions,
  indentBl?: number,
  blockSizePx?: Dimensions,
  col?: number,
  row?: number,
  cellSizePx?: Dimensions,
  numRows?: number,
  hitboxes?: Array<Hitbox>,
  parentPath?: VisualElementPath,
}

/**
 * Specification for a visual element's relationships (children, attachments, popups, etc.).
 * 
 * These fields are managed by VesCache, not stored directly on the VisualElement object.
 * This separation clarifies that VisualElement contains the element's own properties,
 * while VesCache manages the hierarchical relationships between elements.
 */
export interface VisualElementRelationships {
  childrenVes?: Array<VisualElementSignal>,
  tableVesRows?: Array<number>,
  attachmentsVes?: Array<VisualElementSignal>,
  popupVes?: VisualElementSignal | null,
  selectedVes?: VisualElementSignal | null,
  dockVes?: VisualElementSignal | null,
  focusedChildItemMaybe?: Item | null,
}

/**
 * Combined type for creating visual elements.
 * 
 * This type combines VisualElementSpec (properties stored on VisualElement) with
 * VisualElementRelationships (properties managed by VesCache). The separation into
 * two interfaces documents the conceptual difference:
 * - VisualElementSpec: The element's own properties (geometry, flags, etc.)
 * - VisualElementRelationships: Hierarchical relationships (children, attachments, etc.)
 * 
 * VesCache functions accept this combined type for convenience during arrangement.
 */
export type VisualElementCreateParams = VisualElementSpec & VisualElementRelationships;

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
      _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
      resizingFromBoundsPx: null,
      boundsPx: { x: 0, y: 0, w: 0, h: 0 },
      childAreaBoundsPx: null,
      viewportBoundsPx: null,
      tableDimensionsPx: null,
      listChildAreaBoundsPx: null,
      listViewportBoundsPx: null,
      indentBl: null,
      blockSizePx: null,
      col: null,
      row: null,
      cellSizePx: null,
      numRows: null,
      hitboxes: [],
      // childrenVes: [],
      // attachmentsVes: [], // moved to VesCache
      // selectedVes: null, // moved to VesCache
      // dockVes: null, // moved to VesCache
      // tableVesRows: null,

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
    ve._arrangeFlags_useForPartialRearrangeOnly = ArrangeItemFlags.None;
    ve.resizingFromBoundsPx = null;
    ve.boundsPx = { x: 0, y: 0, w: 0, h: 0 };
    ve.childAreaBoundsPx = null;
    ve.viewportBoundsPx = null;
    ve.listChildAreaBoundsPx = null;
    ve.listViewportBoundsPx = null;
    ve.tableDimensionsPx = null;
    ve.indentBl = null;
    ve.blockSizePx = null;
    ve.col = null;
    ve.row = null;
    ve.cellSizePx = null;
    ve.numRows = null;
    ve.hitboxes = [];
    // ve.childrenVes = [];
    // ve.tableVesRows = null;

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

  /**
   * Tree item is the link item if it exists, otherwise the item itself.
   * @param visualElement - the visual element to get the tree item from.
   * @returns the tree item.
   */
  treeItem: (visualElement: VisualElement): Item => {
    return visualElement.linkItemMaybe != null
      ? visualElement.linkItemMaybe!
      : visualElement.displayItem;
  },

  /**
   * Tree item is the link item if it exists, otherwise the item itself.
   * @param visualElementPath - the path to get the tree item from.
   * @returns the tree item.
   */
  treeItemFromPath: (visualElementPath: VisualElementPath): Item | null => {
    const veid = VeFns.veidFromPath(visualElementPath);
    let item;
    if (veid.linkIdMaybe) {
      item = itemState.get(veid.linkIdMaybe);
    } else {
      item = itemState.get(veid.itemId);
    }
    return item;
  },

  /**
   * Tree item is the link item if it exists, otherwise the item itself.
   * @param veid - the veid to get the tree item from.
   * @returns the tree item.
   */
  treeItemFromVeid: (veid: Veid): Item | null => {
    let item;
    if (veid.linkIdMaybe) {
      item = itemState.get(veid.linkIdMaybe);
    } else {
      item = itemState.get(veid.itemId);
    }
    return item;
  },

  addVeidToPath: (veid: Veid, path: VisualElementPath): VisualElementPath => {

    if (!veid.itemId || veid.itemId === "") {
      console.error("MALFORMED PATH CREATION: addVeidToPath called with empty itemId");
      console.error("  veid:", veid);
      console.error("  path:", path);
      console.error("  Stack trace:");
      console.trace();
      panic(`addVeidToPath: veid.itemId is empty or null. This will create a malformed path.`);
    }

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

    if (!current || current === "") {
      console.error("MALFORMED PATH CREATION: veToPath called with empty displayItem.id");
      console.error("  visualElement:", visualElement);
      console.error("  Stack trace:");
      console.trace();
      panic(`veToPath: visualElement.displayItem.id is empty. This will create a malformed path.`);
    }

    if (visualElement.linkItemMaybe != null) {
      current += "[" + visualElement.linkItemMaybe!.id + "]";
    }

    if (visualElement.parentPath == null) {
      return current;
    }

    const result = current + "-" + visualElement.parentPath!;

    if (result.startsWith("-") || result.includes("--") || result.includes("-[")) {
      console.error("MALFORMED PATH CREATION: veToPath created malformed path");
      console.error("  result:", result);
      console.error("  from visualElement:", visualElement);
      console.error("  Stack trace:");
      console.trace();
    }

    return result;
  },

  computeFocusPathRelativeToRoot: (visualElement: VisualElement, rootVeid: Veid): VisualElementPath => {
    let currVe: VisualElement | null = visualElement;
    const hierarchy: Veid[] = [];
    while (currVe != null) {
      // Use actualVeidFromVe for root comparison (matches how rootVeid is computed)
      const actualCurrVeid = VeFns.actualVeidFromVe(currVe);
      const isRoot = actualCurrVeid.itemId === rootVeid.itemId && actualCurrVeid.linkIdMaybe === rootVeid.linkIdMaybe;

      // For the root element, use actualVeidFromVe since it will become the main page
      // without synthetic links. For nested elements, use veidFromVe to include
      // synthetic links (like LIST_PAGE_MAIN_ITEM_LINK_ITEM) that match VesCache paths.
      const currVeid = isRoot ? actualCurrVeid : VeFns.veidFromVe(currVe);
      hierarchy.push(currVeid);

      if (isRoot) {
        break;
      }
      currVe = currVe.parentPath ? (VesCache.get(currVe.parentPath)?.get() ?? null) : null;
    }

    let focusPath = UMBRELLA_PAGE_UID;
    for (let i = hierarchy.length - 1; i >= 0; i--) {
      focusPath = VeFns.addVeidToPath(hierarchy[i], focusPath);
    }
    return focusPath;
  },

  parentPath: (path: VisualElementPath): VisualElementPath => {
    const pos = path.indexOf("-");
    if (pos == -1) {
      return "";
    }

    const result = path.substring(pos + 1);

    if (result.startsWith("-") || result.includes("--")) {
      console.error("MALFORMED PATH CREATION: parentPath returning malformed path");
      console.error("  result:", result);
      console.error("  from input:", path);
      console.error("  Stack trace:");
      console.trace();
    }

    return result;
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

  veBoundsRelativeToDesktopPx: (store: StoreContextModel, visualElement: VisualElement): BoundingBox => {
    const resolveParentVe = (path: VisualElementPath | null): VisualElement | null => {
      if (!path) { return null; }
      const ves = VesCache.get(path);
      if (!ves) {
        console.warn("veBoundsRelativeToDesktopPx: parent path missing from VesCache", {
          parentPath: path,
          childId: visualElement.displayItem.id
        });
        return null;
      }
      return ves.get();
    };
    const fallbackBounds = (veForSize: VisualElement = visualElement) => {
      if (isPage(visualElement.displayItem) && visualElement.viewportBoundsPx && visualElement.childAreaBoundsPx) {
        const popupTitleHeightMaybePx = visualElement.boundsPx.h - visualElement.viewportBoundsPx.h;
        return {
          x: r.x,
          y: r.y + popupTitleHeightMaybePx,
          w: visualElement.childAreaBoundsPx.w,
          h: visualElement.childAreaBoundsPx.h
        };
      }
      return { x: r.x, y: r.y, w: veForSize.boundsPx.w, h: veForSize.boundsPx.h };
    };

    let ve: VisualElement | null = visualElement;
    if (ve.parentPath == null) {
      return cloneBoundingBox(ve.boundsPx)!;
    }

    let r = getBoundingBoxTopLeft(ve.boundsPx);

    // handle case of attachment in a table.
    const treeItem = VeFns.treeItem(ve);
    if (treeItem.relationshipToParent == RelationshipToParent.Attachment) {
      const veParent = resolveParentVe(ve.parentPath!);
      if (!veParent) { return fallbackBounds(ve); }
      const veParentParent = resolveParentVe(veParent.parentPath!);
      if (!veParentParent) { return fallbackBounds(veParent); }
      if (isTable(veParentParent.displayItem)) {
        const tableItem = asTableItem(veParentParent.displayItem);
        const fullHeightBl = tableItem.spatialHeightGr / GRID_SIZE;
        const blockHeightPx = ve.boundsPx.h / fullHeightBl;
        r.y -= blockHeightPx * store.perItem.getTableScrollYPos(VeFns.veidFromVe(ve));
        // skip the item that is a child of the table - the attachment ve is relative to the table.
        // TODO (LOW): it would be better if the attachment were relative to the item, not the table.
        ve = veParent;
      }
    }

    ve = resolveParentVe(ve.parentPath!);
    if (!ve) { return fallbackBounds(); }
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
          assert(itemState.get(popupSpec.actualVeid.itemId)!.itemType == ItemType.Page, "veBoundsRelativeToDesktopPx: popup spec type not page.");
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
      ve = ve.parentPath == null ? null : resolveParentVe(ve.parentPath!);
      if (ve === null) { break; }
    }

    if (isPage(visualElement.displayItem) && visualElement.viewportBoundsPx) {
      const adjY = (visualElement.childAreaBoundsPx!.h - visualElement.viewportBoundsPx.h) * store.perItem.getPageScrollYProp(VeFns.veidFromVe(visualElement));
      const adjX = (visualElement.childAreaBoundsPx!.w - visualElement.viewportBoundsPx.w) * store.perItem.getPageScrollXProp(VeFns.veidFromVe(visualElement));
      const popupTitleHeightMaybePx = visualElement.boundsPx.h - visualElement.viewportBoundsPx!.h;
      return {
        x: r.x + adjX,
        y: r.y + popupTitleHeightMaybePx + adjY,
        w: visualElement.childAreaBoundsPx!.w,
        h: visualElement.childAreaBoundsPx!.h
      };
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
    if (VeFns.treeItem(visualElement).relationshipToParent == RelationshipToParent.Child && isTable(parent.displayItem)) { return true; }
    if (VeFns.treeItem(visualElement).relationshipToParent != RelationshipToParent.Attachment) { return false; }
    const parentParent = VesCache.get(parent.parentPath!)!.get();
    return isTable(parentParent.displayItem);
  },

  zIndexStyle: (visualElement: VisualElement): string => {
    if (visualElement.flags & VisualElementFlags.Moving) {
      return ` z-index: ${Z_INDEX_MOVING};`;
    }

    if (visualElement.flags & VisualElementFlags.ZAbove || visualElement.flags & VisualElementFlags.Popup) {
      return ` z-index: ${Z_INDEX_POPUP};`;
    }

    if (isPage(visualElement.displayItem) || isTable(visualElement.displayItem)) {
      return ` z-index: ${Z_INDEX_ITEMS};`;
    }

    return ` z-index: ${Z_INDEX_ABOVE_TRANSLUCENT};`;
  },

  opacityStyle: (visualElement: VisualElement): string => {
    return visualElement.flags & VisualElementFlags.Moving ? " opacity: 0.3;" : "";
  },

  /**
   * Like veBoundsRelativeToDesktopPx, but for pages returns the on-screen viewport rectangle
   * rather than the full childArea size. This is useful for interactions that should be
   * clipped to what is visibly covered by the page (e.g., marquee selection intersection).
   */
  veViewportBoundsRelativeToDesktopPx: (store: StoreContextModel, visualElement: VisualElement): BoundingBox => {
    const resolveParentVe = (path: VisualElementPath | null): VisualElement | null => {
      if (!path) { return null; }
      const ves = VesCache.get(path);
      if (!ves) {
        console.warn("veViewportBoundsRelativeToDesktopPx: parent path missing from VesCache", {
          parentPath: path,
          childId: visualElement.displayItem.id
        });
        return null;
      }
      return ves.get();
    };
    const fallbackBounds = (veForSize: VisualElement = visualElement) => {
      if (isPage(visualElement.displayItem) && visualElement.viewportBoundsPx) {
        const popupTitleHeightMaybePx = visualElement.boundsPx.h - visualElement.viewportBoundsPx.h;
        return {
          x: r.x,
          y: r.y + popupTitleHeightMaybePx,
          w: visualElement.viewportBoundsPx.w,
          h: visualElement.viewportBoundsPx.h,
        };
      }
      return { x: r.x, y: r.y, w: veForSize.boundsPx.w, h: veForSize.boundsPx.h };
    };

    let ve: VisualElement | null = visualElement;
    if (ve.parentPath == null) {
      if (isPage(ve.displayItem) && ve.viewportBoundsPx) {
        const popupTitleHeightMaybePx = ve.boundsPx.h - ve.viewportBoundsPx.h;
        return {
          x: ve.boundsPx.x,
          y: ve.boundsPx.y + popupTitleHeightMaybePx,
          w: ve.viewportBoundsPx.w,
          h: ve.viewportBoundsPx.h,
        };
      }
      return cloneBoundingBox(ve.boundsPx)!;
    }

    let r = getBoundingBoxTopLeft(ve.boundsPx);

    // handle case of attachment in a table.
    const treeItem = VeFns.treeItem(ve);
    if (treeItem.relationshipToParent == RelationshipToParent.Attachment) {
      const veParent = resolveParentVe(ve.parentPath!);
      if (!veParent) { return fallbackBounds(ve); }
      const veParentParent = resolveParentVe(veParent.parentPath!);
      if (!veParentParent) { return fallbackBounds(veParent); }
      if (isTable(veParentParent.displayItem)) {
        const tableItem = asTableItem(veParentParent.displayItem);
        const fullHeightBl = tableItem.spatialHeightGr / GRID_SIZE;
        const blockHeightPx = ve.boundsPx.h / fullHeightBl;
        r.y -= blockHeightPx * store.perItem.getTableScrollYPos(VeFns.veidFromVe(ve));
        // skip the item that is a child of the table - the attachment ve is relative to the table.
        // TODO (LOW): it would be better if the attachment were relative to the item, not the table.
        ve = veParent;
      }
    }

    ve = resolveParentVe(ve.parentPath!);
    if (!ve) { return fallbackBounds(); }
    while (ve != null) {
      r = vectorAdd(r, getBoundingBoxTopLeft(ve.viewportBoundsPx ? ve.viewportBoundsPx : ve.boundsPx));
      if (isTable(ve.displayItem)) {
        const tableItem = asTableItem(ve.displayItem);
        const fullHeightBl = tableItem.spatialHeightGr / GRID_SIZE;
        const blockHeightPx = visualElement.boundsPx.h / fullHeightBl;
        r.y -= blockHeightPx * store.perItem.getTableScrollYPos(VeFns.veidFromVe(ve));
      } else if (isPage(ve.displayItem)) {
        let adjY = 0.0;
        let adjX = 0.0;
        if (ve.flags & VisualElementFlags.Popup) {
          const popupSpec = store.history.currentPopupSpec()!;
          assert(itemState.get(popupSpec.actualVeid.itemId)!.itemType == ItemType.Page, "veViewportBoundsRelativeToDesktopPx: popup spec type not page.");
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
      ve = ve.parentPath == null ? null : resolveParentVe(ve.parentPath!);
      if (ve === null) { break; }
    }

    if (isPage(visualElement.displayItem) && visualElement.viewportBoundsPx) {
      const popupTitleHeightMaybePx = visualElement.boundsPx.h - visualElement.viewportBoundsPx!.h;
      return {
        x: r.x,
        y: r.y + popupTitleHeightMaybePx,
        w: visualElement.viewportBoundsPx!.w,
        h: visualElement.viewportBoundsPx!.h,
      };
    }

    return { x: r.x, y: r.y, w: visualElement.boundsPx.w, h: visualElement.boundsPx.h };
  },

  toDebugString: (ve: VisualElement): string => {
    let result = "";
    if (isTitledItem(ve.displayItem)) {
      result += "'" + asTitledItem(ve.displayItem).title + "' (" + ve.displayItem.id + ")  ";
    } else {
      result += "[N/A] (" + ve.displayItem.id + ")  ";
    }
    result += `[x: ${ve.boundsPx.x}, y: ${ve.boundsPx.y}, w: ${ve.boundsPx.w}, h: ${ve.boundsPx.h}]`;
    result += ` parent: ${ve.parentPath}`;
    return result;
  },

  validatePath: (path: VisualElementPath): void => {
    if (!path || path === "") { return; }

    try {
      const parts = path.split("-");
      for (const part of parts) {
        if (part.length !== 32 && part.length !== 66) {
          panic(`validatePath: Invalid path segment length ${part.length} in path "${path}"`);
        }
      }
    } catch (e) {
      console.error(e);
      panic(`validatePath: Error validating path "${path}"`);
    }
  },
}


function getIdsFromPathPart(part: string): Veid {
  let itemId = part;
  let linkIdMaybe = null;
  if (part.length == EMPTY_UID.length * 2 + 2) {
    itemId = part.substring(0, EMPTY_UID.length);
    linkIdMaybe = part.substring(EMPTY_UID.length + 1, part.length - 1);
  } else if (part.length != EMPTY_UID.length) {
    panic(`getIdsFromPathPart: wrong uid length. Expected ${EMPTY_UID.length} or ${EMPTY_UID.length * 2 + 2}, got ${part.length} for part: "${part}"`);
  }
  return { itemId, linkIdMaybe };
}


function printRecursive(visualElement: VisualElement, level: number, relationship: string) {
  let indent = "";
  for (let i = 0; i < level; ++i) { indent += "-"; }
  console.debug(relationship + " " + indent + " [" + (visualElement.linkItemMaybe ? "link: " + visualElement.linkItemMaybe!.id : "") + "] {" + (visualElement.displayItem ? "itemid: " + visualElement.displayItem.id : "") + "}");


}


function overrideVeFields(result: VisualElement, override: VisualElementSpec) {
  result.displayItem = override.displayItem;

  if (typeof (override.linkItemMaybe) != 'undefined') { result.linkItemMaybe = override.linkItemMaybe; }
  if (typeof (override.actualLinkItemMaybe) != 'undefined') { result.actualLinkItemMaybe = override.actualLinkItemMaybe; }
  if (typeof (override.flags) != 'undefined') { result.flags = override.flags; }
  if (typeof (override._arrangeFlags_useForPartialRearrangeOnly) != 'undefined') { result._arrangeFlags_useForPartialRearrangeOnly = override._arrangeFlags_useForPartialRearrangeOnly; }
  if (typeof (override.boundsPx) != 'undefined') { result.boundsPx = override.boundsPx; }
  if (typeof (override.childAreaBoundsPx) != 'undefined') { result.childAreaBoundsPx = override.childAreaBoundsPx; }
  if (typeof (override.viewportBoundsPx) != 'undefined') { result.viewportBoundsPx = override.viewportBoundsPx; }
  if (typeof (override.listChildAreaBoundsPx) != 'undefined') { result.listChildAreaBoundsPx = override.listChildAreaBoundsPx; }
  if (typeof (override.listViewportBoundsPx) != 'undefined') { result.listViewportBoundsPx = override.listViewportBoundsPx; }
  if (typeof (override.tableDimensionsPx) != 'undefined') { result.tableDimensionsPx = override.tableDimensionsPx; }
  if (typeof (override.indentBl) != 'undefined') { result.indentBl = override.indentBl; }
  if (typeof (override.blockSizePx) != 'undefined') { result.blockSizePx = override.blockSizePx; }
  if (typeof (override.col) != 'undefined') { result.col = override.col; }
  if (typeof (override.row) != 'undefined') { result.row = override.row; }
  if (typeof (override.cellSizePx) != 'undefined') { result.cellSizePx = override.cellSizePx; }
  if (typeof (override.numRows) != 'undefined') { result.numRows = override.numRows; }
  if (typeof (override.hitboxes) != 'undefined') { result.hitboxes = override.hitboxes; }
  if (typeof (override.parentPath) != 'undefined') { result.parentPath = override.parentPath; }
  if (typeof (override.displayItemFingerprint) != 'undefined') { result.displayItemFingerprint = override.displayItemFingerprint; }
  // tableVesRows is moved to VesCache, do not copy to VisualElement
  // attachmentsVes is moved to VesCache, do not copy to VisualElement
  // popupVes is moved to VesCache, do not copy to VisualElement
  // selectedVes is moved to VesCache, do not copy to VisualElement
  // dockVes is moved to VesCache, do not copy to VisualElement

  if (isTable(result.displayItem) && (result.flags & VisualElementFlags.Detailed) && result.childAreaBoundsPx == null) {
    console.error("A detailed table visual element was created without childAreaBoundsPx set.", result);
    console.trace();
  }
  // TODO (LOW): some additional sanity checking here would help catch arrange bugs.
}
