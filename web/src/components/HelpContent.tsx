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

import { Component, For, JSX, Show } from "solid-js";


// Shown in the help overlay and on the login page. Keep in sync with input/key.ts, input/mouse_*.ts and the
// keyboard listeners in Main.tsx.

const IS_MAC = typeof navigator != "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The primary modifier: Cmd on a Mac, Ctrl elsewhere. Drag modifiers read ctrlKey, so they are Ctrl everywhere. */
const MOD = IS_MAC ? "⌘" : "Ctrl";

interface HelpRow {
  /** Alternative ways to do the same thing. Each is a list of keys pressed together. */
  keys: Array<Array<string>>,
  text: string,
  macOnly?: boolean,
}

interface HelpSection {
  title: string,
  rows: Array<HelpRow>,
  /** Followed by the single-key shortcuts for each item type. */
  withCreateKeys?: boolean,
}

/** Mouse actions, shown as words rather than key caps. */
const MOUSE_ACTIONS = new Set(["Drop files", "Right-click", "Long press", "Drag", "Drag background"]);

const CREATE_KEYS: Array<[string, string]> = [
  ["N", "note"], ["P", "page"], ["T", "table"], ["X", "text"],
  ["R", "rating"], ["W", "password"], ["L", "link"], ["D", "divider"],
];

const SECTIONS: Array<HelpSection> = [
  {
    title: "Create",
    withCreateKeys: true,
    rows: [
      { keys: [["/"]], text: "Add an item at the cursor, choosing its type" },
      { keys: [["Drop files"]], text: "Upload files to where you drop them" },
    ],
  },
  {
    title: "Navigate",
    rows: [
      { keys: [["Right-click"]], text: "Go back. It doesn't open a menu, except in text you are editing." },
      { keys: [["← ↑ → ↓"]], text: "Move focus between items" },
      { keys: [["Enter"]], text: "Open or step into the focused item" },
      { keys: [["Space"]], text: "Open the focused item in a popup" },
      { keys: [["Esc"]], text: "Close the popup, or move focus up a level" },
      { keys: [["⌘", "Enter"]], text: "Hide or show the toolbar and dock", macOnly: true },
    ],
  },
  {
    title: "Edit",
    rows: [
      { keys: [["F2"]], text: "Edit the focused item" },
      { keys: [["Esc"]], text: "Stop editing" },
      { keys: [["Long press"]], text: "Edit a page's title" },
      { keys: [[MOD, "Z"], [MOD, "Shift", "Z"]], text: "Undo / redo text edits" },
    ],
  },
  {
    title: "Arrange",
    rows: [
      { keys: [["Drag"]], text: "Move an item" },
      { keys: [["Ctrl", "Drag"]], text: "Make a link to the item" },
      { keys: [["Shift", "Drag"]], text: "Clone the item (its children are not cloned)" },
      { keys: [["Drag background"]], text: "Select several items" },
    ],
  },
  {
    title: "Find",
    rows: [
      { keys: [[MOD, "F"]], text: "Find on this page" },
      { keys: [[MOD, "Shift", "F"]], text: "Search everything (Queries)" },
      { keys: [[MOD, "P"]], text: "Print the current page" },
      { keys: [["?"]], text: "Show this help" },
    ],
  },
];


const Key: Component<{ children: JSX.Element }> = (props) =>
  <kbd class="inline-block min-w-[20px] px-[5px] text-center text-[11px] leading-[18px] font-mono text-slate-700 bg-slate-50 border border-slate-300 rounded-sm shadow-[0_1px_0_#cbd5e1] whitespace-nowrap">
    {props.children}
  </kbd>;

const KeyCombo: Component<{ keys: Array<string> }> = (props) =>
  <span class="inline-flex items-center gap-[3px]">
    <For each={props.keys}>{(k, i) =>
      <>
        <Show when={i() > 0}>
          <span class="text-[10px] text-slate-400">+</span>
        </Show>
        <Show when={MOUSE_ACTIONS.has(k)} fallback={<Key>{k}</Key>}>
          <span class="text-[13px] text-slate-600 italic whitespace-nowrap">{k}</span>
        </Show>
      </>
    }</For>
  </span>;

const Keys: Component<{ alternatives: Array<Array<string>> }> = (props) =>
  <span class="inline-flex flex-wrap items-center gap-x-[5px] gap-y-[3px]">
    <For each={props.alternatives}>{(combo, i) =>
      <>
        <Show when={i() > 0}><span class="text-[11px] text-slate-400">or</span></Show>
        <KeyCombo keys={combo} />
      </>
    }</For>
  </span>;

const SectionTitle: Component<{ children: JSX.Element }> = (props) =>
  <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-[6px]">{props.children}</div>;


/** A short introduction, then the keyboard and mouse shortcuts, grouped by task. */
export const HelpContent: Component = () => {
  const rows = (section: HelpSection) => section.rows.filter(r => !r.macOnly || IS_MAC);

  return (
    <div class="text-sm text-slate-800">
      <p class="mb-4 leading-snug text-slate-700">
        Everything in Infumap is an item. Press <Key>/</Key> to add one, or a letter key (listed below) to add a
        specific type.
      </p>

      <For each={SECTIONS}>{section =>
        <div class="mb-4 last:mb-0">
          <SectionTitle>{section.title}</SectionTitle>
          <div class="grid grid-cols-[minmax(0,7.5rem)_1fr] sm:grid-cols-[minmax(0,10rem)_1fr] gap-x-3 gap-y-[5px] items-baseline">
            <For each={rows(section)}>{row =>
              <>
                <Keys alternatives={row.keys} />
                <span class="leading-snug">{row.text}</span>
              </>
            }</For>
          </div>
          <Show when={section.withCreateKeys}>
            <div class="mt-[8px] mb-[4px] text-slate-600">Or press a letter to add that type of item:</div>
            <div class="grid grid-cols-4 gap-x-3 gap-y-[5px]">
              <For each={CREATE_KEYS}>{([k, name]) =>
                <span class="inline-flex items-center gap-[6px]"><Key>{k}</Key><span>{name}</span></span>
              }</For>
            </div>
          </Show>
        </div>
      }</For>
    </div>
  );
}
