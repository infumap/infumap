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
import { GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, requestContainerSyncSoon, server } from '../server';
import { asTextItem, isText } from '../items/text-item';
import { openTextDocumentProjection } from '../items/text-document';
import { TransientMessageType } from '../store/StoreProvider_Overlay';


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

  const windowPopStateListener = async (_e: PopStateEvent) => {
    const navigationRequestId = store.history.beginNavigationRequest();
    const debug = false;
    if (debug) { console.debug("window popstate handler: called."); }
    store.overlay.clear();

    const p = window.location.pathname;
    if (p == "/login" || p == "/signup" || p == "/setup") {
      // The browser has already changed entries; restoring a route must not push one.
      store.currentUrlPath.set(p);
      return;
    }

    const parts = p.split("/");
    let currentUrlUidMaybe: string | null = null;

    if (parts.length >= 4 && parts[1] == "remote") {
      currentUrlUidMaybe = parts[3];
    } else {
      currentUrlUidMaybe = parts[parts.length - 1];
    }

    if (parts.length == 2 && currentUrlUidMaybe != "" && !isUid(currentUrlUidMaybe)) {
      const username = currentUrlUidMaybe;
      const userMaybe = store.user.getUserMaybe();
      if (userMaybe && userMaybe.username.toLowerCase() == username.toLowerCase() &&
        itemState.get(userMaybe.homePageId)) {
        currentUrlUidMaybe = userMaybe.homePageId;
      } else {
        try {
          const result = await server.fetchItems(username, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, store.general.networkStatus);
          if (!store.history.isNavigationRequestCurrent(navigationRequestId)) { return; }
          currentUrlUidMaybe = (result.item as { id: string }).id;
          if (!itemState.get(currentUrlUidMaybe)) {
            itemState.setItemFromServerObject(result.item, null);
            itemState.applyAttachmentItemsSnapshotFromServerObjects(currentUrlUidMaybe, result.attachments[currentUrlUidMaybe] ?? [], null);
          }
        } catch (error) {
          if (!store.history.isNavigationRequestCurrent(navigationRequestId)) { return; }
          console.error(`Could not restore homepage for '${username}'.`, error);
          store.overlay.toolbarTransientMessage.set({ text: "could not restore page", type: TransientMessageType.Error });
          return;
        }
      }
    }

    const currentUrlPageIdMaybe = currentUrlUidMaybe === ""
      ? store.user.getUserMaybe()?.homePageId ?? null
      : currentUrlUidMaybe;

    if (isUid(currentUrlUidMaybe) || currentUrlUidMaybe == "") {
      const prevHistoryVeid = store.history.peekPrevPageVeid();
      if (!prevHistoryVeid) {
        if (currentUrlPageIdMaybe && itemState.get(currentUrlPageIdMaybe)) {
          if (debug) {
            console.debug(
              currentUrlUidMaybe == ""
                ? "window popstate handler: no prevHistoryVeid, switching to root page."
                : "window popstate handler: no prevHistoryVeid, switching to page."
            );
          }
          switchToUrlItem(currentUrlPageIdMaybe, p);
        } else {
          if (debug) {
            console.debug(
              currentUrlUidMaybe == ""
                ? "window popstate handler: root page not available, doing nothing."
                : `window popstate handler: page ${currentUrlUidMaybe} not available, doing nothing.`
            );
          }
        }
      } else {
        if (currentUrlPageIdMaybe != null && prevHistoryVeid.itemId == currentUrlPageIdMaybe &&
          isPage(itemState.get(currentUrlPageIdMaybe))) {
          if (debug) { console.debug("window popstate handler: prevHistoryVeid and currentUrlUid match, moving back in history."); }
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
          if (currentUrlPageIdMaybe && itemState.get(currentUrlPageIdMaybe)) {
            if (debug) {
              console.debug(
                currentUrlUidMaybe == ""
                  ? "window popstate handler: prevHistoryUid and root page do not match, switching to root page."
                  : "window popstate handler: prevHistoryUid and urlUid do not match, switching to urlUid.",
                prevHistoryVeid.itemId,
                currentUrlUidMaybe
              );
            }
            switchToUrlItem(currentUrlPageIdMaybe, p);
          } else {
            if (debug) {
              console.debug(
                currentUrlUidMaybe == ""
                  ? "window popstate handler: root page not available, doing nothing."
                  : `window popstate handler: page ${currentUrlUidMaybe} not available, doing nothing.`
              );
            }
          }
        }
      }
    } else {
      if (debug) { console.debug("window popstate handler: url path is not an infumap page, switching to non-page."); }
      store.currentUrlPath.set(p);
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
    <Switch>
      <Match when={store.currentUrlPath.get() == "/login"}><LoginPath /></Match>
      <Match when={store.currentUrlPath.get() == "/signup"}><SignUpPath /></Match>
      <Match when={store.currentUrlPath.get() == "/setup"}><SetupPath /></Match>
      <Match when={true}><MainPath /></Match>
    </Switch>
  );
};

export default App;
