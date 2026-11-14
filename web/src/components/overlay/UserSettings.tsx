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

import { Component, For, Match, Show, Switch, onMount, createSignal } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { getBoundingBoxTopLeft, getBoundingBoxSize } from "../../util/geometry";
import { logout } from "../Main";
import { InfuButton } from "../library/InfuButton";
import { createInfuSignal, createNumberSignal } from "../../util/signals";
import { InfuTextInput } from "../library/InfuTextInput";
import { post } from "../../server";
import { ChangePasswordResponse, Totp, UpdateTotpResponse } from "../../util/accountTypes";
import { RemoteSessions, RemoteSession } from "../../store/RemoteSessions";
import { PasswordStrength } from "../PasswordStrength";
import { DIALOG_LABEL_CLASS, DIALOG_NOTE_CLASS, FLOATING_DIALOG_SURFACE_CLASS, DialogHeader, dialogButtonClass } from "../library/dialogStyle";


interface IngestSessionInfo {
  id: string,
  deviceName: string,
  createdAt: number,
  lastUsedAt: number,
  accessExpires: number,
  refreshExpires: number,
  revoked: boolean,
}

interface IngestSimpleResponse {
  success: boolean,
  err: string | null,
}

interface IngestPairingCodeResponse extends IngestSimpleResponse {
  pairingCode: string | null,
  expiresAt: number | null,
}

interface IngestSessionsResponse extends IngestSimpleResponse {
  sessions: IngestSessionInfo[] | null,
}


