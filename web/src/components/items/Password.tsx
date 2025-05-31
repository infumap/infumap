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
import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX, PADDING_PROP, Z_INDEX_POPUP, Z_INDEX_SHADOW } from "../../constants";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { BoundingBox } from "../../util/geometry";
import { ItemFns } from "../../items/base/item-polymorphism";
import { PasswordFns, asPasswordItem } from "../../items/password-item";
import { useStore } from "../../store/StoreProvider";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { FEATURE_COLOR } from "../../style";
import { isComposite } from "../../items/composite-item";
import { itemState } from "../../store/ItemState";
import { appendNewlineIfEmpty, trimNewline } from "../../util/string";
import { getCaretPosition, setCaretPosition } from "../../util/caret";
import { fullArrange } from "../../layout/arrange";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Password: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const passwordItem = () => asPasswordItem(props.visualElement.displayItem);
  const isPopup = () => !(!(props.visualElement.flags & VisualElementFlags.Popup));
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w / 4.0,
      y: boundsPx().h - ATTACH_AREA_SIZE_PX,
      w: boundsPx().w / 2.0,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const moveOutOfCompositeBox = (): BoundingBox => {
    return ({
      x: boundsPx().w
          - COMPOSITE_MOVE_OUT_AREA_SIZE_PX
          - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
          - COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX
          - CONTAINER_IN_COMPOSITE_PADDING_PX,
      y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    });
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
  const showTriangleDetail = () => (boundsPx().h / naturalHeightPx()) > 0.5;

  const eatMouseEvent = (ev: MouseEvent) => { ev.stopPropagation(); }

  const copyClickHandler = () => {
    navigator.clipboard.writeText(passwordItem().text);
  }

  const isVisible = () => store.currentVisiblePassword.get() == passwordItem().id;
  const VisibleClickHandler = () => {
    if (!isVisible()) {
      store.currentVisiblePassword.set(passwordItem().id);
    } else {
      store.currentVisiblePassword.set(null);
    }
  }

  const isInComposite = () =>
    isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId));

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    store.perVe.getMouseIsOver(vePath()) &&
    !store.anItemIsMoving.get() &&
    store.overlay.textEditInfo() == null &&
    isInComposite();

  const isInCompositeOrDocument = () =>
    (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) != 0;

  const shadowOuterClass = () => {
    if (isPopup()) {
      return `absolute border border-[#999] rounded-sm shadow-xl blur-md bg-slate-700 pointer-events-none`;
    }
    return `absolute border border-[#999] rounded-sm shadow-xl bg-white`;
  };

  const outerClass = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      return 'absolute rounded-sm';
    } else {
      return `absolute border border-[#999] rounded-sm bg-white hover:shadow-md`;
    }
  };

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) &&
                !(props.visualElement.flags & VisualElementFlags.DockItem)}>
      <div class={`${shadowOuterClass()}`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `z-index: ${isPopup() ? Z_INDEX_POPUP : Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
    </Show>;

  const inputListener = (_ev: InputEvent) => {
    setTimeout(() => {
      if (store.overlay.textEditInfo() && !store.overlay.toolbarPopupInfoMaybe.get()) {
        const editingItemPath = store.overlay.textEditInfo()!.itemPath;
        let editingDomId = editingItemPath + ":title";
        let el = document.getElementById(editingDomId);
        let newText = el!.innerText;
        let item = asPasswordItem(itemState.get(VeFns.veidFromPath(editingItemPath).itemId)!);
        item.text = trimNewline(newText);
        const caretPosition = getCaretPosition(el!);
        fullArrange(store);
        setCaretPosition(el!, caretPosition);
      }
    }, 0);
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "Enter":
        ev.preventDefault();
        ev.stopPropagation();
        return;
    }
  }

  const renderDetailed = () =>
    <>
      <Switch>
        <Match when={!isVisible() && (store.overlay.textEditInfo() == null || store.overlay.textEditInfo()!.itemPath != vePath())}>
          <span id={VeFns.veToPath(props.visualElement) + ":title"}
                class={"text-left"}
                style={`position: absolute; ` +
                       `left: ${NOTE_PADDING_PX*textBlockScale()}px; ` +
                       `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4)*textBlockScale()}px; ` +
                       `width: ${naturalWidthPx()}px; ` +
                       `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; `+
                       `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                       `overflow-wrap: break-word; white-space: pre-wrap; ` +
                       `outline: 0px solid transparent;`}>
            ••••••••••••
          </span>
        </Match>
        <Match when={store.overlay.textEditInfo() != null || isVisible()}>
          <span id={VeFns.veToPath(props.visualElement) + ":title"}
                class={"text-left"}
                style={`position: absolute; ` +
                       `left: ${NOTE_PADDING_PX*textBlockScale()}px; ` +
                       `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4)*textBlockScale()}px; ` +
                       `width: ${naturalWidthPx()}px; ` +
                       `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; `+
                       `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                       `overflow-wrap: break-word; white-space: pre-wrap; ` +
                       `outline: 0px solid transparent;`}
                contentEditable={!isInComposite() && store.overlay.textEditInfo() != null ? true : undefined}
                spellcheck={store.overlay.textEditInfo() != null}
                onKeyDown={keyDownHandler}
                onInput={inputListener}>
            {appendNewlineIfEmpty(passwordItem().text)}<span></span>
          </span>
        </Match>
      </Switch>
      <div class="absolute text-center text-slate-600"
           style={`left: ${boundsPx().w - oneBlockWidthPx()*1.05}px; ` +
                  `top: ${boundsPx().h*PADDING_PROP}px; ` +
                  `width: ${oneBlockWidthPx() / smallScale()}px; ` +
                  `height: ${boundsPx().h/smallScale()}px; `+
                  `transform: scale(${smallScale()}); transform-origin: top left;`}
          onmousedown={eatMouseEvent}
          onmouseup={eatMouseEvent}
          onclick={copyClickHandler}>
        <i class={`fas fa-copy cursor-pointer`} />
      </div>
      <div class="absolute text-center text-slate-600"
           style={`left: ${boundsPx().w - oneBlockWidthPx()*1.8}px; top: ${boundsPx().h*PADDING_PROP}px; ` +
                  `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h/smallScale()}px; `+
                  `transform: scale(${smallScale()}); transform-origin: top left;`}
          onmousedown={eatMouseEvent}
          onmouseup={eatMouseEvent}
          onclick={VisibleClickHandler}>
        <i class={`fas ${isVisible() ? 'fa-eye-slash' : 'fa-eye'} cursor-pointer`} />
      </div>
      <For each={props.visualElement.attachmentsVes}>{attachment =>
        <VisualElement_Desktop visualElement={attachment.get()} />
      }</For>
      <Show when={showMoveOutOfCompositeArea()}>
        <div class={`absolute rounded-sm`}
             style={`left: ${moveOutOfCompositeBox().x}px; top: ${moveOutOfCompositeBox().y}px; width: ${moveOutOfCompositeBox().w}px; height: ${moveOutOfCompositeBox().h}px; ` +
                    `background-color: ${FEATURE_COLOR};`} />
      </Show>
      <Show when={props.visualElement.linkItemMaybe != null &&
                  (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
                  !(isPopup() && (props.visualElement.actualLinkItemMaybe == null)) &&
                  showTriangleDetail()}>
        <InfuLinkTriangle />
      </Show>
      <Show when={!isInCompositeOrDocument() && showTriangleDetail()}>
        <InfuResizeTriangle />
      </Show>
      <Show when={store.perVe.getMovingItemIsOverAttach(vePath())}>
        <div class={`absolute rounded-sm`}
             style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                    `background-color: ${FEATURE_COLOR};`} />
      </Show>
      <Show when={store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
        <div class={`absolute rounded-sm`}
             style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; ` +
                    `background-color: ${FEATURE_COLOR};`} />
      </Show>
    </>;

  return (
    <>
      {renderShadowMaybe()}
      <div class={outerClass()}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
          {renderDetailed()}
        </Show>
      </div>
    </>
  );
}
