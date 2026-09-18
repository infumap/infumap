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

import { Component, For, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import {
  queryChatUsesCapability,
  queryChatUsesInfumapData,
  setQueryChatUsesCapability,
  setQueryChatUsesInfumapData,
} from "../../items/chat";
import { QueryItem } from "../../items/query-item";
import { ChatToolServerInfo } from "../../server";
import { useStore } from "../../store/StoreProvider";
import { QuickTooltip } from "../library/QuickTooltip";

interface QueryChatToolButtonsProps {
  queryItem: () => QueryItem,
  togglesDisabled: () => boolean,
  lockedTitleSuffix?: string,
  beforeToggle?: () => void,
  infumapButtonRef?: (el: HTMLButtonElement) => void,
  onInfumapTabKey?: (ev: KeyboardEvent) => void,
  onInspectorTabKey?: (ev: KeyboardEvent) => void,
}

function iconSource(server: ChatToolServerInfo): string | null {
  const icon = server.icons?.find(candidate => {
    const src = candidate.src.trim();
    return src.startsWith("data:image/") || src.startsWith("https://") || src.startsWith("http://");
  });
  return icon?.src ?? null;
}

function prettyTools(tools: Array<Record<string, unknown>>): string {
  return JSON.stringify({ tools }, null, 2);
}

export const QueryChatToolButtons: Component<QueryChatToolButtonsProps> = (props: QueryChatToolButtonsProps) => {
  const store = useStore();
  const [inspectorOpen, setInspectorOpen] = createSignal(false);

  const toolServers = (): Array<ChatToolServerInfo> =>
    (store.general.chatBackends()?.toolServers ?? []).filter(server => server.available);
  const infumapTools = (): Array<Record<string, unknown>> => store.general.chatBackends()?.infumapTools ?? [];
  const stop = (ev: Event) => { ev.stopPropagation(); };
  const closeInspector = () => setInspectorOpen(false);
  const openInspector = () => setInspectorOpen(true);

  const onWindowKeyDown = (ev: KeyboardEvent) => {
    if (inspectorOpen() && ev.key == "Escape") {
      ev.stopPropagation();
      closeInspector();
    }
  };
  window.addEventListener("keydown", onWindowKeyDown, true);
  onCleanup(() => window.removeEventListener("keydown", onWindowKeyDown, true));

  const toggleTitle = (label: string, enabled: boolean): string => {
    const action = enabled ? "Disable" : "Enable";
    const suffix = props.togglesDisabled() && props.lockedTitleSuffix != null
      ? ` ${props.lockedTitleSuffix}`
      : "";
    return `${action} tools from ${label}.${suffix}`;
  };

  const toggleInfumap = () => {
    if (props.togglesDisabled()) { return; }
    props.beforeToggle?.();
    setQueryChatUsesInfumapData(store, props.queryItem(), !queryChatUsesInfumapData(store, props.queryItem()));
  };

  const toggleServer = (server: ChatToolServerInfo) => {
    if (props.togglesDisabled() || !server.available) { return; }
    props.beforeToggle?.();
    setQueryChatUsesCapability(
      store,
      props.queryItem(),
      server.id,
      !queryChatUsesCapability(store, props.queryItem(), server.id),
    );
  };

  const toggleButtonClasses = (enabled: boolean): Record<string, boolean> => ({
    "border-[#666] bg-[#e9eef8] text-black": enabled,
    "border-[#aaa] bg-white text-[#555] hover:bg-slate-50": !enabled,
  });

  const serverIcon = (server: ChatToolServerInfo) => {
    const src = iconSource(server);
    return (
      <span class="relative flex h-4 w-4 items-center justify-center">
        <i class="bi-tools text-[12px]" />
        <Show when={src != null}>
          <img
            src={src!}
            alt=""
            class="absolute inset-0 h-4 w-4 object-contain"
            onError={(ev) => { ev.currentTarget.style.display = "none"; }} />
        </Show>
      </span>
    );
  };

  return (
    <>
      <div class="flex shrink-0 items-center gap-1">
        <QuickTooltip text={toggleTitle("Infumap", queryChatUsesInfumapData(store, props.queryItem()))}>
          <button
            ref={(el) => props.infumapButtonRef?.(el)}
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border"
            classList={{
              ...toggleButtonClasses(queryChatUsesInfumapData(store, props.queryItem())),
              "cursor-pointer": !props.togglesDisabled(),
              "cursor-default opacity-60": props.togglesDisabled(),
            }}
            aria-label="Use Infumap data"
            aria-pressed={queryChatUsesInfumapData(store, props.queryItem())}
            disabled={props.togglesDisabled()}
            onClick={toggleInfumap}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key == "Tab") { props.onInfumapTabKey?.(ev); }
            }}>
            <i class="bi-database text-[12px]" />
          </button>
        </QuickTooltip>

        <For each={toolServers()}>{server => {
          const enabled = () => queryChatUsesCapability(store, props.queryItem(), server.id);
          const unavailableTitle = () => server.unavailableReason ?? `${server.label} is unavailable.`;
          return (
            <QuickTooltip text={server.available ? toggleTitle(server.label, enabled()) : unavailableTitle()}>
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border"
                classList={{
                  ...toggleButtonClasses(enabled()),
                  "cursor-pointer": server.available && !props.togglesDisabled(),
                  "cursor-default opacity-40": !server.available,
                  "cursor-default opacity-60": server.available && props.togglesDisabled(),
                }}
                aria-label={`Use tools from ${server.label}`}
                aria-pressed={enabled()}
                disabled={!server.available || props.togglesDisabled()}
                onClick={() => toggleServer(server)}
                onKeyDown={stop}>
                {serverIcon(server)}
              </button>
            </QuickTooltip>
          );
        }}</For>

        <span class="ml-2 inline-flex">
          <QuickTooltip text="Inspect tool definitions">
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[#aaa] bg-white text-[#555] hover:bg-slate-50"
              aria-label="Inspect tool definitions"
              aria-haspopup="dialog"
              aria-expanded={inspectorOpen()}
              onClick={() => inspectorOpen() ? closeInspector() : openInspector()}
              onKeyDown={(ev) => {
                ev.stopPropagation();
                if (ev.key == "Tab") { props.onInspectorTabKey?.(ev); }
              }}>
              <i class="bi-braces text-[12px]" />
            </button>
          </QuickTooltip>
        </span>
      </div>

      <Show when={inspectorOpen()}>
        <Portal mount={document.body}>
          <div
            class="fixed inset-0"
            style={`z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY};`}
            onMouseDown={(ev) => { stop(ev); closeInspector(); }}
            onClick={stop} />
          <div
            class="fixed flex flex-col overflow-hidden rounded-md border border-slate-300 bg-white text-black shadow-lg"
            style={`left: 4vw; top: 4vh; width: 92vw; height: 92vh; z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 1};`}
            role="dialog"
            aria-label="Tool definitions"
            onMouseDown={stop}
            onMouseUp={stop}
            onClick={stop}
            onKeyDown={stop}
            onKeyUp={stop}>
            <div class="flex shrink-0 items-center border-b border-slate-200 px-3 py-2">
              <div>
                <div class="text-[12px] font-medium text-slate-700">Tool definitions</div>
                <div class="text-[11px] text-slate-500">JSON sent or advertised by each tool source</div>
              </div>
              <button
                type="button"
                class="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
                title="Close"
                aria-label="Close tool definitions"
                onClick={closeInspector}>
                <i class="bi-x-lg text-[12px]" />
              </button>
            </div>
            <div class="min-h-0 grow overflow-y-auto px-3 py-2 text-[12px]">
              <details open>
                <summary class="cursor-pointer select-none py-1 font-medium text-slate-700">
                  <i class="bi-database mr-2" />Infumap <span class="font-normal text-slate-400">({infumapTools().length})</span>
                </summary>
                <pre class="mb-2 max-h-[68vh] overflow-auto rounded bg-slate-50 p-2 select-text whitespace-pre text-[11px] leading-4 text-slate-600">
                  {prettyTools(infumapTools())}
                </pre>
              </details>
              <For each={toolServers()}>{server =>
                <details>
                  <summary class="flex cursor-pointer list-item select-none py-1 font-medium text-slate-700">
                    <span class="ml-2 inline-flex align-middle">{serverIcon(server)}</span>
                    <span class="ml-1">{server.label}</span>
                    <span class="ml-1 font-normal text-slate-400">
                      {server.available ? `(${server.tools.length})` : "(unavailable)"}
                    </span>
                  </summary>
                  <Show
                    when={server.available}
                    fallback={<div class="mb-2 rounded bg-slate-50 p-2 text-[11px] text-slate-500">
                      {server.unavailableReason ?? "Tool definitions are unavailable."}
                    </div>}>
                    <pre class="mb-2 max-h-[68vh] overflow-auto rounded bg-slate-50 p-2 select-text whitespace-pre text-[11px] leading-4 text-slate-600">
                      {prettyTools(server.tools)}
                    </pre>
                  </Show>
                </details>
              }</For>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
};
