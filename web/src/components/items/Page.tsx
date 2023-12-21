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

import { Component, createEffect, createMemo, For, Match, onMount, Show, Switch } from "solid-js";
import { ArrangeAlgorithm, asPageItem, isPage, PageFns } from "../../items/page-item";
import { ANCHOR_BOX_SIZE_PX, ATTACH_AREA_SIZE_PX, LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL, RESIZE_BOX_SIZE_PX, TOP_TOOLBAR_HEIGHT_PX, Z_INDEX_ITEMS } from "../../constants";
import { hexToRGBA } from "../../util/color";
import { Colors, HighlightColor, linearGradient } from "../../style";
import { useStore } from "../../store/StoreProvider";
import { VisualElement_Desktop, VisualElement_LineItem, VisualElementProps } from "../VisualElement";
import { ItemFns } from "../../items/base/item-polymorphism";
import { HitboxFlags } from "../../layout/hitbox";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { itemState } from "../../store/ItemState";
import { VisualElementFlags, VeFns } from "../../layout/visual-element";
import { VesCache } from "../../layout/ves-cache";
import { PermissionFlags } from "../../items/base/permission-flags-item";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { TOP_LEVEL_PAGE_UID } from "../../util/uid";


export const Page_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  let rootDiv: HTMLDivElement | undefined;

  onMount(() => {
    let veid;
    let div;

    if (props.visualElement.flags & VisualElementFlags.Popup) {
      veid = VeFns.veidFromPath(store.history.currentPopupSpec()!.vePath);
      div = popupDiv;
    } else if (props.visualElement.flags & VisualElementFlags.ListPageRoot) {
      const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath!);
      const selectedPath = store.perItem.getSelectedListPageItem(parentVeid);
      veid = VeFns.veidFromPath(selectedPath);
      div = rootDiv;
    } else if (props.visualElement.flags & VisualElementFlags.TopLevelRoot ||
               props.visualElement.flags & VisualElementFlags.EmbededInteractiveRoot) {
      veid = VeFns.veidFromVe(props.visualElement);
      div = rootDiv;
    } else {
      veid = VeFns.veidFromVe(props.visualElement);
      div = translucentDiv;
    }

    if (!div) { return; }

    const scrollXProp = store.perItem.getPageScrollXProp(veid);
    const scrollXPx = scrollXProp * (childAreaBoundsPx().w - viewportBoundsPx().w);

    const scrollYProp = store.perItem.getPageScrollYProp(veid);
    const scrollYPx = scrollYProp * (childAreaBoundsPx().h - viewportBoundsPx().h);

    div.scrollTop = scrollYPx;
    div.scrollLeft = scrollXPx;
  });

  const pageItem = () => asPageItem(props.visualElement.displayItem);
  const parentPage = () => {
    const veParentPath = props.visualElement.parentPath!;
    const parentVe = VesCache.get(veParentPath)!.get();
    return asPageItem(itemState.get(parentVe.displayItem.id)!);
  };
  const boundsPx = () => props.visualElement.boundsPx;
  const blockSizePx = () => props.visualElement.blockSizePx!;
  const scale = () => (boundsPx().h - viewportBoundsPx().h) / LINE_HEIGHT_PX;
  const viewportBoundsPx = () => props.visualElement.viewportBoundsPx!;
  const innerBoundsPx = () => {
    let r = zeroBoundingBoxTopLeft(props.visualElement.boundsPx);
    r.w = r.w - 2;
    r.h = r.h - 2;
    return r;
  };
  const childAreaBoundsPx = () => props.visualElement.childAreaBoundsPx!;
  const clickBoundsPx = (): BoundingBox | null => props.visualElement.hitboxes.find(hb => hb.type == HitboxFlags.Click || hb.type == HitboxFlags.OpenAttachment)!.boundsPx;
  const popupClickBoundsPx = (): BoundingBox | null => props.visualElement.hitboxes.find(hb => hb.type == HitboxFlags.OpenPopup)!.boundsPx;
  const hasPopupClickBoundsPx = (): boolean => props.visualElement.hitboxes.find(hb => hb.type == HitboxFlags.OpenPopup) != undefined;
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const isPoppedUp = () => VeFns.veToPath(props.visualElement) == store.history.currentPopupSpecVePath();
  const isPublic = () => pageItem().permissionFlags != PermissionFlags.None;
  const isEmbeddedInteractive = () => !!(props.visualElement.flags & VisualElementFlags.EmbededInteractiveRoot);

  const lineVes = () => props.visualElement.childrenVes.filter(c => c.get().flags & VisualElementFlags.LineItem);
  const desktopVes = () => props.visualElement.childrenVes.filter(c => !(c.get().flags & VisualElementFlags.LineItem));

  const calcTitleInBoxScale = (textSize: string) => {
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

  const listViewScale = () => props.visualElement.boundsPx.w / store.desktopMainAreaBoundsPx().w;

  const renderAsDock = () => {
    return (
      <div class={`absolute border-r border-slate-300 rounded-sm align-middle text-center`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `background-color: ${props.visualElement.movingItemIsOver.get() ? "#dddddd" : (props.visualElement.mouseIsOver.get() ? "#eeeeee" : "#ffffff")}; `}>
        <For each={props.visualElement.childrenVes}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
        <Show when={props.visualElement.childrenVes.length == 0}>
          <div class="absolute text-slate-400"
               style={`left: ${boundsPx().w/2-5}px; top: ${boundsPx().h / 2}px; ` +
                      `font-size: ${10}px;`}>
            <i class="fa fa-chevron-right" />
          </div>
        </Show>
      </div>);
  }

  const renderAsTrash = () => {
    const trashFontSizePx = () => {
      return boundsPx().h * 0.65;
    }

    return (
      <div class={`absolute rounded-sm shadow-lg align-middle text-center`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `background-color: ${props.visualElement.movingItemIsOver.get() ? "#dddddd" : (props.visualElement.mouseIsOver.get() ? "#eeeeee" : "#ffffff")}; ` +
                  `font-size: ${trashFontSizePx()}px;`}>
        <i class="fa fa-trash" />
      </div>);
  }

  // ## Opaque

  const renderAsOpaque = () => {
    const opaqueTitleInBoxScale = createMemo((): number => calcTitleInBoxScale("xs"));

    const renderBoxTitle = () =>
      <div class='flex items-center justify-center'
           style={`width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
        <div class='flex items-center text-center text-xs font-bold text-white'
             style={`transform: scale(${opaqueTitleInBoxScale()}); transform-origin: center center;`}>
          {pageItem().title}
        </div>
      </div>;

    const renderHoverOverMaybe = () =>
      <Show when={props.visualElement.mouseIsOver.get() && !store.anItemIsMoving.get()}>
        <div class={'absolute rounded-sm'}
             style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                    'background-color: #ffffff33;'} />
        <Show when={hasPopupClickBoundsPx()}>
          <div class={'absolute rounded-sm'}
               style={`left: ${popupClickBoundsPx()!.x}px; top: ${popupClickBoundsPx()!.y}px; width: ${popupClickBoundsPx()!.w}px; height: ${popupClickBoundsPx()!.h}px; ` +
                      'background-color: #ffffff55;'} />
        </Show>
      </Show>;

    const renderMovingOverMaybe = () =>
      <Show when={props.visualElement.movingItemIsOver.get()}>
        <div class={'absolute rounded-sm'}
             style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                    'background-color: #ffffff33;'} />
      </Show>;

    const renderMovingOverAttachMaybe = () =>
      <Show when={props.visualElement.movingItemIsOverAttach.get()}>
        <div class={'absolute rounded-sm'}
              style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                     'background-color: #ff0000;'} />
      </Show>;

    const renderPopupSelectedOverlayMaybe = () =>
      <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || isPoppedUp()}>
        <div class='absolute'
              style={`left: ${innerBoundsPx().x}px; top: ${innerBoundsPx().y}px; width: ${innerBoundsPx().w}px; height: ${innerBoundsPx().h}px; ` +
                     'background-color: #dddddd88;'} />
      </Show>;

    const renderIsLinkMaybe = () =>
      <Show when={props.visualElement.linkItemMaybe != null}>
        <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`} />
      </Show>;

    return (
      <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.0)}; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
          {renderBoxTitle()}
          {renderHoverOverMaybe()}
          {renderMovingOverMaybe()}
          {renderMovingOverAttachMaybe()}
          {renderPopupSelectedOverlayMaybe()}
          <For each={props.visualElement.attachmentsVes}>{attachmentVe =>
            <VisualElement_Desktop visualElement={attachmentVe.get()} />
          }</For>
          {renderIsLinkMaybe()}
        </Show>
      </div>
    );
  }


  // ## Translucent

  let translucentDiv: HTMLDivElement | undefined;
  let updatingTranslucentScrollTop = false;
  createEffect(() => {
    // occurs on page arrange algorithm change.
    if (!childAreaBoundsPx()) { return; }

    updatingTranslucentScrollTop = true;
    if (translucentDiv) {
      translucentDiv.scrollTop =
        store.perItem.getPageScrollYProp(VeFns.veidFromVe(props.visualElement)) *
        (childAreaBoundsPx().h - props.visualElement.boundsPx.h);
      translucentDiv.scrollLeft =
        store.perItem.getPageScrollXProp(VeFns.veidFromVe(props.visualElement)) *
        (childAreaBoundsPx().w - props.visualElement.boundsPx.w);
    }

    setTimeout(() => {
      updatingTranslucentScrollTop = false;
    }, 0);
  });

  const renderAsTranslucent = () => {
    const translucentTitleInBoxScale = createMemo((): number => calcTitleInBoxScale("lg"));

    const translucentScrollHandler = (_ev: Event) => {
      if (!translucentDiv) { return; }
      if (updatingTranslucentScrollTop) { return; }

      const pageBoundsPx = props.visualElement.boundsPx;
      const childAreaBounds = childAreaBoundsPx();
      const pageVeid = VeFns.veidFromVe(props.visualElement);

      if (childAreaBounds.h > pageBoundsPx.h) {
        const scrollYProp = translucentDiv!.scrollTop / (childAreaBounds.h - pageBoundsPx.h);
        store.perItem.setPageScrollYProp(pageVeid, scrollYProp);
      }
    };

    const renderListPage = () =>
      <>
        <div class="absolute border-r border-slate-700"
             style={`overflow-y: auto; overflow-x: hidden; ` +
                    `width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL * listViewScale()}px; ` +
                    `height: ${boundsPx().h}px; ` +
                    `left: ${boundsPx().x}px; ` +
                    `top: ${boundsPx().y}px; ` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
          <div class="absolute"
               style={`width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; ` +
                      `height: ${LINE_HEIGHT_PX * lineVes().length}px`}>
            <For each={lineVes()}>{childVe =>
              <VisualElement_LineItem visualElement={childVe.get()} />
            }</For>
          </div>
        </div>
        <div ref={translucentDiv}
             class={`absolute`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
          <For each={desktopVes()}>{childVe =>
            <VisualElement_Desktop visualElement={childVe.get()} />
          }</For>
          <Show when={props.visualElement.selectedVes != null}>
            <VisualElement_Desktop visualElement={props.visualElement.selectedVes!.get()} />
          </Show>
        </div>
      </>;

    const renderPage = () =>
      <div ref={translucentDiv}
           class={`absolute border border-slate-700 rounded-sm shadow-lg`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `background-color: #ffffff; ` +
                  `overflow-y: ${boundsPx().h < childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                  `overflow-x: ${boundsPx().w < childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}
           onscroll={translucentScrollHandler}>
        <div class="absolute"
             style={`left: ${0}px; top: ${0}px; ` +
                    `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
          <For each={props.visualElement.childrenVes}>{childVe =>
            <VisualElement_Desktop visualElement={childVe.get()} />
          }</For>
        </div>
      </div>;

    const renderBoxTitleMaybe = () =>
      <Show when={!(props.visualElement.flags & VisualElementFlags.ListPageRoot)}>
        <div class="absolute flex items-center justify-center pointer-events-none"
            style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
          <div class="flex items-center text-center text-xl font-bold text-white pointer-events-none"
              style={`transform: scale(${translucentTitleInBoxScale()}); transform-origin: center center;`}>
            {pageItem().title}
          </div>
        </div>
      </Show>;

    const renderHoverOverMaybe = () =>
      <Show when={props.visualElement.mouseIsOver.get() && !store.anItemIsMoving.get()}>
        <div class={`absolute rounded-sm pointer-events-none`}
             style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                    `background-color: #ffffff33;`} />
        <Show when={hasPopupClickBoundsPx()}>
          <div class={`absolute rounded-sm pointer-events-none`}
               style={`left: ${popupClickBoundsPx()!.x}px; top: ${popupClickBoundsPx()!.y}px; width: ${popupClickBoundsPx()!.w}px; height: ${popupClickBoundsPx()!.h}px; ` +
                      `background-color: #ffffff55;`} />
        </Show>
      </Show>;

    const renderMovingOverMaybe = () =>
      <Show when={props.visualElement.movingItemIsOver.get()}>
        <div class={`absolute rounded-sm pointer-events-none`}
             style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                    `background-color: #ffffff33;`} />
      </Show>;

    const renderMovingOverAttachMaybe = () =>
      <Show when={props.visualElement.movingItemIsOverAttach.get()}>
        <div class={`absolute rounded-sm pointer-events-none`}
             style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                    `background-color: #ff0000;`} />
      </Show>;

    const renderPopupSelectedOverlayMaybe = () =>
      <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || isPoppedUp()}>
        <div class="absolute pointer-events-none"
             style={`left: ${innerBoundsPx().x}px; top: ${innerBoundsPx().y}px; width: ${innerBoundsPx().w}px; height: ${innerBoundsPx().h}px; ` +
                    `background-color: #dddddd88;`} />
      </Show>;

    const renderIsLinkMaybe = () =>
      <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
        <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`} />
      </Show>;

    return (
      <>
        <Switch>
          <Match when={pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
            {renderListPage()}
          </Match>
          <Match when={pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
            {renderPage()}
          </Match>
        </Switch>
        <div class={`absolute border border-slate-700 rounded-sm pointer-events-none`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.636)};` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
          {renderHoverOverMaybe()}
          {renderMovingOverMaybe()}
          {renderMovingOverAttachMaybe()}
          {renderPopupSelectedOverlayMaybe()}
          <For each={props.visualElement.attachmentsVes}>{attachmentVe =>
            <VisualElement_Desktop visualElement={attachmentVe.get()} />
          }</For>
          {renderIsLinkMaybe()}
        </div>
        {renderBoxTitleMaybe()}
      </>
    );
  }


  // ## Popup

  let popupDiv: HTMLDivElement | undefined;
  let updatingPopupScrollTop = false;
  createEffect(() => {
    // occurs on page arrange algorithm change.
    if (!childAreaBoundsPx()) { return; }

    updatingPopupScrollTop = true;

    if (popupDiv && store.history.currentPopupSpec()) {
      popupDiv.scrollTop =
        store.perItem.getPageScrollYProp(VeFns.veidFromPath(store.history.currentPopupSpec()!.vePath)) *
        (childAreaBoundsPx().h - props.visualElement.viewportBoundsPx!.h);
      popupDiv.scrollLeft =
        store.perItem.getPageScrollXProp(VeFns.veidFromPath(store.history.currentPopupSpec()!.vePath)) *
        (childAreaBoundsPx().w - props.visualElement.viewportBoundsPx!.w);
    }

    setTimeout(() => {
      updatingPopupScrollTop = false;
    }, 0);
  });

  const renderAsPopup = () => {
    const borderColorVal = () => {
      if (props.visualElement.flags & VisualElementFlags.HasToolbarFocus) {
        return HighlightColor;
      }
      return `${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.75)}; `
    };

    const popupScrollHandler = (_ev: Event) => {
      if (!popupDiv) { return; }
      if (updatingPopupScrollTop) { return; }

      const viewportBoundsPx = props.visualElement.viewportBoundsPx!;
      const childAreaBoundsPx_ = childAreaBoundsPx();
      const popupVeid = VeFns.veidFromPath(store.history.currentPopupSpec()!.vePath);

      if (childAreaBoundsPx_.h > viewportBoundsPx.h) {
        const scrollYProp = popupDiv!.scrollTop / (childAreaBoundsPx_.h - viewportBoundsPx.h);
        store.perItem.setPageScrollYProp(popupVeid, scrollYProp);
      }
    };

    const renderShadow = () =>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} text-xl font-bold rounded-md p-8 blur-md`}
           style={`left: ${boundsPx().x - 10}px; ` +
                  `top: ${boundsPx().y-10 + (props.visualElement.flags & VisualElementFlags.Fixed ? TOP_TOOLBAR_HEIGHT_PX : 0)}px; ` +
                  `width: ${boundsPx().w+20}px; height: ${boundsPx().h+20}px; ` +
                  `background-color: #303030d0;` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}>
      </div>;

    const renderPopupTitle = () =>
      <div class={`absolute`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h - viewportBoundsPx().h}px; ` +
                  `background-color: #fff; ` +
                  `${VeFns.zIndexStyle(props.visualElement)}` +
                  `background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.9)};`}>
        <div class="absolute font-bold"
              style={`left: 0px; top: ${(boundsPx().h - viewportBoundsPx().h) / scale() * 0.05}px; width: ${boundsPx().w / scale() * 0.9}px; height: ${(boundsPx().h - viewportBoundsPx().h) / scale() * 0.9}px; ` +
                     `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${scale() * 0.9}); transform-origin: top left; ` +
                     `overflow-wrap: break-word; padding-left: 4px;`}>
          {pageItem().title}
        </div>
      </div>;

    const renderListPage = () =>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"}`}
           style={`width: ${viewportBoundsPx().w}px; ` +
                  `height: ${viewportBoundsPx().h + (props.visualElement.flags & VisualElementFlags.Fixed ? TOP_TOOLBAR_HEIGHT_PX : 0)}px; ` +
                  `left: ${viewportBoundsPx().x}px; top: ${viewportBoundsPx().y}px; ` +
                  `background-color: #ffffff;` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}>
        <div ref={popupDiv}
             class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} border-r border-slate-700`}
             style={`overflow-y: auto; overflow-x: hidden; ` +
                    `width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL * listViewScale()}px; ` +
                    `height: ${viewportBoundsPx().h}px; ` +
                    `background-color: #ffffff;` +
                    `${VeFns.zIndexStyle(props.visualElement)}`}>
          <div class="absolute"
               style={`width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; height: ${LINE_HEIGHT_PX * lineVes().length}px`}>
            <For each={lineVes()}>{childVe =>
              <VisualElement_LineItem visualElement={childVe.get()} />
            }</For>
          </div>
        </div>
        <For each={desktopVes()}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
        <Show when={props.visualElement.selectedVes != null}>
          <VisualElement_Desktop visualElement={props.visualElement.selectedVes!.get()} />
        </Show>
      </div>;

    const renderPage = () =>
      <div ref={popupDiv}
           class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} border-t border-slate-300`}
           style={`left: ${viewportBoundsPx().x}px; ` +
                  `top: ${viewportBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? TOP_TOOLBAR_HEIGHT_PX : 0)}px; ` +
                  `width: ${viewportBoundsPx().w}px; height: ${viewportBoundsPx().h}px; ` +
                  `background-color: #ffffff;` +
                  `overflow-y: ${viewportBoundsPx().h < childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                  `overflow-x: ${viewportBoundsPx().w < childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}
           onscroll={popupScrollHandler}>
        <div class="absolute"
             style={`left: ${viewportBoundsPx().w - childAreaBoundsPx().w}px; ` +
                    `top: ${0}px; ` +
                    `width: ${childAreaBoundsPx().w}px; ` +
                    `height: ${childAreaBoundsPx().h}px;`}>
          <For each={props.visualElement.childrenVes}>{childVe =>
            <VisualElement_Desktop visualElement={childVe.get()} />
          }</For>
        </div>
      </div>;

    const renderAnchorMaybe = () =>
      <Show when={PageFns.popupPositioningHasChanged(parentPage())}>
        <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm text-gray-100`}
             style={`left: ${boundsPx().x + boundsPx().w - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX}px; ` +
                    `top: ${boundsPx().y + boundsPx().h - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX + (props.visualElement.flags & VisualElementFlags.Fixed ? TOP_TOOLBAR_HEIGHT_PX : 0)}px; ` +
                    `width: ${ANCHOR_BOX_SIZE_PX}px; ` +
                    `height: ${ANCHOR_BOX_SIZE_PX}px; ` +
                    `background-color: #ff0000;` +
                    `${VeFns.zIndexStyle(props.visualElement)}`}>
          <div class={`absolute`} style={"cursor: pointer;"}>
            <i class={`fa fa-anchor`} />
          </div>
        </div>
      </Show>;

    const renderBorder = () =>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} border pointer-events-none`}
           style={`left: ${boundsPx().x}px; ` +
                  `top: ${boundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? TOP_TOOLBAR_HEIGHT_PX : 0)}px; ` +
                  `border-color: ${borderColorVal()}; ` +
                  `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `${VeFns.zIndexStyle(props.visualElement)}`} />;

    return (
      <>
        {renderShadow()}
        <Switch>
          <Match when={pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
            {renderListPage()}
          </Match>
          <Match when={pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
            {renderPage()}
          </Match>
        </Switch>
        {renderAnchorMaybe()}
        {renderPopupTitle()}
        {renderBorder()}
      </>
    );
  }


  // ## Root

  const renderAsRoot = () => {

    const renderIsPublicBorder = () =>
      <Show when={isPublic() && store.user.getUserMaybe() != null}>
        <div class="w-full h-full" style="border-width: 3px; border-color: #ff0000;" />
      </Show>;

    const renderEmbededInteractiveBackgroundMaybe = () =>
      <Show when={isEmbeddedInteractive()}>
        <div class="absolute w-full"
             style={`border-width: 1px; border-color: ${Colors[pageItem().backgroundColorIndex]}; ` +
                    `background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.95)}; ` +
                    `top: ${boundsPx().h - viewportBoundsPx().h}px; bottom: ${0}px;`} />
      </Show>;

    const renderEmbededInteractiveForegroundMaybe = () =>
      <Show when={isEmbeddedInteractive()}>
        <div class="absolute w-full pointer-events-none"
             style={`z-index: ${Z_INDEX_ITEMS}; border-width: 1px; ` +
                    `border-color: ${Colors[pageItem().backgroundColorIndex]}; ` +
                    `top: ${boundsPx().h - viewportBoundsPx().h}px; bottom: ${0}px;`} />
      </Show>;

    const renderEmbededInteractiveTitleMaybe = () =>
      <Show when={isEmbeddedInteractive()}>
        <div class={`absolute`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h - viewportBoundsPx().h}px;`}>
          <div class="absolute font-bold"
               style={`left: 0px; top: 0px; width: ${boundsPx().w / scale()}px; height: ${(boundsPx().h - viewportBoundsPx().h) / scale()}px; ` +
                      `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${scale()}); transform-origin: top left; ` +
                      `overflow-wrap: break-word;`}>
            {pageItem().title}
          </div>
        </div>
      </Show>;

    const renderListPage = () =>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
           style={`width: ${viewportBoundsPx().w}px; ` +
                  `height: ${viewportBoundsPx().h + (props.visualElement.flags & VisualElementFlags.Fixed ? TOP_TOOLBAR_HEIGHT_PX : 0)}px; left: 0px; ` +
                  `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? TOP_TOOLBAR_HEIGHT_PX : 0) + (boundsPx().h - viewportBoundsPx().h)}px; ` +
                  `background-color: #ffffff;` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}>
        <div ref={rootDiv}
             class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} border-r border-slate-300`}
             style={`overflow-y: auto; ` +
                    `width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; ` +
                    `height: ${viewportBoundsPx().h}px; ` +
                    `background-color: #ffffff;` +
                    `${VeFns.zIndexStyle(props.visualElement)}`}>
          <div class="absolute"
               style={`width: ${LINE_HEIGHT_PX * LIST_PAGE_LIST_WIDTH_BL}px; height: ${LINE_HEIGHT_PX * lineVes().length}px`}>
            <For each={lineVes()}>{childVe =>
              <VisualElement_LineItem visualElement={childVe.get()} />
            }</For>
          </div>
        </div>
        <Show when={props.visualElement.dockVes != null}>
          <VisualElement_Desktop visualElement={props.visualElement.dockVes!.get()} />
        </Show>
        <For each={desktopVes()}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
        <Show when={props.visualElement.selectedVes != null}>
          <VisualElement_Desktop visualElement={props.visualElement.selectedVes!.get()} />
        </Show>
        <Show when={props.visualElement.popupVes != null}>
          <VisualElement_Desktop visualElement={props.visualElement.popupVes!.get()} />
        </Show>
      </div>;

    const rootScrollHandler = (_ev: Event) => {
      if (!rootDiv) { return; }

      const pageBoundsPx = props.visualElement.childAreaBoundsPx!;
      const desktopSizePx = props.visualElement.boundsPx;

      let veid = store.history.currentPage()!;
      if (props.visualElement.flags & VisualElementFlags.EmbededInteractiveRoot) {
        veid = VeFns.actualVeidFromVe(props.visualElement);
      } else if (props.visualElement.parentPath != TOP_LEVEL_PAGE_UID) {
        const parentVeid = VeFns.actualVeidFromPath(props.visualElement.parentPath!);
        const selectedPath = store.perItem.getSelectedListPageItem(parentVeid);
        veid = VeFns.veidFromPath(selectedPath);
      }

      if (desktopSizePx.w < pageBoundsPx.w) {
        const scrollXProp = rootDiv!.scrollLeft / (pageBoundsPx.w - desktopSizePx.w);
        store.perItem.setPageScrollXProp(veid, scrollXProp);
      }

      if (desktopSizePx.h < pageBoundsPx.h) {
        const scrollYProp = rootDiv!.scrollTop / (pageBoundsPx.h - desktopSizePx.h);
        store.perItem.setPageScrollYProp(veid, scrollYProp);
      }
    }

    const renderPage = () =>
      <div ref={rootDiv}
           class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
           style={`left: 0px; ` +
                  `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? TOP_TOOLBAR_HEIGHT_PX : 0) + (boundsPx().h - viewportBoundsPx().h)}px; ` +
                  `width: ${viewportBoundsPx().w}px; height: ${viewportBoundsPx().h}px; ` +
                  `overflow-y: ${viewportBoundsPx().h < childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                  `overflow-x: ${viewportBoundsPx().w < childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}
           onscroll={rootScrollHandler}>
        <div class="absolute"
             style={`left: 0px; top: 0px; ` +
                    `width: ${childAreaBoundsPx().w}px; ` +
                    `height: ${childAreaBoundsPx().h}px;`}>
          <Show when={props.visualElement.dockVes != null}>
            <VisualElement_Desktop visualElement={props.visualElement.dockVes!.get()} />
          </Show>
          <For each={props.visualElement.childrenVes}>{childVes =>
            <VisualElement_Desktop visualElement={childVes.get()} />
          }</For>
          <Show when={props.visualElement.popupVes != null}>
            <VisualElement_Desktop visualElement={props.visualElement.popupVes!.get()} />
          </Show>
          <Show when={isPage(VeFns.canonicalItem(props.visualElement)) && asPageItem(VeFns.canonicalItem(props.visualElement)).arrangeAlgorithm == ArrangeAlgorithm.Document}>
            <>
              <div class="absolute" style={`left: ${2.5 * LINE_HEIGHT_PX}px; top: 0px; width: 1px; height: ${childAreaBoundsPx().h}px; background-color: #eee;`} />
              <div class="absolute" style={`left: ${(asPageItem(VeFns.canonicalItem(props.visualElement)).docWidthBl + 3.5) * LINE_HEIGHT_PX}px; top: 0px; width: 1px; height: ${childAreaBoundsPx().h}px; background-color: #eee;`} />
            </>
          </Show>
        </div>
      </div>;

    return (
      <>
        <div class={`absolute`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `background-color: #ffffff;`}>
          {renderEmbededInteractiveBackgroundMaybe()}
          <Switch>
            <Match when={pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
              {renderListPage()}
            </Match>
            <Match when={pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
              {renderPage()}
            </Match>
          </Switch>
          {renderEmbededInteractiveForegroundMaybe()}
          {renderIsPublicBorder()}
        </div>
        {renderEmbededInteractiveTitleMaybe()}
      </>
    );
  }


  // # Top Level

  const renderAsTopLevel = () => {
    return (
      <>
        <div class={`absolute`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `background-color: #ffffff;`}>
          <Show when={props.visualElement.dockVes != null}>
            <VisualElement_Desktop visualElement={props.visualElement.dockVes!.get()} />
          </Show>
          <For each={props.visualElement.childrenVes}>{childVes =>
            <VisualElement_Desktop visualElement={childVes.get()} />
          }</For>
        </div>
      </>
    );
  }


  return (
    <Switch>
      <Match when={props.visualElement.flags & VisualElementFlags.TopLevelPage}>
        {renderAsTopLevel()}
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.IsDock}>
        {renderAsDock()}
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.IsTrash}>
        {renderAsTrash()}
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Popup}>
        {renderAsPopup()}
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.TopLevelRoot ||
                   props.visualElement.flags & VisualElementFlags.ListPageRoot ||
                   props.visualElement.flags & VisualElementFlags.EmbededInteractiveRoot}>
        {renderAsRoot()}
      </Match>
      <Match when={!(props.visualElement.flags & VisualElementFlags.Detailed) ||
                   !(props.visualElement.flags & VisualElementFlags.ShowChildren)}>
        {renderAsOpaque()}
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Detailed &&
                   props.visualElement.parentPath != null &&
                   props.visualElement.flags & VisualElementFlags.ShowChildren}>
        {renderAsTranslucent()}
      </Match>
    </Switch>
  );
}


