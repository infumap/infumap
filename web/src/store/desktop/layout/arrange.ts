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
import { User } from "../../UserStoreProvider";
import { DesktopStoreContextModel } from "../DesktopStoreProvider";
import { isAttachmentsItem } from "../items/base/attachments-item";
import { ITEM_TYPE_PAGE, ITEM_TYPE_TABLE } from "../items/base/item";
import { calcGeometryOfItemInCell, calcGeometryOfItemInPage, calcGeometryOfItemInTable } from "../items/base/item-polymorphism";
import { asPageItem, calcPageInnerSpatialDimensionsBl, isPage } from "../items/page-item";
import { asTableItem, isTable } from "../items/table-item";
import { VisualElement_Reactive } from "../visual-element";


export const switchToPage = (desktopStore: DesktopStoreContextModel, id: Uid, user: User) => {
  batch(() => {
    desktopStore.setCurrentPageId(id);
    arrange(desktopStore, user);
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
  });
}


export let childrenLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadChildItemsIfNotLoaded = (desktopStore: DesktopStoreContextModel, user: User, containerId: string) => {
  if (childrenLoadInitiatedOrComplete[containerId]) {
    return;
  }
  childrenLoadInitiatedOrComplete[containerId] = true;
  server.fetchChildrenWithTheirAttachments(containerId)
    .catch(e => {
      console.log(`Error occurred feching items for '${containerId}': ${e}.`);
    })
    .then(result => {
      if (result != null) {
        batch(() => {
          desktopStore.setChildItemsFromServerObjects(containerId, result.items);
          Object.keys(result.attachments).forEach(id => {
            desktopStore.setAttachmentItemsFromServerObjects(id, result.attachments[id]);
          });
        });
      } else {
        console.log(`No items were fetched for '${containerId}'.`);
      }
    });
}


export const arrange = (desktopStore: DesktopStoreContextModel, user: User): VisualElement_Reactive | null => {
  if (desktopStore.currentPageId() == null) { return null; }
  initiateLoadChildItemsIfNotLoaded(desktopStore, user, desktopStore.currentPageId()!);
  let currentPage = asPageItem(desktopStore.getItem(desktopStore.currentPageId()!)!);
  if (currentPage.arrangeAlgorithm == "grid") {
    return arrange_grid(desktopStore, user);
  } else {
    return arrange_spatialStretch(desktopStore, user);
  }
}


const arrange_grid = (desktopStore: DesktopStoreContextModel, _user: User): VisualElement_Reactive => {
  const currentPage = () => asPageItem(desktopStore.getItem(desktopStore.currentPageId()!)!);
  const pageBoundsPx = () => desktopStore.desktopBoundsPx();

  const numCols = () => 10;
  const numRows = () => Math.ceil(currentPage().computed_children.get().length / numCols());
  const colAspect = () => 1.5;
  const cellWPx = () => pageBoundsPx().w / numCols();
  const cellHPx = () => pageBoundsPx().w / numCols() * (1.0/colAspect());
  const marginPx = () => cellWPx() * 0.01;
  const pageHeightPx = () => numRows() * cellHPx();
  const boundsPx = () => {
    const result = pageBoundsPx();
    result.h = pageHeightPx();
    return result;
  }

  const topLevelVisualElement: VisualElement_Reactive = {
    itemType: ITEM_TYPE_PAGE,
    itemId: currentPage().id,
    isInteractive: true,
    resizingFromBoundsPx: null,
    boundsPx: boundsPx,
    childAreaBoundsPx: boundsPx,
    hitboxes: () => [],
    children: () => [], // replaced below.
    attachments: () => [],
    parent: () => null
  };

  topLevelVisualElement.children = () => {
    const children: Array<VisualElement_Reactive> = [];
    const childItems = currentPage().computed_children.get().map(childId => desktopStore.getItem(childId)!);
    for (let i=0; i<childItems.length; ++i) {
      const item = childItems[i];
      const col = () => i % numCols();
      const row = () => Math.floor(i / numCols());
      const cellBoundsPx = () => ({
        x: col() * cellWPx() + marginPx(),
        y: row() * cellHPx() + marginPx(),
        w: cellWPx() - marginPx() * 2.0,
        h: cellHPx() - marginPx() * 2.0
      });

      let geometry = calcGeometryOfItemInCell(item, cellBoundsPx(), desktopStore.getItem);
      if (!isTable(item)) {
        let ve: VisualElement_Reactive = {
          itemType: item.itemType,
          itemId: item.id,
          isInteractive: true,
          resizingFromBoundsPx: null,
          boundsPx: geometry.boundsPx,
          childAreaBoundsPx: () => null,
          hitboxes: geometry.hitboxes,
          children: () => [],
          attachments: () => [],
          parent: () => topLevelVisualElement,
        };
        children.push(ve);
      } else {
        console.log("TODO: child tables in grid pages.");
      }
    }
    return children;
  }

  return topLevelVisualElement;
}


