/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For, Show, createEffect, createSignal, on, onMount } from "solid-js";
import { filterQueryPrompts, queryPromptPreview, queryPrompts, queryPromptsError, refreshQueryPrompts } from "../../items/query-prompt";
import { switchToPage } from "../../layout/navigation";
import type { PromptSummary } from "../../server";
import { useStore } from "../../store/StoreProvider";
import { QueryPickerPopover } from "./QueryPickerPopover";

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
    <Show when={queryPrompts() == null && queryPromptsError() == null}><div class="px-3 py-2 text-[12px] text-slate-500">Loading prompts…</div></Show>
    <Show when={queryPromptsError()}><div class="px-3 py-2 text-[12px] text-red-700">{queryPromptsError()}</div></Show>
    <Show when={queryPrompts() != null && props.prompts().length == 0}>
      <div class="px-3 py-2 text-[12px] text-slate-500">
        {props.filtered() ? "No prompts match." : "No prompts yet. Notes and composites on the Prompts page are listed here."}
      </div>
    </Show>
    <For each={props.prompts()}>{(prompt, index) =>
      <div id={`${props.listId}-${index()}`} role="option" aria-selected={props.active() == index()} aria-disabled={prompt.tooLong == true}
        class="cursor-pointer px-3 py-1.5" classList={{ "bg-slate-100": props.active() == index(), "opacity-60 cursor-default": prompt.tooLong == true }}
        title={prompt.tooLong ? TOO_LONG_TEXT : prompt.text}
        onMouseMove={() => { if (props.active() != index()) { props.setActive(index()); } }}
        onMouseDown={ev => ev.preventDefault()}
        onClick={() => props.onChoose(prompt)}>
        <div class="truncate text-[13px]">{prompt.name}</div>
        <Show when={prompt.tooLong} fallback={<Show when={queryPromptPreview(prompt)}>{preview => <div class="truncate text-[11px] text-slate-500">{preview()}</div>}</Show>}>
          <div class="text-[11px] text-amber-700">{TOO_LONG_TEXT}</div>
        </Show>
      </div>
    }</For>
  </div>;
}

interface QueryPromptPickerProps {
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
    buttonClass="shrink-0 cursor-pointer" ariaLabel="Insert a prompt" title="Insert a prompt from the Prompts page"
    label={<><i class="bi-card-text shrink-0 text-[11px]" /><span>Prompts</span></>}
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
        <div class="shrink-0 border-b border-slate-200 px-3 py-2">
          <div class="flex items-center gap-2 text-[12px] font-medium text-slate-600">Prompts
            <button type="button" class="ml-auto h-5 w-5 rounded hover:bg-slate-100" aria-label="Close prompts" onClick={close}><i class="bi-x-lg" /></button>
          </div>
          <input type="text" class="mt-1.5 w-full rounded border border-slate-300 px-2 py-1 text-[13px] outline-none focus:border-slate-500"
            placeholder="Filter prompts" aria-label="Filter prompts" role="combobox" aria-expanded="true" aria-controls={listId}
            aria-activedescendant={prompts().length > 0 ? `${listId}-${Math.min(active(), prompts().length - 1)}` : undefined}
            value={filter()} onInput={ev => { setFilter(ev.currentTarget.value); setActive(0); }}
            onKeyDown={ev => { queryPromptListKeyDown(ev, prompts(), active(), setActive, choose); }} />
        </div>
        <div class="min-h-0 grow overflow-y-auto">
          <QueryPromptList listId={listId} prompts={prompts} filtered={() => filter().trim() != ""} active={active} setActive={setActive} onChoose={choose} />
        </div>
        <Show when={queryPrompts() != null}>
          <div class="shrink-0 border-t border-slate-200 px-3 py-2">
            <button type="button" class="block text-[12px] text-blue-700 hover:underline"
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
