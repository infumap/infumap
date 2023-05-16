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
import { server } from "../../../server";
import { Uid } from "../../../util/uid";
import { DesktopStoreContextModel } from "../DesktopStoreProvider";
import { isAttachmentsItem } from "../items/base/attachments-item";
import { asContainerItem } from "../items/base/container-item";
import { ITEM_TYPE_PAGE, ITEM_TYPE_TABLE } from "../items/base/item";
import { calcGeometryOfItemInCell, calcGeometryOfItemInPage, calcGeometryOfItemInTable } from "../items/base/item-polymorphism";
import { asPageItem, calcPageInnerSpatialDimensionsBl, isPage } from "../items/page-item";
import { asTableItem, isTable } from "../items/table-item";
import { VisualElement } from "../visual-element";
import { VisualElementSignal, createVisualElementSignal } from "../../../util/signals";
import { zeroBoundingBoxTopLeft } from "../../../util/geometry";
import { panic } from "../../../util/lang";


export const switchToPage = (desktopStore: DesktopStoreContextModel, id: Uid) => {
  batch(() => {
    desktopStore.setCurrentPageId(id);
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
    arrange(desktopStore); // sets root visual element.
  });
}


export let childrenLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadChildItemsIfNotLoaded = (desktopStore: DesktopStoreContextModel, containerId: string) => {
  if (childrenLoadInitiatedOrComplete[containerId]) {
    return;
  }
  childrenLoadInitiatedOrComplete[containerId] = true;
  server.fetchChildrenWithTheirAttachments(containerId)
    .then(result => {
      if (result != null) {
        batch(() => {
          desktopStore.setChildItemsFromServerObjects(containerId, result.items);
          Object.keys(result.attachments).forEach(id => {
            desktopStore.setAttachmentItemsFromServerObjects(id, result.attachments[id]);
          });
          asContainerItem(desktopStore.getItem(containerId)!).childrenLoaded.set(true);
          rearrangeAllContainerVisualElementsWithId(desktopStore, containerId);
        });
      } else {
        console.log(`No items were fetched for '${containerId}'.`);
      }
    })
    .catch((e: any) => {
      console.log(`Error occurred feching items for '${containerId}': ${e.message}.`);
    });
}

