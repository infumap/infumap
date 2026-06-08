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

import { Component, For, Show } from "solid-js";
import { VisualElementProps, VisualElement_Desktop } from "../VisualElement";
import { COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, Z_INDEX_LOCAL_HIGHLIGHT } from "../../constants";
import { BoundingBox } from "../../util/geometry";
import { CompositeFns, asCompositeItem } from "../../items/composite-item";
import { CompositeFlags } from "../../items/base/flags-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { VesCache } from "../../layout/ves-cache";
import { isPage } from "../../items/page-item";

import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { useStore } from "../../store/StoreProvider";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";
import { MouseAction, MouseActionState } from "../../input/state";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW } from "../../style";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle, shouldShowFocusRingForVisualElement } from "./helper";
import { stackedInsertionLineBoundsPx } from "../../layout/stacked-insertion";
import { LinearSelectionGapCover, linearSelectionGapAfterBoundsPx } from "./LinearSelectionGapCover";
import { appendNewlineIfEmpty } from "../../util/string";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { CompositeMoveOutHandle } from "./CompositeMoveOutHandle";
import { compositeMoveOutHitboxBoundsPx } from "../../layout/composite-move-out";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Composite_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const isPopup = () => !(!(props.visualElement.flags & VisualElementFlags.Popup));
  const boundsPx = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);
  const compositeItem = () => asCompositeItem(props.visualElement.displayItem);
  const canEdit = () => itemCanEdit(compositeItem());
  const childVes = () => VesCache.render.getChildren(vePath())();
  const positionClass = () => (props.visualElement.flags & VisualElementFlags.Fixed) ? 'fixed' : 'absolute';
  const showTitle = () => CompositeFns.showTitle(compositeItem());
  const compositeSizeBl = () => CompositeFns.calcSpatialDimensionsBl(compositeItem());
  const blockSizePx = () => props.visualElement.blockSizePx ?? {
    w: boundsPx().w / compositeSizeBl().w,
    h: boundsPx().h / compositeSizeBl().h,
  };
  const titleHeightPx = () => showTitle() ? blockSizePx().h : 0;
  const bodyTopPx = () => titleHeightPx();
  const bodyHeightPx = () => Math.max(0, boundsPx().h - bodyTopPx());
  const titleScale = () => titleHeightPx() / LINE_HEIGHT_PX;
  const titleEditIsActive = () => store.overlay.textEditInfo()?.itemPath == vePath();
  const isHighlighted = () =>
    !!(props.visualElement.flags & (VisualElementFlags.FindHighlighted | VisualElementFlags.SelectionHighlighted));
  const highlightColor = () =>
    (props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR;
  const linearTextEditIsActive = () => {
    const itemPath = store.overlay.textEditInfo()?.itemPath;
    return itemPath != null && VeFns.parentPath(itemPath) == vePath();
  };

  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: 0,
      y: boundsPx().h - 1,
      w: boundsPx().w - 2,
      h: 1,
    }
  };
  const moveOutOfCompositeBox = (): BoundingBox => {
    const fallbackBounds = {
      x: boundsPx().w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    };

    const moveHitbox = props.visualElement.hitboxes.find(hitbox => hitbox.meta?.compositeMoveOut);
    if (moveHitbox == null) {
      return fallbackBounds;
    }

    const handleBounds = {
      x: moveHitbox.boundsPx.x,
      y: moveHitbox.boundsPx.y,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: moveHitbox.boundsPx.h,
    };
    const handleHitbox = compositeMoveOutHitboxBoundsPx(handleBounds);
    handleBounds.x += moveHitbox.boundsPx.x - handleHitbox.x;
    return handleBounds;
  };

  const moveOverInsertLineBoundsPx = (): BoundingBox | null => {
    const moveOverIndex = store.perVe.getMoveOverIndex(vePath());
    const activeItemId = MouseActionState.isAction(MouseAction.Moving)
      ? MouseActionState.getActiveVisualElement()?.displayItem.id ?? null
      : null;
    const childVes = VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()
      .filter(childVe => childVe.get().displayItem.id !== activeItemId)
      .map(childVe => childVe.get());
    return stackedInsertionLineBoundsPx(childVes, Math.max(0, boundsPx().w - 2), moveOverIndex);
  };

  const showTriangleDetail = () => { return boundsPx().w / LINE_HEIGHT_PX > (0.5 * compositeItem().spatialWidthGr / GRID_SIZE); }

  const showBorder = () => !(compositeItem().flags & CompositeFlags.HideBorder);
  const isInCompositeOrDocument = () =>
    (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) != 0;
  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    store.perVe.getMouseIsOver(vePath()) &&
    !store.anItemIsMoving.get() &&
    store.overlay.textEditInfo() == null &&
    isInCompositeOrDocument();
  const isFocused = () => {
    const focusPath = store.history.getFocusPathMaybe();
    const textEditInfo = store.overlay.textEditInfo();
    return focusPath === vePath() || textEditInfo?.itemPath === vePath();
  };
  const activeChildPath = () => store.overlay.textEditInfo()?.itemPath ?? store.history.getFocusPathMaybe();
  const childFocusBoundsPx = (childBoundsPx: BoundingBox, isPageInComposite: boolean): BoundingBox =>
    isPageInComposite
      ? { x: 0, y: childBoundsPx.y, w: boundsPx().w, h: childBoundsPx.h }
      : childBoundsPx;

  const shadowClass = () => {
    if (isPopup()) {
      return `absolute border border-transparent rounded-xs overflow-hidden blur-md bg-slate-700 pointer-events-none`;
    }
    return `absolute border border-transparent rounded-xs shadow-xl overflow-hidden`;
  };

  const renderShadowMaybe = () =>
    <Show when={!props.suppressLocalShadow &&
      !(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) && showBorder()}>
      <div class={shadowClass()}
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; z-index: 0;`} />
    </Show>;

  const renderFocusRingMaybe = () =>
    <Show when={isFocused() && shouldShowFocusRingForVisualElement(store, () => props.visualElement)}>
      <div class="absolute pointer-events-none rounded-xs"
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
          `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: 2;`} />
    </Show>;

  const keyUpHandler = (ev: KeyboardEvent) => {
    edit_keyUpHandler(store, ev);
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    edit_keyDownHandler(store, props.visualElement, ev);
  }

  const inputListener = (ev: InputEvent) => {
    edit_inputListener(store, ev);
  }

  const renderBodyFrame = () =>
    <div class={`absolute border ` +
      `${showBorder() ? "border-[#999]" : "border-transparent"} ` +
      `rounded-xs pointer-events-none`}
      style={`left: 0px; top: ${bodyTopPx()}px; width: ${boundsPx().w}px; height: ${bodyHeightPx()}px; ` +
        `background-color: ${!(props.visualElement.flags & VisualElementFlags.Detailed) ? "#eee" : "white"}; ` +
        `outline: 0px solid transparent; z-index: 0;`} />;

  const renderTitleMaybe = () =>
    <Show when={showTitle()}>
      <div id={VeFns.veToPath(props.visualElement) + ":title"}
        class={`absolute font-bold overflow-hidden ${titleEditIsActive() ? "select-text cursor-text" : ""}`}
        style={`left: 0px; top: 0px; width: ${boundsPx().w / titleScale()}px; height: ${titleHeightPx() / titleScale()}px; ` +
          `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${titleScale()}); transform-origin: top left; ` +
          `overflow-wrap: break-word; outline: 0px solid transparent; z-index: ${Z_INDEX_LOCAL_HIGHLIGHT + 2};`}
        contentEditable={canEdit() && titleEditIsActive()}
        spellcheck={canEdit() && titleEditIsActive()}
        onKeyUp={keyUpHandler}
        onKeyDown={keyDownHandler}
        onInput={inputListener}>
        {appendNewlineIfEmpty(compositeItem().title)}
      </div>
    </Show>;

  return (
    <div class={positionClass()}
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y + ((props.visualElement.flags & VisualElementFlags.Fixed) ? store.topToolbarHeightPx() : 0)}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
        `${desktopStackRootStyle(props.visualElement)}`}>
      {renderShadowMaybe()}
      <div class={`absolute ${props.suppressLocalShadow ? "" : "hover:shadow-md"}`}
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; z-index: 1; ` +
          `outline: 0px solid transparent; `}
        contentEditable={linearTextEditIsActive()}
        onKeyUp={keyUpHandler}
        onKeyDown={keyDownHandler}
        onInput={inputListener}>
        {renderBodyFrame()}
        {renderTitleMaybe()}
        <Show when={showTitle() && isHighlighted()}>
          <div class="absolute pointer-events-none rounded-xs"
            style={`left: 0px; top: 0px; ` +
              `width: ${boundsPx().w}px; height: ${titleHeightPx()}px; ` +
              `background-color: ${highlightColor()}; ` +
              `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
        </Show>
        <Show when={isHighlighted()}>
          <div class="absolute pointer-events-none rounded-xs"
            style={`left: 0px; top: ${bodyTopPx()}px; ` +
              `width: ${boundsPx().w}px; height: ${bodyHeightPx()}px; ` +
              `background-color: ${highlightColor()}; ` +
              `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
        </Show>
        <For each={childVes()}>{(childVe, index) => {
          const gapAfterBoundsPx = () => linearSelectionGapAfterBoundsPx(
            childVe.get().boundsPx,
            childVes()[index() + 1]?.get().boundsPx ?? null,
            boundsPx().w,
          );
          return (
            <>
              <VisualElement_Desktop visualElement={childVe.get()} suppressLocalShadow={props.suppressLocalShadow} />
              <Show when={activeChildPath() === VeFns.veToPath(childVe.get()) && shouldShowFocusRingForVisualElement(store, () => childVe.get())}>
                {(() => {
                  const focusBoundsPx = childFocusBoundsPx(childVe.get().boundsPx, isPage(childVe.get().displayItem));
                  return (
                    <div class="absolute pointer-events-none select-none"
                      contentEditable={false}
                      style={`left: ${focusBoundsPx.x}px; top: ${focusBoundsPx.y}px; ` +
                        `width: ${focusBoundsPx.w}px; height: ${focusBoundsPx.h}px; ` +
                        `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_HIGHLIGHT + 1};`} />
                  );
                })()}
              </Show>
              <LinearSelectionGapCover
                enabled={linearTextEditIsActive}
                boundsPx={gapAfterBoundsPx} />
            </>
          );
        }}</For>
        <Show when={store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
          <div class={`absolute border border-black`}
            style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px;`} />
        </Show>
        <Show when={showMoveOutOfCompositeArea()}>
          <CompositeMoveOutHandle boundsPx={moveOutOfCompositeBox()} active={store.perVe.getMouseIsOverCompositeMoveOut(vePath())} vePath={vePath()} />
        </Show>
        <Show when={store.perVe.getMovingItemIsOver(vePath()) &&
          moveOverInsertLineBoundsPx()}>
          {lineBoundsPx => (
            <div class="absolute pointer-events-none bg-black"
              style={`left: ${lineBoundsPx().x}px; top: ${lineBoundsPx().y - 1}px; width: ${lineBoundsPx().w}px; height: 2px;`} />
          )}
        </Show>
        <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
          !(isPopup() && (props.visualElement.actualLinkItemMaybe == null)) &&
          showTriangleDetail()}>
          <InfuLinkTriangle />
        </Show>
      </div>
      {renderFocusRingMaybe()}
      <Show when={showTriangleDetail()}>
        <div class="absolute border border-transparent pointer-events-none"
          style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; z-index: 3; outline: 0px solid transparent;`}>
          <div class="absolute"
            style={"width: 0px; height: 0px; bottom: 0px; right: 0px;"}>
            <InfuResizeTriangle />
          </div>
        </div>
      </Show>
      <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
        <div class="absolute pointer-events-none rounded-xs"
          style={autoMovedIntoViewWarningStyle(boundsPx().w, boundsPx().h)} />
      </Show>
    </div>
  );
};
