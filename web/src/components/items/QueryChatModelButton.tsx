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

import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { QueryItem } from "../../items/query-item";
import { effectiveQueryChatModelSelection, setQueryChatModelSelection } from "../../items/chat";
import { useStore } from "../../store/StoreProvider";
import { ChatBackendId, ChatBackendInfo, ChatModelInfo, ChatModelSelection } from "../../server";


const POPUP_WIDTH_PX = 460;
const POPUP_MAX_HEIGHT_PX = 460;
const POPUP_GAP_PX = 6;
const POPUP_VIEWPORT_MARGIN_PX = 8;

/** Effort levels in increasing order, so a model's efforts always read low to high. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const EFFORT_LABELS: { [effort: string]: string } = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

interface QueryChatModelButtonProps {
  queryItem: () => QueryItem,
  /** Receives the button element, so the query control tab cycle can include it. */
  buttonRef?: (el: HTMLButtonElement) => void,
  onTabKey?: (ev: KeyboardEvent) => void,
}

function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort;
}

/** Model names arrive as "Vendor: Model". The vendor is already clear from context in the pill. */
function shortModelName(name: string): string {
  const separatorIndex = name.indexOf(": ");
  return separatorIndex < 0 ? name : name.substring(separatorIndex + 2);
}

function formatContextLength(contextLength: number | undefined): string | null {
  if (contextLength == null || contextLength <= 0) { return null; }
  if (contextLength >= 1000000) { return `${Math.round(contextLength / 100000) / 10}M context`; }
  if (contextLength >= 1000) { return `${Math.round(contextLength / 1000)}K context`; }
  return `${contextLength} context`;
}

/** OpenRouter prices are US dollars per token. Per million tokens is the readable form. */
function formatPrice(pricePerToken: string | undefined): string | null {
  if (pricePerToken == null) { return null; }
  const perMillion = Number(pricePerToken) * 1000000;
  if (!isFinite(perMillion)) { return null; }
  if (perMillion == 0) { return "free"; }
  return `$${perMillion >= 10 ? perMillion.toFixed(0) : perMillion.toFixed(2)}/M`;
}

function modelSubtitle(model: ChatModelInfo): string {
  const parts = [formatContextLength(model.contextLength)];
  const prompt = formatPrice(model.promptPrice);
  const completion = formatPrice(model.completionPrice);
  if (prompt != null && completion != null) {
    parts.push(`${prompt} in · ${completion} out`);
  }
  if (model.reasoningEfforts.length > 0) {
    parts.push(model.reasoningMandatory ? "always reasons" : "reasoning");
  }
  return parts.filter(part => part != null).join(" · ");
}

function sortedEfforts(efforts: Array<string>): Array<string> {
  return [...efforts].sort((a, b) => {
    const aIndex = EFFORT_ORDER.indexOf(a);
    const bIndex = EFFORT_ORDER.indexOf(b);
    return (aIndex < 0 ? EFFORT_ORDER.length : aIndex) - (bIndex < 0 ? EFFORT_ORDER.length : bIndex);
  });
}

