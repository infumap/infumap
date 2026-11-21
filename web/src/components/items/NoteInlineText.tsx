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

import { Component, For, Show, createMemo } from "solid-js";
import { NoteInlineMark, NoteInlineMarkFlags, NoteUrl, noteInlineTextSegments, safeNoteLinkUrl } from "../../items/note-item";
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

// Inherits the cursor: a text cursor while editing, the default inside translucent pages.
function inactiveLinkStyle(flags: number): string {
  return segmentStyle(flags);
}

/**
 * Where only one line of the note is shown, a line break in it would hide the lines after it. A glyph shows it instead.
 * It isn't selectable, so a copy doesn't pick up the glyph.
 */
function textWithLineBreakGlyphs(text: string, lineBreakGlyphs: boolean | undefined) {
  if (!lineBreakGlyphs || !text.includes("\n")) { return text; }
  return text.split("\n").flatMap((line, i) => i == 0 ? [line] : [
    <span class="text-neutral-400" style="padding: 0 0.2em; user-select: none; -webkit-user-select: none;">{"\u21B5"}</span>,
    line,
  ]);
}

export const NoteInlineText: Component<{
  text: string,
  inlineMarks: Array<NoteInlineMark>,
  urls: Array<NoteUrl>,
  linksEnabled?: boolean,
  inactiveLinksStyled?: boolean,
  lineBreakGlyphs?: boolean,
  onLinkMouseDown?: (url: string, ev: MouseEvent) => void,
}> = (props) => {
  // Each arrange of the note can get here, as a change to its alignment does. Rebuilding spans that are the same would
  // collapse a text selection ending inside them.
  const segments = createMemo(() => noteInlineTextSegments(props.inlineMarks, props.urls, props.text)
    .map(segment => ({ ...segment, url: safeNoteLinkUrl(segment.url) })),
    undefined, { equals: (a, b) => JSON.stringify(a) == JSON.stringify(b) });

  const linkMouseDown = (url: string) => (ev: MouseEvent) => {
    if (props.onLinkMouseDown) {
      props.onLinkMouseDown(url, ev);
      return;
    }
    if (ev.button == MOUSE_LEFT) { ClickState.setLinkWasClicked(url); }
    // In a read-only document a press on a link may start a text selection (see mouse_down.ts), which a prevented
    // mousedown can't do. The page body there is contenteditable, so the browser doesn't drag the link instead.
    if (ev.target instanceof Element && ev.target.closest("[data-infumap-read-only-document]") != null) { return; }
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
            fallback={
              <Show
                when={props.inactiveLinksStyled && segment.url != null}
                fallback={<span style={segmentStyle(segment.flags)}>{textWithLineBreakGlyphs(segment.text, props.lineBreakGlyphs)}</span>}>
                <span class="text-blue-600" style={inactiveLinkStyle(segment.flags)}>
                  {textWithLineBreakGlyphs(segment.text, props.lineBreakGlyphs)}
                </span>
              </Show>
            }>
            <a
              href={segment.url ?? ""}
              class="text-blue-600 hover:text-blue-800"
              style={linkStyle(segment.flags)}
              onClick={eatLinkClick}
              onMouseDown={linkMouseDown(segment.url ?? "")}
              onMouseUp={eatLinkClick}>
              {textWithLineBreakGlyphs(segment.text, props.lineBreakGlyphs)}
            </a>
          </Show>
        }</For>
      </Show>
    </>
  );
};
