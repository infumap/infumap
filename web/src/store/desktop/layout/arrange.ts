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

import { batch } from "solid-js";
import { HEADER_HEIGHT_BL } from "../../../components/items/Table";
import { CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_SIZE } from "../../../constants";
import { Uid } from "../../../util/uid";
import { DesktopStoreContextModel, visualElementsWithId } from "../DesktopStoreProvider";
import { isAttachmentsItem } from "../items/base/attachments-item";
import { ITEM_TYPE_LINK, Item } from "../items/base/item";
import { calcGeometryOfItemInCell, calcGeometryOfItemInPage, calcGeometryOfItemInTable } from "../items/base/item-polymorphism";
import { PageItem, asPageItem, calcPageInnerSpatialDimensionsBl, isPage } from "../items/page-item";
import { TableItem, asTableItem, isTable } from "../items/table-item";
import { VisualElement } from "../visual-element";
import { VisualElementSignal, createBooleanSignal, createVisualElementSignal } from "../../../util/signals";
import { BoundingBox, zeroBoundingBoxTopLeft } from "../../../util/geometry";
import { LinkItem, asLinkItem, isLink, newLinkItem } from "../items/link-item";
import { ItemGeometry } from "../item-geometry";
import { Child } from "../relationship-to-parent";
import { newOrdering } from "../../../util/ordering";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { panic } from "../../../util/lang";
import { initiateLoadChildItemsIfNotLoaded } from "./load";
import { Hitbox, HitboxType, cloneHitbox } from "../hitbox";


export const switchToPage = (desktopStore: DesktopStoreContextModel, id: Uid) => {
  batch(() => {
    desktopStore.pushTopLevelPageId(id);
    var page = asPageItem(desktopStore.getItem(id)!);
    // TODO (HIGH): get rid of this horrible hack!
    let desktopEl = window.document.getElementById("desktop")!;
    if (desktopEl) {
      desktopEl.scrollTop = 0;
      desktopEl.scrollLeft = 0;
    }
    // TODO (MEDIUM): retain these.
    page.scrollXPx.set(0);
    page.scrollYPx.set(0);
    arrange(desktopStore);
  });
}


/**
 * Create the visual element tree for the current page.
 * 
 * Design note: Initially, this was implemented such that the visual element state was a function of the item
 * state (arrange was never explicitly called). Note that the result of the arrange function did include (nested)
 * visual element signals though which had dependencies on the relevant part of the item state. This approach was
 * simpler from the point of view that the visual elements did not need to be separately updated / managed. However,
 * the functional approach turned out to be a dead end:
 * 1. It was effectively impossible to perfectly optimize it in the case of, for example, resizing pages because
 *    the children were a function of page size. By comparison, as a general comment, the stateful approach makes
 *    it easy(er) to make precisely the optimal updates at precisely the required times. Also, given optimization as
 *    a priority, I would say the implementation is not actually harder to reason about even though it is more
 *    ad-hoc.
 * 2. The visual element tree state is required for mouse interaction as well as rendering, and it was messy to
 *    create a cached version of this as a side effect of the functional arrange method. And there were associated
 *    bugs, which were not trivial to track down.
 * 3. The functional represenation was not straightforward (compared to the current approach) to reason about -
 *    you need to be very congisant of functional dependencies, what is being captured etc. Even though the direct
 *    approach is more ad-hoc / less "automated", I think the code is simpler to work on due to this.
 */
export const arrange = (desktopStore: DesktopStoreContextModel): void => {
  if (desktopStore.topLevelPageId() == null) { return; }
  initiateLoadChildItemsIfNotLoaded(desktopStore, desktopStore.topLevelPageId()!);
  let currentPage = asPageItem(desktopStore.getItem(desktopStore.topLevelPageId()!)!);
  if (currentPage.arrangeAlgorithm == "grid") {
    arrange_grid(desktopStore);
  } else {
    arrange_spatialStretch(desktopStore);
  }
}