export const Page_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const pageItem = () => asPageItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
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

  const isPoppedUp = () => VeFns.veToPath(props.visualElement) == store.history.currentPopupSpecVePath();

  const bgOpaqueVal = () => `background-image: linear-gradient(270deg, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.7)}, ${hexToRGBA(Colors[pageItem().backgroundColorIndex], 0.75)});`;

  const renderHighlightsMaybe = () => {
    // reverse engineer whether we're in a popup from the size of the OpenPopup vs Click hitbox widths.
    const openPopupBoundsPx = () => {
      const opb = props.visualElement.hitboxes.filter(hb => hb.type == HitboxFlags.OpenPopup)[0].boundsPx;
      const cb = props.visualElement.hitboxes.filter(hb => hb.type == HitboxFlags.Click)[0].boundsPx;
      if (opb.w > cb.w) { // in a popup.
        return boundsPx();
      } else {
        const r = cloneBoundingBox(boundsPx())!;
        r.w = oneBlockWidthPx();
        return r;
      }
    };
    return <Switch>
      <Match when={props.visualElement.mouseIsOverOpenPopup.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${openPopupBoundsPx().x+2}px; top: ${openPopupBoundsPx().y+2}px; width: ${openPopupBoundsPx().w-4}px; height: ${openPopupBoundsPx().h-4}px;`} />
      </Match>
      <Match when={!props.visualElement.mouseIsOverOpenPopup.get() && props.visualElement.mouseIsOver.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${boundsPx().x+2}px; top: ${boundsPx().y+2}px; width: ${boundsPx().w-4}px; height: ${boundsPx().h-4}px;`} />
      </Match>
      <Match when={(props.visualElement.flags & VisualElementFlags.Selected) || isPoppedUp()}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; ` +
                    `background-color: #dddddd88;`} />
      </Match>
    </Switch>;
  };

  const renderThumbnail = () =>
    <div class="absolute border border-slate-700 rounded-sm shadow-sm"
         style={`left: ${boundsPx().x + thumbBoundsPx().x}px; top: ${thumbBoundsPx().y}px; width: ${thumbBoundsPx().w}px; height: ${thumbBoundsPx().h}px; ` +
                bgOpaqueVal()} />;

  const renderText = () =>
    <div class="absolute overflow-hidden"
         style={`left: ${boundsPx().x + oneBlockWidthPx()}px; ` +
                `top: ${boundsPx().y}px; ` +
                `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; ` +
                `height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      {pageItem().title}
    </div>;

  return (
    <>
      {renderHighlightsMaybe()}
      {renderThumbnail()}
      {renderText()}
    </>
  );
}
