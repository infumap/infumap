/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { queryChatModelSelection, setQueryChatModelSelection } from "../../items/chat";
import { getQueryRuntime } from "../../items/query-item";
import type { QueryModelFavorite } from "../../items/query-configuration";
import type { ChatModelInfo } from "../../server";
import { useStore } from "../../store/StoreProvider";
import { QueryPickerPopover, type QueryPickerProps } from "./QueryPickerPopover";
import { queryConfigurationChangeBlockedReason } from "../../items/query-configuration-state";
import { queryModelIssues } from "../../items/query-configuration-availability";

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const effortLabel = (effort: string) => effort == "none" ? "Off" : effort == "xhigh" ? "X-High" : effort[0]?.toUpperCase() + effort.slice(1);
const keyFor = (model: QueryModelFavorite) => JSON.stringify([model.backend, model.model]);
const shortName = (name: string) => name.includes(": ") ? name.substring(name.indexOf(": ") + 2) : name;

function modelDetails(model: ChatModelInfo): string {
  const parts: string[] = [];
  if (model.contextLength != null && model.contextLength > 0) {
    const n = model.contextLength;
    parts.push(n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M context` : n >= 1000 ? `${Math.round(n / 1000)}K context` : `${n} context`);
  }
  const price = (value: string | undefined) => value == null || !Number.isFinite(Number(value)) ? null : `$${(Number(value) * 1_000_000).toFixed(2)}/M`;
  const input = price(model.promptPrice);
  const output = price(model.completionPrice);
  if (input != null && output != null) { parts.push(`${input} in · ${output} out`); }
  if (model.reasoningEfforts.length > 0) { parts.push(model.reasoningMandatory ? "Always reasons" : "Reasoning available"); }
  return parts.join(" · ");
}

interface ModelChoice extends QueryModelFavorite {
  name: string,
  provider: string,
  info?: ChatModelInfo,
  available: boolean,
  reason: string | null,
}

export function QueryModelPicker(props: QueryPickerProps) {
  const store = useStore();
  const [filter, setFilter] = createSignal("");
  const [favoriteBusy, setFavoriteBusy] = createSignal(false);
  const [favoriteError, setFavoriteError] = createSignal<string | null>(null);
  onMount(() => { void store.general.queryProfiles.retrieve(); void store.general.retrieveChatBackends(); });
  const selection = createMemo(() => queryChatModelSelection(store, props.queryItem()));
  const selectionIssues = () => queryModelIssues(store, selection());
  const ready = () => getQueryRuntime(store, props.queryItem()).configurationInitialized || store.general.defaultQueryProfile() != null;
  const blockedReason = () => queryConfigurationChangeBlockedReason(store, props.queryItem());
  const canChange = () => ready() && props.disabled?.() != true && blockedReason() == null;
  const favorites = createMemo(() => store.general.queryProfiles.collection()?.preferences.modelFavorites ?? []);
  const favoriteKeys = createMemo(() => new Set(favorites().map(keyFor)));
  const catalogChoices = createMemo(() => {
    const result: ModelChoice[] = [];
    const backends = store.general.chatBackends()?.backends ?? [];
    for (const backend of backends) {
      if (!backend.supportsModelSelection) {
        result.push({ backend: backend.id, model: null, name: "Server-selected", provider: backend.label,
          available: backend.available, reason: backend.unavailableReason ?? null });
      } else {
        for (const model of backend.models) {
          result.push({ backend: backend.id, model: model.id, name: model.name, provider: backend.label,
            info: model, available: backend.available, reason: backend.unavailableReason ?? null });
        }
      }
    }
    const retained = [...favorites(), ...(selection() == null ? [] : [selection()!])];
    for (const model of retained) {
      if (result.some(choice => keyFor(choice) == keyFor(model))) { continue; }
      const backend = backends.find(backend => backend.id == model.backend);
      result.push({ ...model, name: model.model ?? "Server-selected", provider: backend?.label ?? model.backend,
        available: backend?.available == true && (model.model == null || backend.modelsError != null),
        reason: store.general.chatBackends() == null ? "Loading the model catalog…"
          : backend == null ? "Provider is not configured" : !backend.available ? backend.unavailableReason ?? "Provider unavailable"
          : model.model == null ? null : backend.modelsError ?? "Model is not in the current catalog" });
    }
    return result.map(choice => {
      // Catalog entries already carry their provider's availability; only retained choices need lookup.
      if (choice.info != null) { return choice; }
      const issues = queryModelIssues(store, { backend: choice.backend, model: choice.model, reasoningEffort: null });
      return { ...choice, available: !issues.some(issue => issue.status == "unavailable"), reason: issues.length > 0 ? issues.map(issue => issue.message).join(" ") : choice.reason };
    });
  });
  const choices = createMemo(() => {
    const text = filter().trim().toLowerCase();
    return catalogChoices().filter(choice => `${choice.name} ${choice.provider} ${choice.backend} ${choice.model ?? ""}`.toLowerCase().includes(text))
      .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider));
  });
  const favoriteChoices = () => favorites().map(favorite => choices().find(choice => keyFor(choice) == keyFor(favorite)))
    .filter((choice): choice is ModelChoice => choice != null);
  const otherChoices = () => choices().filter(choice => !favoriteKeys().has(keyFor(choice)));
  const backend = () => store.general.chatBackends()?.backends.find(backend => backend.id == selection()?.backend);
  const model = () => backend()?.models.find(model => model.id == selection()?.model);
  const label = () => {
    if (!ready()) { return store.general.queryProfiles.error() != null ? "Profile unavailable" : "Loading…"; }
    const chosen = selection();
    return chosen == null ? "Choose…" : chosen.model == null ? "Server-selected" : shortName(model()?.name ?? chosen.model);
  };
  const provider = () => backend()?.label ?? selection()?.backend ?? null;
  const efforts = () => [...(backend()?.supportsReasoningEffort ? model()?.reasoningEfforts ?? [] : [])]
    .sort((a, b) => (EFFORTS.indexOf(a) < 0 ? 99 : EFFORTS.indexOf(a)) - (EFFORTS.indexOf(b) < 0 ? 99 : EFFORTS.indexOf(b)));
  const select = (choice: ModelChoice, close: () => void) => {
    if (!canChange() || !choice.available) { return; }
    props.beforeChange?.();
    const current = selection();
    const effort = current?.reasoningEffort;
    setQueryChatModelSelection(store, props.queryItem(), {
      backend: choice.backend, model: choice.model,
      reasoningEffort: current != null && keyFor(current) == keyFor(choice) ? current.reasoningEffort
        : effort != null && choice.info?.reasoningEfforts.includes(effort) ? effort : null,
    });
    close();
  };
  const toggleFavorite = async (choice: ModelChoice) => {
    const collection = store.general.queryProfiles.collection();
    if (favoriteBusy() || collection == null) { return; }
    setFavoriteBusy(true); setFavoriteError(null);
    const key = keyFor(choice);
    const current = collection.preferences.modelFavorites;
    const next = current.some(model => keyFor(model) == key) ? current.filter(model => keyFor(model) != key)
      : [...current, { backend: choice.backend, model: choice.model }];
    try { await store.general.queryProfiles.setModelFavorites(next, collection.revision); }
    catch (error) { setFavoriteError(error instanceof Error ? error.message : String(error)); }
    finally { setFavoriteBusy(false); }
  };
  const rows = (rows: () => ModelChoice[], close: () => void) => <For each={rows()}>{choice =>
    <div class="flex items-center gap-1 px-2">
      <button type="button" role="radio" aria-checked={selection() != null && keyFor(selection()!) == keyFor(choice)}
        disabled={!canChange() || !choice.available}
        class="flex min-w-0 grow items-start gap-2 cursor-pointer rounded px-2 py-1.5 text-left hover:bg-slate-100 disabled:cursor-default disabled:opacity-50"
        onClick={() => select(choice, close)}>
        <div class="min-w-0 grow">
          <div class="truncate text-[13px]">{choice.name}</div>
          <div class="text-[11px] text-slate-500">{choice.backend.startsWith("llama") ? "on" : "via"} {choice.provider}</div>
          <Show when={choice.info}><div class="text-[11px] text-slate-500">{modelDetails(choice.info!)}</div></Show>
          <Show when={choice.reason != null}><div class="text-[11px] text-amber-700">{choice.reason}</div></Show>
        </div>
        <Show when={selection() != null && keyFor(selection()!) == keyFor(choice)}><i class="bi-check-lg shrink-0 text-slate-700" /></Show>
      </button>
      <button type="button" class="h-7 w-7 shrink-0 rounded text-slate-400 hover:bg-slate-100 disabled:opacity-40"
        disabled={favoriteBusy() || store.general.queryProfiles.collection() == null}
        aria-pressed={favoriteKeys().has(keyFor(choice))}
        aria-label={`${favoriteKeys().has(keyFor(choice)) ? "Remove" : "Add"} favorite: ${choice.name} via ${choice.provider}`}
        onClick={() => { void toggleFavorite(choice); }}>
        <i class={favoriteKeys().has(keyFor(choice)) ? "bi-star-fill text-amber-600" : "bi-star"} />
      </button>
    </div>
  }</For>;

  return <QueryPickerPopover buttonRef={props.buttonRef} onTabKey={props.onTabKey} disabled={props.disabled?.() || blockedReason() != null}
    buttonClass="max-w-[340px] flex-[2_1_auto] cursor-pointer" ariaLabel="Choose model and provider"
    title={[`Model: ${label()}${provider() == null ? "" : ` / ${provider()}`}${selection()?.reasoningEffort == null ? "" : ` · ${effortLabel(selection()!.reasoningEffort!)}`}`, ...selectionIssues().map(issue => issue.message), blockedReason(), props.note?.()].filter(Boolean).join("\n")}
    label={<><span class="shrink-0">Model:</span><span class="min-w-0 truncate">{label()}</span>
      <Show when={provider() != null}><span class="max-w-[90px] shrink-0 truncate text-slate-500">/ {provider()}</span></Show>
      <Show when={selection()?.reasoningEffort != null}><span class="shrink-0 text-slate-500">· {effortLabel(selection()!.reasoningEffort!)}</span></Show>
      <Show when={ready() && selectionIssues().length > 0}><i class="bi-exclamation-triangle shrink-0 text-[11px] text-amber-600" /></Show></>}
    onOpen={() => { setFilter(""); setFavoriteError(null); void store.general.queryProfiles.refresh(); void store.general.refreshChatBackends(); }}>
    {close => <>
      <div class="max-h-[220px] overflow-y-auto border-b border-slate-200 px-3 py-2">
        <div class="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-slate-600">Model and provider
          <button type="button" class="ml-auto h-5 w-5 rounded hover:bg-slate-100" aria-label="Close model picker" onClick={close}><i class="bi-x-lg" /></button>
        </div>
        <Show when={props.note?.()}><div class="mb-1.5 text-[11px] text-slate-500">{props.note?.()}</div></Show>
        <For each={selectionIssues()}>{issue => <div role="status" class="mb-1.5 text-[11px] text-amber-700">{issue.message}</div>}</For>
        <button type="button" class="mb-1.5 text-[11px] text-blue-700 hover:underline" disabled={store.general.chatBackendsRefreshing()}
          onClick={() => { void store.general.refreshChatBackends(); }}>{store.general.chatBackendsRefreshing() ? "Checking availability…" : "Refresh model availability"}</button>
        <input data-picker-autofocus type="search" aria-label="Search models and providers" placeholder="Search models or providers…"
          class="w-full rounded border border-slate-300 px-2 py-1 text-[12px] outline-hidden focus:border-slate-500"
          value={filter()} onInput={ev => setFilter(ev.currentTarget.value)}
          onKeyDown={ev => {
            if (ev.key == "ArrowDown") {
              ev.preventDefault();
              ev.currentTarget.closest("[role='dialog']")?.querySelector<HTMLButtonElement>("button[role='radio']:not([disabled])")?.focus();
            }
          }} />
      </div>
      <div class="min-h-0 grow overflow-y-auto py-1" role="radiogroup" aria-label="Model and provider combinations">
        <Show when={store.general.queryProfiles.error()}><div class="px-3 py-1 text-[12px] text-red-700">{store.general.queryProfiles.error()}</div></Show>
        <Show when={store.general.chatBackendsError()}><div class="px-3 py-1 text-[12px] text-red-700">{store.general.chatBackendsError()}</div></Show>
        <Show when={favoriteError()}><div class="px-3 py-1 text-[12px] text-red-700" role="alert">{favoriteError()}</div></Show>
        <Show when={store.general.chatBackends() == null && store.general.chatBackendsError() == null}><div class="px-3 py-2 text-[12px] text-slate-500">Loading models…</div></Show>
        <Show when={favoriteChoices().length > 0}><div class="px-3 py-1 text-[11px] font-medium text-slate-500">Favorites</div>{rows(favoriteChoices, close)}</Show>
        <Show when={otherChoices().length > 0}><div class="px-3 py-1 text-[11px] font-medium text-slate-500">All models</div>{rows(otherChoices, close)}</Show>
        <Show when={choices().length == 0 && store.general.chatBackends() != null}><div class="px-3 py-2 text-[12px] text-slate-500">No matching models or providers.</div></Show>
        <For each={store.general.chatBackends()?.backends.filter(backend => backend.modelsError != null) ?? []}>{backend =>
          <div class="px-3 py-1 text-[12px] text-amber-700">{backend.label}: {backend.modelsError}</div>
        }</For>
      </div>
      <Show when={efforts().length > 0 || selection()?.reasoningEffort != null}>
        <div class="shrink-0 border-t border-slate-200 px-3 py-2 text-[12px]">
          <label class="flex items-center gap-2">Reasoning effort
            <select class="ml-auto rounded border border-slate-300 bg-white px-2 py-1" disabled={!canChange()}
              value={selection()?.reasoningEffort ?? ""}
              onChange={ev => {
                const chosen = selection();
                if (chosen == null || !canChange()) { return; }
                const effort = ev.currentTarget.value || null;
                props.beforeChange?.();
                setQueryChatModelSelection(store, props.queryItem(), { ...chosen, reasoningEffort: effort });
              }}>
              <option value="">Default{model()?.defaultEffort == null ? "" : ` (${effortLabel(model()!.defaultEffort!)})`}</option>
              <Show when={selection()?.reasoningEffort != null && !efforts().includes(selection()!.reasoningEffort!)}>
                <option disabled value={selection()!.reasoningEffort!}>{effortLabel(selection()!.reasoningEffort!)} ({selectionIssues().some(issue => issue.status == "unavailable") ? "unavailable" : "unverified"})</option>
              </Show>
              <For each={efforts()}>{effort => <option value={effort}>{effortLabel(effort)}</option>}</For>
            </select>
          </label>
        </div>
      </Show>
    </>}
  </QueryPickerPopover>;
}
