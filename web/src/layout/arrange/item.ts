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

import { COL_HEADER_HEIGHT_BL, HEADER_HEIGHT_BL } from "../../components/items/Table";
import { BLOCK_SIZE_PX, CHILD_ITEMS_VISIBLE_WIDTH_BL, COMPOSITE_ITEM_GAP_BL, GRID_SIZE, LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL, PAGE_DOCUMENT_LEFT_MARGIN_PX, PAGE_DOCUMENT_TOP_MARGIN_PX, RESIZE_BOX_SIZE_PX } from "../../constants";
import { StoreContextModel } from "../../store/StoreProvider";
import { asAttachmentsItem, isAttachmentsItem } from "../../items/base/attachments-item";
import { Item } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { PageItem, asPageItem, isPage, PageFns, ArrangeAlgorithm } from "../../items/page-item";
import { TableItem, asTableItem, isTable } from "../../items/table-item";
import { VisualElementFlags, VisualElementSpec, VisualElementPath, VeFns, EMPTY_VEID, Veid } from "../visual-element";
import { VisualElementSignal } from "../../util/signals";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { LinkFns, LinkItem, isLink } from "../../items/link-item";
import { assert, panic } from "../../util/lang";
import { initiateLoadChildItemsMaybe } from "../load";
import { itemState } from "../../store/ItemState";
import { TableFlags } from "../../items/base/flags-item";
import { VesCache } from "../ves-cache";
import { ItemGeometry } from "../item-geometry";
import { CompositeItem, asCompositeItem, isComposite } from "../../items/composite-item";
import { arrangeItemAttachments } from "./attachments";
import { getVePropertiesForItem } from "./util";
import { NoteFns, asNoteItem, isNote } from "../../items/note-item";
import { POPUP_LINK_UID, newUid } from "../../util/uid";
import { RelationshipToParent } from "../relationship-to-parent";
import { newOrdering } from "../../util/ordering";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../../items/base/y-sizeable-item";
import { CursorEventState, MouseAction, MouseActionState } from "../../input/state";
import { PopupType } from "../../store/StoreProvider_History";
import { HitboxFlags, HitboxFns } from "../hitbox";
import createJustifiedLayout from "justified-layout";
import { arrangeCellPopup } from "./popup";
import { arrange_grid_page } from "./page_grid";


export const arrangeItem = (
    store: StoreContextModel,
    parentPath: VisualElementPath,
    realParentVeid: Veid | null,
    parentArrangeAlgorithm: string,
    item: Item,
    itemGeometry: ItemGeometry,
    renderChildrenAsFull: boolean,
    isPopup: boolean,
    isRoot: boolean,
    isListPageMainItem: boolean,
    parentIsPopup: boolean): VisualElementSignal => {
  if (isPopup && !isLink(item)) { panic("arrangeItem: popup isn't a link."); }

  const { displayItem, linkItemMaybe, spatialWidthGr } = getVePropertiesForItem(store, item);
  const itemVeid = VeFns.veidFromItems(displayItem, linkItemMaybe);

  let isMoving = false;
  if (!MouseActionState.empty() && MouseActionState.get().action == MouseAction.Moving) {
    const activeElementPath = MouseActionState.get().activeElement;
    if (activeElementPath == VeFns.addVeidToPath(itemVeid, parentPath)) {
      isMoving = true;
    }
  }

  const renderWithChildren = (() => {
    if (isRoot) { return true; }
    if (isPopup) { return true; }
    if (!renderChildrenAsFull) { return false; }
    if (!isPage(displayItem)) { return false; }
    if (parentArrangeAlgorithm == ArrangeAlgorithm.Dock) { return true; }
    return (parentArrangeAlgorithm == ArrangeAlgorithm.SpatialStretch
      ? // This test does not depend on pixel size, so is invariant over display devices.
        (spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL)
      : // However, this test does.
        itemGeometry.boundsPx.w / LINE_HEIGHT_PX >= CHILD_ITEMS_VISIBLE_WIDTH_BL);
  })();

  if (renderWithChildren) {
    initiateLoadChildItemsMaybe(store, itemVeid);
    return arrangePageWithChildren(
      store, parentPath, realParentVeid, asPageItem(displayItem), linkItemMaybe, itemGeometry, isPopup, isRoot, isListPageMainItem, isMoving);
  }

  if (isTable(displayItem) && (item.parentId == store.history.currentPage()!.itemId || renderChildrenAsFull)) {
    initiateLoadChildItemsMaybe(store, itemVeid);
    return arrangeTable(
      store, parentPath, asTableItem(displayItem), linkItemMaybe, itemGeometry, isListPageMainItem, parentIsPopup, isMoving);
  }

  if (isComposite(displayItem)) {
    initiateLoadChildItemsMaybe(store, itemVeid);
    return arrangeComposite(
      store, parentPath, asCompositeItem(displayItem), linkItemMaybe, itemGeometry, isListPageMainItem, isMoving);
  }

  const renderAsOutline = !renderChildrenAsFull;
  return arrangeItemNoChildren(store, parentPath, displayItem, linkItemMaybe, itemGeometry, isPopup, isListPageMainItem, isMoving, renderAsOutline);
}


