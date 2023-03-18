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
import { cloneBoundingBox, zeroTopLeft } from "../../../util/geometry";
import { panic } from "../../../util/lang";
import { Uid } from "../../../util/uid";
import { User } from "../../UserStoreProvider";
import { DesktopStoreContextModel } from "../DesktopStoreProvider";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { isContainer } from "../items/base/container-item";
import { ITEM_TYPE_PAGE, ITEM_TYPE_TABLE } from "../items/base/item";
import { calcGeometryOfAttachmentItem, calcGeometryOfItemInCell, calcGeometryOfItemInPage, calcGeometryOfItemInTable } from "../items/base/item-polymorphism";
import { asPageItem, calcPageInnerSpatialDimensionsBl, isPage, PageItem } from "../items/page-item";
import { asTableItem, isTable } from "../items/table-item";
import { createVisualElementSignal, VisualElement, VisualElementSignal } from "../visual-element";


export const arrange = (desktopStore: DesktopStoreContextModel, user: User): void => {
  if (desktopStore.currentPageId() == null) { return; }
  initiateLoadChildItemsIfNotLoaded(desktopStore, user, desktopStore.currentPageId()!);
  let currentPage = asPageItem(desktopStore.getItem(desktopStore.currentPageId()!)!);
  if (currentPage.arrangeAlgorithm == "grid") {
    arrange_grid(desktopStore, currentPage, user);
  } else {
    arrange_spatialStretch(desktopStore, currentPage, user);
  }
}

export const switchToPage = (desktopStore: DesktopStoreContextModel, id: Uid, user: User) => {
  batch(() => {
    desktopStore.setCurrentPageId(id);
    arrange(desktopStore, user);
    var page = asPageItem(desktopStore.getItem(id)!);
    // TODO (HIGH): get rid of this horrible hack!
    let desktopEl = window.document.getElementById("desktop")!;
    desktopEl.scrollTop = 0;
    desktopEl.scrollLeft = 0;
    // TODO (MEDIUM): retain these.
    page.setScrollXPx(0);
    page.setScrollYPx(0);
  });
}

export let childrenLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadChildItemsIfNotLoaded = (desktopStore: DesktopStoreContextModel, user: User, containerId: string) => {
  if (childrenLoadInitiatedOrComplete[containerId]) {
    return;
  }
  childrenLoadInitiatedOrComplete[containerId] = true;
  server.fetchChildrenWithTheirAttachments(user, containerId)
    .catch(e => {
      console.log(`Error occurred feching items for '${containerId}': ${e}.`);
    })
    .then(result => {
      if (result != null) {
        batch(() => {
          desktopStore.setChildItems(containerId, result.items);
          Object.keys(result.attachments).forEach(id => {
            desktopStore.setAttachmentItems(id, result.attachments[id]);
          });
          arrange(desktopStore, user);
        });
      } else {
        console.log(`No items were fetched for '${containerId}'.`);
      }
    });
}


