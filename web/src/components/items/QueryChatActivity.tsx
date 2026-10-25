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

import { Component, Index, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { requestArrange } from "../../layout/arrange";
import { LIGHT_BORDER_COLOR } from "../../style";
import { BoundingBox } from "../../util/geometry";
import { Uid } from "../../util/uid";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { submitQueryChatToolApproval } from "../../items/chat";
import type { QueryChatActivityModelRound, QueryChatActivityToolCall, QueryChatCompletedActivity } from "../../store/StoreProvider_PerItem";
import { useStore } from "../../store/StoreProvider";
import {
  QUERY_CHAT_ACTIVITY_HEADER_HEIGHT_PX,
  QUERY_CHAT_ACTIVITY_MAX_HEIGHT_PX,
  isQueryChatCompletedActivityExpanded,
  queryChatCompletedActivityReservePx,
  setQueryChatCompletedActivityBodyHeightPx,
  toggleQueryChatCompletedActivityExpanded,
} from "../../items/query-chat-activity-ui";

function queryChatRoundHasContent(round: QueryChatActivityModelRound): boolean {
  return round.reasoning.trim() != "" || round.answer.trim() != "" || round.toolCalls.length > 0;
}

function queryChatToolDisplayName(name: string): string {
  switch (name) {
    case "find":
    case "infumap_search":
    case "lexical_search":
      return "Search Infumap";
    case "search_text":
      return "Search source text";
    case "infumap_get_fragment":
      return "Read Infumap item";
    case "web_search":
      return "Search the web";
    case "web_fetch":
      return "Fetch page";
    default:
      return name.replaceAll("_", " ");
  }
}

function queryChatJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value != "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function queryChatJsonString(value: unknown): string | null {
  if (typeof value != "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed == "" ? null : trimmed;
}

function queryChatJsonNumber(value: unknown): number | null {
  return typeof value == "number" && Number.isFinite(value) ? value : null;
}

function queryChatHasJsonValue(value: unknown): boolean {
  if (value == null) {
    return false;
  }
  if (typeof value == "object") {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return Object.keys(value).length > 0;
  }
  return true;
}

function queryChatPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function queryChatToolDurationLabel(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function queryChatToolCallSignature(name: string, args: unknown): string | null {
  const record = queryChatJsonRecord(args);
  if (name == "infumap_search" || name == "lexical_search" || name == "find") {
    const query = queryChatJsonString(record?.text) ?? queryChatJsonString(record?.query);
    if (query == null) {
      return record == null ? null : `${name}()`;
    }
    return `${name}(${JSON.stringify(query)})`;
  }
  if (name == "infumap_get_fragment") {
    const link = queryChatJsonString(record?.link);
    const ordinal = queryChatJsonNumber(record?.fragmentOrdinal) ?? queryChatJsonNumber(record?.ordinal);
    const count = queryChatJsonNumber(record?.count);
    const parts: Array<string> = [];
    if (link != null) {
      parts.push(JSON.stringify(link));
    }
    if (ordinal != null) {
      parts.push(String(ordinal));
    }
    if (count != null && count > 1) {
      parts.push(`count ${count}`);
    }
    return parts.length == 0 ? `${name}()` : `${name}(${parts.join(", ")})`;
  }
  if (name == "web_search") {
    const query = queryChatJsonString(record?.query) ?? queryChatJsonString(record?.text);
    if (query == null) {
      return record == null ? null : `${name}()`;
    }
    return `${name}(${JSON.stringify(query)})`;
  }
  if (name == "web_fetch") {
    const url = queryChatJsonString(record?.url);
    if (url == null) {
      return record == null ? null : `${name}()`;
    }
    return `${name}(${JSON.stringify(url)})`;
  }
  if (record == null) {
    return null;
  }
  try {
    return `${name}(${JSON.stringify(record)})`;
  } catch {
    return name;
  }
}

function queryChatToolCallStatusIconClass(status: QueryChatActivityToolCall["status"]): string {
  if (status == "complete") {
    return "bi-check-circle mt-[1px] text-emerald-600";
  }
  if (status == "awaiting_approval") {
    return "bi-pause-circle mt-[1px] text-amber-600";
  }
  return "fa fa-circle-notch fa-spin mt-[2px] text-slate-400";
}

function queryChatToolApprovalPrompt(toolCall: QueryChatActivityToolCall): { label: string, value: string } {
  return { label: "Arguments", value: queryChatPrettyJson(toolCall.arguments ?? {}) };
}

function queryChatToolCallHeadline(toolCall: QueryChatActivityToolCall): string | null {
  const signature = queryChatToolCallSignature(toolCall.name, toolCall.arguments);
  let summary = toolCall.summary?.trim() ?? "";
  const record = queryChatJsonRecord(toolCall.arguments);
  const query = queryChatJsonString(record?.text) ?? queryChatJsonString(record?.query);
  if (query != null && summary.startsWith(`"${query}" · `)) {
    summary = summary.slice(`"${query}" · `.length);
  } else if (query != null && summary == `"${query}"`) {
    summary = "";
  }
  const parts = [signature, summary == "" ? null : summary];
  if (toolCall.durationMs != null) {
    parts.push(queryChatToolDurationLabel(toolCall.durationMs));
  }
  const headline = parts.filter((part): part is string => part != null && part != "").join(" · ");
  return headline == "" ? null : headline;
}

export function formatChatActivityElapsed(startedAt: number, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function queryChatActivityIsRunning(phase: string): boolean {
  return phase != "complete" && phase != "cancelled" && phase != "error";
}

function stopQueryChatActivityEvent(ev: Event): void {
  if (ev instanceof MouseEvent && ev.button == MOUSE_RIGHT) {
    return;
  }
  ev.stopPropagation();
}

const QueryChatToolApproval: Component<{
  requestId: string | null,
  toolCall: QueryChatActivityToolCall,
}> = (props) => {
  const [submittingApproval, setSubmittingApproval] = createSignal<{ requestId: string, callId: string } | null>(null);
  const submitting = () => {
    const approval = submittingApproval();
    return approval != null && approval.requestId == props.requestId && approval.callId == props.toolCall.callId;
  };
  const prompt = () => queryChatToolApprovalPrompt(props.toolCall);
  const decide = async (approved: boolean) => {
    const requestId = props.requestId;
    if (requestId == null || submitting()) {
      return;
    }
    const approval = { requestId, callId: props.toolCall.callId };
    setSubmittingApproval(approval);
    try {
      const stillPending = await submitQueryChatToolApproval(approval.requestId, approval.callId, approved);
      if (stillPending && submittingApproval() == approval) {
        setSubmittingApproval(null);
      }
    } catch (e) {
      // Keep disabled until a later attachment supplies authoritative pending approvals.
      console.error("Failed to submit chat tool approval:", e);
    }
  };
  return (
    <>
      <div class="mt-1 text-[12px] text-slate-600">Tool source: {props.toolCall.source ?? props.toolCall.name}</div>
      <div class="mt-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
        {prompt().label}
      </div>
      <div
        class="select-text whitespace-pre-wrap text-[12px] leading-[18px] text-slate-700"
        style="overflow-wrap: anywhere;">
        {prompt().value}
      </div>
      <Show when={props.requestId != null}>
        <div class="mt-2 flex gap-2">
          <button
            type="button"
            class="flex cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white px-3 py-1 text-[12px] font-medium text-black disabled:cursor-default disabled:opacity-40"
            disabled={submitting()}
            onClick={(ev) => {
              ev.stopPropagation();
              void decide(true);
            }}>
            Allow request
          </button>
          <button
            type="button"
            class="flex cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white px-3 py-1 text-[12px] font-medium text-black disabled:cursor-default disabled:opacity-40"
            disabled={submitting()}
            onClick={(ev) => {
              ev.stopPropagation();
              void decide(false);
            }}>
            Deny request
          </button>
        </div>
      </Show>
    </>
  );
};

export const QueryChatActivityRounds: Component<{
  rounds: () => Array<QueryChatActivityModelRound>,
  errorMessage?: () => string | null,
  running: () => boolean,
  requestId?: () => string | null,
  pendingApprovals?: () => Array<string> | undefined,
}> = (props) => {
  const visibleRoundCount = () => props.rounds().filter(queryChatRoundHasContent).length;
  const errorMessage = () => props.errorMessage?.() ?? null;
  return (
    <>
      <Index each={props.rounds()}>{round =>
        <Show when={queryChatRoundHasContent(round())}>
          <div class="mb-3 last:mb-0">
            <Show when={visibleRoundCount() > 1}>
              <div class="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                Round {round().number}
              </div>
            </Show>
            <Show when={round().reasoning.trim() != ""}>
              <div class="mb-2">
                <div class="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                  Thinking
                </div>
                <div
                  class="select-text whitespace-pre-wrap text-[12px] leading-[18px] text-slate-500"
                  style="overflow-wrap: anywhere;">
                  {round().reasoning.trim()}
                </div>
              </div>
            </Show>
            <Show when={round().answer.trim() != ""}>
              <div class="mb-2">
                <div class="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                  {round().toolCalls.length > 0 || round().complete ? "Answer" : "Answering"}
                </div>
                <div
                  class="select-text whitespace-pre-wrap text-[13px] leading-5 text-slate-700"
                  style="overflow-wrap: anywhere;">
                  {round().answer.trim()}
                </div>
              </div>
            </Show>
            <Index each={round().toolCalls}>{(toolCall, toolIndex) =>
              <div class={`flex items-start gap-2 py-1.5 ${
                toolIndex > 0 || round().reasoning.trim() != "" || round().answer.trim() != ""
                  ? "border-t border-slate-100"
                  : ""
              }`}>
                <i class={queryChatToolCallStatusIconClass(toolCall().status)} />
                <div class="min-w-0 grow">
                  <div class="font-medium text-slate-600">{queryChatToolDisplayName(toolCall().name)}</div>
                  <Show when={toolCall().status == "awaiting_approval"}>
                    <QueryChatToolApproval
                      requestId={props.running() && (props.pendingApprovals?.()?.includes(toolCall().callId) ?? true)
                        ? (props.requestId?.() ?? null) : null}
                      toolCall={toolCall()} />
                  </Show>
                  <Show when={toolCall().status != "awaiting_approval" && queryChatToolCallHeadline(toolCall()) != null}>
                    <div
                      class="truncate text-[11px] text-slate-400"
                      title={queryChatToolCallHeadline(toolCall()) ?? undefined}>
                      {queryChatToolCallHeadline(toolCall())}
                    </div>
                  </Show>
                  <Show when={toolCall().status != "awaiting_approval" && queryChatHasJsonValue(toolCall().arguments)}>
                    <details class="mt-1 text-[11px] text-slate-500">
                      <summary class="cursor-pointer select-none text-slate-400">Arguments</summary>
                      <pre
                        class="mt-1 select-text whitespace-pre-wrap text-slate-600"
                        style="overflow-wrap: anywhere;">
                        {queryChatPrettyJson(toolCall().arguments)}
                      </pre>
                    </details>
                  </Show>
                  <Show when={queryChatHasJsonValue(toolCall().resultPreview)}>
                    <details class="mt-1 text-[11px] text-slate-500">
                      <summary class="cursor-pointer select-none text-slate-400">Result</summary>
                      <pre
                        class="mt-1 select-text whitespace-pre-wrap text-slate-600"
                        style="overflow-wrap: anywhere;">
                        {queryChatPrettyJson(toolCall().resultPreview)}
                      </pre>
                    </details>
                  </Show>
                </div>
              </div>
            }</Index>
          </div>
        </Show>
      }</Index>
      <Show when={errorMessage() != null}>
        <div class="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[12px] text-red-700">
          {errorMessage()}
        </div>
      </Show>
      <Show when={visibleRoundCount() == 0 && props.running()}>
        <div class="py-2 text-[12px] text-slate-400">Waiting for model output…</div>
      </Show>
    </>
  );
};

export const QueryChatCompletedActivityTrace: Component<{
  queryId: Uid,
  sectionRootId: Uid,
  activity: QueryChatCompletedActivity,
  turnNumber: number,
  boundsPx: BoundingBox,
}> = (props) => {
  const store = useStore();
  let measureEl: HTMLDivElement | undefined;

  const expanded = () => isQueryChatCompletedActivityExpanded(props.queryId, props.activity.requestId);
  const reservePx = () => queryChatCompletedActivityReservePx(props.queryId, props.activity.requestId);
  createEffect(() => {
    if (!expanded()) {
      return;
    }
    props.activity.rounds;
    const raf = window.requestAnimationFrame(() => {
      if (measureEl == null) {
        return;
      }
      const nextBodyPx = Math.min(
        QUERY_CHAT_ACTIVITY_MAX_HEIGHT_PX - QUERY_CHAT_ACTIVITY_HEADER_HEIGHT_PX,
        measureEl.offsetHeight,
      );
      if (setQueryChatCompletedActivityBodyHeightPx(props.queryId, props.activity.requestId, nextBodyPx)) {
        requestArrange(store, "query-chat-completed-activity-resize");
      }
    });
    onCleanup(() => window.cancelAnimationFrame(raf));
  });

  return (
    <div
      class="absolute flex flex-col overflow-hidden rounded-xs border bg-white pointer-events-auto"
      style={`left: ${props.boundsPx.x}px; top: ${props.boundsPx.y}px; ` +
        `width: ${props.boundsPx.w}px; height: ${reservePx()}px; ` +
        `border-color: ${LIGHT_BORDER_COLOR};`}
      role="region"
      aria-label={`Turn ${props.turnNumber} assistant activity`}
      onMouseDown={stopQueryChatActivityEvent}
      onMouseUp={stopQueryChatActivityEvent}
      onClick={stopQueryChatActivityEvent}
      onKeyDown={stopQueryChatActivityEvent}
      onKeyUp={stopQueryChatActivityEvent}>
      <div
        class="flex h-9 shrink-0 cursor-pointer items-center gap-2 border-b px-3 text-slate-700"
        style={`background-color: #fafafa; border-color: ${LIGHT_BORDER_COLOR};`}
        aria-expanded={expanded()}
        onClick={(ev) => {
          ev.stopPropagation();
          toggleQueryChatCompletedActivityExpanded(props.queryId, props.activity.requestId);
          requestArrange(store, "query-chat-completed-activity-toggle");
        }}>
        <i class="bi-check-circle" />
        <span class="min-w-0 grow truncate text-[13px] font-medium">
          Turn {props.turnNumber}
        </span>
        <span class="shrink-0 text-[11px] tabular-nums text-slate-500">
          {formatChatActivityElapsed(props.activity.startedAt, props.activity.completedAt)}
        </span>
        <i class={expanded() ? "bi-chevron-down" : "bi-chevron-right"} />
      </div>
      <Show when={expanded()}>
        <div class="min-h-0 grow overflow-y-auto">
          <div ref={measureEl} class="px-3 py-2 text-[13px] text-slate-700">
            <QueryChatActivityRounds
              rounds={() => props.activity.rounds}
              running={() => false} />
          </div>
        </div>
      </Show>
    </div>
  );
};
