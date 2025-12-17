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

import { GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, remote, server } from "../server";
import { SOLO_ITEM_HOLDER_PAGE_UID, Uid } from "../util/uid";
import { StoreContextModel } from "../store/StoreProvider";
import { asContainerItem, isContainer } from "../items/base/container-item";
import { isAttachmentsItem } from "../items/base/attachments-item";
import { asLinkItem, isLink, LinkFns } from "../items/link-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { itemState } from "../store/ItemState";
import { fullArrange } from "./arrange";
import { PageFns } from "../items/page-item";
import { Veid, VeFns } from "./visual-element";
import { TabularFns } from "../items/base/tabular-item";
import { VesCache } from "./ves-cache";
import { VisualElementSignal } from "../util/signals";


export function clearLoadState() {
  for (let key in childrenLoadInitiatedOrComplete) {
    if (childrenLoadInitiatedOrComplete.hasOwnProperty(key)) {
      delete childrenLoadInitiatedOrComplete[key];
    }
  }
  for (let key in itemLoadInitiatedOrComplete) {
    if (itemLoadInitiatedOrComplete.hasOwnProperty(key)) {
      delete itemLoadInitiatedOrComplete[key];
    }
  }
  itemLoadFromRemoteStatus = {};
}

export function markChildrenLoadAsInitiatedOrComplete(containerId: Uid) {
  childrenLoadInitiatedOrComplete[containerId] = true;
}


const childrenLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadChildItemsMaybe = (store: StoreContextModel, containerVeid: Veid) => {

  if (containerVeid.itemId == SOLO_ITEM_HOLDER_PAGE_UID) { return; }

  if (childrenLoadInitiatedOrComplete[containerVeid.itemId]) {
    PageFns.setDefaultListPageSelectedItemMaybe(store, containerVeid);
    return;
  }
  childrenLoadInitiatedOrComplete[containerVeid.itemId] = true;

  const container = itemState.get(containerVeid.itemId)!;
  const origin = container.origin;

  const fetchPromise = origin == null
    ? server.fetchItems(`${containerVeid.itemId}`, GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY, store.general.networkStatus)
    : remote.fetchItems(origin, `${containerVeid.itemId}`, GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY, store.general.networkStatus);

  fetchPromise
    .then(result => {
      if (!childrenLoadInitiatedOrComplete[containerVeid.itemId]) { return; };

      if (result != null) {
        try {
          itemState.setChildItemsFromServerObjects(containerVeid.itemId, result.children, origin);
        } catch (e: any) {
          throw new Error(`itemState.setChildItems failed: ${e}`);
        }
        PageFns.setDefaultListPageSelectedItemMaybe(store, containerVeid);
        Object.keys(result.attachments).forEach(id => {
          itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id], origin);
        });
        TabularFns.validateNumberOfVisibleColumnsMaybe(containerVeid.itemId);
        asContainerItem(itemState.get(containerVeid.itemId)!).childrenLoaded = true;
        try {
          fullArrange(store);
        } catch (e: any) {
          throw new Error(`Arrange failed: ${e}`);
        };
      } else {
        console.error(`No items were fetched for '${containerVeid.itemId}'.`);
      }
    })
    .catch((e: any) => {
      console.error(`Error occurred fetching items for '${containerVeid.itemId}': ${e.message}.`);
    });
}


export enum InitiateLoadResult {
  InitiatedOrComplete,
  Failed,
  Success,
};

const itemLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadItemMaybe = (store: StoreContextModel, id: string, containerToSortId?: Uid): Promise<InitiateLoadResult> => {
  if (itemLoadInitiatedOrComplete[id]) { return Promise.resolve(InitiateLoadResult.InitiatedOrComplete); }
  if (itemState.get(id) != null) { return Promise.resolve(InitiateLoadResult.InitiatedOrComplete); }
  itemLoadInitiatedOrComplete[id] = true;

  return server.fetchItems(id, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, store.general.networkStatus)
    .then(result => {
      if (!itemLoadInitiatedOrComplete[id]) { return InitiateLoadResult.Failed; };

      if (result != null) {
        itemState.setItemFromServerObject(result.item, null);
        Object.keys(result.attachments).forEach(id => {
          itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id], null);
        });
        if (containerToSortId) {
          const parentForSort = itemState.get(containerToSortId);
          if (parentForSort) {
            if (isContainer(parentForSort)) { itemState.sortChildren(containerToSortId); }
            else if (isAttachmentsItem(parentForSort)) { itemState.sortAttachments(containerToSortId); }
          }
        }
        try {
          fullArrange(store);
        } catch (e: any) {
          throw new Error(`Arrange failed after load item: ${e}`);
        };
      } else {
        console.error(`Empty result fetching '${id}'.`);
      }
      return InitiateLoadResult.Success;
    })
    .catch((e: any) => {
      console.error(`Error occurred fetching item '${id}': ${e.message}.`);
      return InitiateLoadResult.Failed;
    });
}


