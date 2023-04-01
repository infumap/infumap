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

import { useNavigate } from "@solidjs/router";
import { Component, createSignal, Show } from "solid-js";
import { useGeneralStore } from "../store/GeneralStoreProvider";
import { useUserStore } from "../store/UserStoreProvider";
import { InfuButton } from "./library/InfuButton";
import { InfuLink } from "./library/InfuLink";
import { InfuTextInput } from "./library/InfuTextInput";


export const Login: Component = () => {
  const userStore = useUserStore();
  const generalStore = useGeneralStore();
  const navigate = useNavigate();

  let username: string = "";
  let password: string = "";
  let totpToken: string = "";

  const [error, setError] = createSignal<string | null>(null, { equals: false });

  const toggle2fa = () => {
    generalStore.setPrefer2fa(!generalStore.prefer2fa());
    setError(null);
  }

  const handleLoginClick = async () => {
    const r = await userStore.login(username, password, generalStore.prefer2fa() ? totpToken : null);
    if (r.success) { navigate('/'); }
    else { setError(r.err); }
  }

  return (
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
        <InfuTextInput onInput={(v) => { password = v; setError(null); }} onEnter={handleLoginClick} type="password" />
      </div>
      <div>
        <div class="inline-block w-32"></div>
        <input class="rounded-sm" type="checkbox" id="nootp" name="nootp" value="noopt" checked={generalStore.prefer2fa()} onclick={toggle2fa} />
        <div class="ml-2 mb-3 inline-block"><label for="nootp">Use 2FA</label></div>
      </div>
      <Show when={generalStore.prefer2fa()}>
        <div class="mb-3">
          <div class="inline-block w-32">6 Digit Token</div>
          <InfuTextInput onInput={(v) => { totpToken = v; setError(null); }} onEnter={handleLoginClick} />
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
  );
}
