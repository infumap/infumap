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

import { useLocation, useNavigate } from "@solidjs/router";
import { Component, createSignal, onMount, Show } from "solid-js";
import { post } from "../server";
import { useUserStore } from "../store/UserStoreProvider";
import { InfuButton } from "./library/InfuButton";
import { InfuLink } from "./library/InfuLink";
import { InfuTextInput } from "./library/InfuTextInput";
import { ROOT_USERNAME } from "../constants";
import { useDesktopStore } from "../store/DesktopStoreProvider";


interface Totp {
  qr: string,
  url: string,
  secret: string
}

interface RegisterResponse {
  success: boolean,
  err: string | null
}

export const SignUp: Component = () => {
  const userStore = useUserStore();
  const store = useDesktopStore();
  const navigate = useNavigate();
  const location = useLocation();

  let username: string = "";
  let password: string = "";
  let totpToken: string = "";

  const [totp, setTotp] = createSignal<Totp | null>(null, { equals: false });
  const [error, setError] = createSignal<string | null>(null, { equals: false });
  const [hadSuccess, setHadSuccess] = createSignal<boolean>(false, { equals: false });

  const areSettingUp = () => location.pathname.indexOf("setup") != -1;

  const handleSignupClick = async () => {
    const totpInfo = totp();
    if (totpInfo == null) {
      setError("application error");
      return;
    }
    const r: RegisterResponse = await post(null, '/account/register', {
      username: username,
      password: password,
      totpSecret: store.generalStore.prefer2fa() ? totpInfo.secret : null,
      totpToken: store.generalStore.prefer2fa() ? totpToken : null,
      pageWidthPx: window.innerWidth,
      pageHeightPx: window.innerHeight,
    });
    if (r.success) {
      if (areSettingUp()) {
        let r = await userStore.login(username, password, store.generalStore.prefer2fa() ? totpToken : null);
        if (r.success) {
          store.generalStore.assumeHaveRootUser();
          navigate('/');
        } else {
          setError(r.err);
        }
      } else {
        setHadSuccess(true);
      }
    } else {
      setError(r.err);
    }
  }

  onMount(async () => {
    if (store.generalStore.installationState()!.hasRootUser) {
      navigate("/signup");
    }
    if (areSettingUp()) { username = ROOT_USERNAME; }
    const json: any = await post(null, "/account/totp", {});
    setTotp({
      qr: json.qr,
      url: json.url,
      secret: json.secret
    });
  });

  return (
    <div class="border border-slate-700 m-auto w-96 mt-10 p-3 rounded-md">
      <div class="mb-3 mt-1 text-xl">
        <Show when={areSettingUp()} fallback={<b>Sign Up</b>}>
          <b>Create Root User</b>
        </Show>
      </div>

      <Show when={!hadSuccess()}>
        <div class="mb-3">
          <div class="inline-block w-32">Username</div>
          <Show when={!areSettingUp()} fallback={<InfuTextInput disabled={true} value={ROOT_USERNAME} />}>
            <InfuTextInput onInput={(v) => { username = v; }} />
          </Show>
        </div>
        <div class="mb-3">
          <div class="inline-block w-32">Password</div>
          <InfuTextInput onInput={(v) => { password = v; }} type="password" />
        </div>
        <div>
          <div class="inline-block w-32"></div>
          <input type="checkbox" id="nootp" name="nootp" value="noopt"
                 checked={store.generalStore.prefer2fa()}
                 onclick={() => store.generalStore.setPrefer2fa(!store.generalStore.prefer2fa())} />
          <div class="ml-2 mb-3 inline-block"><label for="nootp">Setup 2FA</label></div>
        </div>
        <Show when={store.generalStore.prefer2fa()}>
          <div class="mb-3">
            <div class="inline-block w-32">6 Digit Token</div>
            <InfuTextInput onInput={(v) => { totpToken = v; }} />
          </div>
        </Show>
        <div class="mb-1">
          <div class="inline-block w-32"></div>
          <InfuButton text="Sign Up" onClick={handleSignupClick} />
        </div>
        <Show when={error() != null}>
          <div class="mb-1">
            <div class="inline-block w-32"></div>
            <div class="text-red-700">{error()}</div>
          </div>
        </Show>
        <Show when={store.generalStore.prefer2fa()}>
          <div class="mt-6">
            <Show when={totp() != null}>
              <div class="absolute">Authenticator setup:</div>
              <img style="padding-top: 10px" src={`data:image/png;base64, ${totp()!.qr}`} />
              <div class="text-sm w-full text-center" style="margin-top: -20px;">
                {totp()!.secret}
                <i class="ml-1 fa fa-copy cursor-pointer" onclick={() => { navigator.clipboard.writeText(totp()!.secret); }} />
              </div>
            </Show>
          </div>
        </Show>
        <Show when={!areSettingUp()}>
          <div class="w-full text-center mt-5 text-sm">
            Already have an account? <InfuLink href="/login" text="login instead" />
          </div>
        </Show>
      </Show>

      <Show when={hadSuccess()}>
        <p class="mb-2 mt-4">Success!</p>
        <p class="mb-5">
          You've been successfully added to the pending users list. You will be able to log in
          after your registration is approved by an administrator.
        </p>
        <InfuButton text="Login" onClick={() => { navigate("/login"); }} />
      </Show>

    </div>
  );
}
