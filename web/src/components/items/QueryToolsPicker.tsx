/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For, Show, createMemo, onMount } from "solid-js";
import { queryChatCapabilities, setQueryChatUsesCapability } from "../../items/chat";
import { getQueryRuntime } from "../../items/query-item";
import { queryConfigurationChangeBlockedReason } from "../../items/query-configuration-state";
import { queryConfigurationIssues } from "../../items/query-configuration-availability";
import { useStore } from "../../store/StoreProvider";
import { QueryPickerPopover, type QueryPickerProps } from "./QueryPickerPopover";

interface ToolsPickerProps extends QueryPickerProps {
  locked: () => boolean,
  lockedReason: string,
}

interface ToolSource {
  id: string,
  label: string,
  description: string,
  available: boolean,
  reason: string | null,
  tools: Array<Record<string, unknown>>,
}

function toolFunction(tool: Record<string, unknown>): Record<string, unknown> {
  return typeof tool.function == "object" && tool.function != null ? tool.function as Record<string, unknown> : tool;
}
function functionName(tool: Record<string, unknown>): string {
  const fn = toolFunction(tool);
  return typeof fn.name == "string" ? fn.name : "Unnamed function";
}
function functionTitle(tool: Record<string, unknown>): string {
  const fn = toolFunction(tool);
  return typeof fn.title == "string" ? fn.title : functionName(tool).replaceAll("_", " ");
}
function functionDescription(tool: Record<string, unknown>): string {
  const description = toolFunction(tool).description;
  return typeof description == "string" ? description : "No description provided.";
}

