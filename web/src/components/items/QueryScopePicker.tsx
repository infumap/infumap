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

import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { QueryItem } from "../../items/query-item";
import {
  queryScopeDescription,
  queryScopeId,
  queryScopeName,
  queryScopeProblemText,
  queryScopeSummary,
  queryScopes,
  queryScopesError,
  refreshQueryScopes,
  setQueryScopeId,
} from "../../items/query-scope";
import { switchToPage } from "../../layout/navigation";
import { useStore } from "../../store/StoreProvider";
import { Uid } from "../../util/uid";


const PANEL_WIDTH_PX = 320;
const PANEL_MAX_HEIGHT_PX = 420;
const PANEL_GAP_PX = 6;
const PANEL_VIEWPORT_MARGIN_PX = 8;
const PANEL_MIN_BELOW_PX = 240;

interface QueryScopePickerProps {
  queryItem: () => QueryItem,
  /** "pill" sits beside the chat setup button; "compact" sits on the search results border. */
  variant: "pill" | "compact",
  /** Shown at the top of the panel, for example when a change only affects what happens next. */
  note?: () => string | null,
  disabled?: () => boolean,
  /** Runs before any change, so an in-progress query edit is not lost to the rerender. */
  beforeChange?: () => void,
  /** Runs after the scope changes, for example to search again. */
  onChange?: () => void,
}

