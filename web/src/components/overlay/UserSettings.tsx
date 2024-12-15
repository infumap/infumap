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

import { Component, Match, Show, Switch, onMount } from "solid-js";
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { boundingBoxFromPosSize, getBoundingBoxTopLeft, getBoundingBoxSize } from "../../util/geometry";
import { logout } from "../Main";
import { InfuButton } from "../library/InfuButton";
import { createInfuSignal, createNumberSignal } from "../../util/signals";
import { InfuTextInput } from "../library/InfuTextInput";
import { post } from "../../server";
import { Totp, UpdateTotpResponse } from "../../util/accountTypes";


const DIALOG_WIDTH_PX = 510;

export const editUserSettingsSizePx = { w: DIALOG_WIDTH_PX, h: 600 };

export function initialEditUserSettingsBounds(store: StoreContextModel) {
  let posPx = {
    x: (store.desktopBoundsPx().w) / 2.0 - DIALOG_WIDTH_PX / 2.0,
    y: 120.0
  };
  return boundingBoxFromPosSize(posPx, { ...editUserSettingsSizePx }); 
}

export const EditUserSettings: Component = () => {
  const store = useStore();

  let editUserSettingsDiv: HTMLDivElement | undefined;

  const totpSignal = createInfuSignal<Totp | null>(null);
  const lastBackupTime = createNumberSignal(-1);
  const lastFailedBackupTime = createNumberSignal(-1);

  function humanReadableTime(unixTimeSeconds: number): string {
    if (unixTimeSeconds == -1) { return ""; }
    if (unixTimeSeconds == 0) { return "N/A"; }
    const date = new Date(unixTimeSeconds * 1000);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hour = date.getHours();
    const minute = date.getMinutes();
    return (
      year + "-" + String(month).padStart(2, '0') + "-" + String(day).padStart(2, '0') + " " +
      String(hour).padStart(2, '0') + ":" + String(minute).padStart(2, '0')
    );
  }

  let totpToken: string = "";

  onMount(async () => {
    const json: any = await post(null, "/account/create-totp", {});
    totpSignal.set({
      qr: json.qr,
      url: json.url,
      secret: json.secret
    });
    const extra_json: any = await post(null, "/account/extra", {});
    lastBackupTime.set(extra_json.lastBackupTime);
    lastFailedBackupTime.set(extra_json.lastFailedBackupTime);
  });

  const addTotpVisibleSignal = createInfuSignal<boolean>(false);
  const errorSignal = createInfuSignal<String | null>("");

  const posPx = () => getBoundingBoxTopLeft(store.overlay.editUserSettingsInfo.get()!.desktopBoundsPx);
  const sizePx = () => getBoundingBoxSize(store.overlay.editUserSettingsInfo.get()!.desktopBoundsPx);

  const copyClickHandler = () => {
    navigator.clipboard.writeText(store.user.getUser().userId);
  }

  const logoutHandler = () => {
    store.overlay.editUserSettingsInfo.set(null);
    logout!();
  }

  const handleShowCreateTotp = (ev: MouseEvent) => {
    ev.preventDefault();
    addTotpVisibleSignal.set(true);
    errorSignal.set(null);
  }

  const handleRemoveTotp = async (ev: MouseEvent) => {
    ev.preventDefault();
    const r: UpdateTotpResponse = await post(null, '/account/update-totp', {
      userId: store.user.getUser().userId,
      totpSecret: null,
      totpToken: null,
    });
    if (r.success) {
      store.user.updateHasTotp(false);
    }
    errorSignal.set(r.err);
  }

  const handleAddTotp = async (ev: MouseEvent) => {
    ev.preventDefault();
    const r: UpdateTotpResponse = await post(null, '/account/update-totp', {
      userId: store.user.getUser().userId,
      totpSecret: totpSignal.get()?.secret,
      totpToken,
    });
    if (r.success) {
      store.user.updateHasTotp(true);
    }
    addTotpVisibleSignal.set(false);
    errorSignal.set(r.err);
  }

  const handleCancelAddTotp = (ev: MouseEvent) => {
    ev.preventDefault();
    addTotpVisibleSignal.set(false);
  }

  return (
    <>
      <div class="fixed text-xl font-bold z-10 rounded-md p-8 blur-md"
           style={`left: ${posPx().x}px; top: ${posPx().y}px; width: ${sizePx().w}px; height: ${sizePx().h}px; background-color: #303030d0;`}>
      </div>
      <div ref={editUserSettingsDiv}
           class="fixed bg-white z-20 rounded-md border border-slate-700"
           style={`left: ${posPx().x+10.0}px; top: ${posPx().y+10}px; width: ${sizePx().w-20.0}px; height: ${sizePx().h-20.0}px;`}>
        <div class="p-3">
          <div class="font-bold text-lg" style="margin-bottom: 14px;">User Settings</div>
          <div>
            <div class="inline-block text-right mr-[6px]" style="width: 150px;">username:</div>
            <div class="font-bold inline-block">{store.user.getUser().username}</div>
          </div>
          <div>
            <div class="inline-block text-right mr-[6px]" style="width: 150px;">id:</div>
            <div class="text-slate-800 text-sm inline-block">
              <span class="font-mono text-slate-400">{`${store.user.getUser().userId}`}</span>
              <i class={`fa fa-copy text-slate-400 cursor-pointer ml-[8px]`} onclick={copyClickHandler} />
            </div>
          </div>

          <div>
            <div class="inline-block text-right mr-[6px]" style="width: 150px;">last backup:</div>
            <div class="inline-block">{humanReadableTime(lastBackupTime.get())}</div>
          </div>
          <div>
            <div class="inline-block text-right mr-[6px]" style="width: 150px;">last failed backup:</div>
            <div class="inline-block">{humanReadableTime(lastFailedBackupTime.get())}</div>
          </div>

          <Switch>
            <Match when={!addTotpVisibleSignal.get()}>
              <div>
                <div class="inline-block text-right mr-[6px]" style="width: 150px;">2FA:</div>
                <div class="inline-block">
                  {store.user.getUser().hasTotp ? "ON" : "OFF"}
                  <Show when={store.user.getUser().hasTotp} fallback={
                    <a class="ml-3" style="color: #00a;" href="" onClick={handleShowCreateTotp}>add</a>
                  }>
                    <a class="ml-3" style="color: #00a;" href="" onClick={handleRemoveTotp}>remove</a>
                  </Show>
                </div>
              </div>
            </Match>

            <Match when={addTotpVisibleSignal.get()}>
              <div>
                <div class="inline-block text-right mr-[6px] align-top" style="width: 150px; z-index: 10">Authenticator setup:</div>
              </div>
              <Show when={totpSignal.get() != null}>
              <div class="inline-block">
                <img class="inline-block" style="margin-left: 125px; width: 200px;" src={`data:image/png;base64, ${totpSignal.get()!.qr}`} />
              </div>
                <div class="text-sm w-full text-center" style="margin-top: -10px;">
                  {totpSignal.get()!.secret}
                  <i class="ml-[8px] fa fa-copy cursor-pointer" onclick={() => { navigator.clipboard.writeText(totpSignal.get()!.secret); }} />
                </div>
              </Show>
              <div class="ml-[80px] mt-[10px]">6 Digit Token: <InfuTextInput onInput={(v) => { totpToken = v; }} /></div>
              <div class="ml-[150px] mt-[8px] mb-[15px]">
                <a class="ml-6" style="color: #00a;" href="" onClick={handleAddTotp}>add</a>
                <a class="ml-3" style="color: #00a;" href="" onClick={handleCancelAddTotp}>cancel</a>
              </div>
            </Match>
          </Switch>

          <Show when={errorSignal.get() != null}>
            <div>
              {"" + errorSignal.get()!}
            </div>
          </Show>

          <div style="margin-top: 20px;">
            <InfuButton text="logout" onClick={logoutHandler} />
          </div>
        </div>
      </div>
    </>
  );
}