const arrange_spatialStretch = (desktopStore: DesktopStoreContextModel) => {
  const currentPage = asPageItem(desktopStore.getItem(desktopStore.topLevelPageId()!)!);
  const desktopAspect = desktopStore.desktopBoundsPx().w / desktopStore.desktopBoundsPx().h;
  const pageAspect = currentPage.naturalAspect.get();
  const topLevelPageBoundsPx = (() => {
    let result = desktopStore.desktopBoundsPx();
    // TODO (MEDIUM): make these cutoff aspect ratios configurable in user settings.
    if (pageAspect / desktopAspect > 1.25) {
      // page to scroll horizontally.
      result.w = Math.round(result.h * pageAspect);
    } else if (pageAspect / desktopAspect < 0.75) {
      // page needs to scroll vertically.
      result.h = Math.round(result.w / pageAspect);
    }
    return result;
  })();

  const topLevelVisualElement: VisualElement = {
    item: currentPage,
    linkItemMaybe: null,
    isInteractive: true,
    isPopup: false,
    resizingFromBoundsPx: null,
    boundsPx: topLevelPageBoundsPx,
    childAreaBoundsPx: topLevelPageBoundsPx,
    hitboxes: [],
    children: [],
    attachments: [],
    parent: null,
    computed_mouseIsOver: createBooleanSignal(false),
    computed_movingItemIsOver: createBooleanSignal(false),
  };

  topLevelVisualElement.children = currentPage.computed_children.get()
    .map(childId => arrangeItem(
      desktopStore,
      desktopStore.getItem(childId)!,
      topLevelPageBoundsPx,
      { get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement },
      false, false));

  let popupId = desktopStore.popupId();
  if (popupId != null) {
    let li = newLinkItem(currentPage.ownerId, currentPage.id, Child, newOrdering(), popupId);
    let widthGr = Math.round((currentPage.innerSpatialWidthGr.get() / GRID_SIZE) / 2.0) * GRID_SIZE;
    let heightGr = Math.round((currentPage.innerSpatialWidthGr.get() / currentPage.naturalAspect.get() / GRID_SIZE)/ 2.0) * GRID_SIZE;
    li.spatialWidthGr.set(widthGr);
    li.spatialPositionGr.set({ x: Math.round((widthGr / GRID_SIZE) / 2.0) * GRID_SIZE, y: ((heightGr / GRID_SIZE) / 2.0) * GRID_SIZE });
    topLevelVisualElement.children.push(
      arrangeItem(
        desktopStore,
        li,
        topLevelPageBoundsPx,
        { get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement },
        false, true));
  }

  desktopStore.setTopLevelVisualElement(topLevelVisualElement);
}

enum RenderStyle {
  Full,
  InsidePopup,
  Placeholder,
}

