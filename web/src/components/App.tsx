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
import { switchToNonPage, switchToPage } from '../layout/navigation';
import { isUid } from '../util/uid';
import { fArrange } from '../layout/arrange';
import { itemState } from '../store/ItemState';


const App: Component = () => {
  const store = useStore();

  onMount(async () => {
    store.currentUrlPath.set(window.location.pathname);
    await store.general.retrieveInstallationState();
    window.addEventListener('popstate', windowPopStateListener);
  });

  onCleanup(() => {
    window.removeEventListener('popstate', windowPopStateListener);
  });

  const windowPopStateListener = (e: PopStateEvent) => {
    const debug = false;
    if (debug) { console.debug("window popstate handler: called."); }
    store.overlay.clear();

    const p = window.location.pathname;
    const parts = p.split("/");
    const currentUrlUidMaybe = parts[parts.length-1];
    if (isUid(currentUrlUidMaybe) || currentUrlUidMaybe == "") {
      const prevHistoryVeid = store.history.peekPrevPageVeid();
      if (!prevHistoryVeid) {
        e.preventDefault();
        if (currentUrlUidMaybe == "") {
          if (debug) { console.debug("window popstate handler: no prevHistoryVeid, switching to (root) page."); }
          if (store.user.getUserMaybe() && itemState.get(store.user.getUser().homePageId) ) {
            switchToPage(store, { itemId: store.user.getUser().homePageId, linkIdMaybe: null }, false, false, false);
          } else {
            if (debug) { console.debug("window popstate handler: root page not available, doing nothing."); }
          }
        } else {
          if (debug) { console.debug("window popstate handler: no prevHistoryVeid, switching to page."); }
          if (itemState.get(currentUrlUidMaybe)) {
            switchToPage(store, { itemId: currentUrlUidMaybe, linkIdMaybe: null }, false, false, false);
          } else {
            if (debug) { console.debug(`window popstate handler: page ${currentUrlUidMaybe} not available, doing nothing.`); }
          }
        }
      } else {
        e.preventDefault();
        if (prevHistoryVeid.itemId == currentUrlUidMaybe) {
          if (debug) { console.debug("window popstate handler: prevHistoryVeid and currentUrlUid match, moving back in history."); }
          store.history.popPageVeid();
          if (store.history.currentPopupSpec() != null) {
            store.history.setFocus(store.history.currentPopupSpec()?.vePath!);
          } else {
            store.history.setFocus(store.history.currentPagePath()!);
          }
          fArrange(store);
        } else {
          if (currentUrlUidMaybe == "") {
            if (store.user.getUser().homePageId == prevHistoryVeid.itemId) {
              if (debug) { console.debug("window popstate handler: moving back in history to root."); }
              store.history.popPageVeid();
              if (store.history.currentPopupSpec() != null) {
                store.history.setFocus(store.history.currentPopupSpec()?.vePath!);
              } else {
                store.history.setFocus(store.history.currentPagePath()!);
              }
              fArrange(store);
            } else {
              if (debug) { console.debug("window popstate handler: prevHistoryUid and urlUid do not match, switching to urlUid (2).", prevHistoryVeid.itemId, currentUrlUidMaybe); }
              switchToPage(store, { itemId: currentUrlUidMaybe, linkIdMaybe: null }, false, false, false);
            }
          } else {
            if (debug) { console.debug("window popstate handler: prevHistoryUid and urlUid do not match, switching to urlUid.", prevHistoryVeid.itemId, currentUrlUidMaybe); }
            switchToPage(store, { itemId: currentUrlUidMaybe, linkIdMaybe: null }, false, false, false);
          }
        }
      }
    } else {
      e.preventDefault();
      if (debug) { console.debug("window popstate handler: url path is not an infumap page, switching to non-page."); }
      switchToNonPage(store, p);
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