const arrangePageWithChildren = (
    store: StoreContextModel,
    parentPath: VisualElementPath,
    realParentVeid: Veid | null,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    isPagePopup: boolean,
    isRoot: boolean,
    isListPageMainItem: boolean,
    isMoving: boolean): VisualElementSignal => {

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const outerBoundsPx = geometry.boundsPx;
  const hitboxes = geometry.hitboxes;

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const parentIsPopup = isPagePopup;

  // *** GRID ***
  if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.Grid) {

    pageWithChildrenVisualElementSpec = arrange_grid_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, isPagePopup, isRoot, isListPageMainItem, isMoving);

  // *** JUSTIFIED VIEW ***
  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.Justified) {

    let movingItem = null;
    if (!MouseActionState.empty() && (MouseActionState.get().action == MouseAction.Moving)) {
      movingItem = VeFns.canonicalItemFromPath(MouseActionState.get().activeElement);
    }

    // if an item is moving out of or in a grid page, then ensure the height of the grid page doesn't
    // change until after the move is complete to avoid a very distruptive jump in y scroll px.
    let nItemAdj = 0;
    if (movingItem && !MouseActionState.get().linkCreatedOnMoveStart) {
      const startParentVes = VesCache.get(MouseActionState.get().startActiveElementParent)!;
      const startParent = startParentVes.get().displayItem;
      if (startParent.id == displayItem_pageWithChildren.id && movingItem!.parentId != startParent.id) {
        nItemAdj = 1;
      }
    }

    let dims = [];
    let items = [];
    for (let i=0; i<displayItem_pageWithChildren.computed_children.length; ++i) {
      const item = itemState.get(displayItem_pageWithChildren.computed_children[i])!;
      if (movingItem && item.id == movingItem!.id) {
        continue;
      }
      let dimensions = ItemFns.calcSpatialDimensionsBl(item);
      dims.push({ width: dimensions.w, height: dimensions.h });
      items.push(item);
    }

    const layout = createJustifiedLayout(dims, createJustifyOptions(geometry.boundsPx.w, displayItem_pageWithChildren.justifiedRowAspect));
    if (layout.boxes.length != items.length) {
      panic(`incorrect number of boxes for items: ${layout.boxes.length} vs ${items.length}.`);
    }

    const childAreaBoundsPx = cloneBoundingBox(geometry.boundsPx)!;
    childAreaBoundsPx.h = layout.containerHeight;

    pageWithChildrenVisualElementSpec = {
      displayItem: displayItem_pageWithChildren,
      linkItemMaybe: linkItemMaybe_pageWithChildren,
      flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
             (isPagePopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
             (isPagePopup && store.getToolbarFocus()!.itemId ==  pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
             (isRoot ? VisualElementFlags.Root : VisualElementFlags.None) |
             (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
             (isListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx,
      hitboxes,
      parentPath,
    };

    const childrenVes = [];

    for (let i=0; i<items.length; ++i) {
      const item = items[i];
      const cellBoundsPx = {
        x: layout.boxes[i].left,
        y: layout.boxes[i].top,
        w: layout.boxes[i].width,
        h: layout.boxes[i].height
      };

      const geometry = ItemFns.calcGeometry_InCell(item, cellBoundsPx, false, false, false, false, true);
      const ves = arrangeItem(store, pageWithChildrenVePath, pageWithChildrenVeid, ArrangeAlgorithm.Justified, item, geometry, true, false, false, false, false);
      childrenVes.push(ves);
    }

    pageWithChildrenVisualElementSpec.childrenVes = childrenVes;

    if (isRoot && !isPagePopup) {
      const currentPopupSpec = store.history.currentPopupSpec();
      if (currentPopupSpec != null) {
        pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store, realParentVeid);
      }
    }


  // *** DOCUMENT VIEW ***
  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.Document) {

    const totalWidthBl = displayItem_pageWithChildren.docWidthBl + 4; // 4 == total margin.
    const requiredWidthPx = totalWidthBl * BLOCK_SIZE_PX.w;
    let scale = geometry.boundsPx.w / requiredWidthPx;
    if (scale > 1.0) { scale = 1.0; }
    const blockSizePx = { w: BLOCK_SIZE_PX.w * scale, h: BLOCK_SIZE_PX.h * scale };

    const childrenVes = [];

    let topPx = PAGE_DOCUMENT_TOP_MARGIN_PX * scale;
    for (let idx=0; idx<displayItem_pageWithChildren.computed_children.length; ++idx) {
      const childId = displayItem_pageWithChildren.computed_children[idx];
      const childItem = itemState.get(childId)!;

      const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);
      if (isTable(displayItem_childItem)) { continue; }

      const geometry = ItemFns.calcGeometry_InComposite(
        linkItemMaybe_childItem ? linkItemMaybe_childItem : displayItem_childItem,
        blockSizePx,
        displayItem_pageWithChildren.docWidthBl,
        topPx);

      const childVeSpec: VisualElementSpec = {
        displayItem: displayItem_childItem,
        linkItemMaybe: linkItemMaybe_childItem,
        flags: VisualElementFlags.InsideCompositeOrDoc | VisualElementFlags.Detailed,
        boundsPx: {
          x: geometry.boundsPx.x + PAGE_DOCUMENT_LEFT_MARGIN_PX * scale,
          y: geometry.boundsPx.y,
          w: geometry.boundsPx.w,
          h: geometry.boundsPx.h,
        },
        hitboxes: geometry.hitboxes,
        parentPath: pageWithChildrenVePath,
        col: 0,
        row: idx,
        blockSizePx: blockSizePx,
      };

      const childVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), pageWithChildrenVePath);
      const childVeSignal = VesCache.createOrRecycleVisualElementSignal(childVeSpec, childVePath);
      childrenVes.push(childVeSignal);

      topPx += geometry.boundsPx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;
    }

    const childAreaBoundsPx = cloneBoundingBox(geometry.boundsPx)!;
    childAreaBoundsPx.h = topPx;

    pageWithChildrenVisualElementSpec = {
      displayItem: displayItem_pageWithChildren,
      linkItemMaybe: linkItemMaybe_pageWithChildren,
      flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
            (isPagePopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
            (isPagePopup && store.getToolbarFocus()!.itemId ==  pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
            (isRoot ? VisualElementFlags.Root : VisualElementFlags.None) |
            (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
            (isListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx,
      hitboxes,
      parentPath,
    };

    pageWithChildrenVisualElementSpec.childrenVes = childrenVes;


  // *** SPATIAL_STRETCH ***
  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
    const aspect = outerBoundsPx.w / outerBoundsPx.h;
    const pageAspect = displayItem_pageWithChildren.naturalAspect;
    const pageBoundsPx = (() => {
      let result = cloneBoundingBox(outerBoundsPx)!;
      // TODO (MEDIUM): make these cutoff aspect ratios configurable in user settings.
      if (pageAspect / aspect > 1.3) {
        // page to scroll horizontally.
        result.w = Math.round(result.h * pageAspect);
      } else if (pageAspect / aspect < 0.7) {
        // page needs to scroll vertically.
        result.h = Math.round(result.w / pageAspect);
      }
      return result;
    })();

    pageWithChildrenVisualElementSpec = {
      displayItem: displayItem_pageWithChildren,
      linkItemMaybe: linkItemMaybe_pageWithChildren,
      flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
             (isPagePopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
             (isPagePopup && store.getToolbarFocus()!.itemId ==  pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
             (isRoot ? VisualElementFlags.Root : VisualElementFlags.None) |
             (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
             (isListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx: pageBoundsPx,
      hitboxes,
      parentPath,
    };

    const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);

    const childrenVes = [];
    for (let i=0; i<displayItem_pageWithChildren.computed_children.length; ++i) {
      const childId = displayItem_pageWithChildren.computed_children[i];
      const childItem = itemState.get(childId)!;
      const parentIsPopup = isPagePopup;
      const emitHitboxes = true;
      const childItemIsPopup = false; // never the case.
      const hasPendingChanges = false; // it may do, but only matters for popups.
      if (isPagePopup || isRoot) {
        const itemGeometry = ItemFns.calcGeometry_Spatial(
          childItem,
          zeroBoundingBoxTopLeft(pageWithChildrenVisualElementSpec.childAreaBoundsPx!),
          PageFns.calcInnerSpatialDimensionsBl(displayItem_pageWithChildren),
          parentIsPopup,
          emitHitboxes,
          childItemIsPopup,
          hasPendingChanges);
        childrenVes.push(arrangeItem(store, pageWithChildrenVePath, pageWithChildrenVeid, ArrangeAlgorithm.SpatialStretch, childItem, itemGeometry, true, childItemIsPopup, false, false, parentIsPopup));
      } else {
        const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);
        const parentPageInnerDimensionsBl = PageFns.calcInnerSpatialDimensionsBl(displayItem_pageWithChildren);
        const itemGeometry = ItemFns.calcGeometry_Spatial(
          childItem,
          innerBoundsPx,
          parentPageInnerDimensionsBl,
          parentIsPopup,
          emitHitboxes,
          childItemIsPopup,
          hasPendingChanges);
        childrenVes.push(arrangeItemNoChildren(store, pageWithChildrenVePath, displayItem, linkItemMaybe, itemGeometry, childItemIsPopup, false, isMoving, true));
      }
    }
    pageWithChildrenVisualElementSpec.childrenVes = childrenVes;

    if (isRoot && !isPagePopup) {
      const currentPopupSpec = store.history.currentPopupSpec();
      if (currentPopupSpec != null) {
        if (currentPopupSpec.type == PopupType.Page) {
          // Position of page popup in spatial pages is user defined.
          const popupLinkToPageId = VeFns.veidFromPath(currentPopupSpec.vePath).itemId;
          const li = LinkFns.create(displayItem_pageWithChildren.ownerId, displayItem_pageWithChildren.id, RelationshipToParent.Child, newOrdering(), popupLinkToPageId!);
          li.id = POPUP_LINK_UID;
          const widthGr = PageFns.getPopupWidthGr(displayItem_pageWithChildren);
          const heightGr = Math.round((widthGr / displayItem_pageWithChildren.naturalAspect / GRID_SIZE)/ 2.0) * 2.0 * GRID_SIZE;
          li.spatialWidthGr = widthGr;
          // assume center positioning.
          li.spatialPositionGr = {
            x: PageFns.getPopupPositionGr(displayItem_pageWithChildren).x - widthGr / 2.0,
            y: PageFns.getPopupPositionGr(displayItem_pageWithChildren).y - heightGr / 2.0
          };

          const itemGeometry = ItemFns.calcGeometry_Spatial(li,
            zeroBoundingBoxTopLeft(pageWithChildrenVisualElementSpec.childAreaBoundsPx!),
            PageFns.calcInnerSpatialDimensionsBl(displayItem_pageWithChildren),
            false, true, true,
            PageFns.popupPositioningHasChanged(displayItem_pageWithChildren));
          pageWithChildrenVisualElementSpec.popupVes = arrangeItem(
            store, pageWithChildrenVePath, pageWithChildrenVeid, ArrangeAlgorithm.SpatialStretch, li, itemGeometry, true, true, false, false, false);
  
        } else if (currentPopupSpec.type == PopupType.Attachment) {
          // Ves are created inline.
        } else if (currentPopupSpec.type == PopupType.Image) {
          pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store, realParentVeid);
        } else {
          panic(`arrange_spatialStretch: unknown popup type: ${currentPopupSpec.type}.`);
        }
      }
    }


  // *** LIST VIEW ***
  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.List) {

    const isFull = outerBoundsPx.h == store.desktopMainAreaBoundsPx().h;
    const scale = isFull ? 1.0 : outerBoundsPx.w / store.desktopMainAreaBoundsPx().w;

    let resizeBoundsPx = {
      x: LIST_PAGE_LIST_WIDTH_BL * LINE_HEIGHT_PX - RESIZE_BOX_SIZE_PX,
      y: 0,
      w: RESIZE_BOX_SIZE_PX,
      h: store.desktopMainAreaBoundsPx().h
    }
    if (isFull) {
      hitboxes.push(HitboxFns.create(HitboxFlags.HorizontalResize, resizeBoundsPx));
    }

    pageWithChildrenVisualElementSpec = {
      displayItem: displayItem_pageWithChildren,
      linkItemMaybe: linkItemMaybe_pageWithChildren,
      flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
             (isPagePopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
             (isPagePopup && store.getToolbarFocus()!.itemId ==  pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
             (isRoot ? VisualElementFlags.Root : VisualElementFlags.None) |
             (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
             (isListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx: geometry.boundsPx,
      hitboxes,
      parentPath,
    };

    let selectedVeid = EMPTY_VEID;
    if (isPagePopup) {
      const poppedUp = store.history.currentPopupSpec()!;
      const poppedUpPath = poppedUp.vePath;
      const poppedUpVeid = VeFns.veidFromPath(poppedUpPath);
      selectedVeid = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(poppedUpVeid));
    } else {
      if (realParentVeid == null) {
        selectedVeid = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(store.history.currentPage()!));
      } else {
        selectedVeid = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(realParentVeid!));
      }
    }

    let listVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<displayItem_pageWithChildren.computed_children.length; ++idx) {
      const childItem = itemState.get(displayItem_pageWithChildren.computed_children[idx])!;
      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

      const widthBl = LIST_PAGE_LIST_WIDTH_BL;
      const blockSizePx = { w: LINE_HEIGHT_PX * scale, h: LINE_HEIGHT_PX * scale };

      const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx, 0, widthBl, parentIsPopup);

      const listItemVeSpec: VisualElementSpec = {
        displayItem,
        linkItemMaybe,
        flags: VisualElementFlags.LineItem |
               (VeFns.compareVeids(selectedVeid, VeFns.veidFromItems(displayItem, linkItemMaybe)) == 0 ? VisualElementFlags.Selected : VisualElementFlags.None),
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        parentPath: pageWithChildrenVePath,
        col: 0,
        row: idx,
        blockSizePx,
      };
      const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), pageWithChildrenVePath);
      const listItemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(listItemVeSpec, childPath);
      listVeChildren.push(listItemVisualElementSignal);
    }
    pageWithChildrenVisualElementSpec.childrenVes = listVeChildren;

    if (selectedVeid != EMPTY_VEID) {
      const boundsPx = {
        x: LIST_PAGE_LIST_WIDTH_BL * LINE_HEIGHT_PX * scale,
        y: 0,
        w: outerBoundsPx.w - (LIST_PAGE_LIST_WIDTH_BL * LINE_HEIGHT_PX) * scale,
        h: outerBoundsPx.h - LINE_HEIGHT_PX * scale
      };
      const selectedIsRoot = isRoot && isPage(itemState.get(selectedVeid.itemId)!);
      const isExpandable = selectedIsRoot;
      pageWithChildrenVisualElementSpec.selectedVes =
        arrangeSelectedListItem(store, selectedVeid, boundsPx, pageWithChildrenVePath, isExpandable, selectedIsRoot);
    }

    if (isRoot && !isPagePopup) {
      const currentPopupSpec = store.history.currentPopupSpec();
      if (currentPopupSpec != null) {
        pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store, realParentVeid);
      }
    }


  } else {

    panic(`arrangePageWithChildren: unknown arrangeAlgorithm: ${displayItem_pageWithChildren.arrangeAlgorithm}.`);
  }

  const attachments = arrangeItemAttachments(store, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, outerBoundsPx, pageWithChildrenVePath);
  pageWithChildrenVisualElementSpec.attachmentsVes = attachments;

  const pageWithChildrenVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(pageWithChildrenVisualElementSpec, pageWithChildrenVePath);
  return pageWithChildrenVisualElementSignal;
}