export const arrangeItem = (
    desktopStore: DesktopStoreContextModel,
    item: Item,
    containerBoundsPx: BoundingBox,
    parentSignalUnderConstruction: VisualElementSignal, // used to establish back references only, not called.
    parentIsPopup: boolean,
    isPopup: boolean): VisualElementSignal => {

  if (isPopup) {
    if (!isLink(item)) {
      panic();
    }
  }

  const parent = asPageItem(desktopStore.getItem(item.parentId)!);
  const pageBoundsPx = zeroBoundingBoxTopLeft(containerBoundsPx);
  const pageInnerPageDimensionsBl = calcPageInnerSpatialDimensionsBl(parent);

  const geometry = calcGeometryOfItemInPage(item, pageBoundsPx, pageInnerPageDimensionsBl, true, desktopStore.getItem);

  let spatialWidthGr = isXSizableItem(item)
    ? asXSizableItem(item).spatialWidthGr.get()
    : 0;

  let linkItemMaybe: LinkItem | null = null;
  if (item.itemType == ITEM_TYPE_LINK) {
    linkItemMaybe = asLinkItem(item);
    item = desktopStore.getItem(linkItemMaybe.linkToId)!;
    if (isXSizableItem(item)) {
      spatialWidthGr = linkItemMaybe.spatialWidthGr.get();
    }
  }

  if (isPage(item) && asPageItem(item).arrangeAlgorithm == "grid") {
    // Always make sure child items of grid pages are loaded, even if not visible,
    // because they are needed to to calculate the height.
    initiateLoadChildItemsIfNotLoaded(desktopStore, item.id);
  }

  if (isPage(item) &&
      // This test does not depend on pixel size, so is invariant over display devices.
      spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
    initiateLoadChildItemsIfNotLoaded(desktopStore, item.id);
    return arrangePage(desktopStore, asPageItem(item), linkItemMaybe, geometry, parentSignalUnderConstruction, parentIsPopup, isPopup);
  }

  if (isTable(item)) {
    initiateLoadChildItemsIfNotLoaded(desktopStore, item.id);
    return arrangeTable(desktopStore, asTableItem(item), linkItemMaybe, geometry, parentSignalUnderConstruction);
  }

  return arrangeItemNoChildren(item, linkItemMaybe, geometry, parentSignalUnderConstruction, parentIsPopup ? RenderStyle.InsidePopup : RenderStyle.Full);
}

const arrangeTable = (
    desktopStore: DesktopStoreContextModel,
    tableItem: TableItem,
    linkItemMaybe: LinkItem | null,
    geometry: ItemGeometry,
    parentSignalUnderConstruction: VisualElementSignal): VisualElementSignal => {

  const sizeBl = { w: tableItem.spatialWidthGr.get() / GRID_SIZE, h: tableItem.spatialHeightGr.get() / GRID_SIZE };
  const blockSizePx = { w: geometry.boundsPx.w / sizeBl.w, h: geometry.boundsPx.h / sizeBl.h };
  const headerHeightPx = blockSizePx.h * HEADER_HEIGHT_BL;

  let childAreaBoundsPx = {
    x: geometry.boundsPx.x, y: geometry.boundsPx.y + headerHeightPx,
    w: geometry.boundsPx.w, h: geometry.boundsPx.h - headerHeightPx
  };

  let tableVisualElement: VisualElement = {
    item: tableItem,
    linkItemMaybe,
    isInteractive: true,
    isPopup: false,
    resizingFromBoundsPx: null,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx,
    hitboxes: geometry.hitboxes,
    children: [],
    attachments: [],
    parent: parentSignalUnderConstruction,
    computed_mouseIsOver: createBooleanSignal(false),
    computed_movingItemIsOver: createBooleanSignal(false),
  }
  const tableVisualElementSignal = createVisualElementSignal(tableVisualElement);

  tableVisualElement.children = (() => {
    let tableVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<tableItem.computed_children.get().length; ++idx) {
      const childId = tableItem.computed_children.get()[idx];
      const childItem = desktopStore.getItem(childId)!;
      if (isLink(childItem)) {
        // TODO.
        panic();
      }
      const geometry = calcGeometryOfItemInTable(childItem, blockSizePx, idx, 0, sizeBl.w, desktopStore.getItem);

      let tableItemVe: VisualElement = {
        item: childItem,
        linkItemMaybe: null,
        isInteractive: true,
        isPopup: false,
        resizingFromBoundsPx: null,
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        children: [],
        attachments: [],
        childAreaBoundsPx: null,
        parent: tableVisualElementSignal,
        computed_mouseIsOver: createBooleanSignal(false),
        computed_movingItemIsOver: createBooleanSignal(false),
      };
      tableVeChildren.push(createVisualElementSignal(tableItemVe));

      // let attachments: Array<VisualElementSignal> = [];
      if (isAttachmentsItem(childItem)) {
        // TODO
      }
    };
    return tableVeChildren;
  })();

  return tableVisualElementSignal;
}

