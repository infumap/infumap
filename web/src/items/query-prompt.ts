/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { createSignal } from "solid-js";
import { ListPromptsResponse, PromptSummary, server } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { Uid } from "../util/uid";

const [promptList, setPromptList] = createSignal<ListPromptsResponse | null>(null);
const [promptListError, setPromptListError] = createSignal<string | null>(null);
let promptListRequest: Promise<void> | null = null;
let promptListGeneration = 0;
let promptListAccountId: Uid | null = null;

export function clearQueryPrompts(): void {
  promptListGeneration++;
  promptListRequest = null;
  promptListAccountId = null;
  setPromptList(null);
  setPromptListError(null);
}

/** The user's prompts as last fetched, or null before the first fetch completes. */
export function queryPrompts(): ListPromptsResponse | null {
  return promptList();
}

export function queryPromptsError(): string | null {
  return promptListError();
}

/** Prompts are edited as ordinary items, so the list is fetched again whenever a picker opens. */
export function refreshQueryPrompts(store: StoreContextModel): Promise<void> {
  const accountId = store.user.getUserMaybe()?.userId ?? null;
  if (promptListAccountId != accountId) { clearQueryPrompts(); promptListAccountId = accountId; }
  if (accountId == null) { return Promise.resolve(); }
  if (promptListRequest == null) {
    const generation = promptListGeneration;
    const isCurrent = () => generation == promptListGeneration && accountId == (store.user.getUserMaybe()?.userId ?? null);
    promptListRequest = server.listPrompts()
      .then(response => {
        if (!isCurrent()) { return; }
        setPromptList(response);
        setPromptListError(null);
      })
      .catch(e => {
        if (!isCurrent()) { return; }
        console.error("Could not load prompts:", e);
        setPromptListError("Could not load prompts.");
      })
      .finally(() => { if (isCurrent()) { promptListRequest = null; } });
  }
  return promptListRequest;
}

/**
 * The prompts holding every word of `filter`, in page order: those whose names start with it first, then those whose
 * names hold every word, then those that hold some only in their text.
 */
export function filterQueryPrompts(prompts: Array<PromptSummary>, filter: string): Array<PromptSummary> {
  const query = filter.trim().toLowerCase();
  if (query == "") { return prompts; }
  const words = query.split(/\s+/);
  const ranked: Array<Array<PromptSummary>> = [[], [], []];
  for (const prompt of prompts) {
    const name = prompt.name.toLowerCase();
    const text = (prompt.text ?? "").toLowerCase();
    if (!words.every(word => name.includes(word) || text.includes(word))) { continue; }
    ranked[name.startsWith(query) ? 0 : words.every(word => name.includes(word)) ? 1 : 2].push(prompt);
  }
  return ranked.flat();
}

/** The text after the name, on one line, or null when the name is all of it. */
export function queryPromptPreview(prompt: PromptSummary): string | null {
  if (prompt.text == null) { return null; }
  const flattened = prompt.text.replace(/\s+/g, " ").trim();
  const name = prompt.name.endsWith("…") ? prompt.name.slice(0, -1) : prompt.name;
  const index = flattened.indexOf(name);
  const rest = (index >= 0 && index < 8 ? flattened.slice(index + name.length) : flattened).trim();
  return rest == "" ? null : rest;
}
