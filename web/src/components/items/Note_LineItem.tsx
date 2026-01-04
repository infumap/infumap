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

import { Component, Match, Show, Switch } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { VisualElementProps } from "../VisualElement";
import { asNoteItem, NoteFns } from "../../items/note-item";
import { NoteFlags } from "../../items/base/flags-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";
import { LINE_HEIGHT_PX, PADDING_PROP, Z_INDEX_ITEMS_OVERLAY, Z_INDEX_HIGHLIGHT } from "../../constants";
import { cloneBoundingBox } from "../../util/geometry";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { ClickState } from "../../input/state";
import { appendNewlineIfEmpty } from "../../util/string";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { SELECTED_DARK, SELECTED_LIGHT, FIND_HIGHLIGHT_COLOR } from "../../style";
import { getTextStyleForNote } from "../../layout/text";
import { isPage, asPageItem, ArrangeAlgorithm } from "../../items/page-item";
import { itemState } from "../../store/ItemState";


export const Note_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const noteItem = () => asNoteItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const showCopyIcon = () => (noteItem().flags & NoteFlags.ShowCopyIcon);

  const isInCalendarPage = () => {
    if (props.visualElement.parentPath) {
      try {
        const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath);
        const parentItem = itemState.get(parentVeid.itemId);
        if (parentItem && isPage(parentItem)) {
          return asPageItem(parentItem).arrangeAlgorithm === ArrangeAlgorithm.Calendar;
        }
      } catch (e) {
        // If path parsing fails, continue to fallback
      }
    }
    return false;
  };

  const shouldHideIcon = () => {
    return (props.visualElement.flags & VisualElementFlags.Attachment) || isInCalendarPage();
  };

  const leftPx = () => shouldHideIcon()
    ? boundsPx().x + oneBlockWidthPx() * PADDING_PROP
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => shouldHideIcon()
    ? boundsPx().w - oneBlockWidthPx() * PADDING_PROP - (showCopyIcon() ? oneBlockWidthPx() * 0.9 : 0)
    : boundsPx().w - oneBlockWidthPx() - (showCopyIcon() ? oneBlockWidthPx() * 0.9 : 0);
  const openPopupBoundsPx = () => {
    const r = cloneBoundingBox(boundsPx())!;
    r.w = oneBlockWidthPx();
    return r;
  };
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;

  const infuTextStyle = () => getTextStyleForNote(noteItem().flags);

  const eatMouseEvent = (ev: MouseEvent) => { ev.stopPropagation(); }

  const copyClickHandler = () => {
    if (noteItem().url == "") {
      navigator.clipboard.writeText(noteItem().title);
    } else {
      navigator.clipboard.writeText("[" + noteItem().title + "](" + noteItem().url + ")");
    }
  }

  // Link click events are handled in the global mouse up handler. However, calculating the text
  // hitbox is difficult, so this hook is here to enable the browser to conveniently do it for us.
  const aHrefMouseDown = (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) { ClickState.setLinkWasClicked(noteItem().url != null && noteItem().url != ""); }
    ev.preventDefault();
  };
  const aHrefClick = (ev: MouseEvent) => { ev.preventDefault(); };
  const aHrefMouseUp = (ev: MouseEvent) => { ev.preventDefault(); };

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={props.visualElement.flags & VisualElementFlags.FindHighlighted}>
        <div class="absolute pointer-events-none"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
            `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `background-color: ${FIND_HIGHLIGHT_COLOR}; ` +
            `z-index: ${Z_INDEX_HIGHLIGHT};`} />
      </Match>
      <Match when={store.perVe.getMouseIsOverOpenPopup(vePath())}>
        <div class="absolute border border-slate-300 rounded-xs pointer-events-none"
          style={`left: ${openPopupBoundsPx().x + 2}px; top: ${openPopupBoundsPx().y + 2}px; ` +
            `width: ${openPopupBoundsPx().w - 4}px; height: ${openPopupBoundsPx().h - 4}px;` +
            `z-index: ${Z_INDEX_ITEMS_OVERLAY}; ` +
            `background-color: #0044ff0a;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-xs"
            style={`left: ${lineHighlightBoundsPx()!.x + 2}px; top: ${lineHighlightBoundsPx()!.y + 2}px; ` +
              `width: ${lineHighlightBoundsPx()!.w - 4}px; height: ${lineHighlightBoundsPx()!.h - 4}px;`} />
        </Show>
      </Match>
      <Match when={!store.perVe.getMouseIsOverOpenPopup(vePath()) && store.perVe.getMouseIsOver(vePath())}>
        <div class="absolute border border-slate-300 rounded-xs pointer-events-none"
          style={`left: ${highlightBoundsPx().x + 2}px; top: ${highlightBoundsPx().y + 2}px; ` +
            `width: ${highlightBoundsPx().w - 4}px; height: ${highlightBoundsPx().h - 4}px;` +
            `z-index: ${Z_INDEX_ITEMS_OVERLAY}; ` +
            `background-color: #0044ff0a;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-xs"
            style={`left: ${lineHighlightBoundsPx()!.x + 2}px; top: ${lineHighlightBoundsPx()!.y + 2}px; ` +
              `width: ${lineHighlightBoundsPx()!.w - 4}px; height: ${lineHighlightBoundsPx()!.h - 4}px;`} />
        </Show>
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
          style={`left: ${boundsPx().x + 1}px; top: ${boundsPx().y}px; width: ${boundsPx().w - 3}px; height: ${boundsPx().h}px; ` +
            `background-color: ${props.visualElement.flags & VisualElementFlags.FocusPageSelected ? SELECTED_DARK : SELECTED_LIGHT};`} />
      </Match>
    </Switch>;

  const renderIconMaybe = () =>
    <Show when={!shouldHideIcon()}>
      <div class="absolute text-center"
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
          `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h / scale()}px; ` +
          `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-sticky-note`} />
      </div>
    </Show>;

  const inputListener = (_ev: InputEvent) => {
    // fullArrange is not required in the line item case, because the ve geometry does not change.
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "Enter":
        ev.preventDefault();
        ev.stopPropagation();
        return;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        store.overlay.setTextEditInfo(store.history, null, true);
        return;
    }
  }

  const renderText = () =>
    <div class={`absolute overflow-hidden whitespace-nowrap ` +
      ((store.overlay.textEditInfo() != null && store.overlay.textEditInfo()?.itemPath == vePath()) || isInCalendarPage() ? '' : `text-ellipsis `) +
      `${infuTextStyle().alignClass} `}
      style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
        `width: ${widthPx() / scale()}px; height: ${boundsPx().h / scale()}px; ` +
        `transform: scale(${scale()}); transform-origin: top left; padding-right: 2px;`}>
      <Switch>
        <Match when={NoteFns.hasUrl(noteItem()) &&
          (store.overlay.textEditInfo() == null || store.overlay.textEditInfo()!.itemPath != vePath())}>
          <a id={VeFns.veToPath(props.visualElement) + ":title"}
            href={noteItem().url}
            class={`text-blue-800 ${infuTextStyle().isCode ? 'font-mono' : ''}`}
            style={`-webkit-user-drag: none; -khtml-user-drag: none; -moz-user-drag: none; -o-user-drag: none; user-drag: none; ` +
              `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; `}
            onClick={aHrefClick}
            onMouseDown={aHrefMouseDown}
            onMouseUp={aHrefMouseUp}>
            {NoteFns.noteFormatMaybe(noteItem().title, noteItem().format)}
          </a>
        </Match>
        <Match when={store.overlay.textEditInfo() != null && store.overlay.textEditInfo()!.itemPath == vePath()}>
          {/* when editing, don't apply text formatting. */}
          <span id={VeFns.veToPath(props.visualElement) + ":title"}
            class={`${infuTextStyle().isCode ? 'font-mono' : ''}`}
            style={`${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; ` +
              `outline: 0px solid transparent;`}
            contentEditable={store.overlay.textEditInfo() != null ? true : undefined}
            spellcheck={store.overlay.textEditInfo() != null}
            onKeyDown={keyDownHandler}
            onInput={inputListener}>
            {appendNewlineIfEmpty(noteItem().title)}<span></span>
          </span>
        </Match>
        <Match when={!NoteFns.hasUrl(noteItem()) || store.overlay.textEditInfo() != null}>
          <span id={VeFns.veToPath(props.visualElement) + ":title"}
            class={`${infuTextStyle().isCode ? 'font-mono' : ''}`}
            style={`${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; ` +
              `outline: 0px solid transparent;`}
            contentEditable={store.overlay.textEditInfo() != null ? true : undefined}
            spellcheck={store.overlay.textEditInfo() != null}
            onKeyDown={keyDownHandler}
            onInput={inputListener}>
            {appendNewlineIfEmpty(NoteFns.noteFormatMaybe(noteItem().title, noteItem().format))}<span></span>
          </span>
        </Match>
      </Switch>
    </div>;

  const renderCopyIconMaybe = () =>
    <Show when={showCopyIcon()}>
      <div class="absolute text-center text-slate-600"
        style={`left: ${boundsPx().x + boundsPx().w - 1 * oneBlockWidthPx()}px; top: ${boundsPx().y + boundsPx().h * PADDING_PROP}px; ` +
          `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h / smallScale()}px; ` +
          `transform: scale(${smallScale()}); transform-origin: top left;`}
        onmousedown={eatMouseEvent}
        onmouseup={eatMouseEvent}
        onclick={copyClickHandler}>
        <i class={`fas fa-copy cursor-pointer`} />
      </div>
    </Show>;

  const renderLinkMarkingMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
      showTriangleDetail()}>
      <div class="absolute text-center text-slate-600"
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
          `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h / scale()}px; ` +
          `transform: scale(${scale()}); transform-origin: top left;`}>
        <InfuLinkTriangle />
      </div>
    </Show>

  return (
    <>
      {renderHighlightsMaybe()}
      {renderIconMaybe()}
      {renderText()}
      {renderCopyIconMaybe()}
      {renderLinkMarkingMaybe()}
    </>
  );
}
