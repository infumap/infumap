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
import { ANCHOR_BOX_SIZE_PX, ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL, PADDING_PROP, RESIZE_BOX_SIZE_PX, Z_INDEX_ITEMS, Z_INDEX_SHADOW, Z_INDEX_SHOW_TOOLBAR_ICON } from "../../constants";
import { hexToRGBA } from "../../util/color";
import { borderColorForColorIdx, BorderType, Colors, FEATURE_COLOR, FEATURE_COLOR_DARK, LIGHT_BORDER_COLOR, linearGradient, mainPageBorderColor, mainPageBorderWidth } from "../../style";
import { useStore } from "../../store/StoreProvider";
import { VisualElement_Desktop, VisualElement_LineItem, VisualElementProps } from "../VisualElement";
import { ItemFns } from "../../items/base/item-polymorphism";
import { HitboxFlags } from "../../layout/hitbox";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { itemState } from "../../store/ItemState";
import { VisualElementFlags, VeFns } from "../../layout/visual-element";
import { PermissionFlags } from "../../items/base/permission-flags-item";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { UMBRELLA_PAGE_UID } from "../../util/uid";
import { fArrange } from "../../layout/arrange";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";
import { isComposite } from "../../items/composite-item";
import { appendNewlineIfEmpty } from "../../util/string";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  let rootDiv: HTMLDivElement | undefined;

  onMount(() => {
    let veid;
    let div;

    if (props.visualElement.flags & VisualElementFlags.Popup) {
      veid = store.history.currentPopupSpec()!.actualVeid;
      div = popupDiv;
    } else if (props.visualElement.flags & VisualElementFlags.ListPageRoot) {
      const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath!);
      veid = store.perItem.getSelectedListPageItem(parentVeid);
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
  const vePath = () => VeFns.veToPath(props.visualElement);
  const parentPage = () => {
    const parentId = VeFns.itemIdFromPath(props.visualElement.parentPath!);
    const parent = itemState.get(parentId)!;
    if (isPage(parent)) {
      return asPageItem(parent);
    }
    return null;
  };
  const parentPageArrangeAlgorithm = () => {
    const pp = parentPage();
    if (!pp) { return ArrangeAlgorithm.None; }
    return pp.arrangeAlgorithm;
  };
  const boundsPx = () => props.visualElement.boundsPx;
  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w / 4.0,
      y: boundsPx().h - ATTACH_AREA_SIZE_PX,
      w: boundsPx().w / 2.0,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
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
  const moveOutOfCompositeBox = (): BoundingBox => {
    return ({
      x: boundsPx().w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX - 2,
      y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    });
  };
  const isPoppedUp = () =>
    store.history.currentPopupSpecVeid() != null &&
    VeFns.compareVeids(VeFns.actualVeidFromVe(props.visualElement), store.history.currentPopupSpecVeid()!) == 0;

  const isPublic = () => pageItem().permissionFlags != PermissionFlags.None;
  const isEmbeddedInteractive = () => !!(props.visualElement.flags & VisualElementFlags.EmbededInteractiveRoot);
  const isDockItem = () => !!(props.visualElement.flags & VisualElementFlags.DockItem);

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

  const isInComposite = () =>
    isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId));

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    store.perVe.getMouseIsOver(vePath()) &&
    !store.anItemIsMoving.get() &&
    store.overlay.textEditInfo() == null &&
    isInComposite();

  const keyUpHandler = (ev: KeyboardEvent) => { }
  const keyDownHandler = (ev: KeyboardEvent) => { }
  const inputListener = (ev: InputEvent) => { }

  const renderGridlinesMaybe = () =>
    <Show when={pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid}>
      <For each={[...Array(pageItem().gridNumberOfColumns).keys()]}>{i =>
        <Show when={i != 0}>
          <div class="absolute bg-slate-100"
               style={`left: ${props.visualElement.cellSizePx!.w * i}px; height: ${childAreaBoundsPx().h}px; width: 1px; top: 0px;`} />
        </Show>
      }</For>
      <For each={[...Array(props.visualElement.numRows!).keys()]}>{i =>
        <div class="absolute bg-slate-100"
             style={`left: 0px; height: 1px; width: ${childAreaBoundsPx().w}px; top: ${props.visualElement.cellSizePx!.h * (i+1)}px;`} />
      }</For>
    </Show>;

  const showDock = () => {
    store.dockVisible.set(true);
    fArrange(store);
  }

  const renderAsDock = () => {
    return (
      <>
        <Show when={store.dockVisible.get()}>
          <div class={`absolute border-r`}
               style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                      `background-color: #ffffff; border-right-width: ${mainPageBorderWidth(store)}px; ` +
                      `border-color: ${mainPageBorderColor(store, itemState.get)}; `}>
            <For each={props.visualElement.childrenVes}>{childVe =>
              <VisualElement_Desktop visualElement={childVe.get()} />
            }</For>
          </div>
        </Show>
        <Show when={!store.dockVisible.get()}>
          <div class={`absolute`}
               style={`left: ${5}px; top: ${boundsPx().h - 30}px; z-index: ${Z_INDEX_SHOW_TOOLBAR_ICON};`}
               onmousedown={showDock}>
            <i class={`fa fa-chevron-right hover:bg-slate-300 p-[2px] text-xs ${!store.topToolbarVisible.get() ? 'text-white' : 'text-slate-400'}`} />
          </div>
        </Show>
      </>);
  }

  const renderAsTrash = () => {
    const trashFontSizePx = () => {
      return boundsPx().h * 0.65;
    }

    return (
      <div class={`absolute rounded-sm align-middle text-center`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `background-color: ${store.perVe.getMovingItemIsOver(vePath()) ? "#dddddd" : (store.perVe.getMouseIsOver(vePath()) ? "#eeeeee" : "#ffffff")}; ` +
                  `font-size: ${trashFontSizePx()}px;`}>
        <i class="fa fa-trash" />
      </div>);
  }


  // ## Opaque

  const renderAsOpaque = () => {
    const opaqueTitleInBoxScale = createMemo((): number => calcTitleInBoxScale("xs"));

    const renderBoxTitle = () =>
      <div id={VeFns.veToPath(props.visualElement) + ":title"}
           class={`flex font-bold text-white`}
           style={`left: ${boundsPx().x}px; ` +
                  `top: ${boundsPx().y}px; ` +
                  `width: ${boundsPx().w}px; ` +
                  `height: ${boundsPx().h}px;` +
                  `font-size: ${12 * opaqueTitleInBoxScale()}px; ` +
                  `justify-content: center; align-items: center; text-align: center;` +
                  `outline: 0px solid transparent;`}
           contentEditable={store.overlay.textEditInfo() != null}
           spellcheck={store.overlay.textEditInfo() != null}>
        {appendNewlineIfEmpty(pageItem().title)}
      </div>;

    const renderHoverOverMaybe = () =>
      <Show when={store.perVe.getMouseIsOver(vePath()) && !store.anItemIsMoving.get()}>
        <>
          <Show when={!isInComposite()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                        `background-color: #ffffff33;`} />
          </Show>
          <Show when={hasPopupClickBoundsPx()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${popupClickBoundsPx()!.x}px; top: ${popupClickBoundsPx()!.y}px; width: ${popupClickBoundsPx()!.w}px; height: ${popupClickBoundsPx()!.h}px; ` +
                        `background-color: ${isInComposite() ? '#ffffff33' : '#ffffff55'};`} />
          </Show>
        </>
      </Show>;

    const renderMovingOverMaybe = () =>
      <Show when={store.perVe.getMovingItemIsOver(vePath())}>
        <div class={'absolute rounded-sm'}
             style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                    'background-color: #ffffff33;'} />
      </Show>;

    const renderMovingOverAttachMaybe = () =>
      <Show when={store.perVe.getMovingItemIsOverAttach(vePath())}>
        <div class={'absolute rounded-sm'}
             style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                    'background-color: #ff0000;'} />
      </Show>;

    const renderMovingOverAttachCompositeMaybe = () =>
      <Show when={store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
        <div class={`absolute rounded-sm`}
             style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; ` +
                    `background-color: ${FEATURE_COLOR_DARK};`} />
      </Show>;

    const renderPopupSelectedOverlayMaybe = () =>
      <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || isPoppedUp()}>
        <div class='absolute'
             style={`left: ${innerBoundsPx().x}px; top: ${innerBoundsPx().y}px; width: ${innerBoundsPx().w}px; height: ${innerBoundsPx().h}px; ` +
                    'background-color: #dddddd88;'} />
      </Show>;

    const renderIsLinkMaybe = () =>
      <Show when={props.visualElement.linkItemMaybe != null}>
        <InfuLinkTriangle />
      </Show>;

    const renderShadowMaybe = () =>
      <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc)}>
        <div class={`absolute border border-transparent rounded-sm shadow-lg overflow-hidden`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
      </Show>;

    return (
      <>
        {renderShadowMaybe()}
        <div class={`absolute border border-slate-700 rounded-sm`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                    `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.0)}; ` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
          <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
            {renderBoxTitle()}
            {renderHoverOverMaybe()}
            {renderMovingOverMaybe()}
            {renderMovingOverAttachMaybe()}
            {renderMovingOverAttachCompositeMaybe()}
            {renderPopupSelectedOverlayMaybe()}
            <For each={props.visualElement.attachmentsVes}>{attachmentVe =>
              <VisualElement_Desktop visualElement={attachmentVe.get()} />
            }</For>
            <Show when={showMoveOutOfCompositeArea()}>
              <div class={`absolute rounded-sm`}
                   style={`left: ${moveOutOfCompositeBox().x}px; top: ${moveOutOfCompositeBox().y}px; width: ${moveOutOfCompositeBox().w}px; height: ${moveOutOfCompositeBox().h}px; ` +
                          `background-color: ${FEATURE_COLOR_DARK};`} />
            </Show>
            {renderIsLinkMaybe()}
            <InfuResizeTriangle />
          </Show>
        </div>
      </>
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
        <div class={`absolute ${borderClass()}`}
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
           class={`absolute ${borderClass()} rounded-sm`}
           style={`left: ${boundsPx().x}px; ` +
                  `top: ${boundsPx().y}px; ` +
                  `width: ${boundsPx().w}px; ` +
                  `height: ${boundsPx().h}px; ` +
                  `background-color: #ffffff; ` +
                  `overflow-y: ${boundsPx().h < childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                  `overflow-x: ${boundsPx().w < childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}
           onscroll={translucentScrollHandler}>
        <div class="absolute"
             style={`left: ${0}px; top: ${0}px; ` +
                    `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
          <For each={props.visualElement.childrenVes}>{childVes =>
            <VisualElement_Desktop visualElement={childVes.get()} />
          }</For>
        </div>
      </div>;

    const renderBoxTitleMaybe = () =>
      <Show when={!(props.visualElement.flags & VisualElementFlags.ListPageRoot)}>
        <div id={VeFns.veToPath(props.visualElement) + ":title"}
             class={`absolute flex font-bold text-white`}
             style={`left: ${boundsPx().x}px; ` +
                    `top: ${boundsPx().y}px; ` +
                    `width: ${boundsPx().w}px; ` +
                    `height: ${boundsPx().h}px;` +
                    `font-size: ${20 * translucentTitleInBoxScale()}px; ` +
                    `justify-content: center; align-items: center; text-align: center; ` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}` +
                    `outline: 0px solid transparent;`}
             spellcheck={store.overlay.textEditInfo() != null}
             contentEditable={store.overlay.textEditInfo() != null}>
            {pageItem().title}
        </div>
      </Show>;

    const renderHoverOverMaybe = () =>
      <Show when={store.perVe.getMouseIsOver(vePath()) && !store.anItemIsMoving.get()}>
        <>
          <Show when={!isInComposite()}>
            <div class={`absolute rounded-sm`}
                style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                        `background-color: #ffffff33;`} />
          </Show>
          <Show when={hasPopupClickBoundsPx()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${popupClickBoundsPx()!.x}px; top: ${popupClickBoundsPx()!.y}px; width: ${popupClickBoundsPx()!.w}px; height: ${popupClickBoundsPx()!.h}px; ` +
                        `background-color: ${isInComposite() ? '#ffffff33' : '#ffffff55'};`} />
          </Show>
        </>
      </Show>;

    const renderMovingOverMaybe = () =>
      <Show when={store.perVe.getMovingItemIsOver(vePath())}>
        <div class={`absolute rounded-sm pointer-events-none`}
             style={`left: ${clickBoundsPx()!.x}px; top: ${clickBoundsPx()!.y}px; width: ${clickBoundsPx()!.w}px; height: ${clickBoundsPx()!.h}px; ` +
                    `background-color: #ffffff33;`} />
      </Show>;

    const renderMovingOverAttachMaybe = () =>
      <Show when={store.perVe.getMovingItemIsOverAttach(vePath())}>
        <div class={`absolute rounded-sm pointer-events-none`}
             style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                    `background-color: #ff0000;`} />
      </Show>;

    const renderMovingOverAttachCompositeMaybe = () =>
      <Show when={store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
        <div class={`absolute rounded-sm`}
             style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; ` +
                    `background-color: ${FEATURE_COLOR};`} />
      </Show>;

    const renderPopupSelectedOverlayMaybe = () =>
      <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || isPoppedUp()}>
        <div class="absolute pointer-events-none"
             style={`left: ${innerBoundsPx().x}px; top: ${innerBoundsPx().y}px; width: ${innerBoundsPx().w}px; height: ${innerBoundsPx().h}px; ` +
                    `background-color: #dddddd88;`} />
      </Show>;

    const renderIsLinkMaybe = () =>
      <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
        <InfuLinkTriangle />
      </Show>;

    const backgroundStyle = () => parentPageArrangeAlgorithm() == ArrangeAlgorithm.List
        ? ''
        : `background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.636)};`;

    const borderClass = () => parentPageArrangeAlgorithm() == ArrangeAlgorithm.List
        ? ''
        : 'border border-slate-700';

    const renderShadowMaybe = () =>
      <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc)}>
        <div class={`absolute border border-transparent rounded-sm shadow-lg overflow-hidden`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
      </Show>;

    const renderResizeTriangle = () =>
      <div class={`absolute border border-transparent rounded-sm shadow-lg overflow-hidden`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `${VeFns.opacityStyle(props.visualElement)}; ${VeFns.zIndexStyle(props.visualElement)}`}>
          <InfuResizeTriangle />
      </div>;

    return (
      <>
        {renderShadowMaybe()}
        <Switch>
          <Match when={pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
            {renderListPage()}
          </Match>
          <Match when={pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
            {renderPage()}
          </Match>
        </Switch>
        {renderResizeTriangle()}
        <div class={`absolute ${borderClass()} rounded-sm`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    backgroundStyle() +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
          {renderHoverOverMaybe()}
          {renderMovingOverMaybe()}
          {renderMovingOverAttachMaybe()}
          {renderMovingOverAttachCompositeMaybe()}
          {renderPopupSelectedOverlayMaybe()}
          <For each={props.visualElement.attachmentsVes}>{attachmentVe =>
            <VisualElement_Desktop visualElement={attachmentVe.get()} />
          }</For>
          <Show when={showMoveOutOfCompositeArea()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${moveOutOfCompositeBox().x}px; top: ${moveOutOfCompositeBox().y}px; width: ${moveOutOfCompositeBox().w}px; height: ${moveOutOfCompositeBox().h}px; ` +
                        `background-color: ${FEATURE_COLOR};`} />
          </Show>
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
        store.perItem.getPageScrollYProp(store.history.currentPopupSpec()!.actualVeid) *
        (childAreaBoundsPx().h - props.visualElement.viewportBoundsPx!.h);
      popupDiv.scrollLeft =
        store.perItem.getPageScrollXProp(store.history.currentPopupSpec()!.actualVeid) *
        (childAreaBoundsPx().w - props.visualElement.viewportBoundsPx!.w);
    }

    setTimeout(() => {
      updatingPopupScrollTop = false;
    }, 0);
  });

  const renderAsPopup = () => {
    const borderColorVal = () => {
      if (props.visualElement.flags & VisualElementFlags.HasToolbarFocus) {
        return `${borderColorForColorIdx(pageItem().backgroundColorIndex, BorderType.Popup)}; `
      }
      return LIGHT_BORDER_COLOR;
    };

    const titleColor = () => `${hexToRGBA(Colors[pageItem().backgroundColorIndex], 1.0)}; `;

    const popupScrollHandler = (_ev: Event) => {
      if (!popupDiv) { return; }
      if (updatingPopupScrollTop) { return; }

      const viewportBoundsPx = props.visualElement.viewportBoundsPx!;
      const childAreaBoundsPx_ = childAreaBoundsPx();
      const popupVeid = store.history.currentPopupSpec()!.actualVeid;

      if (childAreaBoundsPx_.h > viewportBoundsPx.h) {
        const scrollYProp = popupDiv!.scrollTop / (childAreaBoundsPx_.h - viewportBoundsPx.h);
        store.perItem.setPageScrollYProp(popupVeid, scrollYProp);
      }
    };

    const renderShadow = () =>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} text-xl font-bold rounded-md p-8 blur-md`}
           style={`left: ${boundsPx().x - 10}px; ` +
                  `top: ${boundsPx().y-10 + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                  `width: ${boundsPx().w+20}px; height: ${boundsPx().h+20}px; ` +
                  `background-color: #606060e8;` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}>
      </div>;

    const renderPopupTitle = () =>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"}`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; width: ${boundsPx().w}px; height: ${boundsPx().h - viewportBoundsPx().h}px; ` +
                  `background-color: #fff; ` +
                  `${VeFns.zIndexStyle(props.visualElement)}` +
                  `background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.9)};`}>
        <div class="absolute font-bold"
              style={`left: 0px; top: ${(boundsPx().h - viewportBoundsPx().h) / scale() * 0.05}px; ` +
                     `width: ${boundsPx().w / scale() * 0.9}px; ` +
                     `height: ${(boundsPx().h - viewportBoundsPx().h) / scale() * 0.9}px; ` +
                     `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${scale() * 0.9}); ` +
                     `transform-origin: top left; ` +
                     `overflow-wrap: break-word; ` +
                     `padding-left: 4px; ` +
                     `margin-left: 3px;` +
                     `color: ${titleColor()}`}>
          {pageItem().title}
        </div>
      </div>;

    const renderListPage = () =>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"}`}
           style={`width: ${viewportBoundsPx().w}px; ` +
                  `height: ${viewportBoundsPx().h}px; ` +
                  `left: ${viewportBoundsPx().x}px; ` +
                  `top: ${viewportBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
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
                  `top: ${viewportBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
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
          {renderGridlinesMaybe()}
        </div>
      </div>;

    const renderAnchorMaybe = () =>
      <Show when={PageFns.popupPositioningHasChanged(parentPage())}>
        <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm text-gray-100`}
             style={`left: ${boundsPx().x + boundsPx().w - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX}px; ` +
                    `top: ${boundsPx().y + boundsPx().h - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
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
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} pointer-events-none`}
           style={`left: ${boundsPx().x}px; ` +
                  `top: ${boundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                  `border-width: 2px;` +
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

    const renderListPage = () =>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
           style={`width: ${viewportBoundsPx().w}px; ` +
                  `height: ${viewportBoundsPx().h + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; left: 0px; ` +
                  `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (boundsPx().h - viewportBoundsPx().h)}px; ` +
                  `background-color: #ffffff;` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}>
        <div ref={rootDiv}
             class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} ` +
                    `${props.visualElement.flags & VisualElementFlags.DockItem ? "" : "border-slate-300 border-r"}`}
             style={`overflow-y: auto; ` +
                    `width: ${viewportBoundsPx().w}px; ` +
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
        <Show when={props.visualElement.popupVes != null}>
          <VisualElement_Desktop visualElement={props.visualElement.popupVes!.get()} />
        </Show>
      </div>;

    const rootScrollHandler = (_ev: Event) => {
      if (!rootDiv) { return; }

      const pageBoundsPx = props.visualElement.childAreaBoundsPx!;
      const desktopSizePx = props.visualElement.boundsPx;

      let veid = store.history.currentPageVeid()!;
      if (props.visualElement.flags & VisualElementFlags.EmbededInteractiveRoot) {
        veid = VeFns.actualVeidFromVe(props.visualElement);
      } else if (props.visualElement.parentPath != UMBRELLA_PAGE_UID) {
        const parentVeid = VeFns.actualVeidFromPath(props.visualElement.parentPath!);
        veid = store.perItem.getSelectedListPageItem(parentVeid);
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
                  `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (boundsPx().h - viewportBoundsPx().h)}px; ` +
                  `width: ${viewportBoundsPx().w}px; height: ${viewportBoundsPx().h}px; ` +
                  `overflow-y: ${viewportBoundsPx().h < childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                  `overflow-x: ${viewportBoundsPx().w < childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}
           onscroll={rootScrollHandler}>
        <div class="absolute"
             style={`left: 0px; top: 0px; ` +
                    `width: ${childAreaBoundsPx().w}px; ` +
                    `height: ${childAreaBoundsPx().h}px;`}>
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
          {renderGridlinesMaybe()}
        </div>
      </div>;

    return (
      <>
        <div class={`absolute`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `background-color: #ffffff;`}>
          <Switch>
            <Match when={pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
              {renderListPage()}
            </Match>
            <Match when={pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
              {renderPage()}
            </Match>
          </Switch>
          {renderIsPublicBorder()}
        </div>
      </>
    );
  }


  // ## Embedded Root

  const renderAsEmbeddedRoot = () => {

    const borderStyle = () =>
      isDockItem()
        ? `border-color: ${Colors[pageItem().backgroundColorIndex]}; `
        : `border-width: 1px; border-color: ${Colors[pageItem().backgroundColorIndex]}; `;

    const renderEmbededInteractiveBackground = () =>
      <div class="absolute w-full"
           style={`background-image: ${linearGradient(pageItem().backgroundColorIndex, 0.95)}; ` +
                  `top: ${boundsPx().h - viewportBoundsPx().h}px; bottom: ${0}px;` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}` +
                  borderStyle()} />;

    const renderEmbededInteractiveForeground = () =>
      <div class="absolute w-full pointer-events-none"
           style={`${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}` +
                  `top: ${boundsPx().h - viewportBoundsPx().h}px; bottom: ${0}px;` +
                  borderStyle()} />;

    const renderEmbededInteractiveTitleMaybe = () =>
      <Show when={isEmbeddedInteractive()}>
        <div class={`absolute`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h - viewportBoundsPx().h}px;`}>
          <div class="absolute font-bold"
               style={`left: 0px; top: 0px; width: ${boundsPx().w / scale()}px; height: ${(boundsPx().h - viewportBoundsPx().h) / scale()}px; ` +
                      `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${scale()}); transform-origin: top left; ` +
                      `overflow-wrap: break-word;` +
                      `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
            {pageItem().title}
          </div>
        </div>
      </Show>;

    const renderListPage = () =>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
           style={`width: ${viewportBoundsPx().w}px; ` +
                  `height: ${viewportBoundsPx().h + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; left: 0px; ` +
                  `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (boundsPx().h - viewportBoundsPx().h)}px; ` +
                  `background-color: #ffffff;` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <div ref={rootDiv}
             class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} ` +
                    `${props.visualElement.flags & VisualElementFlags.DockItem ? "" : "border-slate-300 border-r"}`}
             style={`overflow-y: auto; ` +
                    `width: ${viewportBoundsPx().w}px; ` +
                    `height: ${viewportBoundsPx().h}px; ` +
                    `background-color: #ffffff;` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
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
        <Show when={props.visualElement.popupVes != null}>
          <VisualElement_Desktop visualElement={props.visualElement.popupVes!.get()} />
        </Show>
      </div>;

    const renderPage = () =>
      <div ref={rootDiv}
           class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
           style={`left: 0px; ` +
                  `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (boundsPx().h - viewportBoundsPx().h)}px; ` +
                  `width: ${viewportBoundsPx().w}px; height: ${viewportBoundsPx().h}px; ` +
                  `overflow-y: ${viewportBoundsPx().h < childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                  `overflow-x: ${viewportBoundsPx().w < childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <div class="absolute"
             style={`left: 0px; top: 0px; ` +
                    `width: ${childAreaBoundsPx().w}px; ` +
                    `height: ${childAreaBoundsPx().h}px;`}
             contentEditable={store.overlay.textEditInfo() != null && pageItem().arrangeAlgorithm == ArrangeAlgorithm.Document}
             onKeyUp={keyUpHandler}
             onKeyDown={keyDownHandler}
             onInput={inputListener}>
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
          {renderGridlinesMaybe()}
        </div>
      </div>;

    return (
      <>
        <div class={`absolute`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `background-color: #ffffff;`}>
          {renderEmbededInteractiveBackground()}
          <Switch>
            <Match when={pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
              {renderListPage()}
            </Match>
            <Match when={pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
              {renderPage()}
            </Match>
          </Switch>
          {renderEmbededInteractiveForeground()}
        </div>
        {renderEmbededInteractiveTitleMaybe()}
      </>
    );
  }


  // # Top Level

  const renderAsUmbrella = () => {
    return (
      <>
        <div class={`absolute`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `background-color: #ffffff;`}>
          <For each={props.visualElement.childrenVes}>{childVes =>
            <VisualElement_Desktop visualElement={childVes.get()} />
          }</For>
          <Show when={props.visualElement.dockVes != null}>
            <VisualElement_Desktop visualElement={props.visualElement.dockVes!.get()} />
          </Show>
        </div>
      </>
    );
  }


  return (
    <Switch>
      <Match when={props.visualElement.flags & VisualElementFlags.UmbrellaPage}>
        {renderAsUmbrella()}
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
                   props.visualElement.flags & VisualElementFlags.ListPageRoot}>
        {renderAsRoot()}
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.EmbededInteractiveRoot}>
        {renderAsEmbeddedRoot()}
      </Match>
      <Match when={!(props.visualElement.flags & VisualElementFlags.Detailed) ||
                   !(props.visualElement.flags & VisualElementFlags.ShowChildren)}>
        {renderAsOpaque()}
      </Match>
      <Match when={true}>
        {renderAsTranslucent()}
      </Match>
    </Switch>
  );
}


export const Page_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const pageItem = () => asPageItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
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

  const isPoppedUp = () =>
    store.history.currentPopupSpecVeid() != null &&
    VeFns.compareVeids(VeFns.actualVeidFromVe(props.visualElement), store.history.currentPopupSpecVeid()!) == 0;

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
    return (
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
        <Match when={(props.visualElement.flags & VisualElementFlags.Selected) || isPoppedUp()}>
          <div class="absolute"
              style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; ` +
                      `background-color: #dddddd88;`} />
        </Match>
      </Switch>);
  };

  const renderThumbnail = () =>
    <div class="absolute border border-slate-700 rounded-sm shadow-sm"
         style={`left: ${boundsPx().x + thumbBoundsPx().x}px; top: ${thumbBoundsPx().y}px; width: ${thumbBoundsPx().w}px; height: ${thumbBoundsPx().h}px; ` +
                bgOpaqueVal()} />;

  const renderExpandIcon = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment)}>
      <div class="absolute text-center text-slate-400"
           style={`left: ${boundsPx().x+boundsPx().w - oneBlockWidthPx()*0.85}px; top: ${boundsPx().y + boundsPx().h*PADDING_PROP}px; ` +
                  `width: ${oneBlockWidthPx() / smallScale() * 0.8}px; height: ${boundsPx().h / smallScale() * 0.8}px; `+
                  `transform: scale(${smallScale()}); transform-origin: top left;`}>
        <i class={`fas ${store.perVe.getIsExpanded(vePath()) ? 'fa-minus' : 'fa-plus'}`} />
      </div>
    </Show>;

  const renderText = () =>
    <div class="absolute overflow-hidden"
         style={`left: ${boundsPx().x + oneBlockWidthPx()}px; ` +
                `top: ${boundsPx().y}px; ` +
                `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; ` +
                `height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      {pageItem().title}<span></span>
    </div>;

  const renderLinkMarkingMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
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
      {renderThumbnail()}
      {renderText()}
      {renderExpandIcon()}
      {renderLinkMarkingMaybe()}
    </>
  );
}
