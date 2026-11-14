/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { filterQueryPrompts, queryPromptPreview, queryPrompts, queryPromptsError, refreshQueryPrompts } from "../../items/query-prompt";
import { switchToPage } from "../../layout/navigation";
import type { PromptSummary } from "../../server";
import { type StoreContextModel, useStore } from "../../store/StoreProvider";
import { QueryPickerPopover } from "./QueryPickerPopover";
import { DIALOG_INPUT_CLASS, DIALOG_LINK_CLASS, DIALOG_SURFACE_CLASS, DialogHeader } from "../library/dialogStyle";

const TOO_LONG_TEXT = "Too long to insert. Shorten it to under 64 KB.";

let nextListId = 0;

/**
 * Moves the highlight or chooses the highlighted prompt for a key pressed where the list's filter is typed. Focus stays
 * there, so the list is navigated without being focused. Returns true if the key was used.
 */
export function queryPromptListKeyDown(
  ev: KeyboardEvent, prompts: Array<PromptSummary>, active: number, setActive: (index: number) => void, choose: (prompt: PromptSummary) => void,
): boolean {
  if (prompts.length == 0) { return false; }
  if (ev.key == "ArrowDown" || ev.key == "ArrowUp") {
    setActive((active + (ev.key == "ArrowDown" ? 1 : -1) + prompts.length) % prompts.length);
  } else if (ev.key == "Enter" && !ev.shiftKey && !ev.isComposing) {
    choose(prompts[Math.min(active, prompts.length - 1)]);
  } else {
    return false;
  }
  ev.preventDefault();
  return true;
}

interface QueryPromptListProps {
  listId: string,
  prompts: () => Array<PromptSummary>,
  /** Whether the list is filtered, so an empty list means no match rather than no prompts. */
  filtered: () => boolean,
  active: () => number,
  setActive: (index: number) => void,
  onChoose: (prompt: PromptSummary) => void,
}

