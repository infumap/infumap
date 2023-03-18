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
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { ITEM_TYPE_PAGE, ITEM_TYPE_TABLE } from "../items/base/item";
import { calcGeometryOfAttachmentItem, calcGeometryOfItemInPage } from "../items/base/item-polymorphism";
import { asPageItem, calcPageInnerSpatialDimensionsBl, isPage, PageItem } from "../items/page-item";
import { asTableItem, isTable } from "../items/table-item";
import { createVisualElementSignal, VisualElement, VisualElementSignal } from "../visual-element";


export const arrange = (desktopStore: DesktopStoreContextModel, user: User): void => {
  if (desktopStore.currentPageId() == null) { return; }
  initiateLoadChildItemsIfNotLoaded(desktopStore, user, desktopStore.currentPageId()!);
  let currentPage = asPageItem(desktopStore.getItem(desktopStore.currentPageId()!)!);
  if (currentPage.arrangeAlgorithm == "grid") {
    desktopStore.arrange_grid(currentPage, user);
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
          desktopStore.arrangeItemsInPage(ves);
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
        desktopStore.arrangeItemsInTable(ves);

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
