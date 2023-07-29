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

import { Component, createMemo, For, Show } from "solid-js";
import { asPageItem, popupPositioningHasChanged } from "../../items/page-item";
import { ATTACH_AREA_SIZE_PX, CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_SIZE, LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL } from "../../constants";
import { hexToRGBA } from "../../util/color";
import { Colors, linearGradient } from "../../style";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { VisualElement_Desktop, VisualElement_LineItem, VisualElementProps_Desktop, VisualElementProps_LineItem } from "../VisualElement";
import { calcSizeForSpatialBl } from "../../items/base/item-polymorphism";
import { HitboxType } from "../../layout/hitbox";
import { BoundingBox } from "../../util/geometry";
import { arrange, ARRANGE_ALGO_LIST, currentVesCache } from "../../layout/arrange";
import { breadcrumbStore } from "../../store/BreadcrumbStore";
import { itemStore } from "../../store/ItemStore";
import { server } from "../../server";
import { detailedFlagSet, lineItemFlagSet, pagePopupFlagSet, rootFlagSet, selectedFlagSet } from "../../layout/visual-element";


export const Page_Desktop: Component<VisualElementProps_Desktop> = (props: VisualElementProps_Desktop) => {
  const desktopStore = useDesktopStore();

  const pageItem = () => asPageItem(props.visualElement.displayItem);
  const parentPage = () => {
    const veParentPath = props.visualElement.parentPath!;
    const parentVe = currentVesCache[veParentPath].get();
    return asPageItem(itemStore.getItem(parentVe.displayItem.id)!);
  };
  const boundsPx = () => props.visualElement.boundsPx;
  const childAreaBoundsPx = () => props.visualElement.childAreaBoundsPx!;
  const clickBoundsPx = (): BoundingBox | null => props.visualElement.hitboxes.find(hb => hb.type == HitboxType.Click || hb.type == HitboxType.OpenAttachment)!.boundsPx;
  const popupClickBoundsPx = (): BoundingBox | null => props.visualElement.hitboxes.find(hb => hb.type == HitboxType.OpenPopup)!.boundsPx;
  const hasPopupClickBoundsPx = (): boolean => props.visualElement.hitboxes.find(hb => hb.type == HitboxType.OpenPopup) != undefined;
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const spatialWidthGr = () => {
    if (props.visualElement.linkItemMaybe != null) {
      return props.visualElement.linkItemMaybe.spatialWidthGr;
    }
    return pageItem().spatialWidthGr;
  };

  const calcTitleScale = (textSize: string) => {
    const outerDiv = document.createElement("div");
    outerDiv.setAttribute("class", "flex items-center justify-center");
    outerDiv.setAttribute("style", `width: ${boundsPx().w}px; height: ${boundsPx().h}px;`);
    const innerDiv = document.createElement("div");
    innerDiv.setAttribute("class", `flex items-center text-center text-${textSize} font-bold text-white`);
    outerDiv.appendChild(innerDiv);
    const txt = document.createTextNode(pageItem().title);
    innerDiv.appendChild(txt);
    document.body.appendChild(outerDiv);
    let scale = 0.85 / Math.max(innerDiv.offsetWidth / boundsPx().w, innerDiv.offsetHeight / boundsPx().h); // 0.85 -> margin.
    document.body.removeChild(outerDiv);
    return scale > 1.0 ? 1.0 : scale;
  }

  const opaqueTitleScale = createMemo((): number => calcTitleScale("xs"));

  const drawAsOpaque = () => {
    return (
      <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.0)};`}>
        <Show when={detailedFlagSet(props.visualElement)}>
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
            <Show when={hasPopupClickBoundsPx()}>
              <div class={`absolute rounded-sm`}
                  style={`left: ${popupClickBoundsPx()!.x}px; top: ${popupClickBoundsPx()!.y}px; width: ${popupClickBoundsPx()!.w}px; height: ${popupClickBoundsPx()!.h}px; ` +
                          `background-color: #ffffff44;`}>
              </div>
            </Show>
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
            <VisualElement_Desktop visualElement={attachmentVe.get()} />
          }</For>
          <Show when={props.visualElement.linkItemMaybe != null}>
            <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`}></div>
          </Show>
        </Show>
      </div>
    );
  }

  const translucentTitleScale = createMemo((): number => calcTitleScale("gl"));

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
              <VisualElement_Desktop visualElement={childVe.get()} />
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
            <Show when={hasPopupClickBoundsPx()}>
              <div class={`absolute rounded-sm`}
                  style={`left: ${popupClickBoundsPx()!.x}px; top: ${popupClickBoundsPx()!.y}px; width: ${popupClickBoundsPx()!.w}px; height: ${popupClickBoundsPx()!.h}px; ` +
                          `background-color: #ffffff44;`}>
              </div>
            </Show>
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
            <VisualElement_Desktop visualElement={attachmentVe.get()} />
          }</For>
          <Show when={props.visualElement.linkItemMaybe != null}>
            <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`}></div>
          </Show>
        </div>
        <div class="absolute flex items-center justify-center" style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
          <div class="flex items-center text-center text-xl font-bold text-white"
               style={`transform: scale(${translucentTitleScale()}); transform-origin: center center;`}>
            {pageItem().title}
          </div>
        </div>
      </>
    );
  }

  const borderColorVal = () => {
    return `${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.75)}; `;
  }

  const anchorPopup = () => {
    const popupParentPage = asPageItem(itemStore.getItem(currentVesCache[props.visualElement.parentPath!].get().displayItem.id)!);
    if (popupParentPage.pendingPopupPositionGr != null) {
      popupParentPage.popupPositionGr = popupParentPage.pendingPopupPositionGr!;
    }
    if (popupParentPage.pendingPopupWidthGr != null) {
      popupParentPage.popupWidthGr = popupParentPage.pendingPopupWidthGr;
    }
    if (popupParentPage.pendingPopupAlignmentPoint != null) {
      popupParentPage.popupAlignmentPoint = popupParentPage.pendingPopupAlignmentPoint;
    }
    server.updateItem(popupParentPage);
    arrange(desktopStore);
  }

  const drawAsPopup = () => {
    return (
      <>
        <div class={`absolute text-xl font-bold rounded-md p-8 blur-md`}
             style={`left: ${boundsPx().x-10}px; top: ${boundsPx().y-10}px; width: ${boundsPx().w+20}px; height: ${boundsPx().h+20}px; background-color: #303030d0;}`}>
        </div>
        <div class={`absolute border rounded-sm`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; background-color: #f8f8f8; border-color: ${borderColorVal()}`}>
        </div>
        <div class={`absolute rounded-sm text-gray-100`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w - childAreaBoundsPx().w}px; height: ${boundsPx().h}px; background-color: ${borderColorVal()}`}>
          <div class="mt-[10px] uppercase rotate-90 whitespace-pre text-[18px]">
            {pageItem().title}
          </div>
          <Show when={popupPositioningHasChanged(parentPage())}>
            <div class={`absolute`} style={"bottom: 10px; left: 5px; cursor: pointer;"} onClick={anchorPopup}>
              <i class={`fa fa-anchor`} />
            </div>
          </Show>
        </div>
        <div class="absolute"
             style={`left: ${childAreaBoundsPx().x}px; top: ${childAreaBoundsPx().y}px; ` +
                    `width: ${childAreaBoundsPx().w}px; height: ${childAreaBoundsPx().h}px;`}>
          <For each={props.visualElement.children}>{childVe =>
            <VisualElement_Desktop visualElement={childVe.get()} />
          }</For>
        </div>
      </>
    );
  }

  const fullBgColorVal = () => {
    return `${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.12)}; `;
  }

  const drawAsFull = () => {
    return (
      <div class={`absolute ${rootFlagSet(props.visualElement) ? "border border-slate-700" : ""}`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; background-color: ${rootFlagSet(props.visualElement) ? fullBgColorVal() : "#ffffff"}`}>
        <For each={props.visualElement.children}>{childVe =>
          lineItemFlagSet(childVe.get())
            ? <VisualElement_LineItem visualElement={childVe.get()} />
            : <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
        <Show when={asPageItem(props.visualElement.displayItem).arrangeAlgorithm == ARRANGE_ALGO_LIST}>
          <div class={`absolute bg-slate-700`}
               style={`left: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; top: 0px; height: ${boundsPx().h}px; width: 1px`}></div>
        </Show>
      </div>
    );
  }

  return (
    <>
      <Show when={pageItem().id == breadcrumbStore.currentPage() || rootFlagSet(props.visualElement)}>
        {drawAsFull()}
      </Show>
      <Show when={!detailedFlagSet(props.visualElement) ||
                  (!rootFlagSet(props.visualElement) && !pagePopupFlagSet(props.visualElement) && pageItem().id != breadcrumbStore.currentPage() && (spatialWidthGr() / GRID_SIZE < CHILD_ITEMS_VISIBLE_WIDTH_BL))}>
        {drawAsOpaque()}
      </Show>
      <Show when={!rootFlagSet(props.visualElement) &&
                  !pagePopupFlagSet(props.visualElement) &&
                  detailedFlagSet(props.visualElement) &&
                  pageItem().id != breadcrumbStore.currentPage() &&
                  (spatialWidthGr() / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL)}>
        {drawAsTranslucent()}
      </Show>
      <Show when={pagePopupFlagSet(props.visualElement)}>
        {drawAsPopup()}
      </Show>
    </>
  );
}


export const Page_LineItem: Component<VisualElementProps_LineItem> = (props: VisualElementProps_LineItem) => {
  const desktopStore = useDesktopStore();

  const pageItem = () => asPageItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.oneBlockWidthPx!;
  const dimensionsBl = () => calcSizeForSpatialBl(pageItem());
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
      <Show when={selectedFlagSet(props.visualElement)}>
        <div class="absolute bg-slate-200"
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
        </div>
      </Show>
      <Show when={props.visualElement.mouseIsOverOpenPopup.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${boundsPx().x+2}px; top: ${boundsPx().y+2}px; width: ${oneBlockWidthPx()-4}px; height: ${boundsPx().h-4}px;`}>
        </div>
      </Show>
      <Show when={!props.visualElement.mouseIsOverOpenPopup.get() && props.visualElement.mouseIsOver.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${boundsPx().x+2}px; top: ${boundsPx().y+2}px; width: ${boundsPx().w-4}px; height: ${boundsPx().h-4}px;`}>
        </div>
      </Show>
      <div class="absolute border border-slate-700 rounded-sm shadow-sm"
           style={`left: ${boundsPx().x + thumbBoundsPx().x}px; top: ${thumbBoundsPx().y}px; width: ${thumbBoundsPx().w}px; height: ${thumbBoundsPx().h}px; ` + bgOpaqueVal()}>
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