const arrange_spatialStretch = (desktopStore: DesktopStoreContextModel, currentPage: PageItem, user: User): void => {
  let currentPageBoundsPx = desktopStore.desktopBoundsPx();

  const desktopAspect = desktopStore.desktopBoundsPx().w / desktopStore.desktopBoundsPx().h;
  const pageAspect = currentPage.naturalAspect;
  // TODO (MEDIUM): make these cutoff aspect ratios configurable in user settings.
  if (pageAspect / desktopAspect > 1.25) {
    // page to scroll horizontally.
    currentPageBoundsPx.w = Math.round(currentPageBoundsPx.h * pageAspect);
  } else if (pageAspect / desktopAspect < 0.75) {
    // page needs to scroll vertically.
    currentPageBoundsPx.h = Math.round(currentPageBoundsPx.w / pageAspect);
  }

  let topLevelVisualElement: VisualElement = {
    itemType: ITEM_TYPE_PAGE,
    isTopLevel: true,
    itemId: currentPage.id,
    boundsPx: currentPageBoundsPx,
    resizingFromBoundsPx: null,
    childAreaBoundsPx: currentPageBoundsPx,
    hitboxes: [],
    children: [],
    attachments: [],
    parent: null
  };
  desktopStore.setTopLevelVisualElement(topLevelVisualElement);
  let topLevelChildren: Array<VisualElementSignal> = [];

  let currentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(currentPage, desktopStore.getItem);
  currentPage.computed_children.map(childId => desktopStore.getItem(childId)!)
    .forEach(childItem => {
      let geometry = calcGeometryOfItemInPage(childItem, currentPageBoundsPx, currentPageInnerDimensionsBl, true, desktopStore.getItem);
      let ves: VisualElementSignal;

      // ### page
      if (isPage(childItem)) {
        let pageItem = asPageItem(childItem);
        // This test does not depend on pixel size, so is invariant over display devices.
        if (pageItem.spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
          initiateLoadChildItemsIfNotLoaded(desktopStore, user, pageItem.id);
          let pageVe: VisualElement = {
            itemType: ITEM_TYPE_PAGE,
            isTopLevel: true,
            itemId: childItem.id,
            boundsPx: geometry.boundsPx,
            resizingFromBoundsPx: null,
            childAreaBoundsPx: geometry.boundsPx,
            hitboxes: geometry.hitboxes,
            children: [],
            attachments: [],
            parent: desktopStore.getTopLevelVisualElementSignalNotNull()
          };
          ves = createVisualElementSignal(pageVe);
          arrangeItemsInPage(desktopStore, ves);
        } else {
          ves = createVisualElementSignal({
            itemType: ITEM_TYPE_PAGE,
            isTopLevel: true,
            itemId: childItem.id,
            boundsPx: geometry.boundsPx,
            resizingFromBoundsPx: null,
            childAreaBoundsPx: null,
            hitboxes: geometry.hitboxes,
            children: [],
            attachments: [],
            parent: desktopStore.getTopLevelVisualElementSignalNotNull()
          });
        }

      // ### table
      } else if (isTable(childItem)) {
        initiateLoadChildItemsIfNotLoaded(desktopStore, user, childItem.id);
        let tableItem = asTableItem(childItem);
        const sizeBl = { w: tableItem.spatialWidthGr / GRID_SIZE, h: tableItem.spatialHeightGr / GRID_SIZE };
        const blockSizePx = { w: geometry.boundsPx.w / sizeBl.w, h: geometry.boundsPx.h / sizeBl.h };
        const headerHeightPx = blockSizePx.h * HEADER_HEIGHT_BL;
        let tableVe: VisualElement = {
          itemType: ITEM_TYPE_TABLE,
          isTopLevel: true,
          itemId: tableItem.id,
          boundsPx: geometry.boundsPx,
          resizingFromBoundsPx: null,
          childAreaBoundsPx: {
            x: geometry.boundsPx.x, y: geometry.boundsPx.y + headerHeightPx,
            w: geometry.boundsPx.w, h: geometry.boundsPx.h - headerHeightPx
          },
          hitboxes: geometry.hitboxes,
          children: [],
          attachments: [],
          parent: desktopStore.getTopLevelVisualElementSignalNotNull()
        }
        ves = createVisualElementSignal(tableVe);
        arrangeItemsInTable(desktopStore, ves);

      // ### other
      } else {
        ves = createVisualElementSignal({
          itemType: childItem.itemType,
          isTopLevel: true,
          itemId: childItem.id,
          boundsPx: geometry.boundsPx,
          resizingFromBoundsPx: null,
          childAreaBoundsPx: null,
          hitboxes: geometry.hitboxes,
          children: [],
          attachments: [],
          parent: desktopStore.getTopLevelVisualElementSignalNotNull()
        });
      }

      topLevelChildren.push(ves);

      if (isAttachmentsItem(childItem)) {
        asAttachmentsItem(childItem).computed_attachments.map(attachmentId => desktopStore.getItem(attachmentId)!).forEach(attachmentItem => {
          const geom = calcGeometryOfAttachmentItem(attachmentItem, geometry.boundsPx, 0, desktopStore.getItem);
          let aves = createVisualElementSignal({
            itemType: attachmentItem.itemType,
            isTopLevel: true,
            itemId: attachmentItem.id,
            boundsPx: geom.boundsPx,
            resizingFromBoundsPx: null,
            childAreaBoundsPx: null,
            hitboxes: geom.hitboxes,
            children: [],
            attachments: [],
            parent: ves
          });
          ves.update(prev => { prev.attachments.push(aves); });
        });
      }

    });

  desktopStore.setTopLevelVisualElement(prev => {
    prev!.children = topLevelChildren;
    return prev;
  });
}


