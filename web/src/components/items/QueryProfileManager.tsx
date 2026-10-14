/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { queryConfigurationsEqual, snapshotQueryProfile, type QueryConfiguration, type QueryProfile } from "../../items/query-configuration";
import { useStore } from "../../store/StoreProvider";
import type { Uid } from "../../util/uid";

export interface QueryProfileSaveContext {
  queryId: Uid,
  accountId: Uid | null,
  configuration: QueryConfiguration,
  appliedProfile: QueryProfile | null,
}

export type QueryProfileManagementAction = "manage" | "saveAs" | "saveChanges";

interface QueryProfileManagerProps {
  initialAction: QueryProfileManagementAction,
  captureCurrent: () => QueryProfileSaveContext,
  currentBlockedReason: () => string | null,
  onSaved: (profile: QueryProfile, context: QueryProfileSaveContext) => boolean,
  summary: (profile: QueryProfile) => JSX.Element,
  onBack: () => void,
}

type ProfileDraft =
  | { kind: "saveAs", context: QueryProfileSaveContext }
  | { kind: "saveChanges", profile: QueryProfile, context: QueryProfileSaveContext }
  | { kind: "rename" | "delete", profile: QueryProfile };

const sameProfile = (left: QueryProfile, right: QueryProfile) => left.id == right.id && left.name == right.name &&
  queryConfigurationsEqual(left.configuration, right.configuration);
const actionClass = "rounded border border-slate-300 px-2 py-1 text-[11px] hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-default disabled:opacity-40";
const nameEncoder = new TextEncoder();
const nameProblem = (name: string): string | null => name.trim() == "" ? "Enter a profile name."
  : /[\u0000-\u001f\u007f-\u009f]/.test(name.trim()) ? "Remove control characters from the profile name."
  : nameEncoder.encode(name.trim()).length > 120 ? "The profile name is too long. Shorten it." : null;