export enum RemoteLoadStatus {
  Pending = "pending",
  Success = "success",
  AuthRequired = "auth-required",
  Failed = "failed"
}
export let itemLoadFromRemoteStatus: { [id: Uid]: RemoteLoadStatus } = {};
export let linkIdToRemoteInfo: { [linkId: Uid]: { itemId: string, baseUrl: string } } = {};

export const initiateLoadItemFromRemoteMaybe = (store: StoreContextModel, itemId: string, baseUrl: string, resolveId: string, containerToSortId?: Uid, forceRetry?: boolean) => {
  linkIdToRemoteInfo[resolveId] = { itemId, baseUrl };
  const currentStatus = itemLoadFromRemoteStatus[itemId];
  if (!forceRetry) {
    if (currentStatus === RemoteLoadStatus.Pending ||
      currentStatus === RemoteLoadStatus.Success) {
      return;
    }
    if (currentStatus === RemoteLoadStatus.AuthRequired ||
      currentStatus === RemoteLoadStatus.Failed) {
      return;
    }
  } else {
    if (currentStatus === RemoteLoadStatus.Pending) { return; }
    if (currentStatus === RemoteLoadStatus.Failed) { return; }
  }
  itemLoadFromRemoteStatus[itemId] = RemoteLoadStatus.Pending;

  remote.fetchItems(baseUrl, itemId, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, store.general.networkStatus)
    .then(result => {
      if (itemLoadFromRemoteStatus[itemId] !== RemoteLoadStatus.Pending) { return; };

      if (result != null) {
        itemLoadFromRemoteStatus[itemId] = RemoteLoadStatus.Success;
        itemState.setItemFromServerObject(result.item, baseUrl);
        // Clear the children load cache so that initiateLoadChildItemsMaybe will fetch children.
        // This is necessary because setItemFromServerObject replaces the item with a fresh object
        // that has computed_children: [], but the cache might still say children were loaded.
        delete childrenLoadInitiatedOrComplete[itemId];
        const linkItemMaybe = itemState.get(resolveId);
        if (linkItemMaybe) {
          const linkItem = asLinkItem(linkItemMaybe);
          linkItem.linkToResolvedId = ItemFns.fromObject(result.item, baseUrl).id;
          linkItem.linkRequiresRemoteLogin = null;
        }
        Object.keys(result.attachments).forEach(id => {
          itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id], baseUrl);
        });
        if (containerToSortId) {
          const parentForSort = itemState.get(containerToSortId);
          if (parentForSort) {
            if (isContainer(parentForSort)) { itemState.sortChildren(containerToSortId); }
            else if (isAttachmentsItem(parentForSort)) { itemState.sortAttachments(containerToSortId); }
          }
        }
        try {
          fullArrange(store);
        } catch (e: any) {
          throw new Error(`Arrange after remote fetch failed: ${e}`);
        };
      } else {
        console.error(`Empty result fetching '${itemId}' from ${baseUrl}.`);
        const linkItemMaybe = itemState.get(resolveId);
        if (linkItemMaybe) {
          asLinkItem(linkItemMaybe).linkRequiresRemoteLogin = null;
        }
        itemLoadFromRemoteStatus[itemId] = RemoteLoadStatus.Failed;
        try {
          fullArrange(store);
        } catch (_e) { }
      }
    })
    .catch((e: any) => {
      const linkItemMaybe = itemState.get(resolveId);
      const isAuthError = e.message && e.message.includes("Reason: auth");

      if (isAuthError) {
        itemLoadFromRemoteStatus[itemId] = RemoteLoadStatus.AuthRequired;
        if (linkItemMaybe) {
          asLinkItem(linkItemMaybe).linkRequiresRemoteLogin = baseUrl;
        }
      } else {
        itemLoadFromRemoteStatus[itemId] = RemoteLoadStatus.Failed;
        if (linkItemMaybe) {
          asLinkItem(linkItemMaybe).linkRequiresRemoteLogin = null;
        }
      }
      console.error(`Error occurred fetching item '${itemId}' from '${baseUrl}': ${e.message}.`);
      try {
        fullArrange(store);
      } catch (_e) { }
    });
}

