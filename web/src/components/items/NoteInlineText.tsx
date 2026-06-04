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
import { NoteInlineMark, NoteInlineMarkFlags, noteInlineTextSegments } from "../../items/note-item";
import { EMPTY_CONTENT_EDITABLE_PLACEHOLDER } from "../../util/string";


function segmentStyle(flags: number): string {
  return `${(flags & NoteInlineMarkFlags.Bold) ? "font-weight: bold; " : ""}` +
    `${(flags & NoteInlineMarkFlags.Italic) ? "font-style: italic; " : ""}`;
}

export const NoteInlineText: Component<{
  text: string,
  inlineMarks: Array<NoteInlineMark>,
  trailingCaretSpan?: boolean,
}> = (props) => {
  const segments = () => noteInlineTextSegments(props.inlineMarks, props.text);

  return (
    <>
      <Show when={props.text == ""}>
        {EMPTY_CONTENT_EDITABLE_PLACEHOLDER}
      </Show>
      <Show when={props.text != ""}>
        <For each={segments()}>{segment =>
          <span style={segmentStyle(segment.flags)}>{segment.text}</span>
        }</For>
      </Show>
      <Show when={props.trailingCaretSpan}>
        <span></span>
      </Show>
    </>
  );
};
