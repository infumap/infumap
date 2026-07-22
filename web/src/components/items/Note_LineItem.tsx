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
import { itemCanEdit } from "../../items/base/capabilities-item";
import { NoteFlags } from "../../items/base/flags-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn, handleLineItemTitleKeyDown, lineItemTextClippedWidthCssPx, shouldShowFocusRingForVisualElement } from "./helper";
import { LINE_HEIGHT_PX, PADDING_PROP, Z_INDEX_LOCAL_OVERLAY, Z_INDEX_LOCAL_HIGHLIGHT } from "../../constants";
import { cloneBoundingBox } from "../../util/geometry";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { SELECTED_DARK, SELECTED_LIGHT, FIND_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW } from "../../style";
import {
  getTextStyleForNote,
  noteHasListMarker,
  noteHasNumbered,
  noteListMarkerFontSizePx,
  noteListMarkerLeftPx,
  noteListMarkerText,
  noteListTextInsetPx,
  noteTextBlockPaddingLeftPx,
} from "../../layout/text";
import { isPage, asPageItem, ArrangeAlgorithm } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { NoteIconGlyph } from "./NoteIconGlyph";
import { ItemIconRenderContext } from "../../items/base/icon-item";
import { NoteInlineText } from "./NoteInlineText";
import { edit_beforeInputHandler, edit_inputListener } from "../../input/edit";


