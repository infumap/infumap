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

import { Component, For, JSX, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { QueryItem } from "../../items/query-item";
import {
  effectiveQueryChatModelSelection,
  queryChatUsesCapability,
  queryChatUsesInfumapData,
  setQueryChatModelSelection,
  setQueryChatUsesCapability,
  setQueryChatUsesInfumapData,
} from "../../items/chat";
import { useStore } from "../../store/StoreProvider";
import {
  ChatBackendId,
  ChatBackendInfo,
  ChatModelInfo,
  ChatModelSelection,
  ChatToolServerInfo,
} from "../../server";
import { QuickTooltip } from "../library/QuickTooltip";


const PANEL_WIDTH_PX = 420;
const PANEL_MAX_HEIGHT_PX = 520;
const PANEL_GAP_PX = 6;
const PANEL_VIEWPORT_MARGIN_PX = 8;

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

interface QueryChatSetupProps {
  queryItem: () => QueryItem,
  /** Tool sources are fixed once a chat has content, and while a request is in flight. */
  toolsLocked: () => boolean,
  /** Explains the lock, shown as a header note rather than hidden in a tooltip. */
  lockedReason: string,
  /**
   * Supplied only where the panel owns the chat / deep research choice. The initial query composer
   * leaves it out, because its mode selector already offers deep research as a third mode.
   */
  deepResearch?: () => boolean,
  setDeepResearch?: (value: boolean) => void,
  modeLocked?: () => boolean,
  /** Runs before any change, so an in-progress query edit is not lost to the rerender. */
  beforeChange?: () => void,
  /** Receives the button element, so the query control tab cycle can include it. */
  buttonRef?: (el: HTMLButtonElement) => void,
  onTabKey?: (ev: KeyboardEvent) => void,
}

/** A togglable provider of tools: Infumap itself, or one configured MCP server. */
interface ToolSource {
  key: string,
  label: string,
  icon: () => JSX.Element,
  available: boolean,
  unavailableReason: string | null,
  tools: Array<Record<string, unknown>>,
  enabled: () => boolean,
  toggle: () => void,
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

function serverIconSource(server: ChatToolServerInfo): string | null {
  const icon = server.icons?.find(candidate => {
    const src = candidate.src.trim();
    return src.startsWith("data:image/") || src.startsWith("https://") || src.startsWith("http://");
  });
  return icon?.src ?? null;
}

function prettyTools(tools: Array<Record<string, unknown>>): string {
  return JSON.stringify({ tools }, null, 2);
}

/**
 * The server's own icon where one loads, and a generic tool glyph otherwise. Exactly one of the two
 * is ever visible: an icon with transparency must not show the glyph through it.
 */
const ServerIcon: Component<{ src: () => string | null }> = (props) => {
  const [loaded, setLoaded] = createSignal(false);
  return (
    <span class="relative flex h-4 w-4 shrink-0 items-center justify-center">
      <Show when={!loaded()}>
        <i class="bi-tools text-[12px]" />
      </Show>
      <Show when={props.src() != null}>
        <img
          src={props.src()!}
          alt=""
          class="absolute inset-0 h-4 w-4 object-contain"
          classList={{ "invisible": !loaded() }}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)} />
      </Show>
    </span>
  );
};


