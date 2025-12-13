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

import { Component, Show, createSignal } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { InfuTextInput } from "../library/InfuTextInput";
import { InfuButton } from "../library/InfuButton";
import { post } from "../../server";
import { RemoteSessions } from "../../store/RemoteSessions";
import { retryLoadItemFromRemote } from "../../layout/load";
import { CursorEventState } from "../../input/state";
import { isInside } from "../../util/geometry";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { fullArrange } from "../../layout/arrange";


export const RemoteLoginOverlay: Component = () => {
  const store = useStore();

  let username: string = "";
  let password: string = "";
  let totpToken: string = "";

  const [error, setError] = createSignal<string | null>(null, { equals: false });
  const [submitting, setSubmitting] = createSignal<boolean>(false);

  const loginInfo = () => store.overlay.remoteLoginInfo.get();

  const closeOverlay = () => {
    setError(null);
    store.overlay.remoteLoginInfo.set(null);
  };

  const handleUpdateLink = () => {
    if (!loginInfo()) { return; }
    store.history.setFocus(loginInfo()!.linkPath);
    fullArrange(store);
    closeOverlay();
  };

  const handleLogin = async () => {
    if (!loginInfo()) { return; }
    setSubmitting(true);
    setError(null);
    try {
      const response: any = await post(
        loginInfo()!.host,
        '/account/login',
        store.general.prefer2fa() ? { username, password, totpToken } : { username, password }
      );
      if (response.success) {
        const sessionDataString = JSON.stringify({
          username,
          userId: response.userId,
          homePageId: response.homePageId,
          trashPageId: response.trashPageId,
          dockPageId: response.dockPageId,
          sessionId: response.sessionId,
          hasTotp: response.hasTotp,
        });
        RemoteSessions.set({ host: loginInfo()!.host, sessionDataString, username });
        retryLoadItemFromRemote(store, loginInfo()!.linkId);
        closeOverlay();
      } else {
        setError(response.err ?? "Login failed.");
      }
    } catch (e: any) {
      setError(e.message ?? "Login failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const boxBoundsPx = () => {
    const desktopBounds = store.desktopBoundsPx();
    const boxWidth = 380;
    const boxHeight = store.general.prefer2fa() ? 250 : 210;
    return ({
      x: (desktopBounds.w - boxWidth) / 2,
      y: (desktopBounds.h - boxHeight) / 2,
      w: boxWidth,
      h: boxHeight
    });
  };

  const boxBoundsRelativeToDesktopPx = () => {
    return boxBoundsPx();
  };

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    if (ev.button === MOUSE_RIGHT) {
      closeOverlay();
      return;
    }
    if (isInside(CursorEventState.getLatestDesktopPx(store), boxBoundsRelativeToDesktopPx())) { return; }
    closeOverlay();
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  return (
    <Show when={loginInfo() != null}>
      <div class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
           style={`background-color: #00000040; z-index: ${Z_INDEX_TEXT_OVERLAY}; display: flex; align-items: center; justify-content: center;`}
           onmousedown={mouseDownListener}
           onmousemove={mouseMoveListener}
           onmouseup={mouseUpListener}>
        <div class="border border-slate-700 rounded-md bg-white shadow-lg"
             style={`width: ${boxBoundsPx().w}px; min-height: ${boxBoundsPx().h}px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);`}
             onmousedown={(ev) => ev.stopPropagation()}>
          <div class="px-4 py-3 flex flex-col">
            <div class="flex items-center justify-between mb-3">
              <div class="text-lg font-semibold">Login to remote host</div>
              <button class="text-sm text-slate-500 hover:text-slate-700" onclick={handleUpdateLink}>Edit link</button>
            </div>
            <div class="text-sm text-slate-600 mb-3 break-all">
              Host: <span class="font-mono">{loginInfo()!.host}</span>
            </div>
            <div class="mb-3">
              <div class="inline-block w-28 text-sm text-slate-700">Username</div>
              <InfuTextInput onInput={(v) => { username = v; setError(null); }} />
            </div>
            <div class="mb-3">
              <div class="inline-block w-28 text-sm text-slate-700">Password</div>
              <form class="inline-block">
                <InfuTextInput onInput={(v) => { password = v; setError(null); }} onEnterKeyDown={handleLogin} type="password" />
              </form>
            </div>
            <div>
              <div class="inline-block w-28"></div>
              <input class="rounded-sm" type="checkbox" id="remote2fa" name="remote2fa" value="remote2fa" checked={store.general.prefer2fa()} onclick={() => { store.general.setPrefer2fa(!store.general.prefer2fa()); setError(null); }} />
              <div class="ml-2 mb-3 inline-block text-sm text-slate-700"><label for="remote2fa">Use 2FA</label></div>
            </div>
            <Show when={store.general.prefer2fa()}>
              <div class="mb-3">
                <div class="inline-block w-28 text-sm text-slate-700">6 Digit Token</div>
                <InfuTextInput onInput={(v) => { totpToken = v; setError(null); }} onEnterKeyDown={handleLogin} />
              </div>
            </Show>
            <div class="flex justify-center">
              <InfuButton text={submitting() ? "Signing in..." : "Login"} onClick={handleLogin} disabled={submitting()} />
            </div>
            <Show when={error() != null}>
              <div class="mt-2 text-sm text-red-700 text-center">{error()}</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};