const arrangePage = (
    desktopStore: DesktopStoreContextModel,
    pageItem: PageItem,
    linkItemMaybe: LinkItem | null,
    geometry: ItemGeometry,
    parentSignalUnderConstruction: VisualElementSignal,
    parentIsPopup: boolean,
    isPopup: boolean): VisualElementSignal => {

  let hitboxes: Array<Hitbox> = parentIsPopup
    ? geometry.hitboxes.filter(hb => hb.type != HitboxType.OpenPopup).map(hb => {
        let nHb = cloneHitbox(hb)!;
        if (nHb.type == HitboxType.Click) { nHb.type = HitboxType.OpenPopup }
        return nHb;
      })
    : geometry.hitboxes;

  const pageWithChildrenVisualElement: VisualElement = {
    item: pageItem,
    linkItemMaybe,
    isInteractive: true,
    isPopup,
    resizingFromBoundsPx: null,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx: geometry.boundsPx,
    hitboxes,
    children: [],
    attachments: [],
    parent: parentSignalUnderConstruction,
    computed_mouseIsOver: createBooleanSignal(false),
    computed_movingItemIsOver: createBooleanSignal(false),
  };
  const pageWithChildrenVisualElementSignal = createVisualElementSignal(pageWithChildrenVisualElement);

  const innerDimensionsBl = calcPageInnerSpatialDimensionsBl(pageItem);
  const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);

  pageWithChildrenVisualElement.children = pageItem.computed_children.get().map(childId => {
    const innerChildItem = desktopStore.getItem(childId)!;
    if (isLink(innerChildItem)) {
      // TODO.
      panic();
    }
    if (isPopup) {
      return arrangeItem(desktopStore, innerChildItem, pageWithChildrenVisualElement.childAreaBoundsPx!, pageWithChildrenVisualElementSignal, true, false);
    }
    const geometry = calcGeometryOfItemInPage(innerChildItem, innerBoundsPx, innerDimensionsBl, true, desktopStore.getItem);
    return arrangeItemNoChildren(innerChildItem, null, geometry, pageWithChildrenVisualElementSignal, RenderStyle.Placeholder);
  });

  return pageWithChildrenVisualElementSignal;
}

const arrangeItemNoChildren = (
    childItem: Item,
    linkItemMaybe: LinkItem | null,
    geometry: ItemGeometry,
    parentSignalUnderConstruction: VisualElementSignal,
    renderStyle: RenderStyle): VisualElementSignal => {

  let hitboxes: Array<Hitbox> = [];
  if (renderStyle == RenderStyle.Full) {
    hitboxes = geometry.hitboxes;
  }
  if (renderStyle == RenderStyle.InsidePopup) {
    if (isPage(childItem)) {
      hitboxes = geometry.hitboxes.filter(hb => hb.type != HitboxType.OpenPopup).map(hb => {
        let nHb = cloneHitbox(hb)!;
        if (nHb.type == HitboxType.Click) { nHb.type = HitboxType.OpenPopup }
        return nHb;
      });
    } else {
      hitboxes = geometry.hitboxes;
    }
  }

  const itemVisualElement: VisualElement = {
    item: childItem,
    linkItemMaybe,
    isInteractive: renderStyle != RenderStyle.Placeholder,
    isPopup: false,
    resizingFromBoundsPx: null,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx: null,
    hitboxes: hitboxes,
    children: [],
    attachments: [],
    parent: parentSignalUnderConstruction,
    computed_mouseIsOver: createBooleanSignal(false),
    computed_movingItemIsOver: createBooleanSignal(false),
  };

  return createVisualElementSignal(itemVisualElement);
}