export const Note_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const noteItem = () => asNoteItem(props.visualElement.displayItem);
  const canEdit = () => itemCanEdit(noteItem());
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx?.w ?? 0;
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

  const iconContext = () => isInCalendarPage()
    ? ItemIconRenderContext.TableAttachment
    : NoteFns.iconRenderContextFromVisualElement(props.visualElement);
  const shouldRenderIcon = () => NoteFns.showsIcon(noteItem(), iconContext());
  const shouldShowLinkMarking = () => props.visualElement.linkItemMaybe != null &&
    (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
    showTriangleDetail();
  const shouldReserveLeadingBlock = () => shouldRenderIcon() || (shouldShowLinkMarking() && !isInCalendarPage());

  const leftPx = () => shouldReserveLeadingBlock()
    ? boundsPx().x + oneBlockWidthPx()
    : boundsPx().x + oneBlockWidthPx() * PADDING_PROP;
  const widthPx = () => shouldReserveLeadingBlock()
    ? boundsPx().w - oneBlockWidthPx() - (showCopyIcon() ? oneBlockWidthPx() * 0.9 : 0)
    : boundsPx().w - oneBlockWidthPx() * PADDING_PROP - (showCopyIcon() ? oneBlockWidthPx() * 0.9 : 0);
  const textWidthPx = () => Math.max(0, widthPx());
  const textPaddingRightCssPx = () => Math.min(2, textWidthPx() / scale());
  const openPopupBoundsPx = () => {
    const r = cloneBoundingBox(boundsPx())!;
    r.w = oneBlockWidthPx();
    return r;
  };
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;

  const infuTextStyle = () => getTextStyleForNote(noteItem().flags);
  const hasListMarker = () => noteHasListMarker(noteItem().flags);
  const listMarkerLeftPx = () => noteListMarkerLeftPx(noteItem().flags);
  const listMarkerText = () => noteListMarkerText(noteItem().flags, props.visualElement.listItemNumber);
  const listMarkerWidthPx = () => noteListTextInsetPx(noteItem().flags);
  const listMarkerFontSizePx = () => noteListMarkerFontSizePx(noteItem().flags, infuTextStyle().fontSize);
  const textPaddingLeftPx = () => noteTextBlockPaddingLeftPx(noteItem().flags);
  const isTextEditTarget = () => store.overlay.textEditInfo()?.itemPath == vePath();
  const renderedTitle = () => noteItem().title;
  const renderedInlineMarks = () => noteItem().inlineMarks;
  const renderedUrls = () => noteItem().urls;

  const eatMouseEvent = (ev: MouseEvent) => { ev.stopPropagation(); }

  const copyClickHandler = () => {
    const url = NoteFns.wholeTitleUrl(noteItem());
    if (url == null) {
      navigator.clipboard.writeText(noteItem().title);
    } else {
      navigator.clipboard.writeText("[" + noteItem().title + "](" + url + ")");
    }
  }

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={props.visualElement.flags & VisualElementFlags.FindHighlighted}>
        <div class="absolute pointer-events-none"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
            `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `background-color: ${FIND_HIGHLIGHT_COLOR}; ` +
            `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
      </Match>
      <Match when={store.perVe.getMouseIsOverOpenPopup(vePath())}>
        <div class="absolute border border-slate-300 rounded-xs pointer-events-none"
          style={`left: ${openPopupBoundsPx().x + 2}px; top: ${openPopupBoundsPx().y + 2}px; ` +
            `width: ${openPopupBoundsPx().w - 4}px; height: ${openPopupBoundsPx().h - 4}px;` +
            `z-index: ${Z_INDEX_LOCAL_OVERLAY}; ` +
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
            `z-index: ${Z_INDEX_LOCAL_OVERLAY}; ` +
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
    <Show when={shouldRenderIcon()}>
      <div class="absolute text-center"
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
          `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h / scale()}px; ` +
          `transform: scale(${scale()}); transform-origin: top left;`}>
        <NoteIconGlyph note={noteItem} iconContext={iconContext} />
      </div>
    </Show>;

  const beforeInputListener = (ev: InputEvent) => {
    edit_beforeInputHandler(store, ev);
  }

  const inputListener = (ev: InputEvent) => {
    ev.stopPropagation();
    edit_inputListener(store, ev);
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    handleLineItemTitleKeyDown(store, ev);
  }

  const renderListMarkerMaybe = () =>
    <Show when={hasListMarker() && (textWidthPx() > 0 || isTextEditTarget())}>
      <div class={`absolute pointer-events-none${infuTextStyle().isCode ? ' font-mono' : ''}`}
        style={`left: ${leftPx() + listMarkerLeftPx()}px; top: ${boundsPx().y}px; ` +
          `width: ${listMarkerWidthPx()}px; height: ${boundsPx().h / scale()}px; ` +
          `box-sizing: border-box; transform: scale(${scale()}); transform-origin: top left; ` +
          `font-size: ${listMarkerFontSizePx()}px; line-height: ${LINE_HEIGHT_PX * infuTextStyle().lineHeightMultiplier}px; ` +
          `${noteHasNumbered(noteItem().flags) ? 'text-align: right; padding-right: 6px; ' : ''}` +
          `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; `}>
        {listMarkerText()}
      </div>
    </Show>;

  const editingTextRenderKey = () => isTextEditTarget()
    ? JSON.stringify([renderedTitle(), renderedInlineMarks(), renderedUrls()])
    : null;

  const renderTitle = (editing: boolean) =>
    <span id={VeFns.veToPath(props.visualElement) + ":title"}
      class={`${infuTextStyle().isCode ? 'font-mono' : ''}`}
      style={`${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; ` +
        `display: inline-block; white-space: pre; outline: 0px solid transparent;`}
      contentEditable={canEdit() && editing ? "plaintext-only" : undefined}
      spellcheck={canEdit() && editing}
      onKeyDown={keyDownHandler}
      onBeforeInput={beforeInputListener}
      onInput={inputListener}>
      <NoteInlineText
        text={renderedTitle()}
        inlineMarks={renderedInlineMarks()}
        urls={renderedUrls()}
        linksEnabled={!editing}
        inactiveLinksStyled={editing} />
    </span>;

  const renderText = () =>
    <>
      {renderListMarkerMaybe()}
      <Show when={textWidthPx() > 0 || isTextEditTarget()}>
        <div class={`absolute overflow-hidden whitespace-nowrap ` +
          (isTextEditTarget() || isInCalendarPage() ? '' : `text-ellipsis `) +
          `${infuTextStyle().alignClass} `}
          style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
            `width: ${lineItemTextClippedWidthCssPx(props.visualElement, textWidthPx(), scale())}px; height: ${boundsPx().h / scale()}px; ` +
            `box-sizing: border-box; transform: scale(${scale()}); transform-origin: top left; ` +
            `padding-left: ${textPaddingLeftPx()}px; padding-right: ${textPaddingRightCssPx()}px;`}>
          <Show keyed when={editingTextRenderKey()} fallback={renderTitle(false)}>
            {(_renderKey) => renderTitle(true)}
          </Show>
        </div>
      </Show>
    </>;

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
    <Show when={shouldShowLinkMarking()}>
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
      <Show when={store.history.getFocusPathMaybe() === vePath() && shouldShowFocusRingForVisualElement(store, () => props.visualElement)}>
        <div class="absolute pointer-events-none"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_OVERLAY};`} />
      </Show>
    </>
  );
}
