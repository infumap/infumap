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
import { compareOrderings, newOrderingAtEnd } from "../../util/ordering";
import { BoundingBox, Dimensions } from "../../util/geometry";
import { TOOLBAR_WIDTH } from "../../constants";
import { AttachmentsItem, isAttachmentsItem } from "./items/base/attachments-item";
import { VisualElement } from "./visual-element";


export interface DesktopStoreContextModel {
  setRootId: Setter<Uid | null>,
  setChildItems: (parentId: Uid, items: Array<Item>) => void,
  setAttachmentItems: (parentId: Uid, items: Array<Item>) => void
  updateItem: (id: Uid, f: (item: Item) => void) => void,
  updateContainerItem: (id: Uid, f: (item: ContainerItem) => void) => void,
  getItem: (id: Uid) => (Item | null) | null,
  getContainerItem: (id: Uid) => (ContainerItem | null) | null,
  addItem: (item: Item) => void,
  newOrderingAtEndOfChildren: (parentId: Uid) => Uint8Array,

  desktopBoundsPx: () => BoundingBox,
  resetDesktopSizePx: () => void,

  setCurrentPageId: Setter<Uid | null>,
  currentPageId: Accessor<Uid | null>,

  setTopLevelVisualElement: Setter<VisualElement | null>,
  getTopLevelVisualElement: Accessor<VisualElement | null>,
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
  const [currentPageId, setCurrentPageId] = createSignal<Uid | null>(null, { equals: false });
  const [desktopSizePx, setDesktopSizePx] = createSignal<Dimensions>(currentDesktopSize(), { equals: false });
  const [getTopLevelVisualElement, setTopLevelVisualElement] = createSignal<VisualElement | null>(null, { equals: false });
  // TODO: Need some way to keep track of parent pages that haven't been loaded yet.

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

  const getContainerItem = (id: Uid): ContainerItem | null => {
    const item = getItem(id);
    if (item == null) { return null; }
    return asContainerItem(item);
  }

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
      parent.computed_children.set(children);
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
        const parentItem = getContainerItem(item.parentId)!;
        parentItem.computed_children.set([...parentItem.computed_children.get(), item.id]);
      } else {
        throwExpression("only support child relationships currently");
      }
    });
  }


  const newOrderingAtEndOfChildren = (parentId: Uid): Uint8Array => {
    let parent = asContainerItem(items[parentId].item());
    let children = parent.computed_children.get().map(c => items[c].item().ordering);
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


  const value: DesktopStoreContextModel = {
    currentPageId, setCurrentPageId,
    desktopBoundsPx, resetDesktopSizePx,
    setRootId, setChildItems, setAttachmentItems,
    updateItem, updateContainerItem,
    getItem, getContainerItem, addItem, newOrderingAtEndOfChildren,
    getTopLevelVisualElement,
    setTopLevelVisualElement,
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
