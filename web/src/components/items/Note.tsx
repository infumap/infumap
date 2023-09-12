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
import { asNoteItem, asNoteMeasurable, calcNoteSizeForSpatialBl } from "../../items/note-item";
import { ATTACH_AREA_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../../constants";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { BoundingBox } from "../../util/geometry";
import { calcSizeForSpatialBl, cloneMeasurableFields } from "../../items/base/item-polymorphism";
import { VisualElementFlags, attachmentFlagSet, detailedFlagSet, selectedFlagSet } from "../../layout/visual-element";
import { NoteFlags } from "../../items/base/flags-item";
import { VesCache } from "../../layout/ves-cache";
import { asCompositeItem } from "../../items/composite-item";


export const Note_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const noteItem = () => asNoteItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const sizeBl = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideComposite) {
      const cloned = asNoteMeasurable(cloneMeasurableFields(props.visualElement.displayItem));
      cloned.spatialWidthGr = asCompositeItem(VesCache.get(props.visualElement.parentPath!)!.get().displayItem).spatialWidthGr;
      return calcSizeForSpatialBl(cloned);
    }
    if (props.visualElement.linkItemMaybe != null) {
      return calcSizeForSpatialBl(props.visualElement.linkItemMaybe!);
    }
    return calcNoteSizeForSpatialBl(noteItem());
  };
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => boundsPx().w / naturalWidthPx();
  const heightScale = () => boundsPx().h / naturalHeightPx();
  const scale = () => Math.min(heightScale(), widthScale());
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w / 4.0,
      y: boundsPx().h - ATTACH_AREA_SIZE_PX,
      w: boundsPx().w / 2.0,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const outerClass = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideComposite) {
      return 'absolute rounded-sm bg-white';
    } else {
      if ((noteItem().flags & NoteFlags.Heading) == NoteFlags.Heading) {
        if (props.visualElement.mouseIsOver.get()) {
          return 'absolute border border-slate-700 rounded-sm font-bold shadow-lg';
        } else {
          return 'absolute border border-transparent rounded-sm font-bold';
        }
      }
      return 'absolute border border-slate-700 rounded-sm shadow-lg bg-white';
    }
  };
  const shiftTextLeft = () =>
    (noteItem().flags & NoteFlags.Heading) == NoteFlags.Heading && !props.visualElement.mouseIsOver.get();

  return (
    <div class={`${outerClass()}`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
      <Show when={detailedFlagSet(props.visualElement)}>
        <div style={`position: absolute; left: ${shiftTextLeft() ? '-' + NOTE_PADDING_PX : '0'}px; top: ${-LINE_HEIGHT_PX/4 * scale()}px; width: ${naturalWidthPx()}px; ` +
                    `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${scale()}); transform-origin: top left; ` +
                    `overflow-wrap: break-word; padding: ${NOTE_PADDING_PX}px;`}>
          <Show when={noteItem().url != null && noteItem().url != ""}
                fallback={<span>{noteItem().title}</span>}>
            <span class={`text-blue-800 cursor-pointer`}>{noteItem().title}</span>
          </Show>
        </div>
        <For each={props.visualElement.attachments}>{attachment =>
          <VisualElement_Desktop visualElement={attachment.get()} />
        }</For>
        <Show when={props.visualElement.linkItemMaybe != null}>
          <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`}></div>
        </Show>
        <Show when={props.visualElement.movingItemIsOverAttach.get()}>
          <div class={`absolute rounded-sm`}
               style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                      `background-color: #ff0000;`}>
          </div>
        </Show>
        <Show when={props.visualElement.movingItemIsOverAttachComposite.get()}>
          <div class={`absolute rounded-sm`}
               style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; ` +
                      `background-color: #ff0000;`}>
          </div>
        </Show>
      </Show>
    </div>
  );
}


export const Note_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const noteItem = () => asNoteItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.oneBlockWidthPx!;
  const showCopyIcon = () => (noteItem().flags & NoteFlags.ShowCopyIcon) == NoteFlags.ShowCopyIcon;
  const leftPx = () => attachmentFlagSet(props.visualElement)
    ? boundsPx().x + oneBlockWidthPx() * 0.15
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => attachmentFlagSet(props.visualElement)
    ? boundsPx().w - oneBlockWidthPx() * 0.15 - (showCopyIcon() ? oneBlockWidthPx() * 0.9 : 0)
    : boundsPx().w - oneBlockWidthPx() - (showCopyIcon() ? oneBlockWidthPx() * 0.9 : 0);

  const copyClickHandler = () => {
    if (noteItem().url == "") {
      navigator.clipboard.writeText(noteItem().title);
    } else {
      navigator.clipboard.writeText("[" + noteItem().title + "](" + noteItem().url + ")");
    }
  }

  return (
    <>
      <Show when={selectedFlagSet(props.visualElement)}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; background-color: #dddddd88;`}>
        </div>
      </Show>
      <Show when={!props.visualElement.mouseIsOverOpenPopup.get() && props.visualElement.mouseIsOver.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${boundsPx().x+2}px; top: ${boundsPx().y+2}px; width: ${boundsPx().w-4}px; height: ${boundsPx().h-4}px;`}>
        </div>
      </Show>
      <Show when={!attachmentFlagSet(props.visualElement)}>
        <div class="absolute text-center"
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                    `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                    `transform: scale(${scale()}); transform-origin: top left;`}>
          <i class={`fas fa-sticky-note`} />
        </div>
      </Show>
      <div class="absolute overflow-hidden whitespace-nowrap text-ellipsis"
           style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <span class={`${noteItem().url == "" ? "" : "text-blue-800 cursor-pointer"}`}>{noteItem().title}</span>
      </div>
      <Show when={showCopyIcon()}>
        <div class="absolute text-center text-slate-600"
             style={`left: ${boundsPx().x+boundsPx().w - 1*oneBlockWidthPx()}px; top: ${boundsPx().y + boundsPx().h*0.15}px; ` +
                    `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h/smallScale()}px; `+
                    `transform: scale(${smallScale()}); transform-origin: top left;`}
             onclick={copyClickHandler}>
          <i class={`fas fa-copy cursor-pointer`} />
        </div>
      </Show>
    </>
  );
}