/** The prompts as a listbox whose highlight is driven from elsewhere: the picker's filter, or the chat composer. */
export function QueryPromptList(props: QueryPromptListProps) {
  let list: HTMLDivElement | undefined;
  createEffect(on(props.active, active => {
    list?.querySelector(`#${props.listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }));
  return <div ref={list} id={props.listId} role="listbox" aria-label="Prompts" class="py-1">
    <Show when={queryPrompts() == null && queryPromptsError() == null}><div class="px-3 py-2 text-[12px] text-neutral-500">Loading prompts…</div></Show>
    <Show when={queryPromptsError()}><div class="px-3 py-2 text-[12px] text-red-700">{queryPromptsError()}</div></Show>
    <Show when={queryPrompts() != null && props.prompts().length == 0}>
      <div class="px-3 py-2 text-[12px] text-neutral-500">
        {props.filtered() ? "No prompts match." : "No prompts yet. Notes and composites on the Prompts page are listed here."}
      </div>
    </Show>
    <For each={props.prompts()}>{(prompt, index) =>
      <div id={`${props.listId}-${index()}`} role="option" aria-selected={props.active() == index()} aria-disabled={prompt.tooLong == true}
        class="cursor-pointer px-3 py-1.5" classList={{ "bg-control-hover": props.active() == index(), "opacity-60 cursor-default": prompt.tooLong == true }}
        title={prompt.tooLong ? TOO_LONG_TEXT : prompt.text}
        onMouseMove={() => { if (props.active() != index()) { props.setActive(index()); } }}
        onMouseDown={ev => ev.preventDefault()}
        onClick={() => props.onChoose(prompt)}>
        <div class="truncate text-[13px]">{prompt.name}</div>
        <Show when={prompt.tooLong} fallback={<Show when={queryPromptPreview(prompt)}>{preview => <div class="truncate text-[11px] text-neutral-500">{preview()}</div>}</Show>}>
          <div class="text-[11px] text-amber-700">{TOO_LONG_TEXT}</div>
        </Show>
      </div>
    }</For>
  </div>;
}

interface QueryPromptPickerProps {
  buttonAppearance: { class: string, style: string },
  disabled?: () => boolean,
  /** Called once the picker has closed and returned focus to its button. */
  onChoose: (text: string) => void,
  buttonRef?: (el: HTMLButtonElement) => void,
  onTabKey?: (ev: KeyboardEvent) => void,
}

/** A button that opens the prompts with a filter, to insert one into a chat message. */
export function QueryPromptPicker(props: QueryPromptPickerProps) {
  const store = useStore();
  const listId = `query-prompts-${nextListId++}`;
  const [filter, setFilter] = createSignal("");
  const [active, setActive] = createSignal(0);
  const prompts = () => filterQueryPrompts(queryPrompts()?.prompts ?? [], filter());
  onMount(() => { if (queryPrompts() == null) { void refreshQueryPrompts(store); } });

  return <QueryPickerPopover width={360} disabled={props.disabled?.() == true} buttonRef={props.buttonRef} onTabKey={props.onTabKey}
    buttonAppearance={props.buttonAppearance} ariaLabel="Insert a prompt" title="Insert a prompt (or type / at the start of the message)"
    label={<i class="bi-journal-text" />}
    onOpen={() => { setFilter(""); setActive(0); void refreshQueryPrompts(store); }}>
    {close => {
      const choose = (prompt: PromptSummary) => {
        if (prompt.text == null) { return; }
        const text = prompt.text;
        close();
        // After close() has queued focusing the button, so the caller can move focus to where the text went.
        queueMicrotask(() => props.onChoose(text));
      };
      return <>
        <DialogHeader title="Prompts" onClose={close}>
          <input type="text" class={`mt-1.5 w-full ${DIALOG_INPUT_CLASS}`}
            placeholder="Filter prompts" aria-label="Filter prompts" role="combobox" data-picker-autofocus aria-expanded="true" aria-controls={listId}
            aria-activedescendant={prompts().length > 0 ? `${listId}-${Math.min(active(), prompts().length - 1)}` : undefined}
            value={filter()} onInput={ev => { setFilter(ev.currentTarget.value); setActive(0); }}
            onKeyDown={ev => { queryPromptListKeyDown(ev, prompts(), active(), setActive, choose); }} />
        </DialogHeader>
        <div class="min-h-0 grow overflow-y-auto">
          <QueryPromptList listId={listId} prompts={prompts} filtered={() => filter().trim() != ""} active={active} setActive={setActive} onChoose={choose} />
        </div>
        <Show when={queryPrompts() != null}>
          <div class="shrink-0 border-t border-chrome-line px-3 py-2">
            <button type="button" class={`block ${DIALOG_LINK_CLASS}`}
              title="Each note or composite on the Prompts page is a prompt." onClick={() => {
                const pageId = queryPrompts()?.promptsPageId;
                close();
                if (pageId != null) { switchToPage(store, { itemId: pageId, linkIdMaybe: null }, true, false, false); }
              }}>Edit prompts</button>
          </div>
        </Show>
      </>;
    }}
  </QueryPickerPopover>;
}

/** The filter typed after a "/" that starts a message of one line, or null when the message is not one. */
export function queryPromptSlashFilter(text: string): string | null {
  return /^\/[^\n]*$/.test(text) ? text.slice(1) : null;
}

export interface QueryPromptSuggestions {
  open: () => boolean,
  prompts: () => Array<PromptSummary>,
  active: () => number,
  setActive: (index: number) => void,
  /** Handles a key pressed in the message while the suggestions are open. Returns true if it was used. */
  keyDown: (ev: KeyboardEvent, choose: (prompt: PromptSummary) => void) => boolean,
}

/**
 * Prompts suggested while a message is "/" and a filter. They are shown only while some match, so a message that
 * merely starts with "/" is not in the way, and Escape hides them until the message stops starting with "/".
 */
export function createQueryPromptSuggestions(store: StoreContextModel, filter: () => string | null): QueryPromptSuggestions {
  const [active, setActive] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);
  const prompts = createMemo(() => {
    const current = filter();
    return current == null ? [] : filterQueryPrompts(queryPrompts()?.prompts ?? [], current);
  });
  createEffect(on(filter, current => { setActive(0); if (current == null) { setDismissed(false); } }));
  createEffect(on(() => filter() != null, started => { if (started) { void refreshQueryPrompts(store); } }));
  const open = () => {
    const current = filter();
    return current != null && !dismissed() && (current.trim() == "" || prompts().length > 0);
  };
  const keyDown = (ev: KeyboardEvent, choose: (prompt: PromptSummary) => void) => {
    if (!open()) { return false; }
    if (ev.key == "Escape") { ev.preventDefault(); setDismissed(true); return true; }
    return queryPromptListKeyDown(ev, prompts(), active(), setActive, choose);
  };
  return { open, prompts, active, setActive, keyDown };
}

interface QueryPromptSuggestionListProps {
  suggestions: QueryPromptSuggestions,
  /** The message input: the list opens above or below it, wherever there is more room. */
  anchor: () => HTMLElement | undefined,
  onChoose: (prompt: PromptSummary) => void,
}

/** The suggested prompts beside the message input, which keeps focus. */
export function QueryPromptSuggestionList(props: QueryPromptSuggestionListProps) {
  const store = useStore();
  const listId = `query-prompts-${nextListId++}`;
  const [anchorRect, setAnchorRect] = createSignal<DOMRect | null>(null);
  const update = () => setAnchorRect(props.anchor()?.getBoundingClientRect() ?? null);
  createEffect(() => {
    if (!props.suggestions.open()) { return; }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    onCleanup(() => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    });
  });
  const style = () => {
    const rect = anchorRect();
    if (rect == null) { return "display: none;"; }
    const margin = 8;
    const gap = 4;
    const width = Math.min(Math.max(rect.width, 280), 420, window.innerWidth - margin * 2);
    const above = rect.top - margin - gap;
    const below = window.innerHeight - rect.bottom - margin - gap;
    const height = Math.max(0, Math.min(320, Math.max(above, below)));
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    const vertical = above > below ? `bottom: ${window.innerHeight - rect.top + gap}px;` : `top: ${rect.bottom + gap}px;`;
    return `left: ${left}px; ${vertical} width: ${width}px; max-height: ${height}px; z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 1};`;
  };
  return <Show when={props.suggestions.open()}>
    <Portal mount={document.body}>
      <div class={`fixed flex flex-col overflow-hidden ${DIALOG_SURFACE_CLASS}`} style={style()}
        onMouseDown={ev => { ev.preventDefault(); ev.stopPropagation(); }} onMouseUp={ev => ev.stopPropagation()} onClick={ev => ev.stopPropagation()}>
        <div class="min-h-0 grow overflow-y-auto">
          <QueryPromptList listId={listId} prompts={props.suggestions.prompts} filtered={() => false}
            active={props.suggestions.active} setActive={props.suggestions.setActive} onChoose={props.onChoose} />
        </div>
        <div class="flex shrink-0 items-center gap-2 border-t border-chrome-line px-3 py-1.5 text-[11px] text-neutral-500">
          <span class="min-w-0 truncate">↑↓ choose · Enter insert · Esc dismiss</span>
          <button type="button" class={`ml-auto shrink-0 ${DIALOG_LINK_CLASS}`} onClick={() => {
            const pageId = queryPrompts()?.promptsPageId;
            if (pageId != null) { switchToPage(store, { itemId: pageId, linkIdMaybe: null }, true, false, false); }
          }}>Edit prompts</button>
        </div>
      </div>
    </Portal>
  </Show>;
}