/**
 * Create the visual element tree for the current page.
 * 
 * Design note: Initially, this was implemented such that there was no state (signals) associated with the 
 * visual elements - the display was a pure function of the item tree state. This was simpler from the point
 * of view that the visual elements did not need to be separately updated / managed. However, the functional
 * approach turned out to be a dead end:
 * 1. It was effectively impossible to perfectly optimize it in the case of, for example, resizing pages because
 *    the children were a function of page size. By comparison, as a general comment, the stateful approach makes
 *    it easy to make precisely the optimal updates at precisely the required times. Also, given optimization as
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
  if (desktopStore.currentPageId() == null) { return; }
  initiateLoadChildItemsIfNotLoaded(desktopStore, desktopStore.currentPageId()!);
  let currentPage = asPageItem(desktopStore.getItem(desktopStore.currentPageId()!)!);
  if (currentPage.arrangeAlgorithm == "grid") {
    arrange_grid(desktopStore);
  } else {
    arrange_spatialStretch(desktopStore);
  }
}


const arrange_spatialStretch = (desktopStore: DesktopStoreContextModel) => {
  const currentPage = asPageItem(desktopStore.getItem(desktopStore.currentPageId()!)!);
  const desktopAspect = desktopStore.desktopBoundsPx().w / desktopStore.desktopBoundsPx().h;
  const pageAspect = currentPage.naturalAspect.get();
  const currentPageBoundsPx = (() => {
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

  // the signal for this visual element is fixed, in DesktopStore.
  const topLevelVisualElement: VisualElement = {
    itemType: ITEM_TYPE_PAGE,
    itemId: currentPage.id,
    isInteractive: true,
    resizingFromBoundsPx: null,
    boundsPx: currentPageBoundsPx,
    childAreaBoundsPx: currentPageBoundsPx,
    hitboxes: [],
    children: [], // replaced below.
    attachments: [],
    parent: null
  };

  const currentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(currentPage);

  topLevelVisualElement.children = currentPage.computed_children.get()
    .map(childId => {
      const childItem = desktopStore.getItem(childId)!;
      const geometry = calcGeometryOfItemInPage(childItem, currentPageBoundsPx, currentPageInnerDimensionsBl, true, desktopStore.getItem);

      if (isPage(childItem) &&
          asPageItem(childItem).arrangeAlgorithm == "grid") {
        // Always make sure child items of grid pages are loaded, even if not visible,
        // because they are needed to to calculate the height.
        initiateLoadChildItemsIfNotLoaded(desktopStore, childItem.id);
      }

      // ### Child is a page with children visible.
      if (isPage(childItem) &&
          // This test does not depend on pixel size, so is invariant over display devices.
          asPageItem(childItem).spatialWidthGr.get() / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
        const pageItem = asPageItem(childItem);
        initiateLoadChildItemsIfNotLoaded(desktopStore, pageItem.id);

        const pageWithChildrenVisualElement: VisualElement = {
          itemType: ITEM_TYPE_PAGE,
          itemId: childId,
          isInteractive: true,
          resizingFromBoundsPx: null,
          boundsPx: geometry.boundsPx,
          childAreaBoundsPx: geometry.boundsPx,
          hitboxes: geometry.hitboxes,
          children: [],
          attachments: [],
          parent: desktopStore.rootVisualElement,
        };
        const pageWithChildrenVisualElementSignal = createVisualElementSignal(pageWithChildrenVisualElement);

        const innerDimensionsBl = calcPageInnerSpatialDimensionsBl(pageItem);

        // innerBoundsPx is boundsPx with x,y == 0,0 and it does not depend on item.spatialPositionGr,
        // so pageWithChildrenVe.children does not depend on this either.
        const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);
        pageWithChildrenVisualElement.children = pageItem.computed_children.get().map(childId => {
          const childItem = desktopStore.getItem(childId)!;
          const geometry = calcGeometryOfItemInPage(childItem, innerBoundsPx, innerDimensionsBl, false, desktopStore.getItem);
          const pageVisualElement = {
            itemType: childItem.itemType,
            itemId: childItem.id,
            isInteractive: false,
            resizingFromBoundsPx: null,
            boundsPx: geometry.boundsPx,
            childAreaBoundsPx: null,
            hitboxes: [],
            children: [],
            attachments: [],
            parent: pageWithChildrenVisualElementSignal.get
          };
          return createVisualElementSignal(pageVisualElement);
        });

        return pageWithChildrenVisualElementSignal;

      // ### Table
      } else if (isTable(childItem)) {
        initiateLoadChildItemsIfNotLoaded(desktopStore, childItem.id);
        let tableItem = asTableItem(childItem);

        const sizeBl = { w: tableItem.spatialWidthGr.get() / GRID_SIZE, h: tableItem.spatialHeightGr.get() / GRID_SIZE };
        const blockSizePx = { w: geometry.boundsPx.w / sizeBl.w, h: geometry.boundsPx.h / sizeBl.h };

        let childAreaBoundsPx = (() => {
          const headerHeightPx = blockSizePx.h * HEADER_HEIGHT_BL;
          return {
            x: geometry.boundsPx.x, y: geometry.boundsPx.y + headerHeightPx,
            w: geometry.boundsPx.w, h: geometry.boundsPx.h - headerHeightPx
          };
        })();

        let tableVisualElement: VisualElement = {
          itemType: ITEM_TYPE_TABLE,
          itemId: tableItem.id,
          isInteractive: true,
          resizingFromBoundsPx: null,
          boundsPx: geometry.boundsPx,
          childAreaBoundsPx,
          hitboxes: geometry.hitboxes,
          children: [],
          attachments: [],
          parent: desktopStore.rootVisualElement,
        }
        const tableVisualElementSignal = createVisualElementSignal(tableVisualElement);

        tableVisualElement.children = (() => {
          let tableVeChildren: Array<VisualElementSignal> = [];
          for (let idx=0; idx<tableItem.computed_children.get().length; ++idx) {
            const childId = tableItem.computed_children.get()[idx];
            const childItem = desktopStore.getItem(childId)!;
            const geometry = calcGeometryOfItemInTable(childItem, blockSizePx, idx, 0, sizeBl.w, desktopStore.getItem);

            let tableItemVe: VisualElement = {
              itemType: childItem.itemType,
              itemId: childItem.id,
              isInteractive: true,
              resizingFromBoundsPx: null,
              boundsPx: geometry.boundsPx,
              hitboxes: geometry.hitboxes,
              children: [],
              attachments: [],
              childAreaBoundsPx: null,
              parent: tableVisualElementSignal.get
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

      // ### Any other item type.
      } else {
        const itemVisualElement: VisualElement = {
          itemType: childItem.itemType,
          itemId: childItem.id,
          isInteractive: true,
          resizingFromBoundsPx: null,
          boundsPx: geometry.boundsPx,
          childAreaBoundsPx: null,
          hitboxes: geometry.hitboxes,
          children: [],
          attachments: [], // TODO.
          parent: desktopStore.rootVisualElement,
        };
        // if attachments...
        const itemVisualElementSignal = createVisualElementSignal(itemVisualElement);
        return itemVisualElementSignal;
      }
    });

  // set this last as it triggers the display update.
  desktopStore.setRootVisualElement(topLevelVisualElement);
}


const arrange_grid = (desktopStore: DesktopStoreContextModel): void => {
  const currentPage = asPageItem(desktopStore.getItem(desktopStore.currentPageId()!)!);
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
    itemType: ITEM_TYPE_PAGE,
    itemId: currentPage.id,
    isInteractive: true,
    resizingFromBoundsPx: null,
    boundsPx: boundsPx,
    childAreaBoundsPx: boundsPx,
    hitboxes: [],
    children: [], // replaced below.
    attachments: [],
    parent: null
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
          itemType: item.itemType,
          itemId: item.id,
          isInteractive: true,
          resizingFromBoundsPx: null,
          boundsPx: geometry.boundsPx,
          childAreaBoundsPx: null,
          hitboxes: geometry.hitboxes,
          children: [],
          attachments: [],
          parent: desktopStore.rootVisualElement,
        };
        children.push(createVisualElementSignal(ve));
      } else {
        console.log("TODO: child tables in grid pages.");
      }
    }
    return children;
  })();

  desktopStore.setRootVisualElement(topLevelVisualElement);
}


/**
 * Call after loading children of a container.
 */
