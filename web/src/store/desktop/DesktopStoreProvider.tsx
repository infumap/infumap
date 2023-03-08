/*
  Copyright (C) 2022-2023 The Infumap Authors
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

import { Accessor, batch, createSignal, JSX, Setter } from "solid-js";
import { createContext, useContext } from "solid-js";
import { panic, throwExpression } from "../../util/lang";
import { Item, ITEM_TYPE_PAGE, ITEM_TYPE_TABLE } from "./items/base/item";
import { calcGeometryOfAttachmentItem, calcGeometryOfItemInCell, calcGeometryOfItemInPage, calcGeometryOfItemInTable } from "./items/base/item-polymorphism";
import { EMPTY_UID, Uid } from "../../util/uid";
import { Attachment, Child, NoParent } from "./relationship-to-parent";
import { asContainerItem, ContainerItem, isContainer } from "./items/base/container-item";
import { compareOrderings, newOrderingAtEnd } from "../../util/ordering";
import { BoundingBox, cloneBoundingBox, Dimensions, zeroTopLeft } from "../../util/geometry";
import { CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_SIZE, TOOLBAR_WIDTH } from "../../constants";
import { asPageItem, calcPageInnerSpatialDimensionsBl, isPage, PageItem } from "./items/page-item";
import { User } from "../UserStoreProvider";
import { asTableItem, isTable } from "./items/table-item";
import { HEADER_HEIGHT_BL } from "../../components/items/Table";
import { server } from "../../server";
import { asAttachmentsItem, AttachmentsItem, isAttachmentsItem } from "./items/base/attachments-item";
import { createVisualElementSignal, VisualElement, VisualElementSignal } from "./visual-element";


export interface DesktopStoreContextModel {
  setRootId: Setter<Uid | null>,
  setChildItems: (parentId: Uid, items: Array<Item>) => void,
  setAttachmentItems: (parentId: Uid, items: Array<Item>) => void
  updateItem: (id: Uid, f: (item: Item) => void) => void,
  updateContainerItem: (id: Uid, f: (item: ContainerItem) => void) => void,
  getItem: (id: Uid) => (Item | null) | null,
  addItem: (item: Item) => void,
  newOrderingAtEndOfChildren: (parentId: Uid) => Uint8Array,

  arrangeVisualElement: (visualElement: VisualElementSignal, user: User, updateChildren: boolean) => void,
  arrange: (user: User) => void,

  desktopBoundsPx: () => BoundingBox,
  resetDesktopSizePx: () => void,

  currentPageId: Accessor<Uid | null>,
  switchToPage: (id: Uid, user: User) => void,

  childrenLoadInitiatedOrComplete: { [id: Uid]: boolean },

  getTopLevelVisualElement: Accessor<VisualElement | null>,
  getTopLevelVisualElementSignalNotNull: () => VisualElementSignal,
}

export interface DesktopStoreContextProps {
  children: JSX.Element
}

const DesktopStoreContext = createContext<DesktopStoreContextModel>();


interface ItemSignal {
  item: Accessor<Item>,
  setItem: Setter<Item>,
}


function createItemSignal(item: Item): ItemSignal {
  let [itemAccessor, itemSetter] = createSignal<Item>(item, { equals: false });
  return { item: itemAccessor, setItem: itemSetter };
}


export function DesktopStoreProvider(props: DesktopStoreContextProps) {
  const [_rootId, setRootId] = createSignal<Uid | null>(null, { equals: false });
  let items: { [id: Uid]: ItemSignal } = {};
  let childrenLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};
  const [currentPageId, setCurrentPageId] = createSignal<Uid | null>(null, { equals: false });
  const [desktopSizePx, setDesktopSizePx] = createSignal<Dimensions>(currentDesktopSize(), { equals: false });
  const [getTopLevelVisualElement, setTopLevelVisualElement] = createSignal<VisualElement | null>(null, { equals: false });
  // TODO: Need some way to keep track of parent pages that haven't been loaded yet.

  const getTopLevelVisualElementSignalNotNull = () => {
    return {
      get: () => {
        const result = getTopLevelVisualElement();
        if (result == null) { panic(); }
        return result!;
      },
      set: (visualElement: any) => { // TODO (LOW): work out typing.
        if (visualElement == null) { panic(); }
        setTopLevelVisualElement(visualElement);
        return visualElement;
      },
      update: (f: (visualElement: VisualElement) => void) => {
        setTopLevelVisualElement(prev => {
          if (prev == null) { panic(); }
          f(prev);
          return prev;
        });
      }
    };
  }

  const updateItem = (id: Uid, f: (item: Item) => void): void => {
    if (items.hasOwnProperty(id)) {
      let item = items[id].item();
      f(item);
      items[id].setItem(item);
    } else {
      panic();
    }
  };

  const updateContainerItem = (id: Uid, f: (item: ContainerItem) => void): void => {
    if (items.hasOwnProperty(id)) {
      let item = asContainerItem(items[id].item());
      f(item);
      items[id].setItem(item);
    } else {
      panic();
    }
  }

  const getItem = (id: Uid): Item | null => {
    if (items.hasOwnProperty(id)) {
      return items[id].item();
    }
    return null;
  };


  /**
   * Set all the child items of a container.
   * Special Case (for efficiency): If the container is the root page, then the child items list contains
   *  the root page item as well.
   *
   * @param parentId The id of the parent to set child items of.
   * @param childItems The child items.
   */
  const setChildItems = (parentId: Uid, childItems: Array<Item>): void => {
    batch(() => {
      childItems.forEach(childItem => { items[childItem.id] = createItemSignal(childItem); });
      if (!isContainer(getItem(parentId)!)) {
        throwExpression(`Cannot set ${childItems.length} child items of parent '${parentId}' because it is not a container.`);
      }
      childItems.forEach(childItem => {
        if (childItem.parentId == EMPTY_UID) {
          if (childItem.relationshipToParent != NoParent) { panic(); }
        } else {
          if (childItem.parentId != parentId) {
            throwExpression(`Child item had parent '${childItem.parentId}', but '${parentId}' was expected.`);
          }
          updateItem(childItem.parentId, parentItem => {
            if (childItem.relationshipToParent != Child) {
              throwExpression(`Unexpected relationship to parent ${childItem.relationshipToParent}`);
            }
            (parentItem as ContainerItem).computed_children = [...(parentItem as ContainerItem).computed_children, childItem.id];
          });
        }
      });
      updateItem(parentId, parentItem => {
        (parentItem as ContainerItem).computed_children.sort(
          (a, b) => compareOrderings(getItem(a)!.ordering, getItem(b)!.ordering));
      });
    });
  };


  const setAttachmentItems = (parentId: Uid, attachmentItems: Array<Item>): void => {
    batch(() => {
      if (!isAttachmentsItem(getItem(parentId)!)) {
        throwExpression(`Cannot attach ${attachmentItems.length} items to parent '${parentId}' because it has type '${getItem(parentId)!.itemType}' which does not allow attachments.`);
      }
      attachmentItems.forEach(attachmentItem => {
        items[attachmentItem.id] = createItemSignal(attachmentItem);
        if (attachmentItem.parentId != parentId) {
          throwExpression(`Attachment item had parent '${attachmentItem.parentId}', but '${parentId}' was expected.`);
        }
        updateItem(attachmentItem.parentId, parentItem => {
          if (attachmentItem.relationshipToParent != Attachment) {
            throwExpression(`Unexpected relationship to parent ${attachmentItem.relationshipToParent}`);
          }
          (parentItem as AttachmentsItem).computed_attachments = [...(parentItem as AttachmentsItem).computed_attachments, attachmentItem.id];
        });
      });
      updateItem(parentId, parentItem => {
        (parentItem as AttachmentsItem).computed_attachments.sort(
          (a, b) => compareOrderings(getItem(a)!.ordering, getItem(b)!.ordering));
      });
    });
  };


  const addItem = (item: Item): void => {
    batch(() => {
      items[item.id] = createItemSignal(item);
      if (item.relationshipToParent == Child) {
        updateItem(item.parentId, parentItem => {
          if (!isContainer(parentItem)) { panic(); }
          (parentItem as ContainerItem).computed_children = [...(parentItem as ContainerItem).computed_children, item.id];
        })
      } else {
        throwExpression("only support child relationships currently");
      }
    });
  }


  /**
   * (Re)arranges a visual element that is a child of the top level page visual element.
   * 
   * @param visualElementSignal the visual element to arrange.
   * @param user in case a load of the child items of the element needs to be initiated.
   */
  const arrangeVisualElement = (visualElementSignal: VisualElementSignal, user: User, updateChildren: boolean) => {
    const visualElement = visualElementSignal.get();
    if (visualElement.parent == null) { panic(); }
    if (visualElement.parent.get().itemId != getTopLevelVisualElement()!.itemId) { panic(); }

    const parentBoundsPx = zeroTopLeft(cloneBoundingBox(visualElement.parent!.get().boundsPx)!);
    const item = getItem(visualElement.itemId)!;
    const parentPage = asPageItem(getItem(visualElement.parent!.get().itemId)!);
    const parentInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(parentPage, getItem);
    const newGeometry = calcGeometryOfItemInPage(item, parentBoundsPx, parentInnerDimensionsBl, true, getItem);

    if (isPage(visualElement)) {
      visualElementSignal.update(ve => {
        ve.boundsPx = newGeometry.boundsPx;
        ve.childAreaBoundsPx = newGeometry.boundsPx;
        ve.hitboxes = newGeometry.hitboxes;
      });
      if (updateChildren) {
        batch(() => {
          if (asPageItem(item).spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
            initiateLoadChildItemsIfNotLoaded(user, item.id);
            arrangeItemsInPage(visualElementSignal);
          } else {
            if (visualElement.children.length != 0) {
              visualElementSignal.update(ve => { ve.children = []; });
            }
          }
        });
      }

    } else if (isTable(visualElement)) {
      const tableItem = asTableItem(getItem(visualElement.itemId)!);
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
          arrangeItemsInTable(visualElementSignal);
        });
      }

    } else {
      visualElementSignal.update(ve => {
        ve.boundsPx = newGeometry.boundsPx;
        ve.hitboxes = newGeometry.hitboxes;
      });
    }
  };


  const arrangeItemsInPage = (visualElementSignal: VisualElementSignal) => {
    const visualElement = visualElementSignal.get();
    const pageItem = asPageItem(getItem(visualElement.itemId)!);

    let children: Array<VisualElementSignal> = [];

    const innerBoundsPx = zeroTopLeft(cloneBoundingBox(visualElement.boundsPx)!);
    const innerDimensionsBl = calcPageInnerSpatialDimensionsBl(pageItem, getItem);

    pageItem.computed_children.forEach(childId => {
      const childItem = getItem(childId)!;
      const geometry = calcGeometryOfItemInPage(childItem, innerBoundsPx, innerDimensionsBl, true, getItem);
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


  const arrangeItemsInTable = (visualElementSignal: VisualElementSignal) => {
    const visualElement = visualElementSignal.get();
    const tableItem = asTableItem(getItem(visualElement.itemId)!);

    const sizeBl = { w: tableItem.spatialWidthGr / GRID_SIZE, h: tableItem.spatialHeightGr / GRID_SIZE };
    const blockSizePx = { w: visualElement.boundsPx.w / sizeBl.w, h: visualElement.boundsPx.h / sizeBl.h };

    let tableVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<tableItem.computed_children.length; ++idx) {
      const childId = tableItem.computed_children[idx];
      const childItem = getItem(childId)!;
      const geometry = calcGeometryOfItemInTable(childItem, blockSizePx, idx, 0, sizeBl.w, getItem);

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
        asAttachmentsItem(childItem).computed_attachments.map(attachmentId => getItem(attachmentId)!).forEach(attachmentItem => {
          const geometry = calcGeometryOfItemInTable(attachmentItem, blockSizePx, idx, 8, sizeBl.w, getItem);
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


  const arrange_spatialStretch = (currentPage: PageItem, user: User): void => {
    let currentPageBoundsPx = desktopBoundsPx();

    const desktopAspect = desktopBoundsPx().w / desktopBoundsPx().h;
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
    setTopLevelVisualElement(topLevelVisualElement);
    let topLevelChildren: Array<VisualElementSignal> = [];

    let currentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(currentPage, getItem);
    currentPage.computed_children.map(childId => getItem(childId)!)
      .forEach(childItem => {
        let geometry = calcGeometryOfItemInPage(childItem, currentPageBoundsPx, currentPageInnerDimensionsBl, true, getItem);
        let ves: VisualElementSignal;

        // ### page
        if (isPage(childItem)) {
          let pageItem = asPageItem(childItem);
          // This test does not depend on pixel size, so is invariant over display devices.
          if (pageItem.spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
            initiateLoadChildItemsIfNotLoaded(user, pageItem.id);
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
              parent: getTopLevelVisualElementSignalNotNull()
            };
            ves = createVisualElementSignal(pageVe);
            arrangeItemsInPage(ves);
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
              parent: getTopLevelVisualElementSignalNotNull()
            });
          }

        // ### table
        } else if (isTable(childItem)) {
          initiateLoadChildItemsIfNotLoaded(user, childItem.id);
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
            parent: getTopLevelVisualElementSignalNotNull()
          }
          ves = createVisualElementSignal(tableVe);
          arrangeItemsInTable(ves);

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
            parent: getTopLevelVisualElementSignalNotNull()
          });
        }

        topLevelChildren.push(ves);

        if (isAttachmentsItem(childItem)) {
          asAttachmentsItem(childItem).computed_attachments.map(attachmentId => getItem(attachmentId)!).forEach(attachmentItem => {
            const geom = calcGeometryOfAttachmentItem(attachmentItem, geometry.boundsPx, 0, getItem);
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

    setTopLevelVisualElement(prev => {
      prev!.children = topLevelChildren;
      return prev;
    });
  }


  const arrange_grid = (currentPage: PageItem, _user: User): void => {
    const pageBoundsPx = desktopBoundsPx();

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
      parent: getTopLevelVisualElementSignalNotNull()
    };
    let topLevelChildren: Array<VisualElementSignal> = [];
    setTopLevelVisualElement(topLevelVisualElement);

    const children = currentPage.computed_children.map(childId => getItem(childId)!);
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

      let geometry = calcGeometryOfItemInCell(item, cellBoundsPx, getItem);
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
        parent: getTopLevelVisualElementSignalNotNull()
      };
      topLevelChildren.push(createVisualElementSignal(ve));
    }

    const numRows = Math.ceil(children.length / numCols);
    let pageHeightPx = numRows * cellHPx;

    setTopLevelVisualElement(prev => {
      prev!.children = topLevelChildren;
      prev!.boundsPx.h = pageHeightPx;
      prev!.childAreaBoundsPx!.h = pageHeightPx;
      return prev;
    });
  }


  const arrange = (user: User): void => {
    if (currentPageId() == null) { return; }
    initiateLoadChildItemsIfNotLoaded(user, currentPageId()!);
    let currentPage = asPageItem(getItem(currentPageId()!)!);
    if (currentPage.arrangeAlgorithm == "grid") {
      arrange_grid(currentPage, user);
    } else {
      arrange_spatialStretch(currentPage, user);
    }
  }


  const initiateLoadChildItemsIfNotLoaded = (user: User, containerId: string) => {
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
            setChildItems(containerId, result.items);
            Object.keys(result.attachments).forEach(id => {
              setAttachmentItems(id, result.attachments[id]);
            });
            arrange(user);
          });
        } else {
          console.log(`No items were fetched for '${containerId}'.`);
        }
      });
  }


  const newOrderingAtEndOfChildren = (parentId: Uid): Uint8Array => {
    let parent = asContainerItem(items[parentId].item());
    let children = parent.computed_children.map(c => items[c].item().ordering);
    return newOrderingAtEnd(children);
  }


  function currentDesktopSize(): Dimensions {
    let rootElement = document.getElementById("root") ?? panic();
    return { w: rootElement.clientWidth - TOOLBAR_WIDTH, h: rootElement.clientHeight };
  }


  const resetDesktopSizePx = () => { setDesktopSizePx(currentDesktopSize()); }
  const desktopBoundsPx = () => {
    const dimensionsPx = desktopSizePx();
    return { x: 0.0, y: 0.0, w: dimensionsPx.w, h: dimensionsPx.h }
  }


  const switchToPage = (id: Uid, user: User) => {
    batch(() => {
      setCurrentPageId(id);
      arrange(user);
      var page = asPageItem(getItem(id)!);
      // TODO (HIGH): get rid of this horrible hack!
      let desktopEl = window.document.getElementById("desktop")!;
      desktopEl.scrollTop = 0;
      desktopEl.scrollLeft = 0;
      // TODO (MEDIUM): retain these.
      page.setScrollXPx(0);
      page.setScrollYPx(0);
    });
  }

  const value: DesktopStoreContextModel = {
    currentPageId, switchToPage,
    desktopBoundsPx, resetDesktopSizePx,
    setRootId, setChildItems, setAttachmentItems,
    updateItem, updateContainerItem,
    getItem, addItem, newOrderingAtEndOfChildren,
    arrangeVisualElement, arrange,
    childrenLoadInitiatedOrComplete,
    getTopLevelVisualElement,
    getTopLevelVisualElementSignalNotNull,
  };

  return (
    <DesktopStoreContext.Provider value={value}>
      {props.children}
    </DesktopStoreContext.Provider>
  );
}


export function useDesktopStore() : DesktopStoreContextModel {
  return useContext(DesktopStoreContext) ?? panic();
}