/** Edits saved account profiles; only saving the current setup can rebase this query's snapshot. */
export function QueryProfileManager(props: QueryProfileManagerProps) {
  const store = useStore();
  const ownerId = store.user.getUserMaybe()?.userId ?? null;
  let mounted = true;
  let body: HTMLDivElement | undefined;
  onCleanup(() => { mounted = false; });
  const [draft, setDraft] = createSignal<ProfileDraft | null>(null);
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const collection = createMemo(() => store.general.queryProfiles.collection());
  const profiles = () => collection()?.profiles ?? [];
  const pins = () => collection()?.preferences.pinnedProfileIds ?? [];
  const accountChanged = () => (store.user.getUserMaybe()?.userId ?? null) != ownerId;
  const unavailable = () => busy() || accountChanged() || collection() == null;
  const isDefault = (id: Uid) => collection()?.preferences.defaultProfileId == id;
  const isPinned = (id: Uid) => pins().includes(id);
  const targetStale = () => {
    const current = draft();
    if (current == null || current.kind == "saveAs") { return false; }
    const saved = profiles().find(profile => profile.id == current.profile.id);
    return saved == null || !sameProfile(saved, current.profile);
  };
  const focus = (key?: string) => queueMicrotask(() => {
    if (!mounted) { return; }
    const target = key == null ? null : Array.from(body?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])
      .find(button => button.dataset.profileAction == key);
    (target ?? body?.querySelector<HTMLElement>("[data-profile-editor-focus]") ?? body)?.focus();
  });
  createEffect(() => { draft(); focus(); });
  const begin = (kind: "rename" | "delete", profile: QueryProfile) => {
    if (unavailable()) { return; }
    setError(null); setNotice(null);
    setName(profile.name);
    setDraft({ kind, profile: snapshotQueryProfile(profile) });
  };
  const beginSave = (kind: "saveAs" | "saveChanges") => {
    if (unavailable() || props.currentBlockedReason() != null) { return; }
    const context = props.captureCurrent();
    if (context.accountId != ownerId) { return; }
    setError(null); setNotice(null); setName("");
    if (kind == "saveAs") { setDraft({ kind, context }); return; }
    const profile = profiles().find(profile => profile.id == context.appliedProfile?.id);
    if (profile == null) { setError("The applied profile no longer exists. Use Save as profile instead."); return; }
    setDraft({ kind, profile: snapshotQueryProfile(profile), context });
  };
  if (props.initialAction != "manage") { beginSave(props.initialAction); }

  const run = async (action: () => Promise<string>, focusKey?: string) => {
    if (unavailable()) { return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const message = await action();
      if (mounted && !accountChanged()) { setDraft(null); setNotice(message); focus(focusKey); }
    } catch (error) {
      if (mounted && !accountChanged()) { setError(error instanceof Error ? error.message : String(error)); }
    } finally { if (mounted) { setBusy(false); } }
  };
  const togglePin = (profile: QueryProfile) => {
    const wasPinned = isPinned(profile.id);
    void run(async () => {
      await store.general.queryProfiles.setPinned(profile.id, !wasPinned);
      return `${wasPinned ? "Unpinned" : "Pinned"} “${profile.name}”.`;
    }, `${profile.id}:pin`);
  };
  const reorder = (profile: QueryProfile, index: number, direction: -1 | 1) => {
    void run(async () => {
      await store.general.queryProfiles.move(profile.id, index + direction);
      return `Moved “${profile.name}”.`;
    }, `${profile.id}:order:${direction}`);
  };
  const makeDefault = (profile: QueryProfile) => {
    void run(async () => { await store.general.queryProfiles.setDefault(profile.id); return `“${profile.name}” is the default for new queries.`; }, `${profile.id}:default`);
  };
  const duplicate = (profile: QueryProfile) => {
    void run(async () => { const copy = await store.general.queryProfiles.duplicate(profile.id); return `Created “${copy.name}”.`; });
  };
  /** Deleting the default makes the first remaining profile the default. */
  const nextDefault = (deleted: QueryProfile) => isDefault(deleted.id) ? profiles().find(profile => profile.id != deleted.id) ?? null : null;
  const submit = (ev: SubmitEvent) => {
    ev.preventDefault();
    const current = draft();
    const saved = collection();
    if (current == null || saved == null || unavailable() || targetStale()) { return; }
    const trimmed = name().trim();
    if ((current.kind == "saveAs" || current.kind == "rename") && nameProblem(trimmed) != null) {
      setError(nameProblem(trimmed)); return;
    }
    if ((current.kind == "saveAs" || current.kind == "saveChanges") && props.currentBlockedReason() != null) { return; }
    if (current.kind == "delete" && saved.profiles.length <= 1) { return; }
    void run(async () => {
      switch (current.kind) {
        case "saveAs":
        case "saveChanges": {
          const profile = current.kind == "saveAs"
            ? await store.general.queryProfiles.create(trimmed, current.context.configuration)
            : await store.general.queryProfiles.setConfiguration(current.profile.id, current.context.configuration);
          const rebased = mounted && !accountChanged() && props.onSaved(profile, current.context);
          return rebased ? `Saved “${profile.name}”.` : `Saved “${profile.name}”. Select it to use its settings.`;
        }
        case "rename":
          await store.general.queryProfiles.rename(current.profile.id, trimmed);
          return `Renamed profile to “${trimmed}”.`;
        case "delete":
          await store.general.queryProfiles.delete(current.profile.id);
          return `Deleted “${current.profile.name}”. Existing query settings were kept.`;
      }
    });
  };
  const preview = (current: ProfileDraft): QueryProfile => current.kind == "saveAs"
    ? { id: "", name: name().trim(), configuration: current.context.configuration }
    : current.kind == "saveChanges" ? { ...current.profile, configuration: current.context.configuration } : current.profile;
  const formTitle = (current: ProfileDraft) => current.kind == "saveAs" ? "Save as profile"
    : current.kind == "saveChanges" ? `Save changes to “${current.profile.name}”`
    : `${current.kind == "rename" ? "Rename" : "Delete"} “${current.profile.name}”`;
  const submitDisabled = () => {
    const current = draft();
    if (current == null || unavailable() || targetStale()) { return true; }
    if (current.kind == "saveAs" || current.kind == "saveChanges") { if (props.currentBlockedReason() != null) { return true; } }
    if (current.kind == "delete") { return profiles().length <= 1; }
    return current.kind != "saveChanges" && nameProblem(name()) != null;
  };

  return <div ref={body} tabindex={-1} class="min-h-0 overflow-y-auto px-3 py-2 outline-hidden">
    <div class="mb-2 flex items-center gap-2">
      <button type="button" class={actionClass} disabled={busy()} onClick={props.onBack}>Back to profiles</button>
      <span class="text-[12px] font-medium text-slate-600">Manage profiles</span>
    </div>
    <Show when={accountChanged()}><div role="alert" class="mb-2 text-[12px] text-red-700">The account changed. Close and reopen profile management.</div></Show>
    <Show when={store.general.queryProfiles.error()}>
      <div role="alert" class="mb-2 text-[12px] text-red-700">{store.general.queryProfiles.error()}
        <button type="button" class="ml-2 underline" disabled={busy() || accountChanged() || store.general.queryProfiles.loading()}
          onClick={() => { void store.general.queryProfiles.refresh(); }}>Retry</button>
      </div>
    </Show>
    <Show when={collection() == null && !accountChanged() && store.general.queryProfiles.error() == null}>
      <div class="mb-2 text-[12px] text-slate-500">Loading profiles…</div>
    </Show>
    <Show when={error()}><div role="alert" class="mb-2 break-words text-[12px] text-red-700">{error()}</div></Show>
    <Show when={notice()}><div role="status" class="mb-2 break-words text-[12px] text-slate-600">{notice()}</div></Show>
    <Show when={busy()}><div role="status" class="mb-2 text-[12px] text-slate-500">Saving…</div></Show>
    <Show when={draft()} keyed fallback={<>
      <div class="mb-2 text-[11px] text-slate-500">The default applies to new queries. Managing saved profiles keeps existing query settings.</div>
      <button type="button" class={actionClass} disabled={unavailable() || props.currentBlockedReason() != null}
        title={props.currentBlockedReason() ?? "Save this query's scope, model and tools"} onClick={() => beginSave("saveAs")}>Save current setup as profile…</button>
      <div class="mt-3 text-[12px] font-medium text-slate-600">Saved profiles</div>
      <For each={profiles()}>{(profile, index) => <div class="mt-2 rounded border border-slate-200 p-2">
        <div class="flex items-center gap-2">
          <span class="min-w-0 grow break-words text-[13px] font-medium">{profile.name}</span>
          <Show when={isDefault(profile.id)}><span class="shrink-0 rounded bg-slate-100 px-1 text-[10px] text-slate-600">Default</span></Show>
          <button type="button" class={actionClass} data-profile-action={`${profile.id}:order:-1`} aria-label={`Move ${profile.name} up`}
            disabled={unavailable() || index() == 0} onClick={() => reorder(profile, index(), -1)}><i class="bi-arrow-up" /></button>
          <button type="button" class={actionClass} data-profile-action={`${profile.id}:order:1`} aria-label={`Move ${profile.name} down`}
            disabled={unavailable() || index() == profiles().length - 1} onClick={() => reorder(profile, index(), 1)}><i class="bi-arrow-down" /></button>
        </div>
        {props.summary(profile)}
        <div class="mt-2 flex flex-wrap items-center gap-1">
          <button type="button" class={actionClass} data-profile-action={`${profile.id}:pin`} aria-pressed={isPinned(profile.id)} disabled={unavailable()} onClick={() => togglePin(profile)}>{isPinned(profile.id) ? "Unpin" : "Pin"}</button>
          <button type="button" class={actionClass} data-profile-action={`${profile.id}:default`} disabled={unavailable() || isDefault(profile.id)} onClick={() => makeDefault(profile)}>Make default</button>
          <button type="button" class={actionClass} disabled={unavailable()} onClick={() => begin("rename", profile)}>Rename</button>
          <button type="button" class={actionClass} disabled={unavailable()} onClick={() => duplicate(profile)}>Duplicate</button>
          <button type="button" class={`${actionClass} text-red-700`} disabled={unavailable() || profiles().length <= 1}
            title={profiles().length <= 1 ? "Keep at least one profile." : `Delete ${profile.name}`} onClick={() => begin("delete", profile)}>Delete</button>
        </div>
      </div>}</For>
    </>}>
      {current => <form onSubmit={submit}>
        <div class="mb-2 break-words text-[13px] font-medium">{formTitle(current)}</div>
        <Show when={current.kind == "saveAs" || current.kind == "rename"}>
          <label class="mb-2 block text-[12px]">Profile name
            <input data-profile-editor-focus class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-[13px] outline-blue-500" maxLength={120}
              required value={name()} disabled={busy()} aria-invalid={name().length > 0 && nameProblem(name()) != null}
              onInput={ev => setName(ev.currentTarget.value)} />
            <Show when={name().length > 0 && nameProblem(name()) != null}><span role="status" class="mt-1 block text-[11px] text-red-700">{nameProblem(name())}</span></Show>
          </label>
        </Show>
        <div class="mb-2 rounded bg-slate-50 p-2">{props.summary(preview(current))}</div>
        <Show when={current.kind == "saveAs"}><div class="mb-2 text-[11px] text-slate-500">Saves this query's scope, model and tools. Pin it in Manage profiles for one-click access.</div></Show>
        <Show when={current.kind == "saveChanges"}>
          <div class="mb-2 text-[11px] text-slate-500">Replace the saved profile's settings with the setup shown above. Existing chats keep their snapshots.</div>
          <Show when={current.kind == "saveChanges" && current.context.appliedProfile != null && !sameProfile(current.profile, current.context.appliedProfile)}>
            <div class="mb-2 text-[11px] text-amber-700">The saved profile has changed since it was applied. Saving replaces its current settings.</div>
          </Show>
        </Show>
        <Show when={current.kind == "delete"}>
          <div class="mb-2 text-[12px] text-slate-600">Delete this saved profile? Existing chats keep their applied settings.</div>
          <Show when={profiles().length <= 1}><div class="mb-2 text-[11px] text-amber-700">Keep at least one profile. Save another before deleting this one.</div></Show>
          <Show when={current.kind == "delete" ? nextDefault(current.profile) : null}>{next =>
            <div class="mb-2 text-[11px] text-slate-500">“{next().name}” will become the default for new queries.</div>
          }</Show>
        </Show>
        <Show when={targetStale()}><div role="alert" class="mb-2 text-[12px] text-amber-700">This saved profile changed or was deleted while editing. Cancel and reopen the action to review it.</div></Show>
        <Show when={(current.kind == "saveAs" || current.kind == "saveChanges") && props.currentBlockedReason() != null}>
          <div class="mb-2 text-[11px] text-slate-500">{props.currentBlockedReason()}</div>
        </Show>
        <div class="flex items-center gap-2">
          <button data-profile-editor-focus={current.kind == "saveChanges" || current.kind == "delete" ? true : undefined}
            type="submit" class={`${actionClass} ${current.kind == "delete" ? "text-red-700" : "font-medium"}`} disabled={submitDisabled()}>
            {current.kind == "delete" ? "Delete profile" : current.kind == "saveChanges" ? "Save changes" : "Save profile"}
          </button>
          <button type="button" class={actionClass} disabled={busy()} onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
        </div>
      </form>}
    </Show>
  </div>;
}