export const QueryChatSetup: Component<QueryChatSetupProps> = (props: QueryChatSetupProps) => {
  const store = useStore();

  const [isOpen, setIsOpen] = createSignal(false);
  const [view, setView] = createSignal<"main" | "model">("main");
  const [filterText, setFilterText] = createSignal("");
  const [anchorRect, setAnchorRect] = createSignal<DOMRect | null>(null);
  const [inspectedSource, setInspectedSource] = createSignal<string | null>(null);
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

  const modelLabel = (): string => {
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

  /** Every configured server is listed, a down one included, so its absence is never a mystery. */
  const toolServers = (): Array<ChatToolServerInfo> => backends()?.toolServers ?? [];
  const infumapTools = (): Array<Record<string, unknown>> => backends()?.infumapTools ?? [];

  const toolSources = createMemo((): Array<ToolSource> => {
    const sources: Array<ToolSource> = [{
      key: "infumap",
      label: "Infumap data",
      icon: () => <i class="bi-database shrink-0 text-[12px]" />,
      available: true,
      unavailableReason: null,
      tools: infumapTools(),
      enabled: () => queryChatUsesInfumapData(store, props.queryItem()),
      toggle: () => setQueryChatUsesInfumapData(
        store, props.queryItem(), !queryChatUsesInfumapData(store, props.queryItem())),
    }];
    for (const server of toolServers()) {
      sources.push({
        key: `server:${server.id}`,
        label: server.label,
        icon: () => <ServerIcon src={() => serverIconSource(server)} />,
        available: server.available,
        unavailableReason: server.available ? null : (server.unavailableReason ?? "Not available"),
        tools: server.tools,
        enabled: () => queryChatUsesCapability(store, props.queryItem(), server.id),
        toggle: () => setQueryChatUsesCapability(
          store, props.queryItem(), server.id, !queryChatUsesCapability(store, props.queryItem(), server.id)),
      });
    }
    return sources;
  });

  /** Tools actually offered to the model on the next send. The headline cost of the setup. */
  const enabledToolCount = (): number =>
    toolSources()
      .filter(source => source.available && source.enabled())
      .reduce((total, source) => total + source.tools.length, 0);

  const toolsSummary = (): string => {
    if (backends() == null) { return "…"; }
    const count = enabledToolCount();
    if (count == 0) { return "no tools"; }
    return count == 1 ? "1 tool" : `${count} tools`;
  };

  const buttonTitle = (): string => {
    if (store.general.chatBackendsError() != null) { return store.general.chatBackendsError()!; }
    const lines: Array<string> = [];
    const modelId = selectedModelId();
    const backendLabel = backend(selectedBackendId() ?? "llama")?.label;
    lines.push(modelId != null
      ? `Model: ${modelId} (${backendLabel})`
      : (backendLabel != null ? `Model: ${backendLabel}` : "Choose the model that answers."));
    const enabled = toolSources().filter(source => source.available && source.enabled());
    lines.push(enabled.length == 0
      ? "Tools: none"
      : `Tools: ${enabled.map(source => source.label).join(", ")}`);
    if (props.deepResearch?.() == true) { lines.push("Deep research is on."); }
    return lines.join("\n");
  };

  const filteredModels = createMemo((): Array<ChatModelInfo> => {
    const models = backend("openrouter")?.models ?? [];
    const filter = filterText().trim().toLowerCase();
    if (filter == "") { return models; }
    return models.filter(model =>
      model.name.toLowerCase().includes(filter) || model.id.toLowerCase().includes(filter));
  });

  const applySelection = (next: ChatModelSelection | null) => {
    props.beforeChange?.();
    setQueryChatModelSelection(store, props.queryItem(), next);
  };

  const selectBackend = (backendId: ChatBackendId) => {
    if (backendId == "openrouter") {
      const modelId = selectedModelId() ?? backends()?.default.model ?? backend("openrouter")?.models[0]?.id;
      applySelection({ backend: backendId, model: modelId });
      // Stay in the model view: choosing OpenRouter is the first half of choosing a model.
      return;
    }
    applySelection({ backend: backendId });
    setView("main");
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

  const toggleSource = (source: ToolSource) => {
    if (props.toolsLocked() || !source.available) { return; }
    props.beforeChange?.();
    source.toggle();
  };

  const setDeepResearch = (value: boolean) => {
    if (props.modeLocked?.() == true) { return; }
    props.beforeChange?.();
    props.setDeepResearch?.(value);
  };

  const open = () => {
    setAnchorRect(buttonEl?.getBoundingClientRect() ?? null);
    setFilterText("");
    setView("main");
    setIsOpen(true);
    void store.general.refreshChatBackends();
  };

  const close = () => {
    setIsOpen(false);
    setInspectedSource(null);
  };

  const onWindowKeyDown = (ev: KeyboardEvent) => {
    if (ev.key != "Escape") { return; }
    if (inspectedSource() != null) {
      ev.stopPropagation();
      setInspectedSource(null);
      return;
    }
    if (isOpen()) {
      ev.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onWindowKeyDown, true);
  onCleanup(() => window.removeEventListener("keydown", onWindowKeyDown, true));

  /** Positioned above the button where there is room, and clamped to the viewport. */
  const panelStyle = (): string => {
    const rect = anchorRect();
    const left = rect == null
      ? PANEL_VIEWPORT_MARGIN_PX
      : Math.max(
          PANEL_VIEWPORT_MARGIN_PX,
          Math.min(rect.right - PANEL_WIDTH_PX, window.innerWidth - PANEL_WIDTH_PX - PANEL_VIEWPORT_MARGIN_PX));
    const spaceAbove = rect == null ? 0 : rect.top - PANEL_GAP_PX - PANEL_VIEWPORT_MARGIN_PX;
    const spaceBelow = rect == null ? 0 : window.innerHeight - rect.bottom - PANEL_GAP_PX - PANEL_VIEWPORT_MARGIN_PX;
    const placeAbove = spaceAbove >= Math.min(PANEL_MAX_HEIGHT_PX, spaceBelow) || spaceAbove >= spaceBelow;
    const maxHeight = Math.max(200, Math.min(PANEL_MAX_HEIGHT_PX, placeAbove ? spaceAbove : spaceBelow));
    const vertical = rect == null
      ? `top: ${PANEL_VIEWPORT_MARGIN_PX}px;`
      : placeAbove
        ? `bottom: ${Math.max(PANEL_VIEWPORT_MARGIN_PX, window.innerHeight - rect.top + PANEL_GAP_PX)}px;`
        : `top: ${rect.bottom + PANEL_GAP_PX}px;`;
    return `left: ${left}px; ${vertical} width: ${PANEL_WIDTH_PX}px; max-height: ${maxHeight}px; ` +
      `z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 1};`;
  };

  const stop = (ev: Event) => { ev.stopPropagation(); };

  /** The panel's rows are divs, so they need the activation keys a button would give for free. */
  const activateOnKey = (action: () => void) => (ev: KeyboardEvent) => {
    if (ev.key != "Enter" && ev.key != " ") { return; }
    ev.preventDefault();
    ev.stopPropagation();
    action();
  };

  const renderModeSection = () => {
    const locked = () => props.modeLocked?.() == true;
    const row = (value: boolean, label: string, description: string) => {
      const selected = () => props.deepResearch!() == value;
      return (
        <div
          class="flex items-start gap-2 rounded-xs px-3 py-1.5"
          classList={{
            "cursor-pointer hover:bg-slate-100": !locked(),
            "cursor-default opacity-50": locked(),
          }}
          role="radio"
          tabindex={locked() ? -1 : 0}
          aria-checked={selected()}
          onClick={() => setDeepResearch(value)}
          onKeyDown={activateOnKey(() => setDeepResearch(value))}>
          <i
            class="mt-[2px] shrink-0 text-[12px]"
            classList={{
              "bi-record-circle text-slate-700": selected(),
              "bi-circle text-slate-400": !selected(),
            }} />
          <div class="min-w-0 grow">
            <div class="text-black" style="font-size: 13px; line-height: 18px;">{label}</div>
            <div class="text-[11px] text-slate-500">{description}</div>
          </div>
        </div>
      );
    };
    return (
      <div class="border-b border-slate-200 py-1.5" role="radiogroup" aria-label="Chat mode">
        <div class="px-3 pb-0.5 text-[11px] font-medium tracking-wide text-slate-500 uppercase">Mode</div>
        {row(false, "Chat", "Answers in one pass, using the tools below.")}
        {row(true, "Deep research", "Plans, runs several rounds of research, then writes up.")}
      </div>
    );
  };

  const openModelView = () => {
    setFilterText("");
    setView("model");
    window.setTimeout(() => filterInputEl?.focus(), 0);
  };

  const renderModelSection = () => (
    <div class="border-b border-slate-200 py-1.5">
      <div class="px-3 pb-0.5 text-[11px] font-medium tracking-wide text-slate-500 uppercase">Model</div>
      <div
        class="flex cursor-pointer items-center gap-2 rounded-xs px-3 py-1.5 hover:bg-slate-100"
        role="button"
        tabindex={0}
        onClick={openModelView}
        onKeyDown={activateOnKey(openModelView)}>
        <div class="min-w-0 grow truncate text-black" style="font-size: 13px; line-height: 18px;">
          {modelLabel()}
        </div>
        <i class="bi-chevron-right shrink-0 text-[11px] text-slate-400" />
      </div>
      <Show when={availableEfforts().length > 0}>
        <div class="flex items-center gap-2 px-3 py-1">
          <div class="shrink-0 text-[12px] text-slate-600">Effort</div>
          <div class="ml-auto flex flex-wrap justify-end gap-1">
            <For each={availableEfforts()}>{effort =>
              <button
                type="button"
                class="cursor-pointer rounded-md border px-2 py-0.5 text-[11px]"
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
  );

  /** A row's three states: usable, being probed right now, or known to be down. */
  const sourceState = (source: ToolSource): "ok" | "checking" | "down" => {
    if (source.available) { return "ok"; }
    return store.general.chatBackendsRefreshing() ? "checking" : "down";
  };

  const renderToolsSection = () => (
    <div class="py-1.5">
      <div class="flex items-baseline gap-2 px-3 pb-0.5">
        <div class="shrink-0 text-[11px] font-medium tracking-wide text-slate-500 uppercase">Tools</div>
        <Show when={props.toolsLocked()}>
          <div class="min-w-0 grow truncate text-right text-[11px] text-slate-500">{props.lockedReason}</div>
        </Show>
      </div>
      <Show when={backends() == null}>
        <For each={[0, 1, 2]}>{() =>
          <div class="flex animate-pulse items-center gap-2 px-3 py-1.5">
            <div class="h-3.5 w-3.5 shrink-0 rounded-xs bg-slate-200" />
            <div class="h-4 w-4 shrink-0 rounded-full bg-slate-200" />
            <div class="h-3 grow rounded-xs bg-slate-200" />
            <div class="h-3 w-12 shrink-0 rounded-xs bg-slate-100" />
          </div>
        }</For>
      </Show>
      <For each={toolSources()}>{source => {
        const state = () => sourceState(source);
        const selectable = () => state() == "ok" && !props.toolsLocked();
        return (
          <div
            class="flex items-center gap-2 rounded-xs px-3 py-1.5"
            classList={{
              "cursor-pointer hover:bg-slate-100": selectable(),
              "cursor-default": !selectable(),
              "opacity-50": state() == "down",
              "opacity-60": state() == "ok" && props.toolsLocked(),
            }}
            role="checkbox"
            tabindex={selectable() ? 0 : -1}
            aria-checked={source.enabled()}
            aria-disabled={!selectable()}
            aria-label={`Use tools from ${source.label}`}
            onClick={() => toggleSource(source)}
            onKeyDown={activateOnKey(() => toggleSource(source))}>
            <i
              class="shrink-0 text-[13px]"
              classList={{
                "bi-check-square-fill text-slate-700": source.enabled(),
                "bi-square text-slate-400": !source.enabled(),
              }} />
            {source.icon()}
            <div class="min-w-0 grow truncate text-black" style="font-size: 13px; line-height: 18px;">
              {source.label}
            </div>
            <div
              class="shrink-0 text-[11px]"
              classList={{
                "text-slate-500": state() != "checking",
                "text-amber-600": state() == "checking",
              }}>
              <Show when={state() != "checking"} fallback={"checking\u2026"}>
                {source.available
                  ? (source.tools.length == 1 ? "1 tool" : `${source.tools.length} tools`)
                  : source.unavailableReason}
              </Show>
            </div>
            <Show when={source.tools.length > 0}>
              <QuickTooltip text={`Inspect the tool definitions ${source.label} advertises`}>
                <button
                  type="button"
                  class="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                  aria-label={`Inspect tool definitions for ${source.label}`}
                  onClick={(ev) => { ev.stopPropagation(); setInspectedSource(source.key); }}>
                  <i class="bi-braces text-[12px]" />
                </button>
              </QuickTooltip>
            </Show>
          </div>
        );
      }}</For>
    </div>
  );

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
        role="button"
        tabindex={info.available ? 0 : -1}
        onClick={() => { if (info.available) { selectBackend(info.id); } }}
        onKeyDown={activateOnKey(() => { if (info.available) { selectBackend(info.id); } })}>
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

  const renderModelView = () => (
    <>
      <div class="flex shrink-0 items-center gap-2 border-b border-slate-200 px-2 py-1.5">
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          aria-label="Back to chat setup"
          onClick={() => setView("main")}>
          <i class="bi-chevron-left text-[12px]" />
        </button>
        <div class="text-[11px] font-medium tracking-wide text-slate-500 uppercase">Select a model</div>
      </div>
      <div class="min-h-0 grow overflow-y-auto pb-1">
        <Show when={!anyBackendAvailable()}>
          <div class="px-3 py-2 text-[12px] text-slate-500">
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
              role="button"
              tabindex={0}
              onClick={() => selectModel(model)}
              onKeyDown={activateOnKey(() => selectModel(model))}>
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
                class="cursor-pointer rounded-md border px-2 py-0.5 text-[11px]"
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
    </>
  );

  const inspected = (): ToolSource | null =>
    toolSources().find(source => source.key == inspectedSource()) ?? null;

  return (
    <>
      <button
        ref={(el) => { buttonEl = el; props.buttonRef?.(el); }}
        type="button"
        class="flex h-[22px] w-[210px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-[#d6d6d6] bg-white pl-2.5 pr-2 text-[#555] hover:bg-slate-50"
        style="font-size: 12px; line-height: 18px;"
        title={buttonTitle()}
        aria-haspopup="dialog"
        aria-expanded={isOpen()}
        aria-label="Chat setup"
        onClick={(ev) => { stop(ev); isOpen() ? close() : open(); }}
        onMouseDown={stop}
        onMouseUp={stop}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.key == "Tab" && !isOpen()) { props.onTabKey?.(ev); }
        }}>
        <Show when={props.deepResearch?.() == true}>
          <i class="bi-binoculars shrink-0 text-[12px] text-black" />
        </Show>
        <span class="min-w-0 truncate">{modelLabel()}</span>
        <span class="shrink-0 text-[#999]">·</span>
        <span class="shrink-0 text-[#999]">{toolsSummary()}</span>
        <i class="bi-chevron-expand ml-auto shrink-0 text-[10px]" />
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
            style={panelStyle()}
            role="dialog"
            aria-label="Chat setup"
            onMouseDown={stop}
            onMouseUp={stop}
            onClick={stop}
            onKeyDown={stop}
            onKeyUp={stop}>
            <Show when={view() == "model"} fallback={
              <div class="min-h-0 grow overflow-y-auto">
                <Show when={props.deepResearch != null}>
                  {renderModeSection()}
                </Show>
                {renderModelSection()}
                {renderToolsSection()}
              </div>
            }>
              {renderModelView()}
            </Show>
          </div>
        </Portal>
      </Show>

      <Show when={inspected() != null}>
        <Portal mount={document.body}>
          <div
            class="fixed inset-0"
            style={`z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 2};`}
            onMouseDown={(ev) => { stop(ev); setInspectedSource(null); }}
            onClick={stop} />
          <div
            class="fixed flex flex-col overflow-hidden rounded-md border border-slate-300 bg-white text-black shadow-lg"
            style={`left: 1vw; top: 1vh; width: 98vw; height: 98vh; z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 3};`}
            role="dialog"
            aria-label="Tool definitions"
            onMouseDown={stop}
            onMouseUp={stop}
            onClick={stop}
            onKeyDown={stop}
            onKeyUp={stop}>
            <div class="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2">
              {inspected()!.icon()}
              <div>
                <div class="text-[12px] font-medium text-slate-700">{inspected()!.label}</div>
                <div class="text-[11px] text-slate-500">
                  Tool definitions advertised to the model ({inspected()!.tools.length})
                </div>
              </div>
              <button
                type="button"
                class="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
                title="Close"
                aria-label="Close tool definitions"
                onClick={() => setInspectedSource(null)}>
                <i class="bi-x-lg text-[12px]" />
              </button>
            </div>
            <pre class="min-h-0 grow overflow-auto px-3 py-2 text-[11px] leading-4 whitespace-pre text-slate-600 select-text">
              {prettyTools(inspected()!.tools)}
            </pre>
          </div>
        </Portal>
      </Show>
    </>
  );
};
