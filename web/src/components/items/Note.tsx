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

import { Component, For, Match, Show, Switch } from "solid-js";
import { NoteFns, asNoteItem } from "../../items/note-item";
import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_SHADOW } from "../../constants";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { BoundingBox } from "../../util/geometry";
import { ItemFns } from "../../items/base/item-polymorphism";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { NoteFlags } from "../../items/base/flags-item";
import { VesCache } from "../../layout/ves-cache";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { getTextStyleForNote } from "../../layout/text";
import { useStore } from "../../store/StoreProvider";
import { isComposite } from "../../items/composite-item";
import { ClickState } from "../../input/state";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { isNumeric } from "../../util/math";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/item";


export const Note_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const noteItem = () => asNoteItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const sizeBl = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideComposite) {
      const cloned = NoteFns.asNoteMeasurable(ItemFns.cloneMeasurableFields(props.visualElement.displayItem));
      const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath!);
      const parentVe = VesCache.find(parentVeid)[0].get();
      cloned.spatialWidthGr = asXSizableItem(VeFns.canonicalItem(parentVe)).spatialWidthGr;
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }
    if (props.visualElement.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(props.visualElement.linkItemMaybe!);
    }
    return NoteFns.calcSpatialDimensionsBl(noteItem());
  };
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX*2;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (boundsPx().w - NOTE_PADDING_PX*2) / naturalWidthPx();
  const heightScale = () => (boundsPx().h - NOTE_PADDING_PX*2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();

  const attachBoundsPx = (): BoundingBox => {
    return ({
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    });
  };
  const attachCompositeBoundsPx = (): BoundingBox => {
    return ({
      x: boundsPx().w / 4.0,
      y: boundsPx().h - ATTACH_AREA_SIZE_PX,
      w: boundsPx().w / 2.0,
      h: ATTACH_AREA_SIZE_PX,
    });
  };
  const moveOutOfCompositeBox = (): BoundingBox => {
    return ({
      x: boundsPx().w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    });
  };

  const outerClass = (shadow: boolean) => {
    if (props.visualElement.flags & VisualElementFlags.InsideComposite) {
      return 'absolute rounded-sm bg-white';
    } else {
      if ((noteItem().flags & NoteFlags.HideBorder)) {
        if (props.visualElement.mouseIsOver.get()) {
          return `absolute border border-slate-700 rounded-sm ${shadow ? "shadow-lg" : ""}`;
        } else {
          return 'absolute border border-transparent rounded-sm';
        }
      }
      return `absolute border border-slate-700 rounded-sm ${shadow ? "shadow-lg" : ""} bg-white`;
    }
  };

  // Link click events are handled in the global mouse up handler. However, calculating the text
  // hitbox is difficult, so this hook is here to enable the browser to conveniently do it for us.
  const aHrefMouseDown = (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) { ClickState.setLinkWasClicked(noteItem().url != null && noteItem().url != ""); }
    ev.preventDefault();
  };
  const aHrefClick = (ev: MouseEvent) => { ev.preventDefault(); };
  const aHrefMouseUp = (ev: MouseEvent) => { ev.preventDefault(); };

  const infuTextStyle = () => getTextStyleForNote(noteItem().flags);

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    props.visualElement.mouseIsOver.get() &&
    !store.itemIsMoving.get() &&
    store.overlay.noteEditOverlayInfo.get() == null &&
    isComposite(VesCache.get(props.visualElement.parentPath!)!.get().displayItem);

  const renderShadow = () =>
    <div class={`${outerClass(true)}`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />;

  const renderDetailed = () =>
    <>
      <div class={`${infuTextStyle().isCode ? ' font-mono' : ''} ${infuTextStyle().alignClass}`}
           style={`position: absolute; ` +
                  `left: ${NOTE_PADDING_PX*textBlockScale()}px; ` +
                  `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4)*textBlockScale()}px; ` +
                  `width: ${naturalWidthPx()}px; ` +
                  `line-height: ${LINE_HEIGHT_PX * lineHeightScale() * infuTextStyle().lineHeightMultiplier}px; `+
                  `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                  `font-size: ${infuTextStyle().fontSize}px; ` +
                  `overflow-wrap: break-word; white-space: pre-wrap; ` +
                  `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; `}>
        <Switch>
          <Match when={noteItem().url != null && noteItem().url != "" && noteItem().title != ""}>
            <a href={""}
                class={`text-blue-800`}
                style={`-webkit-user-drag: none; -khtml-user-drag: none; -moz-user-drag: none; -o-user-drag: none; user-drag: none;`}
                onClick={aHrefClick}
                onMouseDown={aHrefMouseDown}
                onMouseUp={aHrefMouseUp}>
                {formatMaybe(props.visualElement.evaluatedTitle != null ? props.visualElement.evaluatedTitle : noteItem().title, noteItem().format)}
            </a>
          </Match>
          <Match when={noteItem().url == null || noteItem().url == "" || noteItem().title == ""}>
            <span>{formatMaybe(props.visualElement.evaluatedTitle != null ? props.visualElement.evaluatedTitle : noteItem().title, noteItem().format)}</span>
          </Match>
        </Switch>
      </div>
      <For each={props.visualElement.attachments}>{attachment =>
        <VisualElement_Desktop visualElement={attachment.get()} />
      }</For>
      <Show when={showMoveOutOfCompositeArea()}>
        <div class={`absolute rounded-sm`}
            style={`left: ${moveOutOfCompositeBox().x}px; top: ${moveOutOfCompositeBox().y}px; width: ${moveOutOfCompositeBox().w}px; height: ${moveOutOfCompositeBox().h}px; ` +
                    `background-color: #ff0000;`} />
      </Show>
      <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
        <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`} />
      </Show>
      <Show when={props.visualElement.movingItemIsOverAttach.get()}>
        <div class={`absolute rounded-sm`}
            style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                    `background-color: #ff0000;`} />
      </Show>
      <Show when={props.visualElement.movingItemIsOverAttachComposite.get()}>
        <div class={`absolute rounded-sm`}
            style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; ` +
                    `background-color: #ff0000;`} />
      </Show>
    </>;

  return (
    <>
      {renderShadow()}
      <div class={`${outerClass(false)}`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `${VeFns.zIndexStyle(props.visualElement)}; ${VeFns.opacityStyle(props.visualElement)}; ` +
                  `${!(props.visualElement.flags & VisualElementFlags.Detailed) ? 'background-color: #ddd; ' : ''}`}>
        <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
          {renderDetailed()}
        </Show>
      </div>
    </>
  );
}


export const Note_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const noteItem = () => asNoteItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const showCopyIcon = () => (noteItem().flags & NoteFlags.ShowCopyIcon);
  const leftPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().x + oneBlockWidthPx() * 0.15
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().w - oneBlockWidthPx() * 0.15 - (showCopyIcon() ? oneBlockWidthPx() * 0.9 : 0)
    : boundsPx().w - oneBlockWidthPx() - (showCopyIcon() ? oneBlockWidthPx() * 0.9 : 0);

  const infuTextStyle = () => getTextStyleForNote(noteItem().flags);

  const copyMouseDownHandler = (ev: MouseEvent) => { ev.stopPropagation(); }
  const copyMouseUpHandler = (ev: MouseEvent) => { ev.stopPropagation(); }
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
      <Match when={!props.visualElement.mouseIsOverOpenPopup.get() && props.visualElement.mouseIsOver.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${boundsPx().x+2}px; top: ${boundsPx().y+2}px; width: ${boundsPx().w-4}px; height: ${boundsPx().h-4}px;`} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; background-color: #dddddd88;`} />
      </Match>
    </Switch>;

  const renderIconMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment)}>
      <div class="absolute text-center"
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-sticky-note`} />
      </div>
    </Show>;

  const renderText = () =>
    <div class={`absolute overflow-hidden whitespace-nowrap text-ellipsis ` +
                `${infuTextStyle().alignClass} `}
         style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
                `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <Switch>
        <Match when={noteItem().url != null && noteItem().url != "" && noteItem().title != ""}>
          <a href={""}
             class={`text-blue-800 ${infuTextStyle().isCode ? 'font-mono' : ''}`}
             style={`-webkit-user-drag: none; -khtml-user-drag: none; -moz-user-drag: none; -o-user-drag: none; user-drag: none; ` +
                    `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; `}
             onClick={aHrefClick}
             onMouseDown={aHrefMouseDown}
             onMouseUp={aHrefMouseUp}>
            {formatMaybe(props.visualElement.evaluatedTitle != null ? props.visualElement.evaluatedTitle : noteItem().title, noteItem().format)}
          </a>
        </Match>
        <Match when={noteItem().url == null || noteItem().url == "" || noteItem().title == ""}>
          <span class={`${infuTextStyle().isCode ? 'font-mono' : ''}`}
                style={`${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; `}>
            {formatMaybe(props.visualElement.evaluatedTitle != null ? props.visualElement.evaluatedTitle : noteItem().title, noteItem().format)}
          </span>
        </Match>
      </Switch>
    </div>;

  const renderCopyIconMaybe = () =>
    <Show when={showCopyIcon()}>
      <div class="absolute text-center text-slate-600"
           style={`left: ${boundsPx().x+boundsPx().w - 1*oneBlockWidthPx()}px; top: ${boundsPx().y + boundsPx().h*0.15}px; ` +
                  `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h/smallScale()}px; `+
                  `transform: scale(${smallScale()}); transform-origin: top left;`}
          onmousedown={copyMouseDownHandler}
          onmouseup={copyMouseUpHandler}
          onclick={copyClickHandler}>
        <i class={`fas fa-copy cursor-pointer`} />
      </div>
    </Show>;

  return (
    <>
      {renderHighlightsMaybe()}
      {renderIconMaybe()}
      {renderText()}
      {renderCopyIconMaybe()}
    </>
  );
}


// TODO (HIGH): something not naive.
function formatMaybe(text: string, format: string): string {
  if (format == "") { return text; }
  if (!isNumeric(text)) { return text; }
  if (format == "0.0") { return parseFloat(text).toFixed(1); }
  if (format == "0.00") { return parseFloat(text).toFixed(2); }
  if (format == "0.000") { return parseFloat(text).toFixed(3); }
  if (format == "0.0000") { return parseFloat(text).toFixed(4); }
  return text;
}
