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
import { HelpContent } from "./HelpContent";
import { AuthCheckbox, AuthError, AuthField, AuthPage } from "./AuthPage";


export const Login: Component = () => {
  const store = useStore();

  let username: string = "";
  let password: string = "";
  let totpToken: string = "";

  const [error, setError] = createSignal<string | null>(null, { equals: false });
  const [showHelp, setShowHelp] = createSignal(false);

  const toggle2fa = () => {
    store.general.setPrefer2fa(!store.general.prefer2fa());
    setError(null);
  }

  const handleLoginClick = async () => {
    const r = await store.user.login(username, password, store.general.prefer2fa() ? totpToken : null);
    if (r.success) {
      store.general.clearNetworkHistory();
      const queryString = window.location.search;
      const urlParams = new URLSearchParams(queryString);
      const loginPath = "/login";
      const basePath = location.href.substring(0, location.href.lastIndexOf(loginPath));
      const redirectPathMaybe = urlParams.get("redirect");
      if (redirectPathMaybe && redirectPathMaybe.length > 0) {
        location.href = basePath + decodeURIComponent(redirectPathMaybe);
      } else {
        // The stored username, not as typed: lookup is case insensitive.
        const storedUsername = store.user.getUser().username;
        if (storedUsername == ROOT_USERNAME) {
          switchToNonPage(store, "/"); // TODO:
        } else {
          switchToNonPage(store, `/${storedUsername}`); // TODO:
        }
      }
    }
    else {
      setError(r.err);
    }
  }

  return (
    <AuthPage title="Log in" below={
      <>
        <div class="w-full max-w-sm mx-auto px-4 mt-4 text-sm text-slate-600 text-center">
          Press <kbd class="px-[5px] font-mono text-[11px] border border-slate-300 rounded-sm bg-slate-50">?</kbd> when
          logged in at any time to see help.
          <div>
            <span class="text-blue-800 hover:text-blue-400 cursor-pointer" onClick={() => setShowHelp(!showHelp())}>
              {showHelp() ? "Hide help" : "Show help"}
            </span>
          </div>
        </div>
        <Show when={showHelp()}>
          <div class="w-[calc(100%-32px)] max-w-[560px] mx-auto mt-4 p-4 border border-slate-300 rounded-md">
            <HelpContent />
          </div>
        </Show>
        <div class="h-10" />
      </>
    }>
      {/* A form, so password managers recognise the fields. Submitting is done by the button and Enter handlers. */}
      <form onSubmit={(ev) => ev.preventDefault()}>
        <AuthField label="Username" for="login-username">
          <InfuTextInput id="login-username" autocomplete="username" fullWidth={true}
            onInput={(v) => { username = v; setError(null); }} onEnterKeyDown={handleLoginClick} />
        </AuthField>
        <AuthField label="Password" for="login-password">
          <InfuTextInput id="login-password" autocomplete="current-password" type="password" fullWidth={true}
            onInput={(v) => { password = v; setError(null); }} onEnterKeyDown={handleLoginClick} />
        </AuthField>
        <AuthCheckbox id="login-use-2fa" label="Use 2FA" checked={store.general.prefer2fa()} onClick={toggle2fa} />
        <Show when={store.general.prefer2fa()}>
          <AuthField label="6 digit token" for="login-totp">
            <InfuTextInput id="login-totp" autocomplete="one-time-code" inputMode="numeric" fullWidth={true}
              onInput={(v) => { totpToken = v; setError(null); }} onEnterKeyDown={handleLoginClick} />
          </AuthField>
        </Show>
        <InfuButton text="Log in" onClick={handleLoginClick} fullWidth={true} />
        <Show when={error() != null}>
          <AuthError>{error()}</AuthError>
        </Show>
      </form>
      <div class="text-center mt-5 text-sm">
        Don't have an account? <InfuLink href="/signup" text="Sign up" />
      </div>
    </AuthPage>
  );
}
