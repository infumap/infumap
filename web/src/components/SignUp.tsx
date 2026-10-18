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

import { Component, createSignal, onMount, Show } from "solid-js";
import { post } from "../server";
import { InfuButton } from "./library/InfuButton";
import { InfuLink } from "./library/InfuLink";
import { InfuTextInput } from "./library/InfuTextInput";
import { ROOT_USERNAME } from "../constants";
import { useStore } from "../store/StoreProvider";
import { RegisterResponse, Totp } from "../util/accountTypes";
import { switchToNonPage } from "../layout/navigation";
import { AuthCheckbox, AuthError, AuthField, AuthPage } from "./AuthPage";


export const SignUp: Component = () => {
  const store = useStore();

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
      totpSecret: store.general.prefer2fa() ? totpInfo.secret : null,
      totpToken: store.general.prefer2fa() ? totpToken : null,
      pageWidthPx: window.innerWidth,
      pageHeightPx: window.innerHeight,
    });
    if (r.success) {
      if (areSettingUp()) {
        let r = await store.user.login(username, password, store.general.prefer2fa() ? totpToken : null);
        if (r.success) {
          store.general.clearNetworkHistory();
          await store.general.retrieveInstallationState();

          switchToNonPage(store, "/"); // TODO: not quite right.
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
    if (store.general.installationState()!.hasRootUser) {
      switchToNonPage(store, "/signup");
    }
    if (areSettingUp()) { username = ROOT_USERNAME; }
    const json: any = await post(null, "/account/create-totp", {});
    setTotp({
      qr: json.qr,
      url: json.url,
      secret: json.secret
    });
  });

  return (
    <AuthPage title={areSettingUp() ? "Create Root User" : "Sign up"}>
      <Show when={!hadSuccess()}>
        <form onSubmit={(ev) => ev.preventDefault()}>
          <AuthField label="Username" for="signup-username">
            <Show when={!areSettingUp()} fallback={<InfuTextInput id="signup-username" disabled={true} value={ROOT_USERNAME} fullWidth={true} />}>
              <InfuTextInput id="signup-username" autocomplete="username" fullWidth={true} onInput={(v) => { username = v; }} />
            </Show>
          </AuthField>
          <AuthField label="Password" for="signup-password">
            <InfuTextInput id="signup-password" autocomplete="new-password" type="password" fullWidth={true}
              onInput={(v) => { password = v; }} />
          </AuthField>
          <AuthCheckbox id="signup-setup-2fa" label="Set up 2FA" checked={store.general.prefer2fa()}
            onClick={() => store.general.setPrefer2fa(!store.general.prefer2fa())} />
          <Show when={store.general.prefer2fa()}>
            {/* Scanned before the token below can be entered. */}
            <Show when={totp() != null}>
              <div class="mb-4">
                <div class="text-sm text-slate-700 mb-1">Scan with your authenticator app</div>
                <img class="block mx-auto w-[200px] max-w-full" src={`data:image/png;base64, ${totp()!.qr}`} />
                <div class="font-mono text-xs text-center break-all">
                  {totp()!.secret}
                  <i class="ml-1 fa fa-copy cursor-pointer" title="Copy" onclick={() => { navigator.clipboard.writeText(totp()!.secret); }} />
                </div>
              </div>
            </Show>
            <AuthField label="6 digit token" for="signup-totp">
              <InfuTextInput id="signup-totp" autocomplete="one-time-code" inputMode="numeric" fullWidth={true}
                onInput={(v) => { totpToken = v; }} />
            </AuthField>
          </Show>
          <InfuButton text="Sign up" onClick={handleSignupClick} fullWidth={true} />
          <Show when={error() != null}>
            <AuthError>{error()}</AuthError>
          </Show>
        </form>
        <Show when={!areSettingUp()}>
          <div class="text-center mt-5 text-sm">
            Already have an account? <InfuLink href="/login" text="Log in" />
          </div>
        </Show>
      </Show>

      <Show when={hadSuccess()}>
        <p class="mb-2">Success!</p>
        <p class="mb-5">
          You've been successfully added to the pending users list. You will be able to log in
          after your registration is approved by an administrator.
        </p>
        <InfuButton text="Log in" onClick={() => { switchToNonPage(store, "/login"); }} fullWidth={true} />
      </Show>
    </AuthPage>
  );
}
