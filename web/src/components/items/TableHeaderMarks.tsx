/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, Show } from "solid-js";

/**
 * The marks at the right of a table column heading. An arrow, always shown, when the table is sorted by the column.
 * The chevron of the column menu, which opens from the right end of the heading: faint on every heading while the mouse
 * is over the headings, so it can be found, and full where the mouse is on it. Nothing while the heading is edited,
 * as the marks are inside its editable element.
 */
export const TableHeaderMarks: Component<{
  sort: "asc" | "desc" | null,
  menu: "none" | "faint" | "full",
  editing: boolean,
}> = (props) => (
  <Show when={!props.editing}>
    <Show when={props.sort != null}>
      <div class="absolute pointer-events-none text-slate-600" contentEditable={false}
        style="top: 0px; right: 20px; font-size: smaller;">
        <i class={props.sort == "asc" ? "fas fa-arrow-up" : "fas fa-arrow-down"} />
      </div>
    </Show>
    <Show when={props.menu != "none"}>
      <div class={`absolute pointer-events-none ${props.menu == "faint" ? "opacity-30" : ""}`} contentEditable={false}
        style="top: 0px; right: 7px; font-size: smaller;">
        <i class="fas fa-chevron-down" />
      </div>
    </Show>
  </Show>
);