const arrangeComposite = (
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_Composite: CompositeItem,
    linkItemMaybe_Composite: LinkItem | null,
    compositeGeometry: ItemGeometry,
    isListPageMainItem: boolean,
    isMoving: boolean): VisualElementSignal => {
  const compositeVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_Composite, linkItemMaybe_Composite), parentPath);

  let childAreaBoundsPx = {
    x: compositeGeometry.boundsPx.x, y: compositeGeometry.boundsPx.y,
    w: compositeGeometry.boundsPx.w, h: compositeGeometry.boundsPx.h
  };

  const compositeVisualElementSpec: VisualElementSpec = {
    displayItem: displayItem_Composite,
    linkItemMaybe: linkItemMaybe_Composite,
    flags: VisualElementFlags.Detailed |
           (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (isListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
    boundsPx: compositeGeometry.boundsPx,
    childAreaBoundsPx,
    hitboxes: compositeGeometry.hitboxes,
    parentPath,
  };

  const compositeSizeBl = ItemFns.calcSpatialDimensionsBl(linkItemMaybe_Composite ? linkItemMaybe_Composite : displayItem_Composite);
  const blockSizePx = { w: compositeGeometry.boundsPx.w / compositeSizeBl.w, h: compositeGeometry.boundsPx.h / compositeSizeBl.h };

  let compositeVeChildren: Array<VisualElementSignal> = [];
  let topPx = 0.0;
  for (let idx=0; idx<displayItem_Composite.computed_children.length; ++idx) {
    const childId = displayItem_Composite.computed_children[idx];
    const childItem = itemState.get(childId)!;

    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);
    if (isTable(displayItem_childItem)) { continue; }

    const geometry = ItemFns.calcGeometry_InComposite(
      linkItemMaybe_childItem ? linkItemMaybe_childItem : displayItem_childItem,
      blockSizePx,
      compositeSizeBl.w,
      topPx);

    topPx += geometry.boundsPx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;

    const compositeChildVeSpec: VisualElementSpec = {
      displayItem: displayItem_childItem,
      linkItemMaybe: linkItemMaybe_childItem,
      flags: VisualElementFlags.InsideCompositeOrDoc | VisualElementFlags.Detailed,
      boundsPx: {
        x: geometry.boundsPx.x,
        y: geometry.boundsPx.y,
        w: geometry.boundsPx.w,
        h: geometry.boundsPx.h,
      },
      hitboxes: geometry.hitboxes,
      parentPath: compositeVePath,
      col: 0,
      row: idx,
      blockSizePx,
    };

    const attachments = arrangeItemAttachments(store, displayItem_childItem, linkItemMaybe_childItem, geometry.boundsPx, compositeVePath);
    compositeChildVeSpec.attachmentsVes = attachments;

    const compositeChildVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), compositeVePath);
    const compositeChildVeSignal = VesCache.createOrRecycleVisualElementSignal(compositeChildVeSpec, compositeChildVePath);
    compositeVeChildren.push(compositeChildVeSignal);
  }
  compositeVisualElementSpec.childrenVes = compositeVeChildren;

  const compositeVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(compositeVisualElementSpec, compositeVePath);

  return compositeVisualElementSignal;
}