export const rearrangeAllContainerVisualElementsWithId = (desktopStore: DesktopStoreContextModel, itemId: Uid): void => {
  const ves = visualElementsWithId(desktopStore, itemId);
  ves.forEach(ve => {
    rearrangeVisualElement(desktopStore, ve);
  });
}

const childVisualElementsWithId = (desktopStore: DesktopStoreContextModel, ve: VisualElement, id: Uid): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  ve.children.forEach(childVes => {
    if (childVes.get().itemId == id) {
      result.push(childVes);
    }
    result = result.concat(childVisualElementsWithId(desktopStore, childVes.get(), id));
  });
  return result;
}

const visualElementsWithId = (desktopStore: DesktopStoreContextModel, id: Uid): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  const rootVe = desktopStore.rootVisualElement();
  if (rootVe.itemId == id) {
    result.push({ get: desktopStore.rootVisualElement, set: desktopStore.setRootVisualElement });
  }
  result = result.concat(childVisualElementsWithId(desktopStore, rootVe, id));
  return result;
}

export const rearrangeVisualElement = (desktopStore: DesktopStoreContextModel, ve: VisualElementSignal): void => {
  if (isTable(ve.get())) {
    rearrangeTable(desktopStore, ve);
  } else if (isPage(ve.get())) {
    rearrangePage(desktopStore, ve);
  } else {
    rearrangeItem(desktopStore, ve);
  }
}

export const rearrangeItem = (desktopStore: DesktopStoreContextModel, ve: VisualElementSignal) => {
  const parent = ve.get().parent;
  if (parent == null) {
    console.log("TODO: not rearranging item because parent is null");
    return;
  }

  const parentVisualElement = parent!();
  const currentPage = asPageItem(desktopStore.getItem(parentVisualElement.itemId)!);
  const currentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(currentPage);
  const currentPageBoundsPx = parentVisualElement.childAreaBoundsPx!;

  const childId = ve.get().itemId;
  const childItem = desktopStore.getItem(ve.get().itemId)!;
  const geometry = calcGeometryOfItemInPage(childItem, currentPageBoundsPx, currentPageInnerDimensionsBl, true, desktopStore.getItem);

  const itemVisualElement: VisualElement = {
    itemType: ve.get().itemType,
    itemId: childId,
    isInteractive: true,
    resizingFromBoundsPx: null,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx: null,
    hitboxes: geometry.hitboxes,
    children: [],
    attachments: [],
    parent: parent,
  };

  ve.set(itemVisualElement);
}

