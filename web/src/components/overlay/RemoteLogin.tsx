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

import { Component, Show, createSignal, createEffect } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { InfuTextInput } from "../library/InfuTextInput";
import { InfuButton } from "../library/InfuButton";
import { post } from "../../server";
import { RemoteSessions } from "../../store/RemoteSessions";
import { retryLoadItemFromRemote, retryVisibleLinksForHost } from "../../layout/load";
import { CursorEventState } from "../../input/state";
import { isInside } from "../../util/geometry";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { requestArrange } from "../../layout/arrange";
import { DIALOG_BACKDROP_CLASS, DIALOG_LABEL_CLASS, FLOATING_DIALOG_SURFACE_CLASS, DialogHeader, dialogButtonClass } from "../library/dialogStyle";


export const RemoteLoginOverlay: Component = () => {
  const store = useStore();

  let username: string = "";
  let password: string = "";
  let totpToken: string = "";

  const [error, setError] = createSignal<string | null>(null, { equals: false });
  const [submitting, setSubmitting] = createSignal<boolean>(false);

  const loginInfo = () => store.overlay.remoteLoginInfo.get();

  let usernameInputContainer: HTMLDivElement | undefined;

  createEffect(() => {
    if (loginInfo() != null) {
      setTimeout(() => {
        const input = usernameInputContainer?.querySelector('input') as HTMLInputElement | null;
        input?.focus();
      }, 0);
    }
  });

  const closeOverlay = () => {
    setError(null);
    store.overlay.remoteLoginInfo.set(null);
  };

  const handleUpdateLink = () => {
    if (!loginInfo()) { return; }
    store.history.setFocus(loginInfo()!.linkPath);
    requestArrange(store, "remote-login-update-link");
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
          queriesPageId: response.queriesPageId,
          scopesPageId: response.scopesPageId,
          promptsPageId: response.promptsPageId,
          searchAttentionPageId: response.searchAttentionPageId,
          searchProcessingPageId: response.searchProcessingPageId,
          sessionId: response.sessionId,
          hasTotp: response.hasTotp,
        });
        RemoteSessions.set({ host: loginInfo()!.host, sessionDataString, username });
        retryLoadItemFromRemote(store, loginInfo()!.linkId);
        setTimeout(() => {
          retryVisibleLinksForHost(store, loginInfo()!.host);
        }, 0);
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
      <div class={`absolute left-0 top-0 bottom-0 right-0 select-none outline-hidden ${DIALOG_BACKDROP_CLASS}`}
           style={`z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY}; display: flex; align-items: center; justify-content: center;`}
           onmousedown={mouseDownListener}
           onmousemove={mouseMoveListener}
           onmouseup={mouseUpListener}>
        <div class={`flex flex-col overflow-hidden ${FLOATING_DIALOG_SURFACE_CLASS}`}
             style={`width: ${boxBoundsPx().w}px;`}
             onmousedown={(ev) => ev.stopPropagation()}>
          <DialogHeader title="Log in to remote host" onClose={closeOverlay}
            description={<span class="break-all">Host: <span class="font-mono">{loginInfo()!.host}</span></span>} />
          <div class="flex flex-col gap-2 px-3 py-3">
            <label class="flex items-center gap-2">
              <span class={`w-[96px] shrink-0 ${DIALOG_LABEL_CLASS}`}>Username</span>
              <div ref={usernameInputContainer} class="min-w-0 grow">
                <InfuTextInput compact fullWidth onInput={(v) => { username = v; setError(null); }} />
              </div>
            </label>
            <form class="flex items-center gap-2" onSubmit={(ev) => ev.preventDefault()}>
              <span class={`w-[96px] shrink-0 ${DIALOG_LABEL_CLASS}`}>Password</span>
              <div class="min-w-0 grow">
                <InfuTextInput compact fullWidth onInput={(v) => { password = v; setError(null); }} onEnterKeyDown={handleLogin} type="password" />
              </div>
            </form>
            <label class="flex items-center gap-2">
              <span class="w-[96px] shrink-0" />
              <input class="accent-neutral-700" type="checkbox" checked={store.general.prefer2fa()}
                onclick={() => { store.general.setPrefer2fa(!store.general.prefer2fa()); setError(null); }} />
              <span class={DIALOG_LABEL_CLASS}>Use two-factor authentication</span>
            </label>
            <Show when={store.general.prefer2fa()}>
              <label class="flex items-center gap-2">
                <span class={`w-[96px] shrink-0 ${DIALOG_LABEL_CLASS}`}>6-digit code</span>
                <div class="min-w-0 grow">
                  <InfuTextInput compact fullWidth inputMode="numeric" autocomplete="one-time-code"
                    onInput={(v) => { totpToken = v; setError(null); }} onEnterKeyDown={handleLogin} />
                </div>
              </label>
            </Show>
            <Show when={error() != null}>
              <div role="alert" class="text-[12px] text-red-700">{error()}</div>
            </Show>
          </div>
          <div class="flex items-center gap-2 border-t border-chrome-line px-3 py-2">
            <button type="button" class={dialogButtonClass()} title="Edit the link to this host" onclick={handleUpdateLink}>Edit link</button>
            <div class="ml-auto">
              <InfuButton compact text={submitting() ? "Logging in…" : "Log in"} onClick={handleLogin} disabled={submitting()} />
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};
