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
import { VisualElementProps, VisualElement_Desktop } from "../VisualElement";
import { ATTACH_AREA_SIZE_PX, LINE_HEIGHT_PX } from "../../constants";
import { BoundingBox } from "../../util/geometry";
import { asCompositeItem } from "../../items/composite-item";
import { itemState } from "../../store/ItemState";
import { asTitledItem, isTitledItem } from "../../items/base/titled-item";
import { CompositeFlags } from "../../items/base/flags-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";


export const Composite_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const boundsPx = () => props.visualElement.boundsPx;

  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w / 4.0,
      y: boundsPx().h - ATTACH_AREA_SIZE_PX,
      w: boundsPx().w / 2.0,
      h: ATTACH_AREA_SIZE_PX,
    }
  };

  const showBorder = () => !(asCompositeItem(props.visualElement.displayItem).flags & CompositeFlags.HideBorder);

  return (
    <div class={`absolute border ` +
                `${showBorder() ? "border-slate-700" : "border-transparent"} ` +
                `rounded-sm ` +
                `${showBorder() ? "shadow-lg " : ""}` +
                `bg-white overflow-hidden`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)} ` +
                `${!(props.visualElement.flags & VisualElementFlags.Detailed) ? "background-color: #eee;" : ""}`}>
      <For each={props.visualElement.children}>{childVe =>
        <VisualElement_Desktop visualElement={childVe.get()} />
      }</For>
      <Show when={props.visualElement.movingItemIsOverAttachComposite.get()}>
        <div class={`absolute rounded-sm`}
              style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; ` +
                     `background-color: #ff0000;`} />
      </Show>
      <Show when={props.visualElement.linkItemMaybe != null}>
        <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`} />
      </Show>
    </div>
  );
};


export const Composite_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const compositeItem = () => asCompositeItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.oneBlockWidthPx!;
  const leftPx = () => boundsPx().x + oneBlockWidthPx();
  const widthPx = () => boundsPx().w - oneBlockWidthPx();
  const titleText = () => {
    if (compositeItem().computed_children.length == 0) {
      return "[empty]";
    }
    const topItem = itemState.get(compositeItem().computed_children[0])!
    if (isTitledItem(topItem)) {
      return asTitledItem(topItem).title + "...";
    }
    return "[no title]";
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

  const renderIcon = () =>
    <div class="absolute text-center"
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <i class={`fas fa-object-group`} />
    </div>;

  const renderText = () =>
    <div class="absolute overflow-hidden whitespace-nowrap text-ellipsis"
         style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
                `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <span>{titleText()}</span>
    </div>;

  return (
    <>
      {renderHighlightsMaybe()}
      {renderIcon()}
      {renderText()}
    </>
  )
}
