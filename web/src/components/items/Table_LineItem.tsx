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
import { asTableItem } from "../../items/table-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";
import { LINE_HEIGHT_PX, PADDING_PROP } from "../../constants";
import { cloneBoundingBox } from "../../util/geometry";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { SELECTED_DARK, SELECTED_LIGHT } from "../../style";


export const Table_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const tableItem = () => asTableItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const openPopupBoundsPx = () => {
    const r = cloneBoundingBox(boundsPx())!;
    r.w = oneBlockWidthPx();
    return r;
  };
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={store.perVe.getMouseIsOverOpenPopup(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${openPopupBoundsPx().x+2}px; top: ${openPopupBoundsPx().y+2}px; width: ${openPopupBoundsPx().w-4}px; height: ${openPopupBoundsPx().h-4}px;`} />
      </Match>
      <Match when={!store.perVe.getMouseIsOverOpenPopup(vePath()) && store.perVe.getMouseIsOver(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${highlightBoundsPx().x+2}px; top: ${highlightBoundsPx().y+2}px; width: ${highlightBoundsPx().w-4}px; height: ${highlightBoundsPx().h-4}px;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-sm"
               style={`left: ${lineHighlightBoundsPx()!.x+2}px; top: ${lineHighlightBoundsPx()!.y+2}px; width: ${lineHighlightBoundsPx()!.w-4}px; height: ${lineHighlightBoundsPx()!.h-4}px;`} />
        </Show>
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-3}px; height: ${boundsPx().h}px; ` +
                    `background-color: ${props.visualElement.flags & VisualElementFlags.FocusPageSelected ? SELECTED_DARK : SELECTED_LIGHT};`} />
      </Match>
    </Switch>;

  const renderIcon = () =>
    <div class="absolute text-center"
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <i class={`fas fa-table`} />
    </div>;

  const renderExpandIcon = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment) && (props.visualElement.flags & VisualElementFlags.InsideTable)}>
      <div class="absolute text-center text-slate-400"
           style={`left: ${boundsPx().x+boundsPx().w - oneBlockWidthPx()*0.85}px; top: ${boundsPx().y + boundsPx().h*PADDING_PROP}px; ` +
                  `width: ${oneBlockWidthPx() / smallScale() * 0.8}px; height: ${boundsPx().h / smallScale() * 0.8}px; `+
                  `transform: scale(${smallScale()}); transform-origin: top left;`}>
        <i class={`fas ${store.perVe.getIsExpanded(vePath()) ? 'fa-minus' : 'fa-plus'}`} />
      </div>
    </Show>;

  const renderText = () =>
    <div class="absolute overflow-hidden"
         style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <span>{tableItem().title}<span></span></span>
    </div>;

  const renderLinkMarkingMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
                showTriangleDetail()}>
      <div class="absolute text-center text-slate-600"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <InfuLinkTriangle />
      </div>
    </Show>;

  return (
    <>
      {renderHighlightsMaybe()}
      {renderIcon()}
      {renderText()}
      {renderExpandIcon()}
      {renderLinkMarkingMaybe()}
    </>
  );
}