const arrange_grid = (desktopStore: DesktopStoreContextModel): void => {
  const currentPage = asPageItem(desktopStore.getItem(desktopStore.topLevelPageId()!)!);
  const pageBoundsPx = desktopStore.desktopBoundsPx();

  const numCols = currentPage.gridNumberOfColumns.get();
  const numRows = Math.ceil(currentPage.computed_children.get().length / numCols);
  const colAspect = 1.5;
  const cellWPx = pageBoundsPx.w / numCols;
  const cellHPx = pageBoundsPx.w / numCols * (1.0/colAspect);
  const marginPx = cellWPx * 0.01;
  const pageHeightPx = numRows * cellHPx;
  const boundsPx = (() => {
    const result = pageBoundsPx;
    result.h = pageHeightPx;
    return result;
  })();

  const topLevelVisualElement: VisualElement = {
    item: currentPage,
    linkItemMaybe: null,
    isInteractive: true,
    isPopup: false,
    resizingFromBoundsPx: null,
    boundsPx: boundsPx,
    childAreaBoundsPx: boundsPx,
    hitboxes: [],
    children: [], // replaced below.
    attachments: [],
    parent: null,
    computed_mouseIsOver: createBooleanSignal(false),
    computed_movingItemIsOver: createBooleanSignal(false),
  };

  topLevelVisualElement.children = (() => {
    const children: Array<VisualElementSignal> = [];
    const childItems = currentPage.computed_children.get().map(childId => desktopStore.getItem(childId)!);
    for (let i=0; i<childItems.length; ++i) {
      const item = childItems[i];
      const col = i % numCols;
      const row = Math.floor(i / numCols);
      const cellBoundsPx = {
        x: col * cellWPx + marginPx,
        y: row * cellHPx + marginPx,
        w: cellWPx - marginPx * 2.0,
        h: cellHPx - marginPx * 2.0
      };

      let geometry = calcGeometryOfItemInCell(item, cellBoundsPx, desktopStore.getItem);
      if (!isTable(item)) {
        let ve: VisualElement = {
          item,
          linkItemMaybe: null,
          isInteractive: true,
          isPopup: false,
          resizingFromBoundsPx: null,
          boundsPx: geometry.boundsPx,
          childAreaBoundsPx: null,
          hitboxes: geometry.hitboxes,
          children: [],
          attachments: [],
          parent: { get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement },
          computed_mouseIsOver: createBooleanSignal(false),
          computed_movingItemIsOver: createBooleanSignal(false),
        };
        children.push(createVisualElementSignal(ve));
      } else {
        console.log("TODO: child tables in grid pages.");
      }
    }
    return children;
  })();

  desktopStore.setTopLevelVisualElement(topLevelVisualElement);
}

export const rearrangeVisualElementsWithId = (desktopStore: DesktopStoreContextModel, id: Uid, pageChildrenOnly: boolean): void => {
  if (!pageChildrenOnly) {
    // TODO.
    panic();
  }
  const ves = visualElementsWithId(desktopStore, id);
  ves.forEach(ve => {
    if (ve.get().parent == null) {
      rearrangeVisualElement(desktopStore, ve);
    } else {
      if (isPage(ve.get().parent!.get().item)) {
        rearrangeVisualElement(desktopStore, ve);
      }
    }
  });
}

export const rearrangeVisualElement = (desktopStore: DesktopStoreContextModel, visualElementSignal: VisualElementSignal): void => {
  const ve = visualElementSignal.get();
  if (desktopStore.topLevelPageId() == ve.item.id) {
    arrange(desktopStore);
    return;
  }

  // TODO: this seems too much of a hack...
  let item = visualElementSignal.get().item;
  if (visualElementSignal.get().linkItemMaybe != null) {
    item = visualElementSignal.get().linkItemMaybe!;
  }

  const visualElement = arrangeItem(
    desktopStore,
    item,
    visualElementSignal.get().parent!.get().childAreaBoundsPx!,
    visualElementSignal.get().parent!,
    visualElementSignal.get().parent!.get().isPopup,
    visualElementSignal.get().isPopup).get();

  visualElementSignal.set(visualElement);
}
