/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { createSignal } from "solid-js";
import { ListSkillsResponse, SkillSummary, server } from "../server";
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

/** Match every word of the filter against the title. Prefer names that start with the filter. */
export function filterQuerySkills(skills: Array<SkillSummary>, filter: string): Array<SkillSummary> {
  const query = filter.trim().toLowerCase();
  if (query == "") { return skills; }
  const words = query.split(/\s+/);
  const prefix: Array<SkillSummary> = [];
  const contains: Array<SkillSummary> = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    if (name.startsWith(query)) { prefix.push(skill); }
    else if (words.every(word => name.includes(word))) { contains.push(skill); }
  }
  return [...prefix, ...contains];
}
