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
import { useStore } from "../../store/StoreProvider";
import { ExpressionFns, asExpressionItem } from "../../items/expression-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { ItemFns } from "../../items/base/item-polymorphism";
import { itemState } from "../../store/ItemState";
import { asPageItem, isPage } from "../../items/page-item";
import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_SHADOW } from "../../constants";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { BoundingBox } from "../../util/geometry";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { getTextStyleForNote } from "../../layout/text";
import { isNumeric } from "../../util/math";
import { FEATURE_COLOR } from "../../style";
import { isComposite } from "../../items/composite-item";
import { NoteFlags } from "../../items/base/flags-item";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Expression_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const expressionItem = () => asExpressionItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const sizeBl = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      const cloned = ExpressionFns.asExpressionMeasurable(ItemFns.cloneMeasurableFields(props.visualElement.displayItem));
      const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath!);
      const parentDisplayItem = itemState.get(parentVeid.itemId)!;

      let parentCanonicalItem = VeFns.canonicalItemFromVeid(parentVeid);
      if (parentCanonicalItem == null) {
        // case where link is virtual (not in itemState). happens in list selected page case.
        parentCanonicalItem = itemState.get(parentVeid.itemId)!;
      }

      if (isPage(parentDisplayItem)) {
        cloned.spatialWidthGr = asPageItem(parentDisplayItem).docWidthBl * GRID_SIZE;
      } else {
        cloned.spatialWidthGr = asXSizableItem(parentCanonicalItem).spatialWidthGr;
      }
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }
    if (props.visualElement.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(props.visualElement.linkItemMaybe!);
    }
    return ExpressionFns.calcSpatialDimensionsBl(expressionItem());
  };
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX*2;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (boundsPx().w - NOTE_PADDING_PX*2) / naturalWidthPx();
  const heightScale = () => (boundsPx().h - NOTE_PADDING_PX*2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();

  const attachBoundsPx = (): BoundingBox => {
    return ({
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    });
  };
  const attachCompositeBoundsPx = (): BoundingBox => {
    return ({
      x: boundsPx().w / 4.0,
      y: boundsPx().h - ATTACH_AREA_SIZE_PX,
      w: boundsPx().w / 2.0,
      h: ATTACH_AREA_SIZE_PX,
    });
  };
  const moveOutOfCompositeBox = (): BoundingBox => {
    return ({
      x: boundsPx().w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX - 2,
      y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    });
  };

  const outerClass = (shadow: boolean) => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      return 'absolute rounded-sm bg-white';
    } else {
      if ((expressionItem().flags & NoteFlags.HideBorder)) {
        if (store.perVe.getMouseIsOver(vePath())) {
          return `absolute border border-slate-700 rounded-sm ${shadow ? "shadow-lg" : ""}`;
        } else {
          return 'absolute border border-transparent rounded-sm';
        }
      }
      return `absolute border border-slate-700 rounded-sm ${shadow ? "shadow-lg" : ""} bg-white`;
    }
  };

  const infuTextStyle = () => getTextStyleForNote(expressionItem().flags);

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    store.perVe.getMouseIsOver(vePath()) &&
    !store.anItemIsMoving.get() &&
    store.overlay.expressionEditOverlayInfo() == null &&
    isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId));

  const renderShadow = () =>
    <div class={`${outerClass(true)}`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />;

  const renderDetailed = () =>
    <>
      <div class={`${infuTextStyle().isCode ? ' font-mono' : ''} ${infuTextStyle().alignClass}`}
           style={`position: absolute; ` +
                  `left: ${NOTE_PADDING_PX*textBlockScale()}px; ` +
                  `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4)*textBlockScale()}px; ` +
                  `width: ${naturalWidthPx()}px; ` +
                  `line-height: ${LINE_HEIGHT_PX * lineHeightScale() * infuTextStyle().lineHeightMultiplier}px; `+
                  `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                  `font-size: ${infuTextStyle().fontSize}px; ` +
                  `overflow-wrap: break-word; white-space: pre-wrap; ` +
                  `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; `}>
          <span>{formatMaybe(props.visualElement.evaluatedTitle != null ? props.visualElement.evaluatedTitle : expressionItem().title, expressionItem().format)}</span>
      </div>
      <For each={props.visualElement.attachmentsVes}>{attachment =>
        <VisualElement_Desktop visualElement={attachment.get()} />
      }</For>
      <Show when={showMoveOutOfCompositeArea()}>
        <div class={`absolute rounded-sm`}
            style={`left: ${moveOutOfCompositeBox().x}px; top: ${moveOutOfCompositeBox().y}px; width: ${moveOutOfCompositeBox().w}px; height: ${moveOutOfCompositeBox().h}px; ` +
                    `background-color: ${FEATURE_COLOR};`} />
      </Show>
      <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
        <InfuLinkTriangle />
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
      {renderShadow()}
      <div class={`${outerClass(false)}`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `${VeFns.zIndexStyle(props.visualElement)}; ${VeFns.opacityStyle(props.visualElement)}; ` +
                  `${!(props.visualElement.flags & VisualElementFlags.Detailed) ? 'background-color: #ddd; ' : 'background-color: #fff1e4;'}`}>
        <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
          {renderDetailed()}
          <InfuResizeTriangle />
        </Show>
      </div>
    </>
  );
}


export const Expression_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const expressionItem = () => asExpressionItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const leftPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().x + oneBlockWidthPx() * 0.15
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().w - oneBlockWidthPx() * 0.15
    : boundsPx().w - oneBlockWidthPx();

  const infuTextStyle = () => getTextStyleForNote(expressionItem().flags);

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={!store.perVe.getMouseIsOverOpenPopup(vePath()) && store.perVe.getMouseIsOver(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${highlightBoundsPx().x+2}px; top: ${highlightBoundsPx().y+2}px; width: ${highlightBoundsPx().w-4}px; height: ${highlightBoundsPx().h-4}px;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-sm"
               style={`left: ${lineHighlightBoundsPx()!.x+2}px; top: ${lineHighlightBoundsPx()!.y+2}px; width: ${lineHighlightBoundsPx()!.w-4}px; height: ${lineHighlightBoundsPx()!.h-4}px;`} />
        </Show>
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
            style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; background-color: #dddddd88;`} />
      </Match>
    </Switch>;

  const renderIconMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment)}>
      <div class="absolute text-center"
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left; ` +
                  'background-color: #fff1e4;'}>
        <span class="w-[16px] h-[16px] inline-block text-center relative">∑</span>
      </div>
    </Show>;

  const renderText = () =>
    <div class={`absolute overflow-hidden whitespace-nowrap text-ellipsis ` + 
                `${infuTextStyle().alignClass} `}
         style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
               `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
               `transform: scale(${scale()}); transform-origin: top left; ` +
               'background-color: #fff1e4;'}>
      <span class={`${infuTextStyle().isCode ? 'font-mono' : ''}`}
            style={`${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; `}>
        {formatMaybe(props.visualElement.evaluatedTitle != null ? props.visualElement.evaluatedTitle : expressionItem().title, expressionItem().format)}
      </span>
    </div>;

  const renderLinkMarkingMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
      <div class="absolute text-center text-slate-600"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <InfuLinkTriangle />
      </div>
    </Show>

  return (
    <>
      {renderHighlightsMaybe()}
      {renderIconMaybe()}
      {renderText()}
      {renderLinkMarkingMaybe()}
    </>
  );
}


// TODO (HIGH): something not naive.
function formatMaybe(text: string, format: string): string {
  if (format == "") { return text; }
  if (!isNumeric(text)) { return text; }
  if (format == "0.0") { return parseFloat(text).toFixed(1); }
  if (format == "0.00") { return parseFloat(text).toFixed(2); }
  if (format == "0.000") { return parseFloat(text).toFixed(3); }
  if (format == "0.0000") { return parseFloat(text).toFixed(4); }
  return text;
}