export const EditUserSettings: Component = () => {
  const store = useStore();

  let editUserSettingsDiv: HTMLDivElement | undefined;

  const [activeTab, setActiveTab] = createSignal<"local" | "remote" | "ingest">("local");
  const [remoteSessionsList, setRemoteSessionsList] = createSignal<RemoteSession[]>([]);
  const [ingestSessionsList, setIngestSessionsList] = createSignal<IngestSessionInfo[]>([]);

  const totpSignal = createInfuSignal<Totp | null>(null);
  const lastBackupTime = createNumberSignal(-1);
  const lastFailedBackupTime = createNumberSignal(-1);
  const ingestPairingCodeSignal = createInfuSignal<string | null>(null);
  const ingestPairingCodeExpirySignal = createNumberSignal(0);
  const ingestErrorSignal = createInfuSignal<string | null>(null);
  const currentPasswordSignal = createInfuSignal<string>("");
  const newPasswordSignal = createInfuSignal<string>("");
  const confirmPasswordSignal = createInfuSignal<string>("");
  const passwordChangeErrorSignal = createInfuSignal<string | null>(null);
  const passwordChangeSuccessSignal = createInfuSignal<string | null>(null);

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
  let ingestDeviceName: string = "";

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
    updateRemoteSessionsList();
    await updateIngestSessionsList();
  });

  const updateRemoteSessionsList = () => {
    setRemoteSessionsList(RemoteSessions.getAll());
  };

  const updateIngestSessionsList = async () => {
    try {
      const response: IngestSessionsResponse = await post(null, "/ingest/sessions/list", {});
      if (response.success) {
        setIngestSessionsList(response.sessions ?? []);
        ingestErrorSignal.set(null);
      } else {
        setIngestSessionsList([]);
        ingestErrorSignal.set(response.err);
      }
    } catch (e: any) {
      setIngestSessionsList([]);
      ingestErrorSignal.set(e?.message ?? "failed loading ingest sessions");
    }
  };

  const handleRemoteLogout = async (host: string) => {
    const session = RemoteSessions.get(host);
    if (session) {
      try {
        const sessionData = JSON.parse(session.sessionDataString);
        await post(host, "/account/logout", {
          userId: sessionData.userId,
          sessionId: sessionData.sessionId
        });
      } catch (e) {
        console.error("Failed to logout from remote session:", e);
      }
      RemoteSessions.clear(host);
      updateRemoteSessionsList();
    }
  };

  const handleMintIngestPairingCode = async () => {
    ingestErrorSignal.set(null);
    try {
      const response: IngestPairingCodeResponse = await post(null, "/ingest/pairing/create", {
        deviceName: ingestDeviceName.trim() == "" ? null : ingestDeviceName.trim(),
      });
      if (response.success && response.pairingCode != null && response.expiresAt != null) {
        ingestPairingCodeSignal.set(response.pairingCode);
        ingestPairingCodeExpirySignal.set(response.expiresAt);
      } else {
        ingestPairingCodeSignal.set(null);
        ingestErrorSignal.set(response.err ?? "failed minting pairing code");
      }
    } catch (e: any) {
      ingestPairingCodeSignal.set(null);
      ingestErrorSignal.set(e?.message ?? "failed minting pairing code");
    }
  };

  const handleRevokeIngestSession = async (sessionId: string) => {
    ingestErrorSignal.set(null);
    try {
      const response: IngestSimpleResponse = await post(null, "/ingest/sessions/revoke", { sessionId });
      if (response.success) {
        await updateIngestSessionsList();
      } else {
        ingestErrorSignal.set(response.err ?? "failed revoking ingest session");
      }
    } catch (e: any) {
      ingestErrorSignal.set(e?.message ?? "failed revoking ingest session");
    }
  };

  const addTotpVisibleSignal = createInfuSignal<boolean>(false);
  const passwordChangeVisibleSignal = createInfuSignal<boolean>(false);
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
    if (passwordChangeVisibleSignal.get()) {
      passwordChangeVisibleSignal.set(false);
      currentPasswordSignal.set("");
      newPasswordSignal.set("");
      confirmPasswordSignal.set("");
      passwordChangeErrorSignal.set(null);
    }
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

  const handleShowChangePassword = (ev: MouseEvent) => {
    ev.preventDefault();
    if (addTotpVisibleSignal.get()) {
      addTotpVisibleSignal.set(false);
      errorSignal.set(null);
    }
    passwordChangeVisibleSignal.set(true);
    passwordChangeErrorSignal.set(null);
    passwordChangeSuccessSignal.set(null);
  };

  const handleCancelChangePassword = (ev: MouseEvent) => {
    ev.preventDefault();
    passwordChangeVisibleSignal.set(false);
    currentPasswordSignal.set("");
    newPasswordSignal.set("");
    confirmPasswordSignal.set("");
    passwordChangeErrorSignal.set(null);
  };

  const handleChangePassword = async (ev?: MouseEvent) => {
    ev?.preventDefault();
    passwordChangeErrorSignal.set(null);
    passwordChangeSuccessSignal.set(null);

    if (newPasswordSignal.get() != confirmPasswordSignal.get()) {
      passwordChangeErrorSignal.set("The new passwords don't match.");
      return;
    }

    try {
      const response: ChangePasswordResponse = await post(null, "/account/change-password", {
        userId: store.user.getUser().userId,
        currentPassword: currentPasswordSignal.get(),
        newPassword: newPasswordSignal.get(),
      });

      if (response.success) {
        currentPasswordSignal.set("");
        newPasswordSignal.set("");
        confirmPasswordSignal.set("");
        passwordChangeVisibleSignal.set(false);
        passwordChangeSuccessSignal.set("Password updated.");
      } else {
        passwordChangeErrorSignal.set(response.err ?? "Failed to change the password.");
      }
    } catch (e: any) {
      passwordChangeErrorSignal.set(e?.message ?? "Failed to change the password.");
    }
  };

  const tabClass = (tab: string) =>
    "-mb-px h-[30px] cursor-pointer border-b-2 px-3 text-[13px] " +
    (activeTab() === tab ? "border-neutral-800 font-medium text-neutral-900" : "border-transparent text-neutral-500 hover:text-neutral-800");
  const rowClass = "flex min-h-[26px] items-center gap-2";
  const labelClass = `w-[120px] shrink-0 ${DIALOG_LABEL_CLASS}`;
  const copyButtonClass = "ml-2 cursor-pointer text-neutral-400 hover:text-neutral-700";
  const cardClass = "rounded-control border border-chrome-line p-2";

  return (
    // The dialog's bounds are those of editUserSettingsInfo, which mouse_down uses to decide whether a press is in the
    // dialog (and starts moving it) or outside (and closes it). The panel is inset from them, as it always has been.
    <div ref={editUserSettingsDiv}
         class={`fixed z-20 flex flex-col overflow-hidden ${FLOATING_DIALOG_SURFACE_CLASS}`}
         style={`left: ${posPx().x+10.0}px; top: ${posPx().y+10}px; width: ${sizePx().w-20.0}px; height: ${sizePx().h-20.0}px;`}>
      <DialogHeader title="User settings" />

      <div class="flex shrink-0 border-b border-chrome-line px-3" role="tablist">
        <button type="button" role="tab" aria-selected={activeTab() === "local"} class={tabClass("local")}
          onClick={() => setActiveTab("local")}>Local</button>
        <button type="button" role="tab" aria-selected={activeTab() === "remote"} class={tabClass("remote")}
          onClick={() => { setActiveTab("remote"); updateRemoteSessionsList(); }}>Remote</button>
        <button type="button" role="tab" aria-selected={activeTab() === "ingest"} class={tabClass("ingest")}
          onClick={() => { setActiveTab("ingest"); updateIngestSessionsList(); }}>Ingest</button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[13px] text-neutral-800">
        <Switch>
          <Match when={activeTab() === "local"}>
            <div class="flex flex-col gap-1">
              <div class={rowClass}>
                <div class={labelClass}>Username</div>
                <div class="font-medium">{store.user.getUser().username}</div>
              </div>

              <div class={rowClass}>
                <div class={labelClass}>Password</div>
                <span class="font-mono text-neutral-500">••••••</span>
                <Show when={!passwordChangeVisibleSignal.get()}>
                  <button type="button" class={`ml-auto ${dialogButtonClass()}`} onClick={handleShowChangePassword}>Change</button>
                </Show>
              </div>
              <Show when={passwordChangeVisibleSignal.get()}>
                <div class={`ml-[128px] mb-2 flex flex-col gap-2 ${cardClass}`}>
                  <label class="flex items-center gap-2">
                    <span class={`w-[64px] shrink-0 ${DIALOG_LABEL_CLASS}`}>Current</span>
                    <InfuTextInput compact fullWidth type="password" autocomplete="current-password"
                      value={currentPasswordSignal.get()}
                      onInput={(v) => {
                        currentPasswordSignal.set(v);
                        passwordChangeErrorSignal.set(null);
                        passwordChangeSuccessSignal.set(null);
                      }} />
                  </label>
                  <label class="flex items-center gap-2">
                    <span class={`w-[64px] shrink-0 ${DIALOG_LABEL_CLASS}`}>New</span>
                    <InfuTextInput compact fullWidth type="password" autocomplete="new-password"
                      ariaDescribedBy="settings-password-strength"
                      value={newPasswordSignal.get()}
                      onInput={(v) => {
                        newPasswordSignal.set(v);
                        passwordChangeErrorSignal.set(null);
                        passwordChangeSuccessSignal.set(null);
                      }} />
                  </label>
                  <div class="ml-[72px]">
                    <PasswordStrength id="settings-password-strength" password={newPasswordSignal.get()}
                      username={store.user.getUser().username} />
                  </div>
                  <label class="flex items-center gap-2">
                    <span class={`w-[64px] shrink-0 ${DIALOG_LABEL_CLASS}`}>Confirm</span>
                    <InfuTextInput compact fullWidth type="password" autocomplete="new-password"
                      value={confirmPasswordSignal.get()}
                      onInput={(v) => {
                        confirmPasswordSignal.set(v);
                        passwordChangeErrorSignal.set(null);
                        passwordChangeSuccessSignal.set(null);
                      }}
                      onEnterKeyDown={handleChangePassword} />
                  </label>
                  <div class="flex justify-end gap-2">
                    <button type="button" class={dialogButtonClass()} onClick={handleCancelChangePassword}>Cancel</button>
                    <button type="button" class={dialogButtonClass()} onClick={handleChangePassword}>Update password</button>
                  </div>
                </div>
              </Show>
              <Show when={passwordChangeErrorSignal.get() != null}>
                <div role="alert" class="ml-[128px] text-[12px] text-red-700">{passwordChangeErrorSignal.get()!}</div>
              </Show>
              <Show when={passwordChangeSuccessSignal.get() != null}>
                <div role="status" class="ml-[128px] text-[12px] text-green-700">{passwordChangeSuccessSignal.get()!}</div>
              </Show>

              <div class={rowClass}>
                <div class={labelClass}>Two-factor auth</div>
                <span>{store.user.getUser().hasTotp ? "On" : "Off"}</span>
                <Show when={!addTotpVisibleSignal.get()}>
                  <Show when={store.user.getUser().hasTotp} fallback={
                    <button type="button" class={`ml-auto ${dialogButtonClass()}`} onClick={handleShowCreateTotp}>Add</button>
                  }>
                    <button type="button" class={`ml-auto ${dialogButtonClass()}`} onClick={handleRemoveTotp}>Remove</button>
                  </Show>
                </Show>
              </div>
              <Show when={addTotpVisibleSignal.get()}>
                <div class={`ml-[128px] mb-2 flex flex-col gap-2 ${cardClass}`}>
                  <div class={DIALOG_NOTE_CLASS}>Scan the code with an authenticator app, then enter the 6-digit code it shows.</div>
                  <Show when={totpSignal.get() != null}>
                    <img class="self-center" style="width: 180px;" src={`data:image/png;base64, ${totpSignal.get()!.qr}`} />
                    <div class="flex items-center justify-center font-mono text-[12px] text-neutral-600">
                      {totpSignal.get()!.secret}
                      <button type="button" class={copyButtonClass} title="Copy secret" aria-label="Copy secret"
                        onClick={() => { navigator.clipboard.writeText(totpSignal.get()!.secret); }}><i class="bi-copy" /></button>
                    </div>
                  </Show>
                  <label class="flex items-center gap-2">
                    <span class={`w-[64px] shrink-0 ${DIALOG_LABEL_CLASS}`}>Code</span>
                    <InfuTextInput compact fullWidth inputMode="numeric" autocomplete="one-time-code" onInput={(v) => { totpToken = v; }} />
                  </label>
                  <div class="flex justify-end gap-2">
                    <button type="button" class={dialogButtonClass()} onClick={handleCancelAddTotp}>Cancel</button>
                    <button type="button" class={dialogButtonClass()} onClick={handleAddTotp}>Turn on</button>
                  </div>
                </div>
              </Show>
              <Show when={errorSignal.get() != null}>
                <div role="alert" class="ml-[128px] text-[12px] text-red-700">{"" + errorSignal.get()!}</div>
              </Show>

              <div class={rowClass}>
                <div class={labelClass}>User id</div>
                <span class="font-mono text-[12px] text-neutral-500">{store.user.getUser().userId}</span>
                <button type="button" class={copyButtonClass} title="Copy user id" aria-label="Copy user id" onClick={copyClickHandler}><i class="bi-copy" /></button>
              </div>
              <div class={rowClass}>
                <div class={labelClass}>Last backup</div>
                <span>{humanReadableTime(lastBackupTime.get())}</span>
              </div>
              <div class={rowClass}>
                <div class={labelClass}>Last failed backup</div>
                <span>{humanReadableTime(lastFailedBackupTime.get())}</span>
              </div>

              <div class="mt-4">
                <InfuButton compact text="Log out" onClick={logoutHandler} />
              </div>
            </div>
          </Match>

          <Match when={activeTab() === "remote"}>
            <Show when={remoteSessionsList().length === 0} fallback={
              <div class="flex flex-col gap-2">
                <div class={DIALOG_LABEL_CLASS}>Remote sessions</div>
                <For each={remoteSessionsList()}>
                  {(session) => (
                    <div class={`flex items-center justify-between ${cardClass}`}>
                      <div>
                        <div class="font-medium">{session.host}</div>
                        <div class={DIALOG_NOTE_CLASS}>User: {session.username}</div>
                      </div>
                      <InfuButton compact text="Log out" onClick={() => handleRemoteLogout(session.host)} />
                    </div>
                  )}
                </For>
              </div>
            }>
              <div class="text-neutral-500">No remote sessions active.</div>
            </Show>
          </Match>

          <Match when={activeTab() === "ingest"}>
            <div class="flex h-full min-h-0 flex-col gap-2">
              <div class={DIALOG_NOTE_CLASS}>
                Pair ingest clients with one-time codes. Ingest sessions are isolated from normal login sessions and can be revoked independently.
              </div>

              <label class="flex items-center gap-2">
                <span class={labelClass}>Device name</span>
                <InfuTextInput compact fullWidth
                  onInput={(v) => {
                    ingestDeviceName = v;
                    ingestErrorSignal.set(null);
                  }} />
              </label>
              <div class="ml-[128px]">
                <InfuButton compact text="Create pairing code" onClick={handleMintIngestPairingCode} />
              </div>

              <Show when={ingestPairingCodeSignal.get() != null}>
                <div class={`bg-neutral-50 ${cardClass}`}>
                  <div class={DIALOG_LABEL_CLASS}>Pairing code (one-time)</div>
                  <div class="mt-1 flex items-center font-mono text-lg tracking-wider text-neutral-900">
                    {ingestPairingCodeSignal.get()!}
                    <button type="button" class={copyButtonClass} title="Copy pairing code" aria-label="Copy pairing code"
                      onClick={() => { navigator.clipboard.writeText(ingestPairingCodeSignal.get()!); }}><i class="bi-copy text-[13px]" /></button>
                  </div>
                  <div class={`mt-1 ${DIALOG_NOTE_CLASS}`}>Expires: {humanReadableTime(ingestPairingCodeExpirySignal.get())}</div>
                </div>
              </Show>

              <div class={`mt-2 ${DIALOG_LABEL_CLASS}`}>Ingest sessions</div>
              <Show when={ingestSessionsList().length === 0} fallback={
                <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
                  <For each={ingestSessionsList()}>
                    {(session) => (
                      <div class={`flex items-center justify-between ${cardClass}`}>
                        <div>
                          <div class="font-medium">{session.deviceName}</div>
                          <div class={DIALOG_NOTE_CLASS}>Created: {humanReadableTime(session.createdAt)}</div>
                          <div class={DIALOG_NOTE_CLASS}>
                            {session.revoked ? "Revoked" : "Last used"}: {humanReadableTime(session.lastUsedAt)}
                          </div>
                          <Show when={!session.revoked}>
                            <div class={DIALOG_NOTE_CLASS}>Refresh expires: {humanReadableTime(session.refreshExpires)}</div>
                          </Show>
                        </div>
                        <Show when={!session.revoked} fallback={<div class="text-[12px] text-red-700">Revoked</div>}>
                          <InfuButton compact text="Revoke" onClick={() => handleRevokeIngestSession(session.id)} />
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              }>
                <div class="text-neutral-500">No ingest sessions active.</div>
              </Show>

              <Show when={ingestErrorSignal.get() != null}>
                <div role="alert" class="text-[12px] text-red-700">{ingestErrorSignal.get()!}</div>
              </Show>
            </div>
          </Match>
        </Switch>
      </div>
      <div class={`shrink-0 border-t border-chrome-line px-3 py-1 text-right font-mono ${DIALOG_NOTE_CLASS}`}>build: {__INFUMAP_GIT_COMMIT__}</div>
    </div>
  );
}
