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

import { Component, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { SignUp } from './SignUp';
import { Login } from './Login';
import { Main } from './Main';
import { useStore } from '../store/StoreProvider';
import { switchToItem, switchToNonPage, switchToPage } from '../layout/navigation';
import { isEmptyVeid, VeFns, type Veid } from '../layout/visual-element';
import { ArrangeAlgorithm, asPageItem, isPage } from '../items/page-item';
import { isUid, POPUP_LINK_UID } from '../util/uid';
import { arrangeNow } from '../layout/arrange';
import { itemState } from '../store/ItemState';
import { GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THEIR_ATTACHMENTS, remote, requestContainerSyncSoon, server } from '../server';
import { asTextItem, isText } from '../items/text-item';
import { openTextDocumentProjection } from '../items/text-document';
import { TransientMessageType } from '../store/StoreProvider_Overlay';
import { isAttachmentsItem } from '../items/base/attachments-item';
import { asContainerItem, isContainer } from '../items/base/container-item';
import { markChildrenLoadAsInitiatedOrComplete } from '../layout/load';
import { Toolbar_TransientMessage } from './toolbar/Toolbar_TransientMessage';


const App: Component = () => {
  const store = useStore();

  const pathContainsItem = (path: string | null, itemId: string): boolean => {
    let currentPath: string | null = path;
    while (currentPath) {
      if (VeFns.itemIdFromPath(currentPath) === itemId) {
        return true;
      }
      currentPath = VeFns.parentPath(currentPath);
      if (currentPath === "") {
        break;
      }
    }
    return false;
  };

  const pathContainsPopupTarget = (path: string, popupVeid: Veid): boolean => {
    let currentPath: string | null = path;
    while (currentPath) {
      const veid = VeFns.veidFromPath(currentPath);
      if (veid.itemId === popupVeid.itemId &&
        (veid.linkIdMaybe === popupVeid.linkIdMaybe || veid.linkIdMaybe === POPUP_LINK_UID)) {
        return true;
      }
      currentPath = VeFns.parentPath(currentPath);
      if (currentPath === "") {
        break;
      }
    }
    return false;
  };

  const resolveFocusAfterPageBack = (focusPath: string | null, poppedPageVeid?: Veid | null): string | null => {
    const currentPageVeid = store.history.currentPageVeid();
    const currentPagePath = store.history.currentPagePath();
    if (!focusPath || !currentPageVeid || !currentPagePath) {
      return currentPagePath;
    }

    if (focusPath === currentPagePath) {
      return currentPagePath;
    }

    const popupSpec = store.history.currentPopupSpec();
    if (popupSpec != null && pathContainsPopupTarget(focusPath, popupSpec.actualVeid)) {
      return focusPath;
    }

    if (poppedPageVeid != null && pathContainsItem(focusPath, poppedPageVeid.itemId)) {
      return currentPagePath;
    }

    const currentPageItem = itemState.get(currentPageVeid.itemId);
    if (!currentPageItem || !isPage(currentPageItem)) {
      return currentPagePath;
    }

    const currentPage = asPageItem(currentPageItem);
    if (currentPage.arrangeAlgorithm !== ArrangeAlgorithm.List) {
      return currentPagePath;
    }

    const selectedVeid = store.perItem.getSelectedListPageItem(currentPageVeid);
    if (isEmptyVeid(selectedVeid)) {
      return currentPagePath;
    }

    const selectedItem = itemState.get(selectedVeid.itemId);
    if (!selectedItem) {
      return currentPagePath;
    }

    if (pathContainsItem(focusPath, selectedVeid.itemId)) {
      return focusPath;
    }

    return currentPagePath;
  };

  onMount(async () => {
    store.currentUrlPath.set(window.location.pathname);
    await store.user.hydrateFromServer();
    await store.general.retrieveInstallationState();
    window.addEventListener('popstate', windowPopStateListener);
  });

  onCleanup(() => {
    window.removeEventListener('popstate', windowPopStateListener);
  });

  const switchToUrlItem = (itemId: string, urlPath: string): boolean => {
    const item = itemState.get(itemId);
    if (item == null) { return false; }
    if (isText(item)) {
      void openTextDocumentProjection(store, asTextItem(item));
      return true;
    }
    if (isPage(item)) {
      switchToPage(store, { itemId, linkIdMaybe: null }, false, false, false);
    } else {
      switchToItem(store, itemId, true, false);
    }
    // Keep the traversed URL, including a username alias, as the active route.
    store.currentUrlPath.set(urlPath);
    return true;
  }

  const loadHistoryItem = async (requestItemId: string, origin: string | null, navigationRequestId: number): Promise<string | null> => {
    const mode = GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THEIR_ATTACHMENTS;
    const result = origin == null
      ? await server.fetchItems(requestItemId, mode, store.general.networkStatus)
      : await remote.fetchItems(origin, requestItemId, mode, store.general.networkStatus);
    if (!store.history.isNavigationRequestCurrent(navigationRequestId)) { return null; }

    const itemId = (result.item as { id: string }).id;
    const existingItem = itemState.get(itemId);
    if (!existingItem || existingItem.origin !== origin) {
      const item = itemState.upsertItemFromServerObject(result.item, origin);
      if (isAttachmentsItem(item)) {
        itemState.applyAttachmentItemsSnapshotFromServerObjects(itemId, result.attachments[itemId] ?? [], origin);
      }
      if (isContainer(item)) {
        itemState.applyContainerSnapshotFromServerObjects(itemId, result.children, result.attachments, origin);
        asContainerItem(item).childrenLoaded = true;
        markChildrenLoadAsInitiatedOrComplete(itemId);
      }
    }
    return itemId;
  };

  const showHistoryLoadError = (urlPath: string, origin: string | null, error: unknown): void => {
    console.error(`Could not restore '${urlPath}'.`, error);
    const message = error instanceof Error ? error.message : String(error);
    let text = "Could not load this page. Check your connection and try again.";
    if (message.includes("Reason: auth")) {
      if (origin == null && store.user.getUserMaybe() == null) {
        // Replace the inaccessible destination so Forward history remains available.
        window.history.replaceState(null, "", `/login?redirect=${encodeURIComponent(urlPath)}`);
        store.currentUrlPath.set("/login");
        text = "Sign in to open this page.";
      } else {
        text = "You do not have access to this page.";
      }
    } else if (message.includes("Reason: not-found")) {
      text = "This page could not be found. It may have been deleted.";
    }
    store.overlay.toolbarTransientMessage.set({ text, type: TransientMessageType.Error });
  };

  const windowPopStateListener = async (_e: PopStateEvent) => {
    const navigationRequestId = store.history.beginNavigationRequest();
    store.overlay.clear();

    const p = window.location.pathname;
    if (p == "/login" || p == "/signup" || p == "/setup") {
      // The browser has already changed entries; restoring a route must not push one.
      store.currentUrlPath.set(p);
      return;
    }

    let origin: string | null = null;
    let itemId: string | null;
    try {
      const parts = p.split("/");
      let urlItemId = parts[parts.length - 1];
      if (parts.length >= 4 && parts[1] == "remote") {
        origin = decodeURIComponent(parts[2]);
        urlItemId = parts[3];
      }

      if (parts.length == 2 && urlItemId != "" && !isUid(urlItemId)) {
        const userMaybe = store.user.getUserMaybe();
        itemId = userMaybe && userMaybe.username.toLowerCase() == urlItemId.toLowerCase()
          ? userMaybe.homePageId
          : await loadHistoryItem(urlItemId, null, navigationRequestId);
        if (itemId == null) { return; }
      } else if (isUid(urlItemId) || urlItemId == "") {
        itemId = urlItemId == "" ? store.user.getUserMaybe()?.homePageId ?? null : urlItemId;
      } else {
        store.currentUrlPath.set(p);
        return;
      }

      const cachedItem = itemId == null ? null : itemState.get(itemId);
      if (!cachedItem || cachedItem.origin !== origin) {
        itemId = await loadHistoryItem(itemId ?? "", origin, navigationRequestId);
        if (itemId == null) { return; }
      }
    } catch (error) {
      if (!store.history.isNavigationRequestCurrent(navigationRequestId)) { return; }
      showHistoryLoadError(p, origin, error);
      return;
    }

    if (!store.history.isNavigationRequestCurrent(navigationRequestId) || itemId == null) { return; }
    const prevHistoryVeid = store.history.peekPrevPageVeid();
    if (prevHistoryVeid?.itemId == itemId && isPage(itemState.get(itemId))) {
      const poppedPageVeid = store.history.currentPageVeid();
      store.history.popPageVeid();
      const focusCandidate =
        store.history.getFocusPathMaybe() ??
        store.history.currentPopupSpec()?.vePath ??
        store.history.currentPagePath();
      const restoredFocusPath = resolveFocusAfterPageBack(focusCandidate, poppedPageVeid);
      if (restoredFocusPath != null) {
        store.history.setFocus(restoredFocusPath);
      }
      arrangeNow(store, "popstate-back-in-history");
      store.currentUrlPath.set(p);
      requestContainerSyncSoon(store);
    } else {
      switchToUrlItem(itemId, p);
    }
  }

  const fallback = () => <div>waiting ...</div>;

  const fallback2 = () => {
    switchToNonPage(store, "/setup");
    return <></>;
  };

  const LoginPath: Component = () =>
    <Show when={store.general.installationState() != null} fallback={fallback()}>
      <Show when={store.general.installationState()?.hasRootUser} fallback={fallback2()}>
        <Login />
      </Show>
    </Show>;

  const SignUpPath: Component = () =>
    <Show when={store.general.installationState() != null} fallback={fallback()}>
      <Show when={store.general.installationState()?.hasRootUser} fallback={fallback2()}>
        <SignUp />
      </Show>
    </Show>;

  const MainPath: Component = () =>
    <Show when={store.general.installationState() != null} fallback={fallback()}>
      <Show when={store.general.installationState()?.hasRootUser} fallback={fallback2()}>
        <Main />
      </Show>
    </Show>;

  const SetupPath: Component = () =>
    <Show when={store.general.installationState() != null} fallback={fallback()}>
      <SignUp />
    </Show>;

  // Reminder: When adding a route here, also update generate_dist_handlers.py or serve.rs
  return (
    <>
      <Switch>
        <Match when={store.currentUrlPath.get() == "/login"}><LoginPath /></Match>
        <Match when={store.currentUrlPath.get() == "/signup"}><SignUpPath /></Match>
        <Match when={store.currentUrlPath.get() == "/setup"}><SetupPath /></Match>
        <Match when={true}><MainPath /></Match>
      </Switch>
      <Show when={store.overlay.toolbarTransientMessage.get() != null}>
        <Toolbar_TransientMessage />
      </Show>
    </>
  );
};

export default App;
