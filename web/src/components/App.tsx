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

import { Component, onMount, Show } from 'solid-js';
import { SignUp } from './SignUp';
import { Login } from './Login';
import { Navigate, Route, Routes } from '@solidjs/router';
import { Main } from './Main';
import { useDesktopStore } from '../store/DesktopStoreProvider';


const App: Component = () => {
  const store = useDesktopStore();

  onMount(async () => {
    const user = store.userStore.getUserMaybe();
    if (user == null) {
      await store.generalStore.retrieveInstallationState();
    } else {
      store.generalStore.assumeHaveRootUser();
    }
  });

  const fallback = () => <div>waiting ...</div>;
  const fallback2 = () => <Navigate href="/setup" />;

  const LoginPath: Component = () =>
    <Show when={store.generalStore.installationState() != null} fallback={fallback()}>
      <Show when={store.generalStore.installationState()?.hasRootUser} fallback={fallback2()}>
        <Login />
      </Show>
    </Show>;

  const SignUpPath: Component = () =>
    <Show when={store.generalStore.installationState() != null} fallback={fallback()}>
      <Show when={store.generalStore.installationState()?.hasRootUser} fallback={fallback2()}>
        <SignUp />
      </Show>
    </Show>;

  const MainPath: Component = () =>
    <Show when={store.generalStore.installationState() != null} fallback={fallback()}>
      <Show when={store.generalStore.installationState()?.hasRootUser} fallback={fallback2()}>
        <Main />
      </Show>
    </Show>;

  const SetupPath: Component = () =>
    <Show when={store.generalStore.installationState() != null} fallback={fallback()}>
      <SignUp />
    </Show>;

  const UnknownPath: Component = () =>
    <div>unknown path</div>;

  // Reminder: When adding a route here, also update generate_dist_handlers.py or serve.rs
  return (
    <Routes>
      <Route path="/login" component={LoginPath} />
      <Route path="/signup" component={SignUpPath} />
      <Route path="/setup" component={SetupPath} />
      <Route path="/:usernameOrItemId" component={MainPath} />
      <Route path="/:username/:itemLabel" component={MainPath} />
      <Route path="/" component={MainPath} />
      <Route path="*" component={UnknownPath} />
    </Routes>
  );
};

export default App;
