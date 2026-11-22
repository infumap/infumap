/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { queryChatModelSelection, setQueryChatModelSelection } from "../../items/chat";
import { getQueryRuntime } from "../../items/query-item";
import type { QueryModelFavorite } from "../../items/query-configuration";
import type { ChatBackendInfo, ChatModelInfo } from "../../server";
import { useStore } from "../../store/StoreProvider";
import { QueryPickerPopover, type QueryPickerProps } from "./QueryPickerPopover";
import { DIALOG_INPUT_CLASS, DIALOG_NOTE_CLASS, DialogHeader } from "../library/dialogStyle";
import { queryConfigurationChangeBlockedReason } from "../../items/query-configuration-state";
import { queryModelIssues } from "../../items/query-configuration-availability";
import {
  REASONING_EFFORTS, queryModelLabel, queryModelRouteLabel, queryProviderLabel, reasoningEffortLabel,
} from "../../items/query-configuration-labels";

const keyFor = (model: QueryModelFavorite) => JSON.stringify([model.backend, model.model]);

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
  const [providerId, setProviderId] = createSignal<string | null>(null);
  const [favoriteBusy, setFavoriteBusy] = createSignal(false);
  const [favoriteError, setFavoriteError] = createSignal<string | null>(null);
  let searchInput: HTMLInputElement | undefined;
  let modelList: HTMLDivElement | undefined;
  onMount(() => { void store.general.queryProfiles.retrieve(); void store.general.retrieveChatBackends(); });
  const selection = createMemo(() => queryChatModelSelection(store, props.queryItem()));
  const selectionIssues = () => queryModelIssues(store, selection());
  const ready = () => getQueryRuntime(store, props.queryItem()).configurationInitialized || store.general.initialQuerySetup() != null;
  const blockedReason = () => queryConfigurationChangeBlockedReason(store, props.queryItem());
  const canChange = () => ready() && props.disabled?.() != true && blockedReason() == null;
  const favorites = createMemo(() => store.general.queryProfiles.collection()?.preferences.modelFavorites ?? []);
  const favoriteKeys = createMemo(() => new Set(favorites().map(keyFor)));
  const backends = createMemo(() => store.general.chatBackends()?.backends ?? []);
  const browsedProvider = createMemo(() => backends().find(backend => backend.id == providerId()));
  const searchText = createMemo(() => filter().trim().toLowerCase());
  const catalogChoices = createMemo(() => {
    const result = new Map<string, ModelChoice>();
    for (const backend of backends()) {
      for (const model of backend.models) {
        const choice = { backend: backend.id, model: model.id, name: model.name, provider: backend.label,
          info: model, available: backend.available, reason: backend.unavailableReason ?? null };
        result.set(keyFor(choice), choice);
      }
    }
    const current = selection();
    const retained = current == null ? favorites() : [...favorites(), current];
    for (const model of retained) {
      const key = keyFor(model);
      if (result.has(key)) { continue; }
      const provider = queryProviderLabel(store, model.backend);
      const issues = queryModelIssues(store, { backend: model.backend, model: model.model, reasoningEffort: null });
      result.set(key, { ...model, name: model.model ?? provider, provider,
        available: !issues.some(issue => issue.status == "unavailable"), reason: issues.map(issue => issue.message).join(" ") || null });
    }
    return result;
  });
  // Start with providers so a discovered catalog can never crowd out a single-model endpoint.
  const browseProviders = () => browsedProvider() == null && searchText() == "";
  const matchesFilter = (choice: ModelChoice) => {
    const name = browsedProvider() == null ? `${choice.name} ${choice.provider} ${choice.backend}` : choice.name;
    return `${name} ${choice.model ?? ""}`.toLowerCase().includes(searchText());
  };
  const choices = createMemo(() => {
    if (browseProviders()) { return []; }
    const provider = browsedProvider();
    return Array.from(catalogChoices().values()).filter(choice => (provider == null || choice.backend == provider.id) && matchesFilter(choice))
      .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider));
  });
  const favoriteChoices = createMemo(() => favorites().map(favorite => catalogChoices().get(keyFor(favorite)))
    .filter((choice): choice is ModelChoice => choice != null && matchesFilter(choice)));
  const resultChoices = () => browsedProvider() != null ? choices() : choices().filter(choice => !favoriteKeys().has(keyFor(choice)));
  const retainedSelection = () => {
    const current = selection();
    if (current == null || favoriteKeys().has(keyFor(current))) { return undefined; }
    const choice = catalogChoices().get(keyFor(current));
    return choice?.info == null ? choice : undefined;
  };
  const browse = (id: string | null) => {
    setProviderId(id);
    setFilter("");
    if (modelList != null) { modelList.scrollTop = 0; }
    searchInput?.focus();
  };
  const enabledOptions = () => Array.from(modelList?.querySelectorAll<HTMLButtonElement>("[data-model-picker-choice]:not([disabled])") ?? []);
  const navigateProviders = (ev: KeyboardEvent) => {
    if (!browseProviders() || (ev.key != "ArrowDown" && ev.key != "ArrowUp") || !(ev.target instanceof HTMLButtonElement)) { return; }
    const options = enabledOptions();
    const index = options.indexOf(ev.target);
    if (index < 0) { return; }
    ev.preventDefault();
    ev.stopPropagation();
    options[(index + (ev.key == "ArrowDown" ? 1 : -1) + options.length) % options.length].focus();
  };
  const backend = () => backends().find(backend => backend.id == selection()?.backend);
  const model = () => backend()?.models.find(model => model.id == selection()?.model);
  const label = () => {
    if (!ready()) { return store.general.queryProfiles.error() != null || store.general.chatBackendsError() != null ? "Unavailable" : "Loading…"; }
    return selection() == null ? "Choose a model" : queryModelLabel(store, selection(), true);
  };
  const rank = (effort: string) => REASONING_EFFORTS.indexOf(effort) < 0 ? 99 : REASONING_EFFORTS.indexOf(effort);
  const efforts = () => [...(model()?.reasoningEfforts ?? [])]
    .sort((a, b) => rank(a) - rank(b));
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
    if (favoriteBusy() || store.general.queryProfiles.collection() == null) { return; }
    setFavoriteBusy(true); setFavoriteError(null);
    try { await store.general.queryProfiles.setModelFavorite(choice, !favoriteKeys().has(keyFor(choice))); }
    catch (error) { setFavoriteError(error instanceof Error ? error.message : String(error)); }
    finally { setFavoriteBusy(false); }
  };
  const row = (choice: ModelChoice, close: () => void, showProvider = true) => {
    const key = keyFor(choice);
    const selected = () => selection() != null && keyFor(selection()!) == key;
    const isFavorite = () => favoriteKeys().has(key);
    return <div class="flex items-center gap-1 px-2">
      <button type="button" data-model-picker-choice role={browseProviders() ? undefined : "radio"}
        aria-checked={browseProviders() ? undefined : selected()} aria-current={browseProviders() && selected() ? true : undefined}
        disabled={!canChange() || !choice.available}
        class="flex min-w-0 grow items-start gap-2 cursor-pointer rounded px-2 py-1.5 text-left hover:bg-control-hover disabled:cursor-default disabled:opacity-50"
        onClick={() => select(choice, close)}>
        <div class="min-w-0 grow">
          <div class="truncate text-[13px]">{showProvider ? `${choice.provider}: ${choice.name}` : choice.name}</div>
          <Show when={choice.info}><div class="text-[11px] text-neutral-500">{modelDetails(choice.info!)}</div></Show>
          <Show when={choice.reason != null}><div class="text-[11px] text-amber-700">{choice.reason}</div></Show>
        </div>
        <Show when={selected()}><i class="bi-check-lg shrink-0 text-neutral-700" aria-hidden="true" /></Show>
      </button>
      <button type="button" class="h-7 w-7 shrink-0 rounded text-neutral-400 hover:bg-control-hover disabled:opacity-40"
        disabled={favoriteBusy() || store.general.queryProfiles.collection() == null}
        aria-pressed={isFavorite()}
        aria-label={`${isFavorite() ? "Remove" : "Add"} favorite: ${choice.provider}: ${choice.name}`}
        onClick={() => { void toggleFavorite(choice); }}>
        <i class={isFavorite() ? "bi-star-fill text-amber-600" : "bi-star"} aria-hidden="true" />
      </button>
    </div>;
  };
  const providerRow = (provider: ChatBackendInfo, close: () => void) => {
    const singleModel = () => provider.models.length == 1
      ? catalogChoices().get(keyFor({ backend: provider.id, model: provider.models[0].id })) : undefined;
    return <>
      <Show when={singleModel()} fallback={
        <div class="px-2">
          <Show when={provider.models.length > 1} fallback={<div class="px-2 py-1.5">
            <div class="truncate text-[13px]">{provider.label}</div>
            <div class="text-[11px] text-neutral-500">{provider.unavailableReason ?? provider.modelsError ?? "No models available"}</div>
          </div>}>
            <button type="button" data-model-picker-choice class="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-control-hover"
              onClick={() => browse(provider.id)}>
              <span class="min-w-0 grow truncate text-[13px]">{provider.label}</span>
              <span class="shrink-0 text-[11px] text-neutral-500">{provider.models.length} models</span>
              <i class="bi-chevron-right shrink-0 text-[10px] text-neutral-500" aria-hidden="true" />
            </button>
          </Show>
        </div>
      }>{choice => row(choice(), close)}</Show>
      <Show when={provider.models.length > 0 && provider.modelsError}>
        <div class="px-4 pb-1 text-[11px] text-amber-700">{provider.modelsError}</div>
      </Show>
    </>;
  };

  return <QueryPickerPopover buttonRef={props.buttonRef} onTabKey={props.onTabKey} disabled={props.disabled?.() || blockedReason() != null}
    buttonClass="max-w-[260px] cursor-pointer" ariaLabel="Choose model and provider"
    title={[`Model: ${ready() && selection() != null ? queryModelRouteLabel(store, selection()) : label()}`, ...selectionIssues().map(issue => issue.message), blockedReason(), props.note?.()].filter(Boolean).join("\n")}
    label={<><i class="bi-cpu shrink-0 text-[11px]" />
      {/* Short backend/model labels stay visible; the scope and tools pills give way first. */}
      <span class={label().length <= 12 ? "shrink-0" : "min-w-0 truncate"}>{label()}</span>
      <Show when={ready() && selectionIssues().length > 0}><i class="bi-exclamation-triangle shrink-0 text-[11px] text-amber-600" /></Show></>}
    onOpen={() => { setProviderId(null); setFilter(""); setFavoriteError(null); void store.general.queryProfiles.refresh(); void store.general.refreshChatBackends(); }}>
    {close => <>
      <DialogHeader title={browsedProvider()?.label ?? "Model and provider"}>
        <Show when={browsedProvider() != null}>
          <button type="button" class="mt-1 flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[12px] text-neutral-700 hover:bg-control-hover"
            onClick={() => browse(null)}><i class="bi-chevron-left text-[10px]" aria-hidden="true" />All providers</button>
        </Show>
        <Show when={props.note?.()}><div class={`mt-1 ${DIALOG_NOTE_CLASS}`}>{props.note?.()}</div></Show>
        <For each={selectionIssues()}>{issue => <div role="status" class="mt-1 text-[11px] text-amber-700">{issue.message}</div>}</For>
        <input ref={searchInput} data-picker-autofocus type="search"
          aria-label={browsedProvider() == null ? "Search models and providers" : `Search models from ${browsedProvider()?.label}`}
          placeholder={browsedProvider() == null ? "Search models or providers…" : "Search this provider’s models…"}
          class={`mt-1.5 w-full ${DIALOG_INPUT_CLASS}`}
          value={filter()} onInput={ev => setFilter(ev.currentTarget.value)}
          onKeyDown={ev => {
            if (ev.key == "ArrowDown") {
              ev.preventDefault();
              enabledOptions()[0]?.focus();
            }
          }} />
      </DialogHeader>
      <div ref={modelList} class="min-h-0 grow overflow-y-auto py-1" role={browseProviders() ? "group" : "radiogroup"}
        aria-label="Model and provider choices"
        onKeyDown={navigateProviders}>
        <Show when={store.general.queryProfiles.error()}><div class="px-3 py-1 text-[12px] text-red-700">{store.general.queryProfiles.error()}</div></Show>
        <Show when={store.general.chatBackendsError()}><div class="px-3 py-1 text-[12px] text-red-700">{store.general.chatBackendsError()}</div></Show>
        <Show when={favoriteError()}><div class="px-3 py-1 text-[12px] text-red-700" role="alert">{favoriteError()}</div></Show>
        <Show when={store.general.chatBackends() == null && store.general.chatBackendsError() == null}><div class="px-3 py-2 text-[12px] text-neutral-500">Loading models…</div></Show>
        <Show when={browseProviders()}>
          <Show when={backends().length > 0}>
            <div class="px-3 py-1 text-[11px] font-medium text-neutral-500">Providers</div>
            <For each={backends()}>{provider => providerRow(provider, close)}</For>
          </Show>
          <Show when={retainedSelection()}>{choice => <>
            <div class="px-3 py-1 text-[11px] font-medium text-neutral-500">Saved selection</div>
            {row(choice(), close)}
          </>}</Show>
          <Show when={backends().length == 0 && store.general.chatBackends() != null}>
            <div class="px-3 py-2 text-[12px] text-neutral-500">No chat providers available.</div>
          </Show>
        </Show>
        <Show when={browsedProvider() == null && favoriteChoices().length > 0}>
          <div class="px-3 py-1 text-[11px] font-medium text-neutral-500">Favorites</div>
          <For each={favoriteChoices()}>{choice => row(choice, close)}</For>
        </Show>
        <Show when={!browseProviders()}>
          <For each={resultChoices()}>{choice => row(choice, close, browsedProvider() == null)}</For>
          <Show when={choices().length == 0 && store.general.chatBackends() != null}>
            <div class="px-3 py-2 text-[12px] text-neutral-500">{browsedProvider() == null ? "No matching models or providers." : "No matching models."}</div>
          </Show>
          <For each={backends().filter(provider => provider.modelsError != null && (browsedProvider() == null || provider.id == browsedProvider()?.id))}>{provider =>
            <div class="px-3 py-1 text-[12px] text-amber-700">{provider.label}: {provider.modelsError}</div>
          }</For>
        </Show>
      </div>
      <Show when={efforts().length > 0 || selection()?.reasoningEffort != null}>
        <div class="shrink-0 border-t border-chrome-line px-3 py-2 text-[12px]">
          <label class="flex items-center gap-2">Reasoning effort
            <select class={`ml-auto ${DIALOG_INPUT_CLASS}`} disabled={!canChange()}
              value={selection()?.reasoningEffort ?? ""}
              onChange={ev => {
                const chosen = selection();
                if (chosen == null || !canChange()) { return; }
                const effort = ev.currentTarget.value || null;
                props.beforeChange?.();
                setQueryChatModelSelection(store, props.queryItem(), { ...chosen, reasoningEffort: effort });
              }}>
              <option value="">Default{model()?.defaultEffort == null ? "" : ` (${reasoningEffortLabel(model()!.defaultEffort!)})`}</option>
              <Show when={selection()?.reasoningEffort != null && !efforts().includes(selection()!.reasoningEffort!)}>
                <option disabled value={selection()!.reasoningEffort!}>{reasoningEffortLabel(selection()!.reasoningEffort!)} ({selectionIssues().some(issue => issue.status == "unavailable") ? "unavailable" : "unverified"})</option>
              </Show>
              <For each={efforts()}>{effort => <option value={effort}>{reasoningEffortLabel(effort)}</option>}</For>
            </select>
          </label>
        </div>
      </Show>
    </>}
  </QueryPickerPopover>;
}
