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

import { Component, For, Show } from "solid-js";
import { NoteInlineMark, NoteInlineMarkFlags, NoteUrl, noteInlineTextSegments } from "../../items/note-item";
import { EMPTY_CONTENT_EDITABLE_PLACEHOLDER } from "../../util/string";
import { ClickState } from "../../input/state";
import { MOUSE_LEFT } from "../../input/mouse_down";


function segmentStyle(flags: number): string {
  return `${(flags & NoteInlineMarkFlags.Bold) ? "font-weight: bold; " : ""}` +
    `${(flags & NoteInlineMarkFlags.Italic) ? "font-style: italic; " : ""}`;
}

function linkStyle(flags: number): string {
  return `${segmentStyle(flags)} ` +
    `cursor: pointer; ` +
    `-webkit-user-drag: none; -khtml-user-drag: none; -moz-user-drag: none; -o-user-drag: none; user-drag: none;`;
}

export const NoteInlineText: Component<{
  text: string,
  inlineMarks: Array<NoteInlineMark>,
  urls: Array<NoteUrl>,
  linksEnabled?: boolean,
}> = (props) => {
  const segments = () => noteInlineTextSegments(props.inlineMarks, props.urls, props.text);

  const linkMouseDown = (url: string) => (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) { ClickState.setLinkWasClicked(url); }
    ev.preventDefault();
  };
  const eatLinkClick = (ev: MouseEvent) => { ev.preventDefault(); };

  return (
    <>
      <Show when={props.text == ""}>
        {EMPTY_CONTENT_EDITABLE_PLACEHOLDER}
      </Show>
      <Show when={props.text != ""}>
        <For each={segments()}>{segment =>
          <Show
            when={props.linksEnabled && segment.url != null}
            fallback={<span style={segmentStyle(segment.flags)}>{segment.text}</span>}>
            <a
              href={segment.url ?? ""}
              class="text-blue-800 hover:text-blue-600"
              style={linkStyle(segment.flags)}
              onClick={eatLinkClick}
              onMouseDown={linkMouseDown(segment.url ?? "")}
              onMouseUp={eatLinkClick}>
              {segment.text}
            </a>
          </Show>
        }</For>
      </Show>
    </>
  );
};
