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

import { Accessor, batch, createSignal, JSX, Setter } from "solid-js";
import { createContext, useContext } from "solid-js";
import { panic, throwExpression } from "../util/lang";
import { Item } from "../items/base/item";
import { EMPTY_UID, Uid } from "../util/uid";
import { Attachment, Child, NoParent } from "../layout/relationship-to-parent";
import { asContainerItem, ContainerItem, isContainer } from "../items/base/container-item";
import { compareOrderings, newOrderingAtBeginning, newOrderingAtEnd, newOrderingBetween } from "../util/ordering";
import { BoundingBox, Dimensions, Vector } from "../util/geometry";
import { MAIN_TOOLBAR_WIDTH_PX } from "../constants";
import { asAttachmentsItem, AttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { itemFromObject } from "../items/base/item-polymorphism";
import { NONE_VISUAL_ELEMENT, VisualElement } from "../layout/visual-element";
import { VisualElementSignal } from "../util/signals";
import { HitInfo } from "../mouse/hitInfo";
import { asTitledItem, isTitledItem } from "../items/base/titled-item";


export interface DesktopStoreContextModel {
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
  topLevelVisualElementSignal: () => VisualElementSignal,

  setLastMouseMoveEvent: (ev: MouseEvent) => void,
  lastMouseMoveEvent: () => MouseEvent,

  editDialogInfo: Accessor<EditDialogInfo | null>,
  setEditDialogInfo: Setter<EditDialogInfo | null>,

  contextMenuInfo: Accessor<ContextMenuInfo | null>,
  setContextMenuInfo: Setter<ContextMenuInfo | null>,
}

export interface ContextMenuInfo {
  posPx: Vector,
  hitInfo: HitInfo
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
  const [desktopSizePx, setDesktopSizePx] = createSignal<Dimensions>(currentDesktopSize(), { equals: false });
  const [editDialogInfo, setEditDialogInfo] = createSignal<EditDialogInfo | null>(null, { equals: false });
  const [contextMenuInfo, setContextMenuInfo] = createSignal<ContextMenuInfo | null>(null, { equals: false });
  const [topLevelVisualElement, setTopLevelVisualElement] = createSignal<VisualElement>(NONE_VISUAL_ELEMENT, { equals: false });

  const topLevelVisualElementSignal = (): VisualElementSignal => { return { get: topLevelVisualElement, set: setTopLevelVisualElement }; }

  let breadcrumbs: Array<PageBreadcrumb> = [];

  let lastMoveEvent: MouseEvent = new MouseEvent("mousemove");
  const setLastMouseMoveEvent = (ev: MouseEvent) => { lastMoveEvent = ev; }
  const lastMouseMoveEvent = (): MouseEvent => { return lastMoveEvent; }


  function currentDesktopSize(): Dimensions {
    let rootElement = document.getElementById("root") ?? panic();
    return { w: rootElement.clientWidth - MAIN_TOOLBAR_WIDTH_PX, h: rootElement.clientHeight };
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
    // setChildItemsFromServerObjects,
    // setItemFromServerObject,
    // setAttachmentItemsFromServerObjects,
    // getItem, getContainerItem, addItem,
    // deleteItem, newOrderingAtEndOfChildren,
    // newOrderingAtEndOfAttachments,
    // newOrderingAtChildrenPosition, newOrderingAtAttachmentsPosition,
    // sortChildren, sortAttachments,
    topLevelVisualElement, setTopLevelVisualElement,
    topLevelVisualElementSignal,
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


/**
 * Find all visual elements with item and linkIdMaybe as specified.
 */
export const findVisualElements = (desktopStore: DesktopStoreContextModel, itemId: Uid, linkIdMaybe: Uid | null): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  const rootVe = desktopStore.topLevelVisualElement();
  if (rootVe.item.id == itemId) {
    if ((linkIdMaybe == null && rootVe.linkItemMaybe == null) ||
        (rootVe.linkItemMaybe != null && rootVe.linkItemMaybe!.id == linkIdMaybe)) {
      result.push({ get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement });
    }
  }
  result = result.concat(findVisualElementInChildAndAttachments(desktopStore, rootVe, itemId, linkIdMaybe));
  return result;
}

const findVisualElementInChildAndAttachments = (desktopStore: DesktopStoreContextModel, ve: VisualElement, itemId: Uid, linkItemIdMaybe: Uid | null): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  ve.children.forEach(childVes => {
    if (childVes.get().item.id == itemId) {
      if ((linkItemIdMaybe == null && childVes.get().linkItemMaybe == null) ||
          (childVes.get().linkItemMaybe != null && childVes.get().linkItemMaybe!.id == linkItemIdMaybe)) {
        result.push(childVes);
      }
    }
    result = result.concat(findVisualElementInChildAndAttachments(desktopStore, childVes.get(), itemId, linkItemIdMaybe));
  });
  ve.attachments.forEach(attachmentVes => {
    if (attachmentVes.get().item.id == itemId) {
      if ((linkItemIdMaybe == null && attachmentVes.get().linkItemMaybe == null) ||
          (attachmentVes.get().linkItemMaybe != null && attachmentVes.get().linkItemMaybe!.id == linkItemIdMaybe)) {
        result.push(attachmentVes);
      }
    }
    result = result.concat(findVisualElementInChildAndAttachments(desktopStore, attachmentVes.get(), itemId, linkItemIdMaybe));
  });
  return result;
}


export const visualElementsWithItemId = (desktopStore: DesktopStoreContextModel, id: Uid): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  const rootVe = desktopStore.topLevelVisualElement();
  if (rootVe.item.id == id) {
    result.push({ get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement });
  }
  result = result.concat(childAndAttachmentVisualElementsWithId(desktopStore, rootVe, id));
  return result;
}


const childAndAttachmentVisualElementsWithId = (desktopStore: DesktopStoreContextModel, ve: VisualElement, id: Uid): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  ve.children.forEach(childVes => {
    if (childVes.get().item.id == id) {
      result.push(childVes);
    }
    result = result.concat(childAndAttachmentVisualElementsWithId(desktopStore, childVes.get(), id));
  });
  ve.attachments.forEach(attachmentVes => {
    if (attachmentVes.get().item.id == id) {
      result.push(attachmentVes);
    }
    result = result.concat(childAndAttachmentVisualElementsWithId(desktopStore, attachmentVes.get(), id));
  });
  return result;
}