export const arrange_grid = (destopStore: DesktopStoreContextModel, currentPage: PageItem, _user: User): void => {
  const pageBoundsPx = destopStore.desktopBoundsPx();

  const numCols = 10;
  const colAspect = 1.5;
  const cellWPx = pageBoundsPx.w / numCols;
  const cellHPx = pageBoundsPx.w / numCols * (1.0/colAspect);
  const marginPx = cellWPx * 0.01;

  let topLevelVisualElement: VisualElement = {
    itemType: ITEM_TYPE_PAGE,
    isTopLevel: true,
    itemId: currentPage.id,
    boundsPx: cloneBoundingBox(pageBoundsPx)!,
    resizingFromBoundsPx: null,
    childAreaBoundsPx: cloneBoundingBox(pageBoundsPx)!,
    hitboxes: [],
    children: [],
    attachments: [],
    parent: destopStore.getTopLevelVisualElementSignalNotNull()
  };
  let topLevelChildren: Array<VisualElementSignal> = [];
  destopStore.setTopLevelVisualElement(topLevelVisualElement);

  const children = currentPage.computed_children.map(childId => destopStore.getItem(childId)!);
  for (let i=0; i<children.length; ++i) {
    const item = children[i];
    const col = i % numCols;
    const row = Math.floor(i / numCols);
    const cellBoundsPx = {
      x: col * cellWPx + marginPx,
      y: row * cellHPx + marginPx,
      w: cellWPx - marginPx * 2.0,
      h: cellHPx - marginPx * 2.0
    };

    let geometry = calcGeometryOfItemInCell(item, cellBoundsPx, destopStore.getItem);
    if (!isContainer(item)) {
      let ve: VisualElement = {
        itemType: item.itemType,
        isTopLevel: true,
        itemId: item.id,
        boundsPx: geometry.boundsPx,
        resizingFromBoundsPx: null,
        hitboxes: geometry.hitboxes,
        children: [],
        attachments: [],
        childAreaBoundsPx: null,
        parent: destopStore.getTopLevelVisualElementSignalNotNull()
      };
      topLevelChildren.push(createVisualElementSignal(ve));
    } else {
      console.log("TODO: child containers in grid pages.");
    }
  }

  const numRows = Math.ceil(children.length / numCols);
  let pageHeightPx = numRows * cellHPx;

  destopStore.setTopLevelVisualElement(prev => {
    prev!.children = topLevelChildren;
    prev!.boundsPx.h = pageHeightPx;
    prev!.childAreaBoundsPx!.h = pageHeightPx;
    return prev;
  });
}


/**
 * (Re)arranges a visual element that is a child of the top level page visual element.
 *
 * @param visualElementSignal the visual element to arrange.
 * @param user in case a load of the child items of the element needs to be initiated.
 */
export const arrangeVisualElement = (desktopStore: DesktopStoreContextModel, visualElementSignal: VisualElementSignal, user: User, updateChildren: boolean) => {
  const visualElement = visualElementSignal.get();
  if (visualElement.parent == null) { panic(); }
  if (visualElement.parent.get().itemId != desktopStore.getTopLevelVisualElement()!.itemId) { panic(); }

  const parentBoundsPx = zeroTopLeft(cloneBoundingBox(visualElement.parent!.get().boundsPx)!);
  const item = desktopStore.getItem(visualElement.itemId)!;
  const parentPage = asPageItem(desktopStore.getItem(visualElement.parent!.get().itemId)!);
  const parentInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(parentPage, desktopStore.getItem);
  const newGeometry = calcGeometryOfItemInPage(item, parentBoundsPx, parentInnerDimensionsBl, true, desktopStore.getItem);

  if (isPage(visualElement)) {
    visualElementSignal.update(ve => {
      ve.boundsPx = newGeometry.boundsPx;
      ve.childAreaBoundsPx = newGeometry.boundsPx;
      ve.hitboxes = newGeometry.hitboxes;
    });
    if (updateChildren) {
      batch(() => {
        if (asPageItem(item).spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
          initiateLoadChildItemsIfNotLoaded(desktopStore, user, item.id);
          arrangeItemsInPage(desktopStore, visualElementSignal);
        } else {
          if (visualElement.children.length != 0) {
            visualElementSignal.update(ve => { ve.children = []; });
          }
        }
      });
    }

  } else if (isTable(visualElement)) {
    const tableItem = asTableItem(desktopStore.getItem(visualElement.itemId)!);
    const boundsPx = visualElement.boundsPx;
    const sizeBl = { w: tableItem.spatialWidthGr / GRID_SIZE, h: tableItem.spatialHeightGr / GRID_SIZE };
    const blockSizePx = { w: boundsPx.w / sizeBl.w, h: boundsPx.h / sizeBl.h };
    const headerHeightPx = blockSizePx.h * HEADER_HEIGHT_BL;
    const childAreaBoundsPx = {
      x: boundsPx.x, y: boundsPx.y + headerHeightPx,
      w: boundsPx.w, h: boundsPx.h - headerHeightPx
    };
    visualElementSignal.update(ve => {
      ve.boundsPx = newGeometry.boundsPx;
      ve.childAreaBoundsPx = childAreaBoundsPx
      ve.hitboxes = newGeometry.hitboxes;
    });
    if (updateChildren) {
      batch(() => {
        arrangeItemsInTable(desktopStore, visualElementSignal);
      });
    }

  } else {
    visualElementSignal.update(ve => {
      ve.boundsPx = newGeometry.boundsPx;
      ve.hitboxes = newGeometry.hitboxes;
    });
  }
};