const arrangeTable = (
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_Table: TableItem,
    linkItemMaybe_Table: LinkItem | null,
    tableGeometry: ItemGeometry,
    isListPageMainItem: boolean,
    parentIsPopup: boolean,
    isMoving: boolean): VisualElementSignal => {

  const sizeBl = linkItemMaybe_Table
    ? { w: linkItemMaybe_Table!.spatialWidthGr / GRID_SIZE, h: linkItemMaybe_Table!.spatialHeightGr / GRID_SIZE }
    : { w: displayItem_Table.spatialWidthGr / GRID_SIZE, h: displayItem_Table.spatialHeightGr / GRID_SIZE };
  const blockSizePx = { w: tableGeometry.boundsPx.w / sizeBl.w, h: tableGeometry.boundsPx.h / sizeBl.h };
  const headerHeightPx = blockSizePx.h * HEADER_HEIGHT_BL;
  const colHeaderHeightPx = ((displayItem_Table.flags & TableFlags.ShowColHeader)) ? (blockSizePx.h * COL_HEADER_HEIGHT_BL) : 0;

  let childAreaBoundsPx = {
    x: tableGeometry.boundsPx.x, y: tableGeometry.boundsPx.y + (headerHeightPx + colHeaderHeightPx),
    w: tableGeometry.boundsPx.w, h: tableGeometry.boundsPx.h - (headerHeightPx + colHeaderHeightPx)
  };

  const tableVisualElementSpec: VisualElementSpec = {
    displayItem: displayItem_Table,
    linkItemMaybe: linkItemMaybe_Table,
    flags: VisualElementFlags.Detailed |
           (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (isListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
    boundsPx: tableGeometry.boundsPx,
    childAreaBoundsPx,
    hitboxes: tableGeometry.hitboxes,
    blockSizePx,
    parentPath,
  };
  const tableVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_Table, linkItemMaybe_Table), parentPath);

  let tableVeChildren: Array<VisualElementSignal> = [];
  for (let idx=0; idx<displayItem_Table.computed_children.length; ++idx) {
    const childId = displayItem_Table.computed_children[idx];
    const childItem = itemState.get(childId)!;
    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);
    const childVeid = VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem);

    if (isComposite(displayItem_childItem)) {
      initiateLoadChildItemsMaybe(store, childVeid);
    }

    let widthBl = displayItem_Table.tableColumns.length == 1
      ? sizeBl.w
      : Math.min(displayItem_Table.tableColumns[0].widthGr / GRID_SIZE, sizeBl.w);

    const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx, 0, widthBl, parentIsPopup);

    const tableChildVeSpec: VisualElementSpec = {
      displayItem: displayItem_childItem,
      linkItemMaybe: linkItemMaybe_childItem,
      flags: VisualElementFlags.LineItem | VisualElementFlags.InsideTable,
      boundsPx: geometry.boundsPx,
      hitboxes: geometry.hitboxes,
      parentPath: tableVePath,
      col: 0,
      row: idx,
      blockSizePx,
    };
    const tableChildVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), tableVePath);

    if (isAttachmentsItem(displayItem_childItem)) {
      let tableItemVeAttachments: Array<VisualElementSignal> = [];
      const attachmentsItem = asAttachmentsItem(displayItem_childItem);
      let leftBl = displayItem_Table.tableColumns[0].widthGr / GRID_SIZE;
      let i=0;
      for (; i<attachmentsItem.computed_attachments.length; ++i) {
        if (i >= displayItem_Table.tableColumns.length-1) { break; }
        if (leftBl >= displayItem_Table.spatialWidthGr / GRID_SIZE) { break; }
        let widthBl = i == displayItem_Table.tableColumns.length - 2
          ? sizeBl.w - leftBl
          : displayItem_Table.tableColumns[i+1].widthGr / GRID_SIZE;

        const attachmentId = attachmentsItem.computed_attachments[i];
        const attachmentItem = itemState.get(attachmentId)!;
        const { displayItem: displayItem_attachment, linkItemMaybe: linkItemMaybe_attachment } = getVePropertiesForItem(store, attachmentItem);
        const attachment_veid = VeFns.veidFromItems(displayItem_attachment, linkItemMaybe_attachment);

        if (isComposite(displayItem_attachment)) {
          initiateLoadChildItemsMaybe(store, attachment_veid);
        }

        const geometry = ItemFns.calcGeometry_ListItem(attachmentItem, blockSizePx, idx, leftBl, widthBl, parentIsPopup);

        const tableChildAttachmentVeSpec: VisualElementSpec = {
          displayItem: displayItem_attachment,
          linkItemMaybe: linkItemMaybe_attachment,
          flags: VisualElementFlags.InsideTable | VisualElementFlags.Attachment,
          boundsPx: geometry.boundsPx,
          hitboxes: geometry.hitboxes,
          col: i + 1,
          row: idx,
          parentPath: tableChildVePath,
          blockSizePx
        };
        const tableChildAttachmentVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_attachment, linkItemMaybe_attachment), tableChildVePath);
        const tableChildAttachmentVeSignal = VesCache.createOrRecycleVisualElementSignal(tableChildAttachmentVeSpec, tableChildAttachmentVePath);

        if (isNote(tableChildAttachmentVeSpec.displayItem)) {
          const noteItem = asNoteItem(tableChildAttachmentVeSpec.displayItem);
          if (NoteFns.isExpression(noteItem)) {
            VesCache.markEvaluationRequired(VeFns.veToPath(tableChildAttachmentVeSignal.get()));
          }
        }

        tableItemVeAttachments.push(tableChildAttachmentVeSignal);
        leftBl += displayItem_Table.tableColumns[i+1].widthGr / GRID_SIZE;
      }

      tableChildVeSpec.attachmentsVes = tableItemVeAttachments;
    }
    const tableItemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(tableChildVeSpec, tableChildVePath);

    if (isNote(tableChildVeSpec.displayItem)) {
      const noteItem = asNoteItem(tableChildVeSpec.displayItem);
      if (NoteFns.isExpression(noteItem)) {
        VesCache.markEvaluationRequired(VeFns.veToPath(tableItemVisualElementSignal.get()));
      }
    }

    tableVeChildren.push(tableItemVisualElementSignal);
  };

  tableVisualElementSpec.childrenVes = tableVeChildren;

  const attachments = arrangeItemAttachments(store, displayItem_Table, linkItemMaybe_Table, tableGeometry.boundsPx, tableVePath);
  tableVisualElementSpec.attachmentsVes = attachments;

  const tableVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(tableVisualElementSpec, tableVePath);

  return tableVisualElementSignal;
}


