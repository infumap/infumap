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
import { Item } from "./items/base/item";
import { EMPTY_UID, Uid } from "../../util/uid";
import { Attachment, Child, NoParent } from "./relationship-to-parent";
import { asContainerItem, ContainerItem, isContainer } from "./items/base/container-item";
import { compareOrderings, newOrderingAtBeginning, newOrderingAtEnd, newOrderingBetween } from "../../util/ordering";
import { BoundingBox, Dimensions, Vector } from "../../util/geometry";
import { TOOLBAR_WIDTH } from "../../constants";
import { asAttachmentsItem, AttachmentsItem, isAttachmentsItem } from "./items/base/attachments-item";
import { itemFromObject } from "./items/base/item-polymorphism";
import { NONE_VISUAL_ELEMENT, VisualElement } from "./visual-element";
import { VisualElementSignal } from "../../util/signals";


export interface DesktopStoreContextModel {
  setChildItemsFromServerObjects: (parentId: Uid, items: Array<object>) => void,
  setAttachmentItemsFromServerObjects: (parentId: Uid, items: Array<object>) => void
  getItem: (id: Uid) => (Item | null) | null,
  getContainerItem: (id: Uid) => (ContainerItem | null) | null,
  addItem: (item: Item) => void,
  deleteItem: (id: Uid) => void,
  newOrderingAtEndOfChildren: (parentId: Uid) => Uint8Array,
  newOrderingAtPosition: (parentId: Uid, position: number) => Uint8Array,

  desktopBoundsPx: () => BoundingBox,
  resetDesktopSizePx: () => void,

  clearBreadcrumbs: () => void, // and set topLevel page to null.
  pushTopLevelPageId: (uid: Uid) => void,
  popTopLevelPageId: () => void,
  topLevelPageId: () => Uid | null,

  pushPopupId: (id: Uid) => void,
  replacePopupId: (id: Uid) => void,
  popPopupId: () => void,
  popupId: () => Uid | null,

  topLevelVisualElement: Accessor<VisualElement>,
  setTopLevelVisualElement: Setter<VisualElement>,

  setLastMouseMoveEvent: (ev: MouseEvent) => void,
  lastMouseMoveEvent: () => MouseEvent,

  editDialogInfo: Accessor<EditDialogInfo | null>,
  setEditDialogInfo: Setter<EditDialogInfo | null>,

  contextMenuInfo: Accessor<ContextMenuInfo | null>,
  setContextMenuInfo: Setter<ContextMenuInfo | null>,
}

export interface ContextMenuInfo {
  posPx: Vector,
  item: Item
}

export interface EditDialogInfo {
  desktopBoundsPx: BoundingBox,
  item: Item
}

export interface DesktopStoreContextProps {
  children: JSX.Element
}

const DesktopStoreContext = createContext<DesktopStoreContextModel>();


interface PageBreadcrumb {
  pageId: Uid,
  popupBreadcrumbs: Array<Uid>,
}

