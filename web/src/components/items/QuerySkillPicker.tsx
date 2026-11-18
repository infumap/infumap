/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { filterQuerySkills, querySkills, querySkillsError, refreshQuerySkills, type QuerySkillSlash } from "../../items/query-skill";
import type { SkillSummary } from "../../server";
import type { StoreContextModel } from "../../store/StoreProvider";
import { DIALOG_SURFACE_CLASS } from "../library/dialogStyle";

let nextListId = 0;

interface QuerySkillSuggestions {
  open: () => boolean,
  skills: () => Array<SkillSummary>,
  active: () => number,
  setActive: (index: number) => void,
  keyDown: (ev: KeyboardEvent, choose: (skill: SkillSummary) => void) => boolean,
}

export function createQuerySkillSuggestions(
  store: StoreContextModel,
  slash: () => QuerySkillSlash | null,
): QuerySkillSuggestions {
  const [active, setActive] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);
  const tokenStart = () => slash()?.start;
  const filter = () => slash()?.filter;
  const skills = createMemo(() => {
    const current = filter();
    return current == null ? [] : filterQuerySkills(querySkills()?.skills ?? [], current);
  });
  createEffect(on(filter, () => setActive(0)));
  createEffect(on(tokenStart, start => { setDismissed(false); if (start != null) { void refreshQuerySkills(store); } }));
  const open = () => {
    const current = filter();
    return current != null && !dismissed() && (current.trim() == "" || skills().length > 0);
  };
  const keyDown = (ev: KeyboardEvent, choose: (skill: SkillSummary) => void) => {
    if (!open() || ev.isComposing) { return false; }
    if (ev.key == "Escape") {
      ev.preventDefault();
      setDismissed(true);
      return true;
    }
    const options = skills();
    if (options.length == 0) { return false; }
    if (ev.key == "ArrowDown" || ev.key == "ArrowUp") {
      setActive((active() + (ev.key == "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (ev.key == "Enter" && !ev.shiftKey) {
      choose(options[Math.min(active(), options.length - 1)]);
    } else {
      return false;
    }
    ev.preventDefault();
    return true;
  };
  return { open, skills, active, setActive, keyDown };
}

interface QuerySkillListProps {
  listId: string,
  skills: () => Array<SkillSummary>,
  active: () => number,
  setActive: (index: number) => void,
  onChoose: (skill: SkillSummary) => void,
}

function QuerySkillList(props: QuerySkillListProps) {
  let list: HTMLDivElement | undefined;
  createEffect(on(props.active, active => {
    list?.querySelector(`#${props.listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }));
  return <div ref={list} id={props.listId} role="listbox" aria-label="Skills" class="py-1">
    <Show when={querySkills() == null && querySkillsError() == null}>
      <div role="status" class="px-3 py-2 text-[12px] text-neutral-500">Loading skills…</div>
    </Show>
    <Show when={querySkillsError()}><div role="alert" class="px-3 py-2 text-[12px] text-red-700">{querySkillsError()}</div></Show>
    <Show when={querySkills() != null && props.skills().length == 0}>
      <div class="px-3 py-2 text-[12px] text-neutral-500">To add a skill, create a named document page in Skills at the bottom of Queries.</div>
    </Show>
    <For each={props.skills()}>{(skill, index) =>
      <div id={`${props.listId}-${index()}`} role="option" aria-selected={props.active() == index()}
        class="cursor-pointer truncate px-3 py-1.5 text-[13px]" classList={{ "bg-control-hover": props.active() == index() }}
        title={skill.name} onMouseMove={() => { if (props.active() != index()) { props.setActive(index()); } }}
        onClick={() => props.onChoose(skill)}>
        {skill.name}
      </div>
    }</For>
  </div>;
}

interface QuerySkillSuggestionListProps {
  suggestions: QuerySkillSuggestions,
  /** The message input: the list opens above or below it, wherever there is more room. */
  anchor: () => HTMLElement | undefined,
  onChoose: (skill: SkillSummary) => void,
}

/** The suggested skills beside the message input, which keeps focus. */
export function QuerySkillSuggestionList(props: QuerySkillSuggestionListProps) {
  const listId = `query-skills-${nextListId++}`;
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
          <QuerySkillList listId={listId} skills={props.suggestions.skills}
            active={props.suggestions.active} setActive={props.suggestions.setActive} onChoose={props.onChoose} />
        </div>
        <div class="flex shrink-0 items-center gap-2 border-t border-chrome-line px-3 py-1.5 text-[11px] text-neutral-500">
          <span class="min-w-0 truncate">↑↓ choose · Enter mention · Esc dismiss</span>
        </div>
      </div>
    </Portal>
  </Show>;
}
