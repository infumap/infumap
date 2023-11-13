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
import { ATTACH_AREA_SIZE_PX, FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../../constants";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { BoundingBox } from "../../util/geometry";
import { ItemFns } from "../../items/base/item-polymorphism";
import { PasswordFns, asPasswordItem } from "../../items/password-item";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/item";


export const Password: Component<VisualElementProps> = (props: VisualElementProps) => {
  const desktopStore = useDesktopStore();

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
  const sizeBl = () => {
    if (props.visualElement.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(props.visualElement.linkItemMaybe!);
    }
    return PasswordFns.calcSpatialDimensionsBl(passwordItem());
  };
  const oneBlockWidthPx = () => boundsPx().w / sizeBl().w;
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX*2;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (boundsPx().w - NOTE_PADDING_PX*2) / naturalWidthPx();
  const heightScale = () => (boundsPx().h - NOTE_PADDING_PX*2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();
  const smallScale = () => textBlockScale() * 0.7;

  const copyClickHandler = () => {
    navigator.clipboard.writeText(passwordItem().text);
  }

  const isVisible = () => desktopStore.currentVisiblePassword.get() == passwordItem().id;
  const VisibleClickHandler = () => {
    if (!isVisible()) {
      desktopStore.currentVisiblePassword.set(passwordItem().id);
    } else {
      desktopStore.currentVisiblePassword.set(null);
    }
  }

  return (
    <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
      <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
        <div style={`position: absolute; ` + 
                    `left: ${NOTE_PADDING_PX*textBlockScale()}px; ` +
                    `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4)*textBlockScale()}px; ` +
                    `width: ${naturalWidthPx()}px; ` +
                    `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; ` +
                    `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                    `overflow-wrap: break-word; white-space: pre-wrap;`}>
          <Show when={isVisible()} fallback={
            <span class="text-slate-800" style={`margin-left: ${oneBlockWidthPx()*0.15}px`}>••••••••••••</span>
          }>
            <span class="text-slate-800" style={`margin-left: ${oneBlockWidthPx()*0.15}px`}>{passwordItem().text}</span>
          </Show>
        </div>
        <div class="absolute text-center text-slate-600"
             style={`left: ${boundsPx().w - oneBlockWidthPx()*1.05}px; ` +
                    `top: ${boundsPx().h*0.15}px; ` +
                    `width: ${oneBlockWidthPx() / smallScale()}px; ` +
                    `height: ${boundsPx().h/smallScale()}px; `+
                    `transform: scale(${smallScale()}); transform-origin: top left;`}
             onclick={copyClickHandler}>
          <i class={`fas fa-copy cursor-pointer`} />
        </div>
        <div class="absolute text-center text-slate-600"
             style={`left: ${boundsPx().w - oneBlockWidthPx()*1.8}px; top: ${boundsPx().h*0.15}px; ` +
                    `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h/smallScale()}px; `+
                    `transform: scale(${smallScale()}); transform-origin: top left;`}
             onclick={VisibleClickHandler}>
          <i class={`fas ${isVisible() ? 'fa-eye-slash' : 'fa-eye'} cursor-pointer`} />
        </div>
        <For each={props.visualElement.attachments}>{attachment =>
          <VisualElement_Desktop visualElement={attachment.get()} />
        }</For>
        <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
          <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`} />
        </Show>
        <Show when={props.visualElement.movingItemIsOverAttach.get()}>
          <div class={`absolute rounded-sm`}
               style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                      `background-color: #ff0000;`} />
        </Show>
      </Show>
    </div>
  );
}


export const PasswordLineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const desktopStore = useDesktopStore();

  const passwordItem = () => asPasswordItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const leftPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().x
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().w - 1.9 * oneBlockWidthPx()
    : boundsPx().w - 2.9 * oneBlockWidthPx();

  const copyClickHandler = () => {
    navigator.clipboard.writeText(passwordItem().text);
  }

  const isVisible = () => desktopStore.currentVisiblePassword.get() == passwordItem().id;
  const VisibleClickHandler = () => {
    if (!isVisible()) {
      desktopStore.currentVisiblePassword.set(passwordItem().id);
    } else {
      desktopStore.currentVisiblePassword.set(null);
    }
  }

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={!props.visualElement.mouseIsOverOpenPopup.get() && props.visualElement.mouseIsOver.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${boundsPx().x+2}px; top: ${boundsPx().y+2}px; width: ${boundsPx().w-4}px; height: ${boundsPx().h-4}px;`} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; ` +
                    `background-color: #dddddd88;`} />
      </Match>
    </Switch>;

  const renderIconMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment)}>
      <div class="absolute text-center"
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-eye-slash`} />
      </div>
    </Show>;

  const renderText = () =>
    <div class="absolute overflow-hidden whitespace-nowrap"
         style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
                `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <Show when={isVisible()} fallback={
        <span class="text-slate-800" style={`margin-left: ${oneBlockWidthPx()*0.15}px`}>••••••••••••</span>
      }>
        <span class="text-slate-800" style={`margin-left: ${oneBlockWidthPx()*0.15}px`}>{passwordItem().text}</span>
      </Show>
    </div>;

  const renderCopyIcon = () =>
    <div class="absolute text-center text-slate-600"
         style={`left: ${boundsPx().x+boundsPx().w - oneBlockWidthPx()*1.05}px; top: ${boundsPx().y + boundsPx().h*0.15}px; ` +
                `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h/smallScale()}px; `+
                `transform: scale(${smallScale()}); transform-origin: top left;`}
         onclick={copyClickHandler}>
      <i class={`fas fa-copy cursor-pointer`} />
    </div>;

  const renderShowIcon = () =>
    <div class="absolute text-center text-slate-600"
         style={`left: ${boundsPx().x+boundsPx().w - oneBlockWidthPx()*1.8}px; top: ${boundsPx().y + boundsPx().h*0.15}px; ` +
                `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h/smallScale()}px; `+
                `transform: scale(${smallScale()}); transform-origin: top left;`}
         onclick={VisibleClickHandler}>
      <i class={`fas ${isVisible() ? 'fa-eye-slash' : 'fa-eye'} cursor-pointer`} />
    </div>;

  return (
    <>
      {renderHighlightsMaybe()}
      {renderIconMaybe()}
      {renderText()}
      {renderCopyIcon()}
      {renderShowIcon()}
    </>
  );
}
