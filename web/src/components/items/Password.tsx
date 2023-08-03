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

import { Component, createMemo, For, onMount, Show } from "solid-js";
import { ATTACH_AREA_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../../constants";
import { VisualElement_Desktop, VisualElementProps_Desktop, VisualElementProps_LineItem } from "../VisualElement";
import { BoundingBox } from "../../util/geometry";
import { calcSizeForSpatialBl } from "../../items/base/item-polymorphism";
import { attachmentFlagSet, detailedFlagSet } from "../../layout/visual-element";
import { asPasswordItem, calcPasswordSizeForSpatialBl } from "../../items/password-item";
import { createBooleanSignal } from "../../util/signals";


export const Password: Component<VisualElementProps_Desktop> = (props: VisualElementProps_Desktop) => {
  const passwordItem = () => asPasswordItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const sizeBl = createMemo(() => {
    if (props.visualElement.linkItemMaybe != null) {
      return calcSizeForSpatialBl(props.visualElement.linkItemMaybe!);
    }
    return calcPasswordSizeForSpatialBl(passwordItem());
  });
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => boundsPx().w / naturalWidthPx();
  const heightScale = () => boundsPx().h / naturalHeightPx();
  const scale = () => Math.min(heightScale(), widthScale());
  const showText = () => false;

  const copyClickHandler = () => {
    navigator.clipboard.writeText(passwordItem().text);
  }

  return (
    <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
      <Show when={detailedFlagSet(props.visualElement)}>
        <div class="absolute overflow-hidden whitespace-nowrap"
             style={`left: 0px; top: ${-LINE_HEIGHT_PX/4 * scale()}px; width: ${naturalWidthPx()}px; ` +
                    `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${scale()}); transform-origin: top left; ` +
                    `overflow-wrap: break-word; padding: ${NOTE_PADDING_PX}px;`}>
          <Show when={showText()} fallback={
            <span class="text-purple-800">••••••••</span>
          }>
            <span class="text-purple-800">{passwordItem().text}</span>
          </Show>
        </div>
        <div class="absolute text-center text-slate-400"
             style={`left: ${boundsPx().w - (boundsPx().w/sizeBl().w)*1.2}px; top: ${0}px; ` +
                    `width: ${boundsPx().w/sizeBl().w}px; height: ${boundsPx().h}px;`}>
          <i class={`fas fa-eye-slash`}
              style={`transform: scale(${scale()}); transform-origin: top left;`} />
        </div>
        <div class="absolute text-center text-slate-400 cursor-pointer"
             style={`left: ${boundsPx().w - 2.2*(boundsPx().w/sizeBl().w)}px; top: ${0}px; ` +
                    `width: ${boundsPx().w/sizeBl().w}px; height: ${boundsPx().h}px;`}
             onclick={copyClickHandler}>
          <i class={`fas fa-copy`}
             style={`transform: scale(${scale()}); transform-origin: top left;`} />
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
      </Show>
    </div>
  );
}


export const PasswordLineItem: Component<VisualElementProps_LineItem> = (props: VisualElementProps_LineItem) => {
  const passwordItem = () => asPasswordItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.oneBlockWidthPx!;
  const leftPx = () => attachmentFlagSet(props.visualElement)
    ? boundsPx().x
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => attachmentFlagSet(props.visualElement)
    ? boundsPx().w - 1.9 * oneBlockWidthPx()
    : boundsPx().w - 2.9 * oneBlockWidthPx();

  const copyClickHandler = () => {
    navigator.clipboard.writeText(passwordItem().text);
  }

  const isVisible = createBooleanSignal(false);
  const VisibleClickHandler = () => {
    isVisible.set(!isVisible.get());
  }


  return (
    <>
      <Show when={!attachmentFlagSet(props.visualElement)}>
        <div class="absolute text-center"
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                    `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                    `transform: scale(${scale()}); transform-origin: top left;`}>
          <i class={`fas fa-eye-slash`} />
        </div>
      </Show>
      <div class="absolute overflow-hidden whitespace-nowrap"
           style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <Show when={isVisible.get()} fallback={
          <span class="text-slate-800" style={`margin-left: ${oneBlockWidthPx()*0.15}px`}>••••••••••••</span>
        }>
          <span class="text-slate-800" style={`margin-left: ${oneBlockWidthPx()*0.15}px`}>{passwordItem().text}</span>
        </Show>
      </div>
      <div class="absolute text-center text-slate-600"
           style={`left: ${boundsPx().x+boundsPx().w - oneBlockWidthPx()*1.05}px; top: ${boundsPx().y + boundsPx().h*0.15}px; ` +
                  `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h/smallScale()}px; `+
                  `transform: scale(${smallScale()}); transform-origin: top left;`}
           onclick={VisibleClickHandler}>
        <i class={`fas ${isVisible.get() ? 'fa-eye-slash' : 'fa-eye'} cursor-pointer`} />
      </div>
      <div class="absolute text-center text-slate-600"
           style={`left: ${boundsPx().x+boundsPx().w - 1.8*oneBlockWidthPx()}px; top: ${boundsPx().y + boundsPx().h*0.15}px; ` +
                  `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h/smallScale()}px; `+
                  `transform: scale(${smallScale()}); transform-origin: top left;`}
           onclick={copyClickHandler}>
        <i class={`fas fa-copy cursor-pointer`} />
      </div>
    </>
  );
}
