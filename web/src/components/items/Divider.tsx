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

import { Component, Show } from "solid-js";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { asDividerItem } from "../../items/divider-item";
import { COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, LINE_HEIGHT_PX, Z_INDEX_LOCAL_OVERLAY } from "../../constants";
import { HitboxFlags } from "../../layout/hitbox";
import { VisualElementProps } from "../VisualElement";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { useStore } from "../../store/StoreProvider";
import { FIND_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW, SELECTION_HIGHLIGHT_COLOR } from "../../style";
import { BoundingBox } from "../../util/geometry";
import { CompositeMoveOutHandle } from "./CompositeMoveOutHandle";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle, documentPageMoveOutBoxPxMaybe, parentDocumentPageMaybe, shouldShowFocusRingForVisualElement } from "./helper";


const DIVIDER_COLOR = "#64748b";
const DIVIDER_HOVER_BG = "#0044ff0a";
const DIVIDER_LINE_WIDTH_PX = 1;

export const Divider_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const dividerItem = () => asDividerItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;
  const canEdit = () => itemCanEdit(dividerItem());
  const isInDocumentPage = () => {
    return parentDocumentPageMaybe(props.visualElement) != null;
  };
  const isHorizontal = () => isInDocumentPage() || dividerItem().dividerDirection == "horizontal";
  const hasResizeHitbox = () => props.visualElement.hitboxes.some(hitbox => (hitbox.type & HitboxFlags.Resize) != 0);

  const moveOutOfCompositeBox = (): BoundingBox => {
    const documentBox = documentPageMoveOutBoxPxMaybe(props.visualElement);
    if (documentBox != null) { return documentBox; }
    return {
      x: boundsPx().w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    };
  };

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    store.perVe.getMouseIsOver(vePath()) &&
    !store.anItemIsMoving.get() &&
    store.overlay.textEditInfo() == null &&
    (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) != 0;

  const renderLine = () =>
    <Show
      when={isHorizontal()}
      fallback={
        <div class="absolute pointer-events-none"
          style={`left: ${Math.max(0, boundsPx().w / 2 - DIVIDER_LINE_WIDTH_PX / 2)}px; top: 2px; ` +
            `width: ${DIVIDER_LINE_WIDTH_PX}px; height: ${Math.max(0, boundsPx().h - 4)}px; background-color: ${DIVIDER_COLOR};`} />
      }>
      <div class="absolute pointer-events-none"
        style={`left: 2px; top: ${Math.max(0, boundsPx().h / 2 - DIVIDER_LINE_WIDTH_PX / 2)}px; ` +
          `width: ${Math.max(0, boundsPx().w - 4)}px; height: ${DIVIDER_LINE_WIDTH_PX}px; background-color: ${DIVIDER_COLOR};`} />
    </Show>;

  const renderBoundsHighlightMaybe = () =>
    <Show when={store.perVe.getMouseIsOver(vePath()) || store.history.getFocusPathMaybe() === vePath()}>
      <div class="absolute border border-slate-300 rounded-xs pointer-events-none"
        style={`left: 1px; top: 1px; width: ${Math.max(0, boundsPx().w - 2)}px; height: ${Math.max(0, boundsPx().h - 2)}px; ` +
          `z-index: ${Z_INDEX_LOCAL_OVERLAY}; background-color: ${DIVIDER_HOVER_BG};`} />
    </Show>;

  const renderFocusRingMaybe = () =>
    <Show when={store.history.getFocusPathMaybe() === vePath() && shouldShowFocusRingForVisualElement(store, () => props.visualElement)}>
      <div class="absolute pointer-events-none"
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
          `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_OVERLAY};`} />
    </Show>;

  return (
    <div class="absolute"
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
        `${desktopStackRootStyle(props.visualElement)}`}>
      <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute pointer-events-none rounded-xs"
          style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR};`} />
      </Show>
      {renderBoundsHighlightMaybe()}
      {renderLine()}
      <Show when={showMoveOutOfCompositeArea()}>
        <CompositeMoveOutHandle boundsPx={moveOutOfCompositeBox()} active={store.perVe.getMouseIsOverCompositeMoveOut(vePath())} vePath={vePath()} />
      </Show>
      <Show when={props.visualElement.linkItemMaybe != null &&
        (props.visualElement.flags & VisualElementFlags.Detailed &&
          (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)) &&
        showTriangleDetail()}>
        <InfuLinkTriangle />
      </Show>
      <Show when={canEdit() && showTriangleDetail() && hasResizeHitbox() && store.perVe.getMouseIsOver(vePath())}>
        <InfuResizeTriangle />
      </Show>
      {renderFocusRingMaybe()}
      <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
        <div class="absolute pointer-events-none rounded-xs"
          style={autoMovedIntoViewWarningStyle(boundsPx().w, boundsPx().h)} />
      </Show>
    </div>
  );
}