export const arrangeItemsInPage = (desktopStore: DesktopStoreContextModel, visualElementSignal: VisualElementSignal) => {
  const visualElement = visualElementSignal.get();
  const pageItem = asPageItem(desktopStore.getItem(visualElement.itemId)!);

  let children: Array<VisualElementSignal> = [];

  const innerBoundsPx = zeroTopLeft(cloneBoundingBox(visualElement.boundsPx)!);
  const innerDimensionsBl = calcPageInnerSpatialDimensionsBl(pageItem, desktopStore.getItem);

  pageItem.computed_children.forEach(childId => {
    const childItem = desktopStore.getItem(childId)!;
    const geometry = calcGeometryOfItemInPage(childItem, innerBoundsPx, innerDimensionsBl, true, desktopStore.getItem);
    children.push(createVisualElementSignal({
      itemType: childItem.itemType,
      isTopLevel: false,
      itemId: childItem.id,
      boundsPx: geometry.boundsPx,
      resizingFromBoundsPx: null,
      childAreaBoundsPx: null,
      hitboxes: geometry.hitboxes,
      children: [],
      attachments: [],
      parent: visualElementSignal
    }));
  });

  visualElementSignal.update(ve => { ve.children = children; });
}


export const arrangeItemsInTable = (desktopStore: DesktopStoreContextModel, visualElementSignal: VisualElementSignal) => {
  const visualElement = visualElementSignal.get();
  const tableItem = asTableItem(desktopStore.getItem(visualElement.itemId)!);

  const sizeBl = { w: tableItem.spatialWidthGr / GRID_SIZE, h: tableItem.spatialHeightGr / GRID_SIZE };
  const blockSizePx = { w: visualElement.boundsPx.w / sizeBl.w, h: visualElement.boundsPx.h / sizeBl.h };

  let tableVeChildren: Array<VisualElementSignal> = [];
  for (let idx=0; idx<tableItem.computed_children.length; ++idx) {
    const childId = tableItem.computed_children[idx];
    const childItem = desktopStore.getItem(childId)!;
    const geometry = calcGeometryOfItemInTable(childItem, blockSizePx, idx, 0, sizeBl.w, desktopStore.getItem);

    let tableItemVe = createVisualElementSignal({
      itemType: childItem.itemType,
      isTopLevel: false,
      itemId: childItem.id,
      boundsPx: geometry.boundsPx,
      resizingFromBoundsPx: null,
      hitboxes: geometry.hitboxes,
      children: [],
      attachments: [],
      childAreaBoundsPx: null,
      parent: visualElementSignal
    });
    tableVeChildren.push(tableItemVe);
    let attachments: Array<VisualElementSignal> = [];

    if (isAttachmentsItem(childItem)) {
      asAttachmentsItem(childItem).computed_attachments.map(attachmentId => desktopStore.getItem(attachmentId)!).forEach(attachmentItem => {
        const geometry = calcGeometryOfItemInTable(attachmentItem, blockSizePx, idx, 8, sizeBl.w, desktopStore.getItem);
        const boundsPx = {
          x: geometry.boundsPx.x,
          y: 0.0,
          w: geometry.boundsPx.w,
          h: geometry.boundsPx.h,
        };
        let ve = createVisualElementSignal({
          itemType: attachmentItem.itemType,
          isTopLevel: false,
          itemId: attachmentItem.id,
          boundsPx,
          resizingFromBoundsPx: null,
          hitboxes: geometry.hitboxes,
          children: [],
          attachments: [],
          childAreaBoundsPx: null,
          parent: tableItemVe
        });
        attachments.push(ve);
      });
    }
    tableItemVe.update(prev => { prev.attachments = attachments; });
  }

  visualElementSignal.update(ve => { ve.children = tableVeChildren; });
}