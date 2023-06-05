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
import { ATTACH_AREA_SIZE_PX, CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_SIZE, LINE_HEIGHT_PX } from "../../constants";
import { hexToRGBA } from "../../util/color";
import { Colors, linearGradient } from "../../style";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { VisualElementOnDesktop, VisualElementOnDesktopProps } from "../VisualElementOnDesktop";
import { VisualElementInTable, VisualElementInTableProps } from "../VisualElementInTable";
import { asTableItem } from "../../store/desktop/items/table-item";
import { calcSizeForSpatialBl } from "../../store/desktop/items/base/item-polymorphism";
import { HitboxType } from "../../store/desktop/hitbox";
import { BoundingBox } from "../../util/geometry";


export const Page: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const desktopStore = useDesktopStore();

  const SMALL_TOOLBAR_WIDTH_PX = 28;
  const pageItem = () => asPageItem(props.visualElement.item);
  const boundsPx = () => props.visualElement.boundsPx;
  const clickBoundsPx = (): BoundingBox | null => props.visualElement.hitboxes.find(hb => hb.type == HitboxType.Click)!.boundsPx;
  const popupClickBoundsPx = (): BoundingBox | null => props.visualElement.hitboxes.find(hb => hb.type == HitboxType.OpenPopup)!.boundsPx;
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  }

  const opaqueTitleScale = createMemo((): number => {
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
    return (
      <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.0)};`}>
        <Show when={props.visualElement.isInteractive}>
          <div class="flex items-center justify-center" style={`width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
            <div class="flex items-center text-center text-xs font-bold text-white"
                 style={`transform: scale(${opaqueTitleScale()}); transform-origin: center center;`}>
              {pageItem().title}
            </div>
          </div>
          <Show when={props.visualElement.mouseIsOver.get()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                        `background-color: #ffffff22;`}>
            </div>
            <div class={`absolute rounded-sm`}
                 style={`left: ${popupClickBoundsPx()!.x}px; top: ${popupClickBoundsPx()!.y}px; width: ${popupClickBoundsPx()!.w}px; height: ${popupClickBoundsPx()!.h}px; ` +
                        `background-color: #ffffff44;`}>
            </div>
          </Show>
          <Show when={props.visualElement.movingItemIsOver.get()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                        `background-color: #ffffff22;`}>
            </div>
          </Show>
          <Show when={props.visualElement.movingItemIsOverAttach.get()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                        `background-color: #ff0000;`}>
            </div>
          </Show>
          <For each={props.visualElement.attachments}>{attachmentVe =>
            <VisualElementOnDesktop visualElement={attachmentVe.get()} />
          }</For>
        </Show>
      </div>
    );
  }

  const drawAsTranslucent = () => {
    return (
      <>
        <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; background-color: #ffffff;`}>
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
        <div class={`absolute border border-slate-700 rounded-sm`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.636)};`}>
          <Show when={props.visualElement.mouseIsOver.get()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                        `background-color: #ffffff22;`}>
            </div>
            <div class={`absolute rounded-sm`}
                 style={`left: ${popupClickBoundsPx()!.x}px; top: ${popupClickBoundsPx()!.y}px; width: ${popupClickBoundsPx()!.w}px; height: ${popupClickBoundsPx()!.h}px; ` +
                        `background-color: #ffffff44;`}>
            </div>
          </Show>
          <Show when={props.visualElement.movingItemIsOver.get()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                        `background-color: #ffffff22;`}>
            </div>
          </Show>
          <Show when={props.visualElement.movingItemIsOverAttach.get()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                        `background-color: #ff0000;`}>
            </div>
          </Show>
        </div>
        <div class="absolute flex items-center justify-center" style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
          <div class="flex items-center text-center text-xl font-bold text-white">
            {pageItem().title}
          </div>
        </div>
      </>
    );
  }

  const borderColorVal = () => {
    return `${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.75)}; `;
  }

  const drawAsPopup = () => {
    return (
      <>
        <div class={`absolute rounded-sm shadow-xl`}
             style={`left: ${boundsPx().x-SMALL_TOOLBAR_WIDTH_PX-1}px; top: ${boundsPx().y-1}px; width: ${boundsPx().w+SMALL_TOOLBAR_WIDTH_PX+2}px; height: ${boundsPx().h+2}px; background-color: #dddddd;}`}>
        </div>
        <div class={`absolute border rounded-sm`}
             style={`left: ${boundsPx().x-SMALL_TOOLBAR_WIDTH_PX}px; top: ${boundsPx().y}px; width: ${boundsPx().w+SMALL_TOOLBAR_WIDTH_PX}px; height: ${boundsPx().h}px; background-color: #f8f8f8; border-color: ${borderColorVal()}`}>
        </div>
        <div class={`absolute rounded-sm text-gray-100`}
             style={`left: ${boundsPx().x-SMALL_TOOLBAR_WIDTH_PX}px; top: ${boundsPx().y}px; width: ${SMALL_TOOLBAR_WIDTH_PX}px; height: ${boundsPx().h}px; background-color: ${borderColorVal()}`}>
          <div class="mt-[10px] uppercase rotate-90 whitespace-pre text-[18px]">
            {pageItem().title}
          </div>
        </div>
        <div class="absolute"
             style={`left: ${props.visualElement.childAreaBoundsPx!.x}px; top: ${props.visualElement.childAreaBoundsPx!.y}px; ` +
                    `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
          <For each={props.visualElement.children}>{childVe =>
            <VisualElementOnDesktop visualElement={childVe.get()} />
          }</For>
        </div>
      </>
    );
  }

  const drawAsTopLevelPage = () => {
    return (
      <div class={`absolute`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
        <For each={props.visualElement.children}>{childVe =>
          <VisualElementOnDesktop visualElement={childVe.get()} />
        }</For>
      </div>
    );
  }

  return (
    <>
      <Show when={pageItem().id == desktopStore.topLevelPageId()}>
        {drawAsTopLevelPage()}
      </Show>
      <Show when={!props.visualElement.isInteractive || (!props.visualElement.isPopup && pageItem().id != desktopStore.topLevelPageId() && (pageItem().spatialWidthGr / GRID_SIZE < CHILD_ITEMS_VISIBLE_WIDTH_BL))}>
        {drawAsOpaque()}
      </Show>
      <Show when={!props.visualElement.isPopup && pageItem().id != desktopStore.topLevelPageId() && (pageItem().spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL)}>
        {drawAsTranslucent()}
      </Show>
      <Show when={props.visualElement.isPopup}>
        {drawAsPopup()}
      </Show>
    </>
  );
}


export const PageInTable: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  const desktopStore = useDesktopStore();

  const pageItem = () => asPageItem(props.visualElement.item);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const widthBl = asTableItem(props.parentVisualElement.item).spatialWidthGr / GRID_SIZE;
    return boundsPx().w / widthBl;
  }
  const dimensionsBl = () => calcSizeForSpatialBl(pageItem(), desktopStore.getItem);
  const aspect = () => dimensionsBl().w / dimensionsBl().h;
  const thumbBoundsPx = () => {
    if (aspect() >= 1.0) {
      const w = oneBlockWidthPx() * 0.75;
      let h = w / aspect() * boundsPx().h / oneBlockWidthPx();
      if (h < 3 && w > 4) { h = 3; }
      const x = (oneBlockWidthPx() - w) / 2.0;
      const y = (boundsPx().h - h) / 2.0 + boundsPx().y;
      const result = { x, y, w, h };
      return result;
    }
    const h = boundsPx().h * 0.75;
    let w = h * aspect() * oneBlockWidthPx() / boundsPx().h;
    if (w < 3 && h > 4) { w = 3; }
    const x = (oneBlockWidthPx() - w) / 2.0;
    const y = (boundsPx().h - h) / 2.0 + boundsPx().y;
    const result = { x, y, w, h };
    return result;
  };

  const bgOpaqueVal = () => {
    let bg = `background-image: linear-gradient(270deg, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.7)}, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.75)});`;
    return bg;
  }

  return (
    <>
      <div class="absolute border border-slate-700 rounded-sm shadow-sm"
           style={`left: ${thumbBoundsPx().x}px; top: ${thumbBoundsPx().y}px; width: ${thumbBoundsPx().w}px; height: ${thumbBoundsPx().h}px; ` + bgOpaqueVal()}>
      </div>
      <div class="absolute overflow-hidden"
           style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        {pageItem().title}
        <For each={props.visualElement.attachments}>{attachment =>
          <VisualElementInTable visualElement={attachment.get()} parentVisualElement={props.parentVisualElement} />
        }</For>
      </div>
    </>
  );
}
