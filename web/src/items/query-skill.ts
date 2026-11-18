/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { createSignal } from "solid-js";
import { type ChatSkillMention, type ListSkillsResponse, type SkillSummary, server } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { Uid } from "../util/uid";

const [skillList, setSkillList] = createSignal<ListSkillsResponse | null>(null);
const [skillListError, setSkillListError] = createSignal<string | null>(null);
let skillListRequest: Promise<void> | null = null;
let skillListGeneration = 0;
let skillListAccountId: Uid | null = null;

export function clearQuerySkills(): void {
  skillListGeneration++;
  skillListRequest = null;
  skillListAccountId = null;
  setSkillList(null);
  setSkillListError(null);
}

/** The user's skills as last fetched, or null before the first fetch completes. */
export function querySkills(): ListSkillsResponse | null {
  return skillList();
}

export function querySkillsError(): string | null {
  return skillListError();
}

/** Skills are edited as ordinary items, so the list is fetched again whenever a slash picker opens. */
export function refreshQuerySkills(store: StoreContextModel): Promise<void> {
  const accountId = store.user.getUserMaybe()?.userId ?? null;
  if (skillListAccountId != accountId) { clearQuerySkills(); skillListAccountId = accountId; }
  if (accountId == null) { return Promise.resolve(); }
  if (skillListRequest == null) {
    const generation = skillListGeneration;
    const isCurrent = () => generation == skillListGeneration && accountId == (store.user.getUserMaybe()?.userId ?? null);
    skillListRequest = server.listSkills()
      .then(response => {
        if (!isCurrent()) { return; }
        setSkillList(response);
        setSkillListError(null);
      })
      .catch(e => {
        if (!isCurrent()) { return; }
        console.error("Could not load skills:", e);
        setSkillListError("Could not load skills.");
      })
      .finally(() => { if (isCurrent()) { skillListRequest = null; } });
  }
  return skillListRequest;
}

export const MAX_SKILLS_PER_MESSAGE = 10;

export interface DraftSkillMention extends ChatSkillMention {
  /** The start of this particular occurrence in the textarea. */
  start: number,
}

export interface DraftSkillSelection {
  text: string,
  mentions: Array<DraftSkillMention>,
}

export interface QuerySkillSlash {
  start: number,
  end: number,
  filter: string,
}

const SKILL_TOKEN_START = /[\s([{]/u;
const SKILL_TOKEN_END = /^(?:$|[\s)\]}]|[,.!?;:]+(?=$|[\s)\]}]))/u;

/** A slash token at the caret, bounded so paths and URLs do not open the picker. */
export function querySkillSlash(text: string, caret: number): QuerySkillSlash | null {
  const prefix = /(?:^|[\s([{])\/([\p{L}\p{N}_-]*)$/u.exec(text.slice(0, caret));
  if (prefix == null) { return null; }
  const start = caret - prefix[1].length - 1;
  const suffix = /^[\p{L}\p{N}_-]*/u.exec(text.slice(caret))![0];
  const end = caret + suffix.length;
  return SKILL_TOKEN_END.test(text.slice(end)) ? { start, end, filter: prefix[1] } : null;
}

export function draftSkillToken(skill: SkillSummary, mentions: Array<DraftSkillMention>): string {
  const selected = mentions.find(mention => mention.id == skill.id);
  if (selected != null) { return selected.mention; }
  const slug = skill.name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const base = "/" + ([...slug].slice(0, 72).join("").replace(/-$/, "") || "skill");
  const used = new Set(mentions.map(mention => mention.mention));
  let available = base;
  for (let suffix = 2; used.has(available); suffix++) { available = `${base}-${suffix}`; }
  return available;
}

/** Keep only selected occurrences that survived the edit. An identical token typed elsewhere is plain text. */
export function updateDraftSkillSelection(
  draft: DraftSkillSelection, text: string, caret: number | null = null,
): DraftSkillSelection {
  if (draft.text == text) { return draft; }
  if (draft.mentions.length == 0) { return { text, mentions: draft.mentions }; }
  const previous = draft.text;
  if (caret == null && previous.trim() == text) {
    const leadingWhitespace = previous.length - previous.trimStart().length;
    return { text, mentions: draft.mentions.map(mention => ({ ...mention, start: mention.start - leadingWhitespace })) };
  }
  const delta = text.length - previous.length;
  // The browser caret identifies the splice even when the text on both sides repeats, for example two identical
  // mentions next to one another. Fall back to the common prefix and suffix for edits with a moved selection.
  const caretAnchorsTail = caret != null && caret - delta >= 0 && text.slice(caret) == previous.slice(caret - delta);
  let end = caretAnchorsTail ? caret : text.length;
  let start = 0;
  while (start < Math.min(end, end - delta) && text[start] == previous[start]) { start++; }
  if (!caretAnchorsTail) {
    while (end > start && end - delta > start && text[end - 1] == previous[end - delta - 1]) { end--; }
  }
  const mentions: Array<DraftSkillMention> = [];
  for (const mention of draft.mentions) {
    const unchanged = mention.start + mention.mention.length <= start;
    if (!unchanged && mention.start < end - delta) { continue; }
    const position = unchanged ? mention.start : mention.start + delta;
    if (text.startsWith(mention.mention, position)) {
      mentions.push(position == mention.start ? mention : { ...mention, start: position });
    }
  }
  return { text, mentions };
}

/** The model gets each selected skill once, in the order of its first mention. */
export function selectedDraftSkills(draft: DraftSkillSelection): Array<ChatSkillMention> {
  const seen = new Set<Uid>();
  const selected: Array<ChatSkillMention> = [];
  for (const { id, mention, start } of draft.mentions) {
    if (seen.has(id) || (start > 0 && !SKILL_TOKEN_START.test(draft.text[start - 1])) ||
        !SKILL_TOKEN_END.test(draft.text.slice(start + mention.length))) { continue; }
    seen.add(id);
    selected.push({ id, mention });
  }
  return selected;
}

/** Match every word of the filter against the title. Prefer names that start with the filter. */
export function filterQuerySkills(skills: Array<SkillSummary>, filter: string): Array<SkillSummary> {
  const query = filter.trim().toLowerCase().replace(/[-_]+/g, " ").trim();
  if (query == "") { return skills; }
  const words = query.split(/\s+/);
  const prefix: Array<SkillSummary> = [];
  const contains: Array<SkillSummary> = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase().replace(/[-_]+/g, " ");
    if (name.startsWith(query)) { prefix.push(skill); }
    else if (words.every(word => name.includes(word))) { contains.push(skill); }
  }
  return [...prefix, ...contains];
}
