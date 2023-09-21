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

import { Component, createEffect, createMemo, For, onMount, Show } from "solid-js";
import { ArrangeAlgorithm, asPageItem, PageFns } from "../../items/page-item";
import { ATTACH_AREA_SIZE_PX, LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL, MAIN_TOOLBAR_WIDTH_PX } from "../../constants";
import { hexToRGBA } from "../../util/color";
import { Colors, linearGradient } from "../../style";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { VisualElement_Desktop, VisualElement_LineItem, VisualElementProps } from "../VisualElement";
import { ItemFns } from "../../items/base/item-polymorphism";
import { HitboxType } from "../../layout/hitbox";
import { BoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { itemState } from "../../store/ItemState";
import { server } from "../../server";
import { VisualElementFlags, VeFns } from "../../layout/visual-element";
import { VesCache } from "../../layout/ves-cache";
import { arrange } from "../../layout/arrange";


export const Page_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const desktopStore = useDesktopStore();

  onMount(() => {
    if (props.visualElement.flags & VisualElementFlags.Popup) {
      // If the popup is from clicking on a link item, the veid of the popup visual element will not reflect
      // that item since the link id will be the constant one used for popups. Therefore, get the veid directly
      // from the desktop store.
      const popupVeid = VeFns.veidFromPath(desktopStore.currentPopupSpec()!.vePath);

      const scrollXPx = desktopStore.getPageScrollXProp(popupVeid) * (childAreaBoundsPx().w - props.visualElement.boundsPx.w);
      const scrollYPx = desktopStore.getPageScrollYProp(popupVeid) * (childAreaBoundsPx().h - props.visualElement.boundsPx.h);

      popupDiv!.scrollTop = scrollYPx;
      popupDiv!.scrollLeft = scrollXPx;
    }
  });

  const pageItem = () => asPageItem(props.visualElement.displayItem);
  const parentPage = () => {
    const veParentPath = props.visualElement.parentPath!;
    const parentVe = VesCache.get(veParentPath)!.get();
    return asPageItem(itemState.get(parentVe.displayItem.id)!);
  };
  const boundsPx = () => props.visualElement.boundsPx;
  const innerBoundsPx = () => {
    let r = zeroBoundingBoxTopLeft(props.visualElement.boundsPx);
    r.w = r.w - 2;
    r.h = r.h - 2;
    return r;
  }
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
  const isPoppedUp = () => VeFns.veToPath(props.visualElement) == desktopStore.currentPopupSpecVePath();

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
        <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
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
          <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || isPoppedUp()}>
            <div class="absolute"
                 style={`left: ${innerBoundsPx().x}px; top: ${innerBoundsPx().y}px; width: ${innerBoundsPx().w}px; height: ${innerBoundsPx().h}px; background-color: #dddddd88;`}>
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

  let translucentDiv: HTMLDivElement | undefined;

  const translucentScrollHandler = (_ev: Event) => {
    if (!translucentDiv) { return; }
    if (updatingScrollTop) { return; }

    const pageBoundsPx = props.visualElement.boundsPx;
    const childAreaBounds = childAreaBoundsPx();
    const pageVeid = VeFns.getVeid(props.visualElement);

    // TODO: compensate for toolbar width.
    // if (childAreaBounds.w > pageBoundsPx.w) {
    //   const scrollXProp = popupDiv!.scrollLeft / (childAreaBounds.w - pageBoundsPx.w);
    //   desktopStore.setPageScrollXProp(pageVeid, scrollXProp);
    // }

    if (childAreaBounds.h > pageBoundsPx.h) {
      const scrollYProp = translucentDiv!.scrollTop / (childAreaBounds.h - pageBoundsPx.h);
      desktopStore.setPageScrollYProp(pageVeid, scrollYProp);
    }
  }

  let updatingScrollTop = false;
  const _updateScrollTop = createEffect(() => {
    updatingScrollTop = true;

    if (translucentDiv) {
      translucentDiv.scrollTop =
        desktopStore.getPageScrollYProp(VeFns.getVeid(props.visualElement)) *
        (childAreaBoundsPx().h - props.visualElement.boundsPx.h);
    }

    if (popupDiv && desktopStore.currentPopupSpec()) {
      popupDiv.scrollTop =
        desktopStore.getPageScrollYProp(VeFns.veidFromPath(desktopStore.currentPopupSpec()!.vePath)) *
        (childAreaBoundsPx().h - props.visualElement.boundsPx.h);
    }

    setTimeout(() => {
      updatingScrollTop = false;
    }, 0);
  });

  const translucentTitleScale = createMemo((): number => calcTitleScale("gl"));

  const drawAsTranslucent = () => {
    return (
      <>
        <Show when={pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
          <div class="absolute" style={`overflow-y: auto; overflow-x: hidden; width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; height: ${boundsPx().h}px; left: ${boundsPx().x}px; top: ${boundsPx().y}px; `}>
            <div class="absolute" style={`width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; height: ${LINE_HEIGHT_PX * lineVes().length}px`}>
              <For each={lineVes()}>{childVe =>
                <VisualElement_LineItem visualElement={childVe.get()} />
              }</For>
            </div>
          </div>
        </Show>
        <Show when={pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
          <div ref={translucentDiv}
               class={`absolute border border-slate-700 rounded-sm shadow-lg`}
               style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; background-color: #ffffff; ` +
                      `overflow-y: ${boundsPx().h < childAreaBoundsPx().h ? "auto" : "hidden"}; overflow-x: hidden;`}
               onscroll={translucentScrollHandler}>
            <div class="absolute"
                 style={`left: ${0}px; top: ${0}px; ` +
                        `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
              <For each={props.visualElement.children}>{childVe =>
                <VisualElement_Desktop visualElement={childVe.get()} />
              }</For>
            </div>
          </div>
        </Show>
        <div class={`absolute border border-slate-700 rounded-sm pointer-events-none`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.636)};`}>
          <Show when={props.visualElement.mouseIsOver.get()}>
            <div class={`absolute rounded-sm pointer-events-none`}
                 style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                        `background-color: #ffffff22;`}>
            </div>
            <Show when={hasPopupClickBoundsPx()}>
              <div class={`absolute rounded-sm pointer-events-none`}
                  style={`left: ${popupClickBoundsPx()!.x}px; top: ${popupClickBoundsPx()!.y}px; width: ${popupClickBoundsPx()!.w}px; height: ${popupClickBoundsPx()!.h}px; ` +
                          `background-color: #ffffff44;`}>
              </div>
            </Show>
          </Show>
          <Show when={props.visualElement.movingItemIsOver.get()}>
            <div class={`absolute rounded-sm pointer-events-none`}
                 style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                        `background-color: #ffffff22;`}>
            </div>
          </Show>
          <Show when={props.visualElement.movingItemIsOverAttach.get()}>
            <div class={`absolute rounded-sm pointer-events-none`}
                 style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                        `background-color: #ff0000;`}>
            </div>
          </Show>
          <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || isPoppedUp()}>
            <div class="absolute pointer-events-none"
                 style={`left: ${innerBoundsPx().x}px; top: ${innerBoundsPx().y}px; width: ${innerBoundsPx().w}px; height: ${innerBoundsPx().h}px; background-color: #dddddd88;`}>
            </div>
          </Show>
          <For each={props.visualElement.attachments}>{attachmentVe =>
            <VisualElement_Desktop visualElement={attachmentVe.get()} />
          }</For>
          <Show when={props.visualElement.linkItemMaybe != null}>
            <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`}></div>
          </Show>
        </div>
        <div class="absolute flex items-center justify-center pointer-events-none"
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
          <div class="flex items-center text-center text-xl font-bold text-white pointer-events-none"
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
    const popupParentPage = asPageItem(itemState.get(VesCache.get(props.visualElement.parentPath!)!.get().displayItem.id)!);
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

  let popupDiv: HTMLDivElement | undefined;

  const popupScrollHandler = (_ev: Event) => {
    if (!popupDiv) { return; }
    if (updatingScrollTop) { return; }

    const pageBoundsPx = props.visualElement.boundsPx;
    const childAreaBoundsPx_ = childAreaBoundsPx();

    const popupVeid = VeFns.veidFromPath(desktopStore.currentPopupSpec()!.vePath);

    // TODO: need to consider toolbar width.
    // if (childAreaBoundsPx_.w > pageBoundsPx.w) {
    //   const scrollXProp = popupDiv!.scrollLeft / (childAreaBoundsPx_.w - pageBoundsPx.w);
    //   desktopStore.setPageScrollXProp(popupVeid, scrollXProp);
    // }

    if (childAreaBoundsPx_.h > pageBoundsPx.h) {
      const scrollYProp = popupDiv!.scrollTop / (childAreaBoundsPx_.h - pageBoundsPx.h);
      desktopStore.setPageScrollYProp(popupVeid, scrollYProp);
    }
  }

  const drawAsPopup = () => {
    return (
      <>
        <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} text-xl font-bold rounded-md p-8 blur-md`}
             style={`left: ${boundsPx().x-10 + (props.visualElement.flags & VisualElementFlags.Fixed ? MAIN_TOOLBAR_WIDTH_PX : 0)}px; top: ${boundsPx().y-10}px; width: ${boundsPx().w+20}px; height: ${boundsPx().h+20}px; background-color: #303030d0;`}>
        </div>
        <Show when={pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
          <div ref={popupDiv}
               class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} border rounded-sm`}
               style={`overflow-y: auto; overflow-x: hidden; width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; height: ${boundsPx().h}px; left: ${boundsPx().x}px; top: ${boundsPx().y}px; background-color: #f8f8f8; border-color: ${borderColorVal()}`}>
            <div class="absolute" style={`width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; height: ${LINE_HEIGHT_PX * lineVes().length}px`}>
              <For each={lineVes()}>{childVe =>
                <VisualElement_LineItem visualElement={childVe.get()} />
              }</For>
            </div>
          </div>
        </Show>
        <Show when={pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
          <div ref={popupDiv}
               class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} border rounded-sm`}
               style={`left: ${boundsPx().x + (props.visualElement.flags & VisualElementFlags.Fixed ? MAIN_TOOLBAR_WIDTH_PX : 0)}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; background-color: #f8f8f8; border-color: ${borderColorVal()}` +
                      `overflow-y: ${boundsPx().h < childAreaBoundsPx().h ? "auto" : "hidden"}; overflow-x: hidden;`}
              onscroll={popupScrollHandler}>
            <div class="absolute"
                 style={`left: ${boundsPx().w - childAreaBoundsPx().w}px; top: ${0}px; ` +
                        `width: ${childAreaBoundsPx().w}px; height: ${childAreaBoundsPx().h}px;`}>
              <For each={props.visualElement.children}>{childVe =>
                <VisualElement_Desktop visualElement={childVe.get()} />
              }</For>
            </div>
          </div>
        </Show>
        <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm text-gray-100`}
             style={`left: ${boundsPx().x + (props.visualElement.flags & VisualElementFlags.Fixed ? MAIN_TOOLBAR_WIDTH_PX : 0)}px; top: ${boundsPx().y}px; width: ${boundsPx().w - childAreaBoundsPx().w}px; height: ${boundsPx().h}px; background-color: ${borderColorVal()}`}>
          <div class="mt-[10px] uppercase rotate-90 whitespace-pre text-[18px]">
            {pageItem().title}
          </div>
          <Show when={PageFns.popupPositioningHasChanged(parentPage())}>
            <div class={`absolute`} style={"bottom: 10px; left: 5px; cursor: pointer;"} onClick={anchorPopup}>
              <i class={`fa fa-anchor`} />
            </div>
          </Show>
        </div>
      </>
    );
  }

  const fullBgColorVal = () => {
    return `${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.05)}; `;
  }

  const lineVes = () => props.visualElement.children.filter(c => c.get().flags & VisualElementFlags.LineItem);
  const desktopVes = () => props.visualElement.children.filter(c => !(c.get().flags & VisualElementFlags.LineItem));

  const drawAsFull = () => {
    return (
      <div class={`absolute bg-gray-300 ${(props.visualElement.flags & VisualElementFlags.Root) ? "border border-slate-700" : ""}`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; background-color: ${(props.visualElement.flags & VisualElementFlags.Root) ? fullBgColorVal() : "#ffffff"}`}>
        <Show when={pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
          <div class="absolute" style={`overflow-y: auto; overflow-x: hidden; width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; height: ${boundsPx().h}px`}>
            <div class="absolute" style={`width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; height: ${LINE_HEIGHT_PX * lineVes().length}px`}>
              <For each={lineVes()}>{childVe =>
                <VisualElement_LineItem visualElement={childVe.get()} />
              }</For>
            </div>
          </div>
        </Show>
        <Show when={asPageItem(props.visualElement.displayItem).arrangeAlgorithm == ArrangeAlgorithm.List}>
          <div class={`absolute bg-slate-700`}
               style={`left: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; top: 0px; height: ${boundsPx().h}px; width: 1px`}></div>
        </Show>
        <For each={desktopVes()}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
      </div>
    );
  }

  return (
    <>
      <Show when={(props.visualElement.parentPath == null || (props.visualElement.flags & VisualElementFlags.Root)) && !(props.visualElement.flags & VisualElementFlags.Popup)}>
        {drawAsFull()}
      </Show>
      <Show when={!(props.visualElement.flags & VisualElementFlags.Detailed) ||
                  (!(props.visualElement.flags & VisualElementFlags.Root) &&
                   !(props.visualElement.flags & VisualElementFlags.Popup) &&
                   props.visualElement.parentPath != null &&
                   !(props.visualElement.flags & VisualElementFlags.ShowChildren))}>
        {drawAsOpaque()}
      </Show>
      <Show when={!(props.visualElement.flags & VisualElementFlags.Root) &&
                  !(props.visualElement.flags & VisualElementFlags.Popup) &&
                  props.visualElement.flags & VisualElementFlags.Detailed &&
                  props.visualElement.parentPath != null &&
                  props.visualElement.flags & VisualElementFlags.ShowChildren}>
        {drawAsTranslucent()}
      </Show>
      <Show when={props.visualElement.flags & VisualElementFlags.Popup}>
        {drawAsPopup()}
      </Show>
    </>
  );
}


export const Page_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const desktopStore = useDesktopStore();
  const pageItem = () => asPageItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.oneBlockWidthPx!;
  const dimensionsBl = () => ItemFns.calcSpatialDimensionsBl(pageItem());
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

  const isPoppedUp = () => VeFns.veToPath(props.visualElement) == desktopStore.currentPopupSpecVePath();

  const bgOpaqueVal = () => `background-image: linear-gradient(270deg, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.7)}, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.75)});`;

  return (
    <>
      <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || isPoppedUp()}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; background-color: #dddddd88;`}>
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
