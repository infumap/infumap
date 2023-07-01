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
import { useGeneralStore } from '../store/GeneralStoreProvider';
import { useUserStore } from '../store/UserStoreProvider';
import { SignUp } from './SignUp';
import { Login } from './Login';
import { Navigate, Route, Routes } from '@solidjs/router';
import { Main } from './Main';


const App: Component = () => {
  const userStore = useUserStore();
  const generalStore = useGeneralStore();

  onMount(async () => {
    const user = userStore.getUserMaybe();
    if (user == null) {
      await generalStore.retrieveInstallationState();
    } else {
      generalStore.assumeHaveRootUser();
    }
  });

  // TODO (MEDIUM): improve this ...
  const fallback = () => { return <div>waiting ...</div> };
  const fallback2 = () => { return <Navigate href="/setup" /> };
  const LoginMaybe: Component = () =>
    <Show when={generalStore.installationState() != null} fallback={fallback()}>
      <Show when={generalStore.installationState()?.hasRootUser} fallback={fallback2()}>
        <Login />
      </Show>
    </Show>;
  const SignUpMaybe: Component = () =>
    <Show when={generalStore.installationState() != null} fallback={fallback()}>
      <Show when={generalStore.installationState()?.hasRootUser} fallback={fallback2()}>
        <SignUp />
      </Show>
    </Show>;
  const MainMaybe: Component = () =>
    <Show when={generalStore.installationState() != null} fallback={fallback()}>
      <Show when={generalStore.installationState()?.hasRootUser} fallback={fallback2()}>
        <Main />
      </Show>
    </Show>;
  const SetupMaybe: Component = () =>
    <Show when={generalStore.installationState() != null} fallback={fallback()}>
      <SignUp />
    </Show>;

  return (
    <Routes>
      <Route path="/login" component={LoginMaybe} />
      <Route path="/signup" component={SignUpMaybe} />
      <Route path="/setup" component={SetupMaybe} />
      <Route path="/:id" component={MainMaybe} />
      <Route path="/" component={MainMaybe} />
    </Routes>
  );
};

export default App;
