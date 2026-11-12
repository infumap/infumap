/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, Show } from "solid-js";

/**
 * The chevron of a table column's menu, which opens from the right end of its heading: faint on every heading while
 * the mouse is over the table, so it can be found, and full where the mouse is on it. Nothing while the heading is
 * edited, as the chevron is inside its editable element.
 */
export const TableHeaderMarks: Component<{
  menu: "none" | "faint" | "full",
  editing: boolean,
}> = (props) => (
  <Show when={!props.editing && props.menu != "none"}>
    <div class={`absolute pointer-events-none ${props.menu == "faint" ? "opacity-30" : ""}`} contentEditable={false}
      style="top: 0px; right: 7px; font-size: smaller;">
      <i class="fas fa-chevron-down" />
    </div>
  </Show>
);