export function QueryToolsPicker(props: ToolsPickerProps) {
  const store = useStore();
  onMount(() => { void store.general.queryProfiles.retrieve(); void store.general.retrieveChatBackends(); });
  const enabled = createMemo(() => new Set(queryChatCapabilities(store, props.queryItem())));
  const issues = () => queryConfigurationIssues(store, getQueryRuntime(store, props.queryItem()).configuration, "chat").filter(issue => issue.resource == "tools");
  const ready = () => getQueryRuntime(store, props.queryItem()).configurationInitialized || store.general.defaultQueryProfile() != null;
  const lockedReason = () => queryConfigurationChangeBlockedReason(store, props.queryItem()) ??
    (props.locked() || props.disabled?.() == true ? props.lockedReason : !ready() ? "Wait for this query's setup to load." : null);
  const locked = () => lockedReason() != null;
  const sources = createMemo(() => {
    const catalog = store.general.chatBackends();
    const result: ToolSource[] = [{ id: "infumap_data", label: "Infumap",
      description: "Find and read your Infumap items within the selected scope.",
      available: true, reason: null, tools: catalog?.infumapTools ?? [] }];
    for (const server of catalog?.toolServers ?? []) {
      const names = server.tools.map(functionName);
      result.push({ id: server.id, label: server.label == "Web search" ? "Web" : server.label,
        description: names.includes("web_search") ? `${names.includes("fetch_page") ? "Search the public web and read pages." : "Search the public web."} Infumap scope does not limit web access.`
          : server.tools.length > 0 ? server.tools.slice(0, 2).map(functionTitle).join(" · ") : "Capabilities provided by this connection.",
        available: server.available, reason: server.unavailableReason ?? null, tools: server.tools });
    }
    for (const id of enabled()) {
      if (!result.some(source => source.id == id)) {
        result.push({ id, label: id, description: "This saved tool source is not in the current configuration.",
          available: false, reason: catalog == null || store.general.chatBackendsError() != null ? "Could not verify this tool source" : "Not configured", tools: [] });
      }
    }
    return result;
  });
  const selected = () => sources().filter(source => enabled().has(source.id));
  const summary = () => !ready() ? store.general.queryProfiles.error() == null ? "Loading…" : "Unavailable" : selected().length == 0 ? "None" : selected().map(source => source.label).join(" + ");
  const title = () => [`Tools: ${summary()}`, ...issues().map(issue => issue.message), lockedReason(), props.note?.()].filter(Boolean).join("\n");

  return <QueryPickerPopover buttonRef={props.buttonRef} onTabKey={props.onTabKey}
    buttonClass="max-w-[240px] flex-[1_1_auto] cursor-pointer" ariaLabel="Choose tools" title={title()}
    label={<><span class="shrink-0">Tools:</span><span class="min-w-0 truncate">{summary()}</span>
      <Show when={ready() && issues().length > 0}>
        <i class="bi-exclamation-triangle shrink-0 text-[11px] text-amber-600" />
      </Show></>}
    onOpen={() => { void store.general.queryProfiles.refresh(); void store.general.refreshChatBackends(); }}>
    {close => <>
      <div class="max-h-[220px] overflow-y-auto border-b border-slate-200 px-3 py-2">
        <div class="flex items-center gap-2 text-[12px] font-medium text-slate-600">Available capabilities
          <button type="button" class="ml-auto h-5 w-5 rounded hover:bg-slate-100" aria-label="Close tools picker" onClick={close}><i class="bi-x-lg" /></button>
        </div>
        <div class="text-[11px] text-slate-500">Choose the capabilities for the next message.</div>
        <Show when={props.note?.()}><div class="mt-1 text-[11px] text-slate-500">{props.note?.()}</div></Show>
        <Show when={lockedReason()}><div class="mt-1 text-[11px] text-slate-500">{lockedReason()}</div></Show>
        <For each={issues()}>{issue => <div role="status" class="mt-1 text-[11px] text-amber-700">{issue.message}</div>}</For>
        <button type="button" class="mt-1 text-[11px] text-blue-700 hover:underline" disabled={store.general.chatBackendsRefreshing()}
          onClick={() => { void store.general.refreshChatBackends(); }}>{store.general.chatBackendsRefreshing() ? "Checking availability…" : "Refresh tool availability"}</button>
      </div>
      <div class="min-h-0 grow overflow-y-auto py-1">
        <Show when={store.general.queryProfiles.error()}><div class="px-3 py-1 text-[12px] text-red-700">{store.general.queryProfiles.error()}</div></Show>
        <Show when={store.general.chatBackendsError()}><div class="px-3 py-1 text-[12px] text-red-700">{store.general.chatBackendsError()}</div></Show>
        <Show when={store.general.chatBackends() == null && store.general.chatBackendsError() == null}>
          <div class="px-3 py-1 text-[12px] text-slate-500">Loading tool sources…</div>
        </Show>
        <For each={sources()}>{source => <div class="border-b border-slate-100 px-3 py-2 last:border-b-0">
          <label class="flex items-start gap-2 text-[13px]">
            <input type="checkbox" data-picker-autofocus={source.id == "infumap_data" ? true : undefined} class="mt-1 accent-slate-700" checked={enabled().has(source.id)}
              disabled={locked() || (!source.available && !enabled().has(source.id))}
              aria-label={`Enable ${source.label}`}
              onChange={ev => {
                if (locked()) { return; }
                const isEnabled = ev.currentTarget.checked;
                props.beforeChange?.();
                setQueryChatUsesCapability(store, props.queryItem(), source.id, isEnabled);
              }} />
            <div class="min-w-0 grow">
              <div class="flex items-center gap-1.5"><i class={source.id == "infumap_data" ? "bi-database shrink-0 text-[12px]" : "bi-tools shrink-0 text-[12px]"} /><span class="min-w-0 break-words">{source.label}</span></div>
              <div class="text-[11px] text-slate-500">{source.description}</div>
              <Show when={!source.available}><div class="text-[11px] text-amber-700">{store.general.chatBackendsRefreshing() ? "Checking availability…" : source.reason ?? "Unavailable"}</div></Show>
            </div>
          </label>
          <Show when={source.tools.length > 0}>
            <details class="ml-5 mt-1 text-[11px] text-slate-500">
              <summary class="cursor-pointer">Functions ({source.tools.length})</summary>
              <For each={source.tools}>{tool => <div class="mt-2 rounded border border-slate-200 p-2">
                <div class="font-medium text-slate-700">{functionTitle(tool)}</div>
                <div class="mt-0.5 whitespace-pre-wrap break-words">{functionDescription(tool)}</div>
                <details class="mt-1">
                  <summary class="cursor-pointer">Raw schema: {functionName(tool)}</summary>
                  <pre class="mt-1 max-h-[240px] overflow-auto whitespace-pre text-[10px] leading-4 select-text">{JSON.stringify(tool, null, 2)}</pre>
                </details>
              </div>}</For>
            </details>
          </Show>
        </div>}</For>
      </div>
    </>}
  </QueryPickerPopover>;
}