const arrange_spatialStretch = (desktopStore: DesktopStoreContextModel, user: User): VisualElement_Reactive => {
  const currentPage = () => asPageItem(desktopStore.getItem(desktopStore.currentPageId()!)!);
  const currentPageBoundsPx = () => {
    const desktopAspect = desktopStore.desktopBoundsPx().w / desktopStore.desktopBoundsPx().h;
    const pageAspect = currentPage().naturalAspect;
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
  }

  const topLevelVisualElement: VisualElement_Reactive = {
    itemType: ITEM_TYPE_PAGE,
    itemId: currentPage().id,
    isInteractive: true,
    resizingFromBoundsPx: null,
    boundsPx: currentPageBoundsPx,
    childAreaBoundsPx: currentPageBoundsPx,
    hitboxes: () => [],
    children: () => [], // replaced below.
    attachments: () => [],
    parent: () => null
  };

  const currentPageInnerDimensionsBl = () => calcPageInnerSpatialDimensionsBl(currentPage());

  const page = currentPage(); // avoid capturing this in children() =>.
  topLevelVisualElement.children = () => {
    const topLevelChildren: Array<VisualElement_Reactive> = page.computed_children.get()
      .map(childId => {
        const childItem = () => desktopStore.getItem(childId)!;
        const geometry = calcGeometryOfItemInPage(childItem(), currentPageBoundsPx(), currentPageInnerDimensionsBl(), true, desktopStore.getItem);

        // ### Child is a page with children visible.
        if (isPage(childItem()) &&
            // This test does not depend on pixel size, so is invariant over display devices.
            asPageItem(childItem()).spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
          const pageItem = () => asPageItem(childItem());
          initiateLoadChildItemsIfNotLoaded(desktopStore, user, pageItem().id);

          const pageWithChildrenVe: VisualElement_Reactive = {
            itemType: ITEM_TYPE_PAGE,
            itemId: childId,
            isInteractive: true,
            resizingFromBoundsPx: null,
            boundsPx: geometry.boundsPx,
            childAreaBoundsPx: geometry.boundsPx,
            hitboxes: geometry.hitboxes,
            children: () => [],
            attachments: () => [],
            parent: () => topLevelVisualElement,
          };

          const innerDimensionsBl = () => calcPageInnerSpatialDimensionsBl(pageItem());

          const page = pageItem();
          // innerBoundsPx is boundsPx with x,y == 0,0 and it does not depend on item.spatialPositionGr,
          // so pageWithChildrenVe.children does not depend on this either.
          const innerBoundsPx = geometry.innerBoundsPx;
          pageWithChildrenVe.children = () => {
            return page.computed_children.get().map(childId => {
              const childItem = desktopStore.getItem(childId)!;
              const geometry = calcGeometryOfItemInPage(childItem, innerBoundsPx(), innerDimensionsBl(), false, desktopStore.getItem);
              return {
                itemType: childItem.itemType,
                itemId: childItem.id,
                isInteractive: false,
                resizingFromBoundsPx: null,
                boundsPx: geometry.boundsPx,
                childAreaBoundsPx: () => null,
                hitboxes: () => [],
                children: () => [],
                attachments: () => [],
                parent: () => pageWithChildrenVe
              };
            });
          }
          return pageWithChildrenVe;

        // ### Table
        } else if (isTable(childItem())) {
          initiateLoadChildItemsIfNotLoaded(desktopStore, user, childItem().id);
          let tableItem = () => asTableItem(childItem());

          const sizeBl = () => ({ w: tableItem().spatialWidthGr / GRID_SIZE, h: tableItem().spatialHeightGr / GRID_SIZE });
          const blockSizePx = () => ({ w: geometry.boundsPx().w / sizeBl().w, h: geometry.boundsPx().h / sizeBl().h });

          let childAreaBoundsPx = () => {
            const headerHeightPx = blockSizePx().h * HEADER_HEIGHT_BL;
            return {
              x: geometry.boundsPx().x, y: geometry.boundsPx().y + headerHeightPx,
              w: geometry.boundsPx().w, h: geometry.boundsPx().h - headerHeightPx
            };
          };

          let tableVe: VisualElement_Reactive = {
            itemType: ITEM_TYPE_TABLE,
            itemId: tableItem().id,
            isInteractive: true,
            resizingFromBoundsPx: null,
            boundsPx: geometry.boundsPx,
            childAreaBoundsPx,
            hitboxes: geometry.hitboxes,
            children: () => [],
            attachments: () => [],
            parent: () => topLevelVisualElement
          }

          tableVe.children = () => {
            let tableVeChildren: Array<VisualElement_Reactive> = [];
            for (let idx=0; idx<tableItem().computed_children.get().length; ++idx) {
              const childId = () => tableItem().computed_children.get()[idx];
              const childItem = () => desktopStore.getItem(childId())!;
              const geometry = calcGeometryOfItemInTable(childItem(), blockSizePx(), idx, 0, sizeBl().w, desktopStore.getItem);

              let tableItemVe: VisualElement_Reactive = {
                itemType: childItem().itemType,
                itemId: childItem().id,
                isInteractive: true,
                resizingFromBoundsPx: null,
                boundsPx: geometry.boundsPx,
                hitboxes: geometry.hitboxes,
                children: () => [],
                attachments: () => [],
                childAreaBoundsPx: () => null,
                parent: () => tableVe
              };
              tableVeChildren.push(tableItemVe);
              let attachments: Array<VisualElement_Reactive> = [];

              if (isAttachmentsItem(childItem())) {
          // TODO.
          //       asAttachmentsItem(childItem).computed_attachments.map(attachmentId => desktopStore.getItem(attachmentId)!).forEach(attachmentItem => {
          //         const geometry = calcGeometryOfItemInTable(attachmentItem, blockSizePx, idx, 8, sizeBl.w, desktopStore.getItem);
          //         const boundsPx = {
          //           x: geometry.boundsPx.x,
          //           y: 0.0,
          //           w: geometry.boundsPx.w,
          //           h: geometry.boundsPx.h,
          //         };
          //         let ve = createVisualElementSignal({
          //           itemType: attachmentItem.itemType,
          //           isTopLevel: false,
          //           itemId: attachmentItem.id,
          //           boundsPx,
          //           resizingFromBoundsPx: null,
          //           hitboxes: geometry.hitboxes,
          //           children: [],
          //           attachments: [],
          //           childAreaBoundsPx: null,
          //           parent: tableItemVe
          //         });
          //         attachments.push(ve);
          //       });
              }
            };
            return tableVeChildren;
          }

          return tableVe;

        // ### Any other item type.
        } else {
          const itemVe = {
            itemType: childItem().itemType,
            itemId: childItem().id,
            isInteractive: true,
            resizingFromBoundsPx: null,
            boundsPx: geometry.boundsPx,
            childAreaBoundsPx: () => null,
            hitboxes: geometry.hitboxes,
            children: () => [],
            attachments: () => [], // TODO.
            parent: () => topLevelVisualElement
          };
          // if attachments...
          return itemVe;
        }
      });
    return topLevelChildren;
  }

  return topLevelVisualElement;
}
