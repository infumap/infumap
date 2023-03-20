/*
  Copyright (C) 2022-2023 The Infumap Authors
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

import { Component, createMemo, For, Show } from "solid-js";
import { asPageItem } from "../../store/desktop/items/page-item";
import { CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_SIZE, LINE_HEIGHT_PX } from "../../constants";
import { hexToRGBA } from "../../util/color";
import { Colors } from "../../style";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { VisualElementOnDesktopFn, VisualElementOnDesktopPropsFn } from "../VisualElementOnDesktop";
import { VisualElementInTableFn, VisualElementInTablePropsFn } from "../VisualElementInTable";
import { asTableItem } from "../../store/desktop/items/table-item";


export const PageFn: Component<VisualElementOnDesktopPropsFn> = (props: VisualElementOnDesktopPropsFn) => {
  const desktopStore = useDesktopStore();
  const pageItem = () => asPageItem(desktopStore.getItem(props.visualElement.itemId)!);
  const boundsPx = props.visualElement.boundsPx;
  const popupClickBoundsPx = () => {
    return ({
      x: boundsPx().w / 3.0,
      y: boundsPx().h / 3.0,
      w: boundsPx().w / 3.0,
      h: boundsPx().h / 3.0,
    })
  }

  const calcOpaqueScale = createMemo((): number => {
    const outerDiv = document.createElement("div");
    outerDiv.setAttribute("class", "flex items-center justify-center");
    outerDiv.setAttribute("style", `width: ${boundsPx().w}px; height: ${boundsPx().h}px;`);
    const innerDiv = document.createElement("div");
    innerDiv.setAttribute("class", "flex items-center text-center text-xs font-bold text-white");
    outerDiv.appendChild(innerDiv);
    const txt = document.createTextNode(pageItem().title);
    innerDiv.appendChild(txt);
    document.body.appendChild(outerDiv);
    let scale = 0.85 / Math.max(innerDiv.offsetWidth / boundsPx().w, innerDiv.offsetHeight / boundsPx().h); // 0.85 -> margin.
    document.body.removeChild(outerDiv);
    return scale > 1.0 ? 1.0 : scale;
  });

  const drawAsOpaque = () => {
    let bg = `background-image: linear-gradient(270deg, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.986)}, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 1.0)});`;
    if (pageItem().computed_mouseIsOver) {
      bg = `background-color: #880088`;
    }
    if (pageItem().computed_movingItemIsOver) {
      bg = `background-color: #880000;`;
    }
    return (
      <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` + bg}>
        <Show when={pageItem().computed_mouseIsOver}>
          <div class={`absolute`} style={`left: ${popupClickBoundsPx().x}px; top: ${popupClickBoundsPx().y}px; width: ${popupClickBoundsPx().w}px; height: ${popupClickBoundsPx().h}px; background-color: #ff00ff`}></div>
        </Show>
        <Show when={props.visualElement.isTopLevel}>
          <div class="flex items-center justify-center" style={`width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
            <div class="flex items-center text-center text-xs font-bold text-white"
                 style={`transform: scale(${calcOpaqueScale()}); transform-origin: center center;`}>
              {pageItem().title}
            </div>
          </div>
        </Show>
        <For each={props.visualElement.attachments()}>{attachmentVe =>
          <VisualElementOnDesktopFn visualElement={attachmentVe} />
        }</For>
      </div>
    );
  }

  const drawAsTopLevelPage = () => {
    return (
      <div class={`absolute`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
        <For each={props.visualElement.children()}>{childVe =>
          <VisualElementOnDesktopFn visualElement={childVe} />
        }</For>
      </div>
    );
  }

  const drawAsTranslucent = () => {
    let bg = `background-image: linear-gradient(270deg, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.386)}, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.364)});`;
    if (pageItem().computed_mouseIsOver) {
      bg = `background-color: #880088`;
    }
    if (pageItem().computed_movingItemIsOver) {
      bg = `background-color: #88000088;`;
    }
    return (
      <>
      <div class={`absolute border border-slate-700 rounded-sm shadow-lg z-5`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` + bg}>
        <Show when={pageItem().computed_mouseIsOver}>
          <div class={`absolute`} style={`left: ${popupClickBoundsPx().x}px; top: ${popupClickBoundsPx().y}px; width: ${popupClickBoundsPx().w}px; height: ${popupClickBoundsPx().h}px; background-color: #ff00ff`}></div>
        </Show>
        <div class="flex items-center justify-center" style={`width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
          <div class="flex items-center text-center text-xl font-bold text-white">
            {pageItem().title}
          </div>
        </div>
      </div>
      <Show when={props.visualElement.childAreaBoundsPx() != null}>
        <div class="absolute"
            style={`left: ${props.visualElement.childAreaBoundsPx()!.x}px; top: ${props.visualElement.childAreaBoundsPx()!.y}px; ` +
                    `width: ${props.visualElement.childAreaBoundsPx()!.w}px; height: ${props.visualElement.childAreaBoundsPx()!.h}px;`}>
          <For each={props.visualElement.children()}>{childVe =>
            <VisualElementOnDesktopFn visualElement={childVe} />
          }</For>
        </div>
      </Show>
      </>
    );
  }

  return (
    <>
      <Show when={pageItem().id == desktopStore.currentPageId()}>
        {drawAsTopLevelPage()}
      </Show>
      <Show when={pageItem().id != desktopStore.currentPageId() && (pageItem().spatialWidthGr / GRID_SIZE < CHILD_ITEMS_VISIBLE_WIDTH_BL)}>
        {drawAsOpaque()}
      </Show>
      <Show when={pageItem().id != desktopStore.currentPageId() && (pageItem().spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL)}>
        {drawAsTranslucent()}
      </Show>
    </>
  );
}


export const PageInTableFn: Component<VisualElementInTablePropsFn> = (props: VisualElementInTablePropsFn) => {
  const desktopStore = useDesktopStore();
  const pageItem = () => asPageItem(desktopStore.getItem(props.visualElement.itemId)!);
  const boundsPx = props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const widthBl = asTableItem(desktopStore.getItem(props.parentVisualElement.itemId)!).spatialWidthGr / GRID_SIZE;
    return boundsPx().w / widthBl;
  }

  return (
    <>
      <div class="absolute"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${oneBlockWidthPx()}px; height: ${boundsPx().h}px; ` +
                 `background-image: linear-gradient(270deg, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.386)}, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.364)}); ` +
                 `transform: scale(${0.7}); transform-origin: center center;`}>
        <For each={props.visualElement.attachments()}>{attachment =>
          <VisualElementInTableFn visualElement={attachment} parentVisualElement={props.parentVisualElement} />
        }</For>
      </div>
      <div class="absolute overflow-hidden"
           style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        {pageItem().title}
      </div>
    </>
  );
}