const arrangeItemNoChildren = (
    store: StoreContextModel,
    parentVePath: VisualElementPath,
    displayItem: Item,
    linkItemMaybe: LinkItem | null,
    itemGeometry: ItemGeometry,
    isPopup: boolean,
    isListPageMainItem: boolean,
    isMoving: boolean,
    renderAsOutline: boolean): VisualElementSignal => {
  const currentVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), parentVePath);

  const item = displayItem != null ? displayItem : linkItemMaybe!;
  const itemVisualElement: VisualElementSpec = {
    displayItem: item,
    linkItemMaybe,
    flags: (renderAsOutline ? VisualElementFlags.None : VisualElementFlags.Detailed) |
           (isPopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
           (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (isListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
    boundsPx: itemGeometry.boundsPx,
    hitboxes: itemGeometry.hitboxes,
    parentPath: parentVePath,
  };

  // TODO (MEDIUM): reconcile, don't override.
  // TODO (MEDIUM): perhaps attachments is a sub-signal.
  itemVisualElement.attachmentsVes = arrangeItemAttachments(store, displayItem, linkItemMaybe, itemGeometry.boundsPx, currentVePath);

  const itemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(itemVisualElement, currentVePath);

  if (isNote(item)) {
    const noteItem = asNoteItem(item);
    if (NoteFns.isExpression(noteItem)) {
      VesCache.markEvaluationRequired(VeFns.veToPath(itemVisualElementSignal.get()));
    }
  }

  return itemVisualElementSignal;
}


export const LIST_PAGE_MAIN_ITEM_LINK_ITEM = newUid();

export function arrangeSelectedListItem(store: StoreContextModel, veid: Veid, boundsPx: BoundingBox, currentPath: VisualElementPath, isExpandable: boolean, isRoot: boolean): VisualElementSignal {
  const item = itemState.get(veid.itemId)!;
  const canonicalItem = VeFns.canonicalItemFromVeid(veid)!;

  const paddedBoundsPx = {
    x: boundsPx.x + LINE_HEIGHT_PX,
    y: boundsPx.y + LINE_HEIGHT_PX,
    w: boundsPx.w - 2 * LINE_HEIGHT_PX,
    h: boundsPx.h - 2 * LINE_HEIGHT_PX,
  };

  let li = LinkFns.create(item.ownerId, canonicalItem.parentId, RelationshipToParent.Child, newOrdering(), veid.itemId);
  li.id = LIST_PAGE_MAIN_ITEM_LINK_ITEM;
  if (isXSizableItem(item)) { li.spatialWidthGr = asXSizableItem(item).spatialWidthGr; }
  if (isYSizableItem(item)) { li.spatialHeightGr = asYSizableItem(item).spatialHeightGr; }
  li.spatialPositionGr = { x: 0.0, y: 0.0 };

  const geometry = ItemFns.calcGeometry_InCell(li, paddedBoundsPx, isExpandable, false, false, false, false);
  if (isPage(item)) {
    geometry.boundsPx = boundsPx;
    geometry.hitboxes = [];
    if (isExpandable) {
      geometry.hitboxes = [
        HitboxFns.create(HitboxFlags.Expand, { x: 0, y: 0, h: boundsPx.h, w: RESIZE_BOX_SIZE_PX }),
        HitboxFns.create(HitboxFlags.Expand, { x: 0, y: 0, h: RESIZE_BOX_SIZE_PX, w: boundsPx.w }),
        HitboxFns.create(HitboxFlags.Expand, { x: 0, y: boundsPx.h - RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX, w: boundsPx.w }),
        HitboxFns.create(HitboxFlags.Expand, { x: boundsPx.w - RESIZE_BOX_SIZE_PX, y: 0, h: boundsPx.h, w: RESIZE_BOX_SIZE_PX }),
      ];
    }
  }

  const result = arrangeItem(store, currentPath, veid, ArrangeAlgorithm.List, li, geometry, true, false, isRoot, true, false);
  return result;
}

function createJustifyOptions(widthPx: number, rowAspect: number) {
  const NORMAL_ROW_HEIGHT = 200;
  const targetRowHeight = widthPx / rowAspect;
  const options: JustifiedLayoutOptions = {
    containerWidth: widthPx,
    containerPadding: 10 * targetRowHeight / 200,
    boxSpacing: 5 * targetRowHeight / 200,
    targetRowHeight,
  };
  return options;
}

/**
 * Options for configuring the justified layout.
 */
interface JustifiedLayoutOptions {
  /**
   * The width that boxes will be contained within irrelevant of padding.
   * @default 1060
   */
  containerWidth?: number | undefined;
  /**
   * Provide a single integer to apply padding to all sides or provide an object to apply
   * individual values to each side.
   * @default 10
   */
  containerPadding?: number | { top: number; right: number; left: number; bottom: number } | undefined;
  /**
   * Provide a single integer to apply spacing both horizontally and vertically or provide an
   * object to apply individual values to each axis.
   * @default 10
   */
  boxSpacing?: number | { horizontal: number; vertical: number } | undefined;
  /**
   * It's called a target because row height is the lever we use in order to fit everything in
   * nicely. The algorithm will get as close to the target row height as it can.
   * @default 320
   */
  targetRowHeight?: number | undefined;
  /**
   * How far row heights can stray from targetRowHeight. `0` would force rows to be the
   * `targetRowHeight` exactly and would likely make it impossible to justify. The value must
   * be between `0` and `1`.
   * @default 0.25
   */
  targetRowHeightTolerance?: number | undefined;
  /**
   * Will stop adding rows at this number regardless of how many items still need to be laid
   * out.
   * @default Number.POSITIVE_INFINITY
   */
  maxNumRows?: number | undefined;
  /**
   * Provide an aspect ratio here to return everything in that aspect ratio. Makes the values
   * in your input array irrelevant. The length of the array remains relevant.
   * @default false
   */
  forceAspectRatio?: boolean | number | undefined;
  /**
   * If you'd like to insert a full width box every n rows you can specify it with this
   * parameter. The box on that row will ignore the targetRowHeight, make itself as wide as
   * `containerWidth - containerPadding` and be as tall as its aspect ratio defines. It'll
   * only happen if that item has an aspect ratio >= 1. Best to have a look at the examples to
   * see what this does.
   * @default false
   */
  fullWidthBreakoutRowCadence?: boolean | number | undefined;
  /**
   * By default we'll return items at the end of a justified layout even if they don't make a
   * full row. If false they'll be omitted from the output.
   * @default true
   */
  showWidows?: boolean | undefined;
  /**
   * If widows are visible, how should they be laid out?
   * @default "left"
   */
  widowLayoutStyle?: "left" | "justify" | "center" | undefined;
}