export const retryLoadItemFromRemote = (store: StoreContextModel, resolveId: string) => {
  const linkItemMaybe = itemState.get(resolveId);
  if (!linkItemMaybe) { return; }
  const linkItem = asLinkItem(linkItemMaybe);
  if (!linkItem.linkTo.startsWith("http")) { return; }
  const lastIdx = linkItem.linkTo.lastIndexOf('/');
  if (lastIdx == -1) { return; }
  const baseUrl = linkItem.linkTo.substring(0, lastIdx);
  const id = linkItem.linkTo.substring(lastIdx + 1);
  initiateLoadItemFromRemoteMaybe(store, id, baseUrl, linkItem.id, linkItem.parentId, true);
}

const findVisualElementsByLinkId = (linkId: Uid): Array<VisualElementSignal> => {
  const result: Array<VisualElementSignal> = [];
  try {
    const linkItem = itemState.get(linkId);
    if (!linkItem || !isLink(linkItem)) { return result; }
    const linkToId = LinkFns.getLinkToId(asLinkItem(linkItem));

    const pathsForLinkItem = VesCache.getPathsForDisplayId(linkId);
    for (const path of pathsForLinkItem) {
      const ves = VesCache.get(path);
      if (ves) {
        const ve = ves.get();
        if ((ve.linkItemMaybe && ve.linkItemMaybe.id === linkId) ||
          (ve.actualLinkItemMaybe && ve.actualLinkItemMaybe.id === linkId)) {
          if (!result.find(r => r === ves)) {
            result.push(ves);
          }
        }
      }
    }

    const veid = { itemId: linkToId, linkIdMaybe: linkId };
    const ves = VesCache.find(veid);
    for (const v of ves) {
      const ve = v.get();
      if ((ve.linkItemMaybe && ve.linkItemMaybe.id === linkId) ||
        (ve.actualLinkItemMaybe && ve.actualLinkItemMaybe.id === linkId)) {
        if (!result.find(r => r === v)) {
          result.push(v);
        }
      }
    }
  } catch (_e) {
  }
  return result;
};

export const retryVisibleLinksForHost = (store: StoreContextModel, host: string) => {
  const normalizedHost = (() => {
    try {
      return new URL(host).origin;
    } catch (_e) {
      return host;
    }
  })();

  for (const [linkId, remoteInfo] of Object.entries(linkIdToRemoteInfo)) {
    const linkItemMaybe = itemState.get(linkId);
    if (!linkItemMaybe || !isLink(linkItemMaybe)) { continue; }

    const linkItem = asLinkItem(linkItemMaybe);
    if (!linkItem.linkTo.startsWith("http")) { continue; }

    const lastIdx = linkItem.linkTo.lastIndexOf('/');
    if (lastIdx == -1) { continue; }
    const baseUrl = linkItem.linkTo.substring(0, lastIdx);
    const normalizedBaseUrl = (() => {
      try {
        return new URL(baseUrl).origin;
      } catch (_e) {
        return baseUrl;
      }
    })();

    if (normalizedBaseUrl !== normalizedHost) { continue; }

    const status = itemLoadFromRemoteStatus[remoteInfo.itemId];
    if (status === RemoteLoadStatus.AuthRequired || status === RemoteLoadStatus.Failed) {
      const parentItem = itemState.get(linkItem.parentId);
      if (parentItem && isContainer(parentItem)) {
        const containerItem = asContainerItem(parentItem);
        if (containerItem.childrenLoaded) {
          const ves = findVisualElementsByLinkId(linkId);
          if (ves.length > 0) {
            initiateLoadItemFromRemoteMaybe(store, remoteInfo.itemId, remoteInfo.baseUrl, linkId, linkItem.parentId, true);
          }
        }
      }
    }
  }
}

export const retryLinkIfVisible = (store: StoreContextModel, linkId: Uid): boolean => {
  const remoteInfo = linkIdToRemoteInfo[linkId];
  if (!remoteInfo) { return false; }

  const status = itemLoadFromRemoteStatus[remoteInfo.itemId];
  if (status !== RemoteLoadStatus.AuthRequired && status !== RemoteLoadStatus.Failed) { return false; }

  const linkItemMaybe = itemState.get(linkId);
  if (!linkItemMaybe || !isLink(linkItemMaybe)) { return false; }

  const linkItem = asLinkItem(linkItemMaybe);
  const ves = findVisualElementsByLinkId(linkId);
  if (ves.length > 0) {
    initiateLoadItemFromRemoteMaybe(store, remoteInfo.itemId, remoteInfo.baseUrl, linkId, linkItem.parentId, true);
    return true;
  }
  return false;
}