export function DesktopStoreProvider(props: DesktopStoreContextProps) {
  let items: { [id: Uid]: Item } = {};
  const [desktopSizePx, setDesktopSizePx] = createSignal<Dimensions>(currentDesktopSize(), { equals: false });
  const [topLevelVisualElement, setTopLevelVisualElement] = createSignal<VisualElement>(NONE_VISUAL_ELEMENT, { equals: false });
  const [editDialogInfo, setEditDialogInfo] = createSignal<EditDialogInfo | null>(null, { equals: false });
  const [contextMenuInfo, setContextMenuInfo] = createSignal<ContextMenuInfo | null>(null, { equals: false });

  let breadcrumbs: Array<PageBreadcrumb> = [];

  let lastMoveEvent: MouseEvent = new MouseEvent("mousemove");
  const setLastMouseMoveEvent = (ev: MouseEvent) => { lastMoveEvent = ev; }
  const lastMouseMoveEvent = (): MouseEvent => { return lastMoveEvent; }

  // TODO: Need some way to keep track of parent pages that haven't been loaded yet.

  const getItem = (id: Uid): Item | null => {
    if (items.hasOwnProperty(id)) {
      return items[id];
    }
    return null;
  };


  const getContainerItem = (id: Uid): ContainerItem | null => {
    const item = getItem(id);
    if (item == null) { return null; }
    return asContainerItem(item);
  }


  const getAttachmentsItem = (id: Uid): AttachmentsItem | null => {
    const item = getItem(id);
    if (item == null) { return null; }
    return asAttachmentsItem(item);
  }


  const deleteItem = (id: Uid): void => {
    const item = getItem(id)!;
    if (item.parentId == EMPTY_UID) {
      panic!();
    }
    if (isContainer(item)) {
      const containerItem = asContainerItem(item);
      if (containerItem.computed_children.length > 0) {
        panic!();
      }
    }
    const parentItem = getItem(item.parentId)!;
    if (item.relationshipToParent == Child) {
      const containerParentItem = asContainerItem(parentItem);
      containerParentItem.computed_children
        = containerParentItem.computed_children.filter(cid => cid != id);
    } else if (item.relationshipToParent == Attachment) {
      const attachmentsParentItem = asAttachmentsItem(parentItem);
      attachmentsParentItem.computed_attachments
        = attachmentsParentItem.computed_attachments.filter(aid => aid != id);
    } else {
      panic();
    }
    delete items[id];
  }

  /**
   * Set all the child items of a container.
   * Special Case (for efficiency): If the container is the root page, then the child items list contains
   *  the root page item as well.
   *
   * @param parentId The id of the parent to set child items of.
   * @param childItems The child items.
   */
  const setChildItemsFromServerObjects = (parentId: Uid, childItemObjects: Array<object>): void => {
    let childItems = childItemObjects.map(cio => itemFromObject(cio));
    batch(() => {
      childItems.forEach(childItem => { items[childItem.id] = childItem; });
      if (!isContainer(getItem(parentId)!)) {
        throwExpression(`Cannot set ${childItems.length} child items of parent '${parentId}' because it is not a container.`);
      }
      const parent = getContainerItem(parentId)!;
      let children: Array<Uid> = [];
      childItems.forEach(childItem => {
        if (childItem.parentId == EMPTY_UID) {
          if (childItem.relationshipToParent != NoParent) { panic(); }
        } else {
          if (childItem.parentId != parentId) {
            throwExpression(`Child item had parent '${childItem.parentId}', but '${parentId}' was expected.`);
          }
          if (childItem.relationshipToParent != Child) {
            throwExpression(`Unexpected relationship to parent ${childItem.relationshipToParent}`);
          }
          children.push(childItem.id);
        }
      });
      children.sort((a, b) => compareOrderings(getItem(a)!.ordering, getItem(b)!.ordering));
      parent.computed_children = children;
    });
  };


  const setAttachmentItemsFromServerObjects = (parentId: Uid, attachmentItemObject: Array<object>): void => {
    let attachmentItems = attachmentItemObject.map(aio => itemFromObject(aio));
    batch(() => {
      if (!isAttachmentsItem(getItem(parentId)!)) {
        throwExpression(`Cannot attach ${attachmentItems.length} items to parent '${parentId}' because it has type '${getItem(parentId)!.itemType}' which does not allow attachments.`);
      }
      const parent = getAttachmentsItem(parentId)!;
      let attachments: Array<Uid> = [];
      attachmentItems.forEach(attachmentItem => {
        items[attachmentItem.id] = attachmentItem;
        if (attachmentItem.parentId != parentId) {
          throwExpression(`Attachment item had parent '${attachmentItem.parentId}', but '${parentId}' was expected.`);
        }
        if (attachmentItem.relationshipToParent != Attachment) {
          throwExpression(`Unexpected relationship to parent ${attachmentItem.relationshipToParent}`);
        }
        attachments.push(attachmentItem.id);
      });
      attachments.sort((a, b) => compareOrderings(getItem(a)!.ordering, getItem(b)!.ordering));
      parent.computed_attachments = attachments;
    });
  };


  const addItem = (item: Item): void => {
    batch(() => {
      items[item.id] = item;
      if (item.relationshipToParent == Child) {
        const parentItem = getContainerItem(item.parentId)!;
        parentItem.computed_children = [...parentItem.computed_children, item.id];
      } else {
        throwExpression("only support child relationships currently");
      }
    });
  }


  const newOrderingAtEndOfChildren = (parentId: Uid): Uint8Array => {
    let parent = asContainerItem(items[parentId]);
    let childrenOrderings = parent.computed_children.map(c => items[c].ordering);
    return newOrderingAtEnd(childrenOrderings);
  }


  const newOrderingAtPosition = (parentId: Uid, position: number): Uint8Array => {
    let parent = asContainerItem(items[parentId]);
    let childrenOrderings = parent.computed_children.map(c => items[c].ordering);
    if (position <= 0) {
      return newOrderingAtBeginning(childrenOrderings);
    } else if (position >= childrenOrderings.length) {
      return newOrderingAtEnd(childrenOrderings);
    } else {
      return newOrderingBetween(childrenOrderings[position-1], childrenOrderings[position]);
    }
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

  const clearBreadcrumbs = (): void => {
    breadcrumbs = [];
  }

  const pushTopLevelPageId = (uid: Uid): void => {
    breadcrumbs.push({ pageId: uid, popupBreadcrumbs: [] });
  }

  const popTopLevelPageId = (): void => {
    if (breadcrumbs.length <= 1) {
      return;
    }
    breadcrumbs.pop();
  }

  const topLevelPageId = (): Uid | null => {
    if (breadcrumbs.length == 0) {
      return null;
    }
    return breadcrumbs[breadcrumbs.length-1].pageId;
  }

  const pushPopupId = (uid: Uid): void => {
    if (breadcrumbs.length == 0) {
      panic();
    }
    breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs.push(uid);
  }

  const replacePopupId = (uid: Uid): void => {
    if (breadcrumbs.length == 0) {
      panic();
    }
    breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs = [uid];
  }

  const popPopupId = (): void => {
    if (breadcrumbs.length == 0) {
      panic();
    }
    if (breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs.length == 0) {
      return;
    }
    breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs.pop();
  }

  const popupId = (): Uid | null => {
    if (breadcrumbs.length == 0) {
      panic();
    }
    if (breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs.length == 0) {
      return null;
    }
    const lastBreadcrumbPopups = breadcrumbs[breadcrumbs.length-1].popupBreadcrumbs;
    return lastBreadcrumbPopups[lastBreadcrumbPopups.length-1];
  }

  const value: DesktopStoreContextModel = {
    desktopBoundsPx, resetDesktopSizePx,
    setChildItemsFromServerObjects,
    setAttachmentItemsFromServerObjects,
    getItem, getContainerItem, addItem,
    deleteItem, newOrderingAtEndOfChildren,
    newOrderingAtPosition,
    topLevelVisualElement, setTopLevelVisualElement,
    clearBreadcrumbs,
    pushTopLevelPageId, popTopLevelPageId, topLevelPageId,
    replacePopupId, pushPopupId, popPopupId, popupId,
    setLastMouseMoveEvent, lastMouseMoveEvent,
    editDialogInfo, setEditDialogInfo,
    contextMenuInfo, setContextMenuInfo,
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


export const visualElementsWithId = (desktopStore: DesktopStoreContextModel, id: Uid): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  const rootVe = desktopStore.topLevelVisualElement();
  if (rootVe.item.id == id) {
    result.push({ get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement });
  }
  result = result.concat(childVisualElementsWithId(desktopStore, rootVe, id));
  return result;
}


const childVisualElementsWithId = (desktopStore: DesktopStoreContextModel, ve: VisualElement, id: Uid): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  ve.children.forEach(childVes => {
    if (childVes.get().item.id == id) {
      result.push(childVes);
    }
    result = result.concat(childVisualElementsWithId(desktopStore, childVes.get(), id));
  });
  return result;
}