export const QueryScopePicker: Component<QueryScopePickerProps> = (props: QueryScopePickerProps) => {
  const store = useStore();

  const [isOpen, setIsOpen] = createSignal(false);
  const [anchorRect, setAnchorRect] = createSignal<DOMRect | null>(null);
  let buttonEl: HTMLButtonElement | undefined;

  onMount(() => {
    if (queryScopes() == null) { void refreshQueryScopes(store); }
  });

  const selectedId = (): Uid | null => queryScopeId(store, props.queryItem());
  const selectedSummary = () => queryScopeSummary(selectedId());
  const selectedIsMissing = (): boolean => selectedId() != null && selectedSummary() === null;
  const selectedHasProblems = (): boolean => {
    const summary = selectedSummary();
    return summary != null && queryScopeProblemText(summary.problems) != null;
  };
  const disabled = (): boolean => props.disabled?.() == true;

  const buttonTitle = (): string => {
    if (selectedIsMissing()) { return "The selected scope no longer exists. Choose another."; }
    const summary = selectedSummary();
    const lines = [`Scope: ${queryScopeName(selectedId())}`];
    if (summary != null) {
      lines.push(queryScopeDescription(summary));
      const problems = queryScopeProblemText(summary.problems);
      if (problems != null) { lines.push(problems); }
    }
    return lines.join("\n");
  };

  const open = () => {
    if (disabled()) { return; }
    setAnchorRect(buttonEl?.getBoundingClientRect() ?? null);
    setIsOpen(true);
    void refreshQueryScopes(store);
  };

  const close = () => { setIsOpen(false); };

  const select = (scopeId: Uid | null) => {
    close();
    if (scopeId == selectedId()) { return; }
    props.beforeChange?.();
    setQueryScopeId(store, props.queryItem(), scopeId);
    props.onChange?.();
  };

  const editScopes = () => {
    const scopesPageId = queryScopes()?.scopesPageId;
    close();
    if (scopesPageId != null) {
      switchToPage(store, { itemId: scopesPageId, linkIdMaybe: null }, true, false, false);
    }
  };

  const onWindowKeyDown = (ev: KeyboardEvent) => {
    if (ev.key == "Escape" && isOpen()) {
      ev.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onWindowKeyDown, true);
  onCleanup(() => window.removeEventListener("keydown", onWindowKeyDown, true));

  /** Positioned below the button where there is room, else above, and clamped to the viewport. */
  const panelStyle = (): string => {
    const rect = anchorRect();
    const left = rect == null
      ? PANEL_VIEWPORT_MARGIN_PX
      : Math.max(
          PANEL_VIEWPORT_MARGIN_PX,
          Math.min(rect.left, window.innerWidth - PANEL_WIDTH_PX - PANEL_VIEWPORT_MARGIN_PX));
    const spaceAbove = rect == null ? 0 : rect.top - PANEL_GAP_PX - PANEL_VIEWPORT_MARGIN_PX;
    const spaceBelow = rect == null ? 0 : window.innerHeight - rect.bottom - PANEL_GAP_PX - PANEL_VIEWPORT_MARGIN_PX;
    // Opening below keeps the query input above the button visible.
    const placeBelow = spaceBelow >= PANEL_MIN_BELOW_PX || spaceBelow >= spaceAbove;
    const maxHeight = Math.max(160, Math.min(PANEL_MAX_HEIGHT_PX, placeBelow ? spaceBelow : spaceAbove));
    const vertical = rect == null
      ? `top: ${PANEL_VIEWPORT_MARGIN_PX}px;`
      : placeBelow
        ? `top: ${rect.bottom + PANEL_GAP_PX}px;`
        : `bottom: ${Math.max(PANEL_VIEWPORT_MARGIN_PX, window.innerHeight - rect.top + PANEL_GAP_PX)}px;`;
    return `left: ${left}px; ${vertical} width: ${PANEL_WIDTH_PX}px; max-height: ${maxHeight}px; ` +
      `z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 1};`;
  };

  const stop = (ev: Event) => { ev.stopPropagation(); };

  const activateOnKey = (action: () => void) => (ev: KeyboardEvent) => {
    if (ev.key != "Enter" && ev.key != " ") { return; }
    ev.preventDefault();
    ev.stopPropagation();
    action();
  };

  const renderRow = (scopeId: Uid | null, label: string, description: string, warning: string | null) => {
    const selected = () => selectedId() == scopeId;
    return (
      <div
        class="flex cursor-pointer items-start gap-2 rounded-xs px-3 py-1.5 hover:bg-slate-100"
        role="radio"
        tabindex={0}
        aria-checked={selected()}
        onClick={() => select(scopeId)}
        onKeyDown={activateOnKey(() => select(scopeId))}>
        <i
          class="mt-[2px] shrink-0 text-[12px]"
          classList={{
            "bi-record-circle text-slate-700": selected(),
            "bi-circle text-slate-400": !selected(),
          }} />
        <div class="min-w-0 grow">
          <div class="truncate text-black" style="font-size: 13px; line-height: 18px;">{label}</div>
          <div class="truncate text-[11px] text-slate-500">{description}</div>
          <Show when={warning != null}>
            <div class="text-[11px] text-amber-700">{warning}</div>
          </Show>
        </div>
      </div>
    );
  };

  const showWarning = (): boolean => selectedIsMissing() || selectedHasProblems();

  const renderButton = () => (
    <button
      ref={buttonEl}
      type="button"
      class={props.variant == "compact"
        ? "flex max-w-[180px] cursor-pointer items-center gap-1 px-2 disabled:cursor-default disabled:opacity-40"
        : "flex h-[22px] max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-[#d6d6d6] " +
          "bg-white pl-2 pr-2 text-[#555] hover:bg-slate-50 disabled:cursor-default disabled:opacity-50"}
      style={props.variant == "compact"
        ? "height: 20px; font-size: 11px; font-weight: 600; color: rgba(71, 85, 105, 0.92); " +
          "background: rgba(255, 255, 255, 0.96); border: 1px solid rgba(203, 213, 225, 0.95); border-radius: 5px; " +
          "box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);"
        : "font-size: 12px; line-height: 18px;"}
      title={buttonTitle()}
      disabled={disabled()}
      aria-haspopup="dialog"
      aria-expanded={isOpen()}
      aria-label={`Scope: ${queryScopeName(selectedId())}`}
      onClick={(ev) => { stop(ev); isOpen() ? close() : open(); }}
      onMouseDown={stop}
      onMouseUp={stop}
      onKeyDown={stop}>
      <Show when={showWarning()} fallback={<i class="bi-funnel shrink-0 text-[11px]" />}>
        <i class="bi-exclamation-triangle shrink-0 text-[11px] text-amber-600" />
      </Show>
      <span class="min-w-0 truncate">{queryScopeName(selectedId())}</span>
      <Show when={props.variant == "pill"}>
        <i class="bi-chevron-expand ml-auto shrink-0 text-[10px]" />
      </Show>
    </button>
  );

  return (
    <>
      {renderButton()}
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
            aria-label="Scope"
            onMouseDown={stop}
            onMouseUp={stop}
            onClick={stop}
            onKeyDown={stop}
            onKeyUp={stop}>
            <div class="min-h-0 grow overflow-y-auto py-1.5" role="radiogroup" aria-label="Scope">
              <div class="px-3 pb-0.5 text-[11px] font-medium tracking-wide text-slate-500 uppercase">Scope</div>
              <Show when={props.note?.() != null}>
                <div class="px-3 pb-1 text-[11px] text-slate-500">{props.note!()}</div>
              </Show>
              {renderRow(null, "Everything", "Everything under your home page", null)}
              <Show when={selectedIsMissing()}>
                {renderRow(selectedId(), "Missing scope", "This scope was deleted or moved.", "Choose another scope.")}
              </Show>
              <Show when={queryScopes() == null && queryScopesError() == null}>
                <div class="flex animate-pulse items-center gap-2 px-3 py-2">
                  <div class="h-3 w-3 shrink-0 rounded-full bg-slate-200" />
                  <div class="h-3 grow rounded-xs bg-slate-200" />
                </div>
              </Show>
              <Show when={queryScopesError() != null}>
                <div class="px-3 py-1.5 text-[12px] text-red-700">{queryScopesError()}</div>
              </Show>
              <For each={queryScopes()?.scopes ?? []}>{summary =>
                renderRow(
                  summary.id,
                  queryScopeName(summary.id),
                  queryScopeDescription(summary),
                  queryScopeProblemText(summary.problems))
              }</For>
            </div>
            <div class="shrink-0 border-t border-slate-200 px-3 py-2">
              <div class="text-[11px] text-slate-500">
                Each page in Scopes is a scope. Links in it are included, and links in its Exclude page are excluded.
              </div>
              <Show when={queryScopes() != null}>
                <button
                  type="button"
                  class="mt-1 cursor-pointer text-[12px] text-blue-700 hover:underline"
                  onClick={editScopes}>
                  Edit scopes
                </button>
              </Show>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
};
