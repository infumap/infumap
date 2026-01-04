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
import { VesCache } from "../../layout/ves-cache";
import { useStore } from "../../store/StoreProvider";
import { ExpressionFns, asExpressionItem } from "../../items/expression-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { ItemFns } from "../../items/base/item-polymorphism";
import { itemState } from "../../store/ItemState";
import { asPageItem, isPage } from "../../items/page-item";
import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_HIGHLIGHT, Z_INDEX_POPUP, Z_INDEX_SHADOW } from "../../constants";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR } from "../../style";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { BoundingBox } from "../../util/geometry";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { FEATURE_COLOR } from "../../style";
import { isComposite } from "../../items/composite-item";
import { NoteFlags } from "../../items/base/flags-item";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { appendNewlineIfEmpty, trimNewline } from "../../util/string";
import { getCaretPosition, setCaretPosition } from "../../util/caret";
import { fullArrange } from "../../layout/arrange";
import { asLinkItem, isLink } from "../../items/link-item";
import { panic } from "../../util/lang";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Expression_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const isPopup = () => !(!(props.visualElement.flags & VisualElementFlags.Popup));
  const expressionItem = () => asExpressionItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const positionClass = () => (props.visualElement.flags & VisualElementFlags.Fixed) ? 'fixed' : 'absolute';
  const sizeBl = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      const cloned = ExpressionFns.asExpressionMeasurable(ItemFns.cloneMeasurableFields(props.visualElement.displayItem));
      const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath!);
      const parentDisplayItem = itemState.get(parentVeid.itemId)!;

      let parentTreeItem = VeFns.treeItemFromVeid(parentVeid);
      if (parentTreeItem == null) {
        // case where link is virtual (not in itemState). happens in list selected page case.
        parentTreeItem = itemState.get(parentVeid.itemId)!;
      }

      if (isPage(parentDisplayItem)) {
        cloned.spatialWidthGr = asPageItem(parentDisplayItem).docWidthBl * GRID_SIZE;
      } else {
        cloned.spatialWidthGr = isXSizableItem(parentTreeItem)
          ? asXSizableItem(parentTreeItem).spatialWidthGr
          : isLink(parentTreeItem)
            ? asLinkItem(parentTreeItem).spatialWidthGr
            : panic(`Expression sizeBl: parentTreeItem has unexpected type: ${parentTreeItem.itemType}`);
      }
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }
    if (props.visualElement.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(props.visualElement.linkItemMaybe!);
    }
    return ExpressionFns.calcSpatialDimensionsBl(expressionItem());
  };
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX * 2;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (boundsPx().w - NOTE_PADDING_PX * 2) / naturalWidthPx();
  const heightScale = () => (boundsPx().h - NOTE_PADDING_PX * 2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();
  const showTriangleDetail = () => (boundsPx().h / naturalHeightPx()) > 0.5;

  const attachBoundsPx = (): BoundingBox => {
    return ({
      x: boundsPx().w - ATTACH_AREA_SIZE_PX - 2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    });
  };
  const attachInsertBarPx = (): BoundingBox => {
    const innerSizeBl = sizeBl();
    const blockSizePx = boundsPx().w / innerSizeBl.w;
    const insertIndex = store.perVe.getMoveOverAttachmentIndex(vePath());
    // Special case for position 0: align with right edge of parent item
    const xOffset = insertIndex === 0 ? -4 : -2;
    return {
      x: boundsPx().w - insertIndex * blockSizePx + xOffset,
      y: -blockSizePx / 2,
      w: 4,
      h: blockSizePx,
    };
  };
  const attachCompositeBoundsPx = (): BoundingBox => {
    return ({
      x: 0,
      y: boundsPx().h - 1,
      w: boundsPx().w - 2,
      h: 1,
    });
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

  // Check if this expression is currently focused (via focusPath or textEditInfo)
  const isFocused = () => {
    const focusPath = store.history.getFocusPath();
    const textEditInfo = store.overlay.textEditInfo();
    return focusPath === vePath() || (textEditInfo != null && textEditInfo.itemPath === vePath());
  };

  const shadowOuterClass = () => {
    // Enhanced shadow when item is a popup OR focused
    if (isPopup() || isFocused()) {
      return `${positionClass()} border border-[#999] rounded-xs shadow-xl blur-md bg-slate-700 pointer-events-none`;
    }
    if (expressionItem().flags & NoteFlags.HideBorder) {
      if (store.perVe.getMouseIsOver(vePath())) {
        return `${positionClass()} border border-transparent rounded-xs shadow-xl`;
      } else {
        return `${positionClass()} border border-transparent rounded-xs`;
      }
    }
    return `${positionClass()} border border-transparent rounded-xs shadow-xl bg-white`;
  };

  const outerClass = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      return `${positionClass()} rounded-xs`;
    } else {
      if (expressionItem().flags & NoteFlags.HideBorder) {
        if (store.perVe.getMouseIsOver(vePath())) {
          return `${positionClass()} border border-[#999] rounded-xs hover:shadow-md`;
        } else {
          return `${positionClass()} border border-transparent rounded-xs`;
        }
      }
      return `${positionClass()} border border-[#999] rounded-xs bg-white hover:shadow-md`;
    }
  };

  const isInComposite = () =>
    isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId));

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    store.perVe.getMouseIsOver(vePath()) &&
    !store.anItemIsMoving.get() &&
    store.overlay.textEditInfo() == null &&
    isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId));

  const isInCompositeOrDocument = () =>
    (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) != 0;

  const inputListener = (_ev: InputEvent) => {
    setTimeout(() => {
      if (store.overlay.textEditInfo() && !store.overlay.toolbarPopupInfoMaybe.get()) {
        const editingItemPath = store.overlay.textEditInfo()!.itemPath;
        let editingDomId = editingItemPath + ":title";
        let el = document.getElementById(editingDomId);
        let newText = el!.innerText;
        let item = asExpressionItem(itemState.get(VeFns.veidFromPath(editingItemPath).itemId)!);
        item.title = trimNewline(newText);
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
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        store.overlay.setTextEditInfo(store.history, null, true);
        fullArrange(store);
        return;
    }
  }

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) &&
      !(props.visualElement.flags & VisualElementFlags.DockItem)}>
      <div class={`${shadowOuterClass()}`}
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y + ((props.visualElement.flags & VisualElementFlags.Fixed) ? store.topToolbarHeightPx() : 0)}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
          `z-index: ${isPopup() ? Z_INDEX_POPUP : Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
    </Show>;

  const renderDetailed = () =>
    <>
      <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute pointer-events-none rounded-xs"
          style={`left: 0px; top: 0px; ` +
            `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR}; ` +
            `z-index: ${Z_INDEX_HIGHLIGHT};`} />
      </Show>
      <Switch>
        <Match when={store.overlay.textEditInfo() == null || store.overlay.textEditInfo()!.itemPath != vePath()}>
          <span id={VeFns.veToPath(props.visualElement) + ":title"}
            class={"text-left"}
            style={`position: absolute; ` +
              `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
              `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * textBlockScale()}px; ` +
              `width: ${naturalWidthPx()}px; ` +
              `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; ` +
              `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
              `overflow-wrap: break-word; white-space: pre-wrap; ` +
              `outline: 0px solid transparent;`}>
            {appendNewlineIfEmpty(ExpressionFns.expressionFormatMaybe(props.visualElement.evaluatedTitle != null ? props.visualElement.evaluatedTitle : expressionItem().title, expressionItem().format))}
          </span>
        </Match>
        <Match when={store.overlay.textEditInfo() != null}>
          <span id={VeFns.veToPath(props.visualElement) + ":title"}
            class={"text-left"}
            style={`position: absolute; ` +
              `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
              `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * textBlockScale()}px; ` +
              `width: ${naturalWidthPx()}px; ` +
              `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; ` +
              `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
              `overflow-wrap: break-word; white-space: pre-wrap; ` +
              `outline: 0px solid transparent;`}
            contentEditable={!isInComposite() && store.overlay.textEditInfo() != null ? true : undefined}
            spellcheck={store.overlay.textEditInfo() != null}
            onKeyDown={keyDownHandler}
            onInput={inputListener}>
            {appendNewlineIfEmpty(expressionItem().title)}<span></span>
          </span>
        </Match>
      </Switch>
      <For each={VesCache.getAttachmentsVes(VeFns.veToPath(props.visualElement))()}>{attachment =>
        <VisualElement_Desktop visualElement={attachment.get()} />
      }</For>
      <Show when={showMoveOutOfCompositeArea()}>
        <div class={`absolute rounded-xs`}
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
      <Show when={store.perVe.getMovingItemIsOverAttach(vePath()) &&
        store.perVe.getMoveOverAttachmentIndex(vePath()) >= 0}>
        <div class={`absolute bg-black`}
          style={`left: ${attachInsertBarPx().x}px; top: ${attachInsertBarPx().y}px; ` +
            `width: ${attachInsertBarPx().w}px; height: ${attachInsertBarPx().h}px;`} />
      </Show>
      <Show when={store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
        <div class={`absolute border border-black`}
          style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px;`} />
      </Show>
    </>;

  return (
    <>
      {renderShadowMaybe()}
      <div class={`${outerClass()}`}
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y + ((props.visualElement.flags & VisualElementFlags.Fixed) ? store.topToolbarHeightPx() : 0)}px; width: ${boundsPx().w - (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc ? 2 : 0)}px; height: ${boundsPx().h}px; ` +
          `${VeFns.zIndexStyle(props.visualElement)}; ${VeFns.opacityStyle(props.visualElement)}; ` +
          `${!(props.visualElement.flags & VisualElementFlags.Detailed) ? 'background-color: #ddd; ' : 'background-color: #fff1e4;'}`}>
        <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
          {renderDetailed()}
        </Show>
      </div>
    </>
  );
}
