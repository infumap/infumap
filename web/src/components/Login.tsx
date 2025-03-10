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

import { Component, createSignal, Show } from "solid-js";
import { InfuButton } from "./library/InfuButton";
import { InfuLink } from "./library/InfuLink";
import { InfuTextInput } from "./library/InfuTextInput";
import { ROOT_USERNAME } from "../constants";
import { useStore } from "../store/StoreProvider";
import { switchToNonPage } from "../layout/navigation";


export const Login: Component = () => {
  const store = useStore();

  let username: string = "";
  let password: string = "";
  let totpToken: string = "";

  const [error, setError] = createSignal<string | null>(null, { equals: false });

  const toggle2fa = () => {
    store.general.setPrefer2fa(!store.general.prefer2fa());
    setError(null);
  }

  const handleLoginClick = async () => {
    const r = await store.user.login(username, password, store.general.prefer2fa() ? totpToken : null);
    if (r.success) {
      const queryString = window.location.search;
      const urlParams = new URLSearchParams(queryString);
      const loginPath = "/login";
      const basePath = location.href.substring(0, location.href.lastIndexOf(loginPath));
      const redirectPathMaybe = urlParams.get("redirect");
      if (redirectPathMaybe && redirectPathMaybe.length > 0) {
        location.href = basePath + decodeURIComponent(redirectPathMaybe);
      } else {
        if (username == ROOT_USERNAME) {
          switchToNonPage(store, "/"); // TODO:
        } else {
          switchToNonPage(store, `/${username}`); // TODO:
        }
      }
    }
    else {
      setError(r.err);
    }
  }

  return (
    <>
      <div class="border border-slate-700 m-auto w-96 mt-10 p-3 rounded-md">
        <div class="mb-3 mt-1 text-xl">
          <b>Login</b>
        </div>
        <div class="mb-3">
          <div class="inline-block w-32">Username</div>
          <InfuTextInput onInput={(v) => { username = v; setError(null); }} />
        </div>
        <div class="mb-3">
          <div class="inline-block w-32">Password</div>
          <form class="inline-block">
            <InfuTextInput onInput={(v) => { password = v; setError(null); }} onEnterKeyDown={handleLoginClick} type="password" />
          </form>
        </div>
        <div>
          <div class="inline-block w-32"></div>
          <input class="rounded-sm" type="checkbox" id="nootp" name="nootp" value="noopt" checked={store.general.prefer2fa()} onclick={toggle2fa} />
          <div class="ml-2 mb-3 inline-block"><label for="nootp">Use 2FA</label></div>
        </div>
        <Show when={store.general.prefer2fa()}>
          <div class="mb-3">
            <div class="inline-block w-32">6 Digit Token</div>
            <InfuTextInput onInput={(v) => { totpToken = v; setError(null); }} onEnterKeyDown={handleLoginClick} />
          </div>
        </Show>
        <div class="mb-1">
          <div class="inline-block w-32"></div>
          <InfuButton text="Login" onClick={handleLoginClick} />
        </div>
        <Show when={error() != null}>
          <div class="mb-1">
            <div class="inline-block w-32"></div>
            <div class="text-red-700">{error()}</div>
          </div>
        </Show>
        <div class="w-full text-center mt-5 text-sm">
          Don't have an account? <InfuLink href="/signup" text="sign up instead" />
        </div>
      </div>
      <div class="m-auto w-96 mt-10 p-3">
        <div class="mb-3">
          <b>Essential Usage</b>
        </div>
        <div class="mb-3">
          "/" → create a new item at current location using context menu.
        </div>
        <div class="mb-3">
          <Show when={store.general.installationState()?.devFeatureFlag}>
            "n", "p", "t", "r", "w", "l", "e", "f" → create a specific item (note, page, table, rating, password, link, expression, flip card) at the current location.
          </Show>
          <Show when={!store.general.installationState()?.devFeatureFlag}>
            "n", "p", "t", "r", "w", "l", "e" → create a specific item (note, page, table, rating, password, link, expression) at the current location.
          </Show>
        </div>
        <div class="mb-3">
          right mouse button → navigate back in history one step.
        </div>
        <div class="mb-3">
          ctrl drag → create a link to an item.
        </div>
        <div class="mb-3">
          shift drag → clone an item (does not clone children).
        </div>
        <div class="mb-3">
          long left click on page → edit page title.
        </div>
      </div>
    </>
  );
}
