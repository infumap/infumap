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
import { VisualElementOnDesktop, VisualElementOnDesktopProps } from "../VisualElementOnDesktop";
import { VisualElementInTable, VisualElementInTableProps } from "../VisualElementInTable";
import { asTableItem } from "../../store/desktop/items/table-item";
import { HTMLDivElementWithData } from "../../util/html";


export const Page: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const desktopStore = useDesktopStore();
  let nodeElement: HTMLDivElementWithData | undefined;

  const pageItem = () => asPageItem(desktopStore.getItem(props.visualElement.itemId)!);
  const boundsPx = () => props.visualElement.boundsPx;
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

  const bgOpaqueVal = () => {
    let bg = `background-image: linear-gradient(270deg, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.986)}, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 1.0)});`;
    if (pageItem().computed_mouseIsOver.get()) {
      bg = `background-color: #880088`;
    }
    if (pageItem().computed_movingItemIsOver.get()) {
      bg = `background-color: #880000;`;
    }
    return bg;
  }

  const drawAsOpaque = () => {
    return (
      <div ref={nodeElement}
           id={props.visualElement.itemId}
           class={`absolute border border-slate-700 rounded-sm shadow-lg`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` + bgOpaqueVal()}>
        <Show when={pageItem().computed_mouseIsOver.get()}>
          <div class={`absolute`} style={`left: ${popupClickBoundsPx().x}px; top: ${popupClickBoundsPx().y}px; width: ${popupClickBoundsPx().w}px; height: ${popupClickBoundsPx().h}px; background-color: #ff00ff`}></div>
        </Show>
        <Show when={props.visualElement.isInteractive}>
          <div class="flex items-center justify-center" style={`width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
            <div class="flex items-center text-center text-xs font-bold text-white"
                 style={`transform: scale(${calcOpaqueScale()}); transform-origin: center center;`}>
              {pageItem().title}
            </div>
          </div>
          <For each={props.visualElement.attachments}>{attachmentVe =>
            <VisualElementOnDesktop visualElement={attachmentVe.get()} />
          }</For>
        </Show>
      </div>
    );
  }

  const bgTranslucentVal = () => {
    let bg = `background-image: linear-gradient(270deg, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.386)}, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.364)});`;
    if (pageItem().computed_mouseIsOver.get()) {
      bg = `background-color: #880088`;
    }
    if (pageItem().computed_movingItemIsOver.get()) {
      bg = `background-color: #88000088;`;
    }
    return bg;
  }

  const drawAsTranslucent = () => {
    return (
      <>
        <div ref={nodeElement}
            id={props.visualElement.itemId}
            class={`absolute border border-slate-700 rounded-sm shadow-lg z-5`}
            style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` + bgTranslucentVal()}>
          <Show when={pageItem().computed_mouseIsOver.get()}>
            <div class={`absolute`} style={`left: ${popupClickBoundsPx().x}px; top: ${popupClickBoundsPx().y}px; width: ${popupClickBoundsPx().w}px; height: ${popupClickBoundsPx().h}px; background-color: #ff00ff`}></div>
          </Show>
          <div class="flex items-center justify-center" style={`width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
            <div class="flex items-center text-center text-xl font-bold text-white">
              {pageItem().title}
            </div>
          </div>
        </div>
        <Show when={props.visualElement.childAreaBoundsPx != null}>
          <div class="absolute"
              style={`left: ${props.visualElement.childAreaBoundsPx!.x}px; top: ${props.visualElement.childAreaBoundsPx!.y}px; ` +
                      `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
            <For each={props.visualElement.children}>{childVe =>
              <VisualElementOnDesktop visualElement={childVe.get()} />
            }</For>
          </div>
        </Show>
      </>
    );
  }

  const drawAsTopLevelPage = () => {
    return (
      <div ref={nodeElement}
           id={props.visualElement.itemId}
           class={`absolute`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
        <For each={props.visualElement.children}>{childVe =>
          <VisualElementOnDesktop visualElement={childVe.get()} />
        }</For>
      </div>
    );
  }

  return (
    <>
      <Show when={pageItem().id == desktopStore.currentPageId()}>
        {drawAsTopLevelPage()}
      </Show>
      <Show when={pageItem().id != desktopStore.currentPageId() && (pageItem().spatialWidthGr.get() / GRID_SIZE < CHILD_ITEMS_VISIBLE_WIDTH_BL)}>
        {drawAsOpaque()}
      </Show>
      <Show when={pageItem().id != desktopStore.currentPageId() && (pageItem().spatialWidthGr.get() / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL)}>
        {drawAsTranslucent()}
      </Show>
    </>
  );
}


export const PageInTable: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  const desktopStore = useDesktopStore();
  let nodeElement: HTMLDivElementWithData | undefined;

  const pageItem = () => asPageItem(desktopStore.getItem(props.visualElement.itemId)!);
  // refer to: visual-element.ts
  const boundsPx_cache = () => {
    let currentBoundsPx = props.visualElement.boundsPx;
    if (nodeElement == null) { return currentBoundsPx; }
    return currentBoundsPx;
  };
  const boundsPx = props.visualElement.boundsPx;
  const scale = () => boundsPx.h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const widthBl = asTableItem(desktopStore.getItem(props.parentVisualElement.itemId)!).spatialWidthGr.get() / GRID_SIZE;
    return boundsPx.w / widthBl;
  }

  return (
    <>
      <div ref={nodeElement}
           id={props.visualElement.itemId}
           class="absolute"
           style={`left: ${boundsPx_cache().x}px; top: ${boundsPx.y}px; width: ${oneBlockWidthPx()}px; height: ${boundsPx.h}px; ` +
                  `background-image: linear-gradient(270deg, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.386)}, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.364)}); ` +
                  `transform: scale(${0.7}); transform-origin: center center;`}>
      </div>
      <div class="absolute overflow-hidden"
           style={`left: ${boundsPx_cache().x + oneBlockWidthPx()}px; top: ${boundsPx.y}px; ` +
                  `width: ${(boundsPx.w - oneBlockWidthPx())/scale()}px; height: ${boundsPx.h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        {pageItem().title}
        <For each={props.visualElement.attachments}>{attachment =>
          <VisualElementInTable visualElement={attachment.get()} parentVisualElement={props.parentVisualElement} />
        }</For>
      </div>
    </>
  );
}