export const rearrangeTable = (desktopStore: DesktopStoreContextModel, ve: VisualElementSignal) => {
  const parent = ve.get().parent;
  if (parent == null) {
    throw new Error(`table ${ve.get().itemId} has no parent.`);
  }

  const parentVisualElement = parent!();
  const currentPage = asPageItem(desktopStore.getItem(parentVisualElement.itemId)!);
  const currentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(currentPage);
  const currentPageBoundsPx = parentVisualElement.childAreaBoundsPx!;

  const childItem = desktopStore.getItem(ve.get().itemId)!;
  const geometry = calcGeometryOfItemInPage(childItem, currentPageBoundsPx, currentPageInnerDimensionsBl, true, desktopStore.getItem);
  let tableItem = asTableItem(childItem);

  const sizeBl = { w: tableItem.spatialWidthGr.get() / GRID_SIZE, h: tableItem.spatialHeightGr.get() / GRID_SIZE };
  const blockSizePx = { w: geometry.boundsPx.w / sizeBl.w, h: geometry.boundsPx.h / sizeBl.h };

  let childAreaBoundsPx = (() => {
    const headerHeightPx = blockSizePx.h * HEADER_HEIGHT_BL;
    return {
      x: geometry.boundsPx.x, y: geometry.boundsPx.y + headerHeightPx,
      w: geometry.boundsPx.w, h: geometry.boundsPx.h - headerHeightPx
    };
  })();

  let tableVisualElement: VisualElement = {
    itemType: ITEM_TYPE_TABLE,
    itemId: tableItem.id,
    isInteractive: true,
    resizingFromBoundsPx: null,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx,
    hitboxes: geometry.hitboxes,
    children: [],
    attachments: [],
    parent: desktopStore.rootVisualElement,
  }

  tableVisualElement.children = (() => {
    let tableVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<tableItem.computed_children.get().length; ++idx) {
      const childId = tableItem.computed_children.get()[idx];
      const childItem = desktopStore.getItem(childId)!;
      const geometry = calcGeometryOfItemInTable(childItem, blockSizePx, idx, 0, sizeBl.w, desktopStore.getItem);

      let tableItemVisualElement: VisualElement = {
        itemType: childItem.itemType,
        itemId: childItem.id,
        isInteractive: true,
        resizingFromBoundsPx: null,
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        children: [],
        attachments: [],
        childAreaBoundsPx: null,
        parent: ve.get
      };
      tableVeChildren.push(createVisualElementSignal(tableItemVisualElement));
      // let attachments: Array<VisualElementSignal> = [];

      if (isAttachmentsItem(childItem)) {
        // TODO.
      }
    };
    return tableVeChildren;
  })();

  ve.set(tableVisualElement);
}

export const rearrangePage = (desktopStore: DesktopStoreContextModel, ve: VisualElementSignal) => {
  const parent = ve.get().parent;
  if (parent == null) {
    console.log("TODO: not rearranging page because parent is null");
    return;
  }

  const parentVisualElement = parent!();
  const currentPage = asPageItem(desktopStore.getItem(parentVisualElement.itemId)!);
  const currentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(currentPage);
  const currentPageBoundsPx = parentVisualElement.childAreaBoundsPx!;

  const childId = ve.get().itemId;
  const childItem = desktopStore.getItem(ve.get().itemId)!;
  const geometry = calcGeometryOfItemInPage(childItem, currentPageBoundsPx, currentPageInnerDimensionsBl, true, desktopStore.getItem);

  const pageVisualElement: VisualElement = {
    itemType: ITEM_TYPE_PAGE,
    itemId: childId,
    isInteractive: true,
    resizingFromBoundsPx: null,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx: geometry.boundsPx,
    hitboxes: geometry.hitboxes,
    children: [],
    attachments: [],
    parent: parent,
  };

  if (// Page children are visible.
      // This test does not depend on pixel size, so is invariant over display devices.
      asPageItem(childItem).spatialWidthGr.get() / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
    const pageItem = asPageItem(childItem);
    initiateLoadChildItemsIfNotLoaded(desktopStore, pageItem.id);

    const innerDimensionsBl = calcPageInnerSpatialDimensionsBl(pageItem);
    const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);

    // TODO (MEDIUM): If these already exist, they don't need to be replaced, only updated.
    pageVisualElement.children = pageItem.computed_children.get().map(childId => {
      const childItem = desktopStore.getItem(childId)!;
      const geometry = calcGeometryOfItemInPage(childItem, innerBoundsPx, innerDimensionsBl, false, desktopStore.getItem);
      const childVisualElement = {
        itemType: childItem.itemType,
        itemId: childItem.id,
        isInteractive: false,
        resizingFromBoundsPx: null,
        boundsPx: geometry.boundsPx,
        childAreaBoundsPx: null,
        hitboxes: [],
        children: [],
        attachments: [],
        parent: ve.get
      };
      return createVisualElementSignal(childVisualElement);
    });
  }

  ve.set(pageVisualElement);
}