export const QueryChatModelButton: Component<QueryChatModelButtonProps> = (props: QueryChatModelButtonProps) => {
  const store = useStore();

  const [isOpen, setIsOpen] = createSignal(false);
  const [filterText, setFilterText] = createSignal("");
  const [anchorRect, setAnchorRect] = createSignal<DOMRect | null>(null);
  let buttonEl: HTMLButtonElement | undefined;
  let filterInputEl: HTMLInputElement | undefined;

  onMount(() => { void store.general.retrieveChatBackends(); });

  const backends = () => store.general.chatBackends();
  const backend = (id: ChatBackendId): ChatBackendInfo | undefined =>
    backends()?.backends.find(candidate => candidate.id == id);
  const listedBackends = (): Array<ChatBackendInfo> => backends()?.backends ?? [];
  const anyBackendAvailable = (): boolean => listedBackends().some(candidate => candidate.available);

  /**
   * The selection in force, matching what a send would use: this chat's pick once the server still
   * offers it, else what the server would fall back to.
   */
  const selection = createMemo((): ChatModelSelection | null => {
    const explicit = effectiveQueryChatModelSelection(store, props.queryItem());
    if (explicit != null) { return explicit; }
    const serverDefault = backends()?.default;
    if (serverDefault == null) { return null; }
    return { backend: serverDefault.backend, model: serverDefault.model };
  });

  const selectedBackendId = (): ChatBackendId | null => selection()?.backend ?? null;
  const selectedModelId = (): string | null => selection()?.model ?? null;

  const selectedModel = createMemo((): ChatModelInfo | null => {
    if (selectedBackendId() != "openrouter") { return null; }
    const modelId = selectedModelId();
    if (modelId == null) { return null; }
    return backend("openrouter")?.models.find(model => model.id == modelId) ?? null;
  });

  /** The efforts the selected model offers. Empty when effort is not a choice here. */
  const availableEfforts = createMemo((): Array<string> => {
    if (backend(selectedBackendId() ?? "llama")?.supportsReasoningEffort != true) { return []; }
    return sortedEfforts(selectedModel()?.reasoningEfforts ?? []);
  });

  const selectedEffort = (): string | null => {
    const efforts = availableEfforts();
    if (efforts.length == 0) { return null; }
    const chosen = selection()?.reasoningEffort;
    if (chosen != null && efforts.includes(chosen)) { return chosen; }
    const modelDefault = selectedModel()?.defaultEffort;
    return modelDefault != null && efforts.includes(modelDefault) ? modelDefault : null;
  };

  const buttonLabel = (): string => {
    if (backends() == null) { return store.general.chatBackendsError() != null ? "Model unavailable" : "Model"; }
    const backendId = selectedBackendId();
    if (backendId == null) { return "No model"; }
    if (backendId != "openrouter") { return backend(backendId)?.label ?? backendId; }
    const modelId = selectedModelId();
    if (modelId == null) { return "Choose a model"; }
    const model = selectedModel();
    const name = model != null ? shortModelName(model.name) : modelId;
    const effort = selectedEffort();
    return effort != null ? `${name} · ${effortLabel(effort)}` : name;
  };

  const buttonTitle = (): string => {
    if (store.general.chatBackendsError() != null) { return store.general.chatBackendsError()!; }
    const modelId = selectedModelId();
    const backendLabel = backend(selectedBackendId() ?? "llama")?.label;
    if (modelId != null) { return `${modelId} (${backendLabel})`; }
    return backendLabel != null ? `Answers come from ${backendLabel}.` : "Choose the model that answers.";
  };

  const filteredModels = createMemo((): Array<ChatModelInfo> => {
    const models = backend("openrouter")?.models ?? [];
    const filter = filterText().trim().toLowerCase();
    if (filter == "") { return models; }
    return models.filter(model =>
      model.name.toLowerCase().includes(filter) || model.id.toLowerCase().includes(filter));
  });

  const applySelection = (next: ChatModelSelection | null) => {
    setQueryChatModelSelection(store, props.queryItem(), next);
  };

  const selectBackend = (backendId: ChatBackendId) => {
    if (backendId == "openrouter") {
      const modelId = selectedModelId() ?? backends()?.default.model ?? backend("openrouter")?.models[0]?.id;
      applySelection({ backend: backendId, model: modelId });
      // Stay open: choosing OpenRouter is the first half of choosing a model.
      return;
    }
    applySelection({ backend: backendId });
    close();
  };

  const selectModel = (model: ChatModelInfo) => {
    // An effort carried over from another model may not be one this model offers.
    const effort = selection()?.reasoningEffort;
    const keptEffort = effort != null && model.reasoningEfforts.includes(effort) ? effort : undefined;
    applySelection({ backend: "openrouter", model: model.id, reasoningEffort: keptEffort });
  };

  const selectEffort = (effort: string) => {
    const current = selection();
    if (current == null) { return; }
    applySelection({ ...current, reasoningEffort: effort });
  };

  const open = () => {
    setAnchorRect(buttonEl?.getBoundingClientRect() ?? null);
    setFilterText("");
    setIsOpen(true);
    void store.general.retrieveChatBackends();
    window.setTimeout(() => filterInputEl?.focus(), 0);
  };

  const close = () => { setIsOpen(false); };

  const onWindowKeyDown = (ev: KeyboardEvent) => {
    if (isOpen() && ev.key == "Escape") {
      ev.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onWindowKeyDown, true);
  onCleanup(() => window.removeEventListener("keydown", onWindowKeyDown, true));

  /** Positioned above the button where there is room, and clamped to the viewport. */
  const popupStyle = (): string => {
    const rect = anchorRect();
    const left = rect == null
      ? POPUP_VIEWPORT_MARGIN_PX
      : Math.max(
          POPUP_VIEWPORT_MARGIN_PX,
          Math.min(rect.right - POPUP_WIDTH_PX, window.innerWidth - POPUP_WIDTH_PX - POPUP_VIEWPORT_MARGIN_PX));
    const spaceAbove = rect == null ? 0 : rect.top - POPUP_GAP_PX - POPUP_VIEWPORT_MARGIN_PX;
    const spaceBelow = rect == null ? 0 : window.innerHeight - rect.bottom - POPUP_GAP_PX - POPUP_VIEWPORT_MARGIN_PX;
    const placeAbove = spaceAbove >= Math.min(POPUP_MAX_HEIGHT_PX, spaceBelow) || spaceAbove >= spaceBelow;
    const maxHeight = Math.max(200, Math.min(POPUP_MAX_HEIGHT_PX, placeAbove ? spaceAbove : spaceBelow));
    const vertical = rect == null
      ? `top: ${POPUP_VIEWPORT_MARGIN_PX}px;`
      : placeAbove
        ? `bottom: ${Math.max(POPUP_VIEWPORT_MARGIN_PX, window.innerHeight - rect.top + POPUP_GAP_PX)}px;`
        : `top: ${rect.bottom + POPUP_GAP_PX}px;`;
    return `left: ${left}px; ${vertical} width: ${POPUP_WIDTH_PX}px; max-height: ${maxHeight}px; ` +
      `z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 1};`;
  };

  const stop = (ev: Event) => { ev.stopPropagation(); };

  const renderBackendRow = (info: ChatBackendInfo) => {
    const isSelected = () => selectedBackendId() == info.id && info.id != "openrouter";
    const subtitle = () => {
      if (!info.available) { return info.unavailableReason ?? "Not available"; }
      return info.supportsModelSelection ? "Pick a model below" : "Model chosen by the server";
    };
    return (
      <div
        class="flex items-start gap-2 rounded-xs px-3 py-2"
        classList={{
          "cursor-pointer hover:bg-slate-100": info.available,
          "cursor-default opacity-50": !info.available,
        }}
        onClick={() => { if (info.available) { selectBackend(info.id); } }}>
        <div class="min-w-0 grow">
          <div class="truncate font-medium text-black">{info.label}</div>
          <div class="truncate text-[11px] text-slate-500">{subtitle()}</div>
        </div>
        <Show when={isSelected()}>
          <i class="bi-check-lg shrink-0 text-slate-700" />
        </Show>
      </div>
    );
  };

  return (
    <>
      <button
        ref={(el) => { buttonEl = el; props.buttonRef?.(el); }}
        type="button"
        class="flex max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-[#ccc] bg-white px-2.5 py-0.5 text-[#555] hover:bg-slate-50"
        style="font-size: 12px; line-height: 18px;"
        title={buttonTitle()}
        aria-haspopup="listbox"
        aria-expanded={isOpen()}
        onClick={(ev) => { stop(ev); isOpen() ? close() : open(); }}
        onMouseDown={stop}
        onMouseUp={stop}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.key == "Tab" && !isOpen()) { props.onTabKey?.(ev); }
        }}>
        <span class="truncate">{buttonLabel()}</span>
        <i class="bi-chevron-expand shrink-0 text-[10px]" />
      </button>

      <Show when={isOpen()}>
        <Portal mount={document.body}>
          <div
            class="fixed inset-0"
            style={`z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY};`}
            onMouseDown={(ev) => { stop(ev); close(); }}
            onClick={stop} />
          <div
            class="fixed flex flex-col overflow-hidden rounded-md border border-slate-300 bg-white shadow-lg"
            style={popupStyle()}
            onMouseDown={stop}
            onMouseUp={stop}
            onClick={stop}
            onKeyDown={stop}
            onKeyUp={stop}>
            <div class="shrink-0 px-3 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-slate-500 uppercase">
              Select a model
            </div>

            <div class="min-h-0 grow overflow-y-auto pb-1">
              <Show when={!anyBackendAvailable()}>
                <div class="px-3 pb-2 text-[12px] text-slate-500">
                  No language model is configured on this server.
                </div>
              </Show>
              <For each={listedBackends()}>{info => renderBackendRow(info)}</For>

              <Show when={backend("openrouter")?.available}>
                <div class="sticky top-0 border-t border-slate-200 bg-white px-3 py-2">
                  <input
                    ref={filterInputEl}
                    type="text"
                    class="w-full rounded-xs border border-[#ccc] px-2 py-1 text-black outline-hidden"
                    style="font-size: 12px; line-height: 18px;"
                    placeholder="Filter models"
                    value={filterText()}
                    onInput={(ev) => setFilterText(ev.currentTarget.value)} />
                </div>
                <Show when={backend("openrouter")!.modelsError}>
                  <div class="px-3 py-2 text-[12px] text-red-700">{backend("openrouter")!.modelsError}</div>
                </Show>
                <Show when={filteredModels().length == 0 && backend("openrouter")!.modelsError == null}>
                  <div class="px-3 py-2 text-[12px] text-slate-500">No matching models.</div>
                </Show>
                <For each={filteredModels()}>{model =>
                  <div
                    class="flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-slate-100"
                    onClick={() => selectModel(model)}>
                    <div class="min-w-0 grow">
                      <div class="truncate text-black" style="font-size: 13px; line-height: 18px;">{model.name}</div>
                      <div class="truncate text-[11px] text-slate-500">{modelSubtitle(model)}</div>
                    </div>
                    <Show when={selectedBackendId() == "openrouter" && selectedModelId() == model.id}>
                      <i class="bi-check-lg shrink-0 text-slate-700" />
                    </Show>
                  </div>
                }</For>
              </Show>
            </div>

            <Show when={availableEfforts().length > 0}>
              <div class="flex shrink-0 items-center gap-2 border-t border-slate-200 px-3 py-2">
                <div class="shrink-0 text-[12px] text-slate-600">Effort</div>
                <div class="ml-auto flex flex-wrap justify-end gap-1">
                  <For each={availableEfforts()}>{effort =>
                    <button
                      type="button"
                      class="cursor-pointer rounded-full border px-2 py-0.5 text-[11px]"
                      classList={{
                        "border-slate-700 bg-slate-700 text-white": selectedEffort() == effort,
                        "border-[#ccc] bg-white text-slate-600 hover:bg-slate-50": selectedEffort() != effort,
                      }}
                      onClick={() => selectEffort(effort)}>
                      {effortLabel(effort)}
                    </button>
                  }</For>
                </div>
              </div>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
};
