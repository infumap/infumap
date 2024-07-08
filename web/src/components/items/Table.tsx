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

import { Component, createMemo, For, Match, onMount, Show, Switch } from "solid-js";
import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, PADDING_PROP, TABLE_COL_HEADER_HEIGHT_BL, TABLE_TITLE_HEADER_HEIGHT_BL, Z_INDEX_SHADOW } from "../../constants";
import { asTableItem } from "../../items/table-item";
import { VisualElement_LineItem, VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { BoundingBox, cloneBoundingBox } from "../../util/geometry";
import { useStore } from "../../store/StoreProvider";
import { VisualElementFlags, VeFns } from "../../layout/visual-element";
import { TableFlags } from "../../items/base/flags-item";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { rearrangeTableAfterScroll } from "../../layout/arrange/table";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";
import { itemState } from "../../store/ItemState";
import { asCompositeItem, isComposite } from "../../items/composite-item";
import { FEATURE_COLOR } from "../../style";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Table_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const tableItem = () => asTableItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const showColHeader = () => tableItem().flags & TableFlags.ShowColHeader;
  const boundsPx = () => props.visualElement.boundsPx;
  const viewportBoundsPx = () => props.visualElement.viewportBoundsPx;
  const spatialWidthGr = () => {
    if (props.visualElement.linkItemMaybe != null) {
      const parent = itemState.get(props.visualElement.linkItemMaybe.parentId)!;
      if (isComposite(parent)) {
        return asCompositeItem(parent).spatialWidthGr;
      }
      return props.visualElement.linkItemMaybe.spatialWidthGr;
    }
    const parent = itemState.get(tableItem().parentId)!;
    if (isComposite(parent)) {
      return asCompositeItem(parent).spatialWidthGr;
    }
    return tableItem().spatialWidthGr;
  }
  const spatialHeightGr = () => {
    if (props.visualElement.linkItemMaybe != null) {
      return props.visualElement.linkItemMaybe.spatialHeightGr;
    }
    return tableItem().spatialHeightGr;
  }
  const blockSizePx = () => {
    const sizeBl = { w: spatialWidthGr() / GRID_SIZE, h: spatialHeightGr() / GRID_SIZE };
    return { w: boundsPx().w / sizeBl.w, h: boundsPx().h / sizeBl.h };
  }
  const showTriangleDetail = () => (blockSizePx().h / LINE_HEIGHT_PX) > 0.5;
  const headerHeightPx = () => blockSizePx().h * TABLE_TITLE_HEADER_HEIGHT_BL;
  const scale = () => blockSizePx().h / LINE_HEIGHT_PX;
  const overPosRowPx = (): number => {
    const heightBl = spatialHeightGr() / GRID_SIZE;
    const rowHeightPx = boundsPx().h / heightBl;
    const rowNumber = store.perVe.getMoveOverRowNumber(vePath()) - store.perItem.getTableScrollYPos(VeFns.veidFromVe(props.visualElement)) + TABLE_TITLE_HEADER_HEIGHT_BL + (showColHeader() ? TABLE_COL_HEADER_HEIGHT_BL : 0);
    const rowPx = rowNumber * rowHeightPx + boundsPx().y;
    return rowPx;
  };
  const insertBoundsPx = (): BoundingBox => {
    const colNum = store.perVe.getMoveOverColAttachmentNumber(vePath());
    let offsetBl = 0;
    for (let i=0; i<=colNum; ++i) {
      offsetBl += tableItem().tableColumns[i].widthGr / GRID_SIZE;
    }
    return {
      x: blockSizePx().w * offsetBl + boundsPx().x,
      y: overPosRowPx(),
      w: 4,
      h: blockSizePx().h
    };
  }
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  }
  const moveOutOfCompositeBox = (): BoundingBox => {
    return ({
      x: boundsPx().w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    });
  };

  const columnSpecs = createMemo(() => {
    // TODO (LOW): I believe this would be more optimized if this calc was done at arrange time.
    const specsBl = [];
    let accumBl = 0;
    for (let i=0; i<tableItem().numberOfVisibleColumns; ++i) {
      let tc = tableItem().tableColumns[i];
      const prevAccumBl = accumBl;
      accumBl += tc.widthGr / GRID_SIZE;
      if (accumBl >= spatialWidthGr() / GRID_SIZE) {
        break;
      }
      specsBl.push({ idx: i, prevAccumBl, accumBl, name: tc.name, isLast: i == tableItem().numberOfVisibleColumns-1 });
    }
    return specsBl.map(s => ({
      idx: s.idx,
      startPosPx: s.prevAccumBl * blockSizePx().w,
      endPosPx: s.isLast ? boundsPx().w : s.accumBl * blockSizePx().w,
      name: s.name,
      isLast: s.isLast
    }));
  });

  const isInComposite = () =>
    isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId));

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    store.perVe.getMouseIsOver(vePath()) &&
    !store.anItemIsMoving.get() &&
    store.overlay.textEditInfo() == null &&
    isInComposite();

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc)}>
      <div class={`absolute border border-transparent rounded-sm shadow-lg`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y + blockSizePx().h}px; width: ${boundsPx().w}px; height: ${boundsPx().h - blockSizePx().h}px; ` +
                  `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
    </Show>;

  const renderNotDetailed = () =>
    <div class={`absolute border border-slate-700 rounded-sm bg-white`}
         style={`left: ${boundsPx().x}px; ` +
                `top: ${boundsPx().y + blockSizePx().h}px; ` +
                `width: ${boundsPx().w}px; ` +
                `height: ${boundsPx().h - blockSizePx().h}px; ` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`} />;

  const renderDetailed = () =>
    <>
      <div class='absolute'
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <div id={VeFns.veToPath(props.visualElement) + ":title"}
             class={`absolute font-bold`}
             style={`left: 0px; top: 0px; ` +
                    `width: ${boundsPx().w / scale()}px; height: ${headerHeightPx() / scale()}px; ` +
                    `line-height: ${LINE_HEIGHT_PX * TABLE_TITLE_HEADER_HEIGHT_BL}px; ` +
                    `transform: scale(${scale()}); transform-origin: top left; ` +
                    `overflow-wrap: break-word; ` +
                    `outline: 0px solid transparent;`}
              contentEditable={store.overlay.textEditInfo() != null}
              spellcheck={store.overlay.textEditInfo() != null}>
          {tableItem().title}
        </div>
        <div class={`absolute border border-slate-700 rounded-sm bg-white`}
             style={`left: 0px; top: ${headerHeightPx()}px; width: ${boundsPx().w}px; height: ${boundsPx().h - headerHeightPx()}px;`} />
        <Show when={showColHeader()}>
          <div class={`absolute border border-slate-700 bg-slate-300 rounded-sm`}
               style={`left: 0px; top: ${headerHeightPx()}px; width: ${boundsPx().w}px; height: ${headerHeightPx()}px;`} />
        </Show>
        <Show when={store.perVe.getMovingItemIsOverAttach(vePath())}>
          <div class={`absolute rounded-sm`}
               style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                      `background-color: #ff0000;`} />
        </Show>
        <For each={props.visualElement.attachmentsVes}>{attachmentVe =>
          <VisualElement_Desktop visualElement={attachmentVe.get()} />
        }</For>
        <Show when={showMoveOutOfCompositeArea()}>
          <div class={`absolute rounded-sm`}
               style={`left: ${moveOutOfCompositeBox().x}px; top: ${moveOutOfCompositeBox().y}px; width: ${moveOutOfCompositeBox().w}px; height: ${moveOutOfCompositeBox().h}px; ` +
                      `background-color: ${FEATURE_COLOR};`} />
        </Show>
        <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
                    showTriangleDetail()}>
          <InfuLinkTriangle />
        </Show>
        <Show when={showTriangleDetail()}>
          <InfuResizeTriangle />
      </Show>
      </div>
      <TableChildArea visualElement={props.visualElement} />
      <Show when={showColHeader()}>
        <div class='absolute'
            style={`left: ${viewportBoundsPx()!.x}px; top: ${viewportBoundsPx()!.y - blockSizePx().h}px; ` +
                    `width: ${viewportBoundsPx()!.w}px; height: ${blockSizePx().h}px; ` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
          <For each={columnSpecs()}>{spec =>
            <div id={VeFns.veToPath(props.visualElement) + ":col" + spec.idx}
                class={`absolute whitespace-nowrap overflow-hidden`}
                style={`left: ${spec.startPosPx + PADDING_PROP * blockSizePx().w}px; top: 0px; ` +
                       `width: ${(spec.endPosPx - spec.startPosPx - PADDING_PROP * blockSizePx().w) / scale()}px; height: ${headerHeightPx() / scale()}px; ` +
                       `line-height: ${LINE_HEIGHT_PX * TABLE_TITLE_HEADER_HEIGHT_BL}px; ` +
                       `transform: scale(${scale()}); transform-origin: top left;` +
                       `outline: 0px solid transparent;`}
                contentEditable={store.overlay.textEditInfo() != null}
                spellcheck={store.overlay.textEditInfo() != null}>
              {spec.name}
              <Show when={store.perVe.getMouseIsOver(vePath()) && store.mouseOverTableHeaderColumnNumber.get() == spec.idx}>
                <div class="absolute" style="top: 0px; right: 7px; font-size: smaller;">
                  <i class="fas fa-chevron-down" />
                </div>
              </Show>
            </div>
          }</For>
        </div>
      </Show>
      <div class='absolute pointer-events-none'
           style={`left: ${viewportBoundsPx()!.x}px; top: ${viewportBoundsPx()!.y - (showColHeader() ? blockSizePx().h : 0)}px; ` +
                  `width: ${viewportBoundsPx()!.w}px; height: ${viewportBoundsPx()!.h + (showColHeader() ? blockSizePx().h : 0)}px; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <For each={columnSpecs()}>{spec =>
          <Show when={!spec.isLast}>
            <div class="absolute bg-slate-700"
                  style={`left: ${spec.endPosPx}px; width: 1px; top: $0px; height: ${viewportBoundsPx()!.h + (showColHeader() ? blockSizePx().h : 0)}px`} />
          </Show>
        }</For>
      </div>
      <Show when={store.perVe.getMovingItemIsOver(vePath()) && store.perVe.getMoveOverRowNumber(vePath()) > -1 && store.perVe.getMoveOverColAttachmentNumber(vePath()) < 0}>
        <div class={`absolute border border-black`}
             style={`left: ${boundsPx().x}px; top: ${overPosRowPx()}px; width: ${boundsPx().w}px; height: 1px;` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`} />
      </Show>
      <Show when={store.perVe.getMovingItemIsOver(vePath()) && store.perVe.getMoveOverColAttachmentNumber(vePath()) >= 0}>
        <div class={`absolute border border-black bg-black`}
             style={`left: ${insertBoundsPx().x}px; top: ${insertBoundsPx().y}px; width: ${insertBoundsPx().w}px; height: ${insertBoundsPx().h}px;` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`} />
      </Show>
    </>;

  return (
    <Switch>
      <Match when={!(props.visualElement.flags & VisualElementFlags.Detailed)}>
        {renderShadowMaybe()}
        {renderNotDetailed()}
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Detailed}>
        {renderShadowMaybe()}
        {renderDetailed()}
      </Match>
    </Switch>
  );
}


const TableChildArea: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  let outerDiv: HTMLDivElement | undefined;

  const QUANTIZE_SCROLL_TIMEOUT_MS = 600;

  let scrollDoneTimer: number | null = null;
  function scrollDoneHandler() {
    const newScrollYPos = Math.round(store.perItem.getTableScrollYPos(VeFns.veidFromVe(props.visualElement)));
    store.perItem.setTableScrollYPos(VeFns.veidFromVe(props.visualElement), newScrollYPos);
    (outerDiv!)!.scrollTop = newScrollYPos * blockHeightPx();
    scrollDoneTimer = null;
    rearrangeTableAfterScroll(store, props.visualElement.parentPath!, VeFns.veidFromVe(props.visualElement), newScrollYPos);
  }

  const blockHeightPx = () => props.visualElement.blockSizePx!.h;
  const viewportBoundsPx = () => props.visualElement.viewportBoundsPx;

  const scrollHandler = (_ev: Event) => {
    if (scrollDoneTimer != null) { clearTimeout(scrollDoneTimer); }
    scrollDoneTimer = setTimeout(scrollDoneHandler, QUANTIZE_SCROLL_TIMEOUT_MS);
    const prevScrollYPos = store.perItem.getTableScrollYPos(VeFns.veidFromVe(props.visualElement));
    store.perItem.setTableScrollYPos(VeFns.veidFromVe(props.visualElement), (outerDiv!)!.scrollTop / blockHeightPx());
    rearrangeTableAfterScroll(store, props.visualElement.parentPath!, VeFns.veidFromVe(props.visualElement), prevScrollYPos);
  }

  onMount(() => {
    outerDiv!.scrollTop = store.perItem.getTableScrollYPos(VeFns.veidFromVe(props.visualElement)) * blockHeightPx();
  });

  const renderVisibleItems = () =>
    <For each={props.visualElement.childrenVes}>{childVes =>
      <>
        <VisualElement_LineItem visualElement={childVes.get()} />
        <For each={childVes.get().attachmentsVes}>{attachment =>
          <VisualElement_LineItem visualElement={attachment.get()} />
        }</For>
      </>
    }</For>;

  return (
    <div ref={outerDiv}
         id={props.visualElement.displayItem.id}
         class='absolute'
         style={`left: ${viewportBoundsPx()!.x}px; top: ${viewportBoundsPx()!.y}px; ` +
                `width: ${viewportBoundsPx()!.w}px; height: ${viewportBoundsPx()!.h}px; overflow-y: auto;` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}
                onscroll={scrollHandler}>
      <div class='absolute' style={`width: ${viewportBoundsPx()!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
        {renderVisibleItems()}
      </div>
    </div>
  );
}


export const Table_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const tableItem = () => asTableItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const openPopupBoundsPx = () => {
    const r = cloneBoundingBox(boundsPx())!;
    r.w = oneBlockWidthPx();
    return r;
  };
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;

  const renderHighlightsMaybe = () =>
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
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; ` +
                    `background-color: #dddddd88;`} />
      </Match>
    </Switch>;

  const renderIcon = () =>
    <div class="absolute text-center"
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <i class={`fas fa-table`} />
    </div>;

  const renderExpandIcon = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment) && (props.visualElement.flags & VisualElementFlags.InsideTable)}>
      <div class="absolute text-center text-slate-400"
           style={`left: ${boundsPx().x+boundsPx().w - oneBlockWidthPx()*0.85}px; top: ${boundsPx().y + boundsPx().h*PADDING_PROP}px; ` +
                  `width: ${oneBlockWidthPx() / smallScale() * 0.8}px; height: ${boundsPx().h / smallScale() * 0.8}px; `+
                  `transform: scale(${smallScale()}); transform-origin: top left;`}>
        <i class={`fas ${store.perVe.getIsExpanded(vePath()) ? 'fa-minus' : 'fa-plus'}`} />
      </div>
    </Show>;

  const renderText = () =>
    <div class="absolute overflow-hidden"
         style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <span>{tableItem().title}<span></span></span>
    </div>;

  const renderLinkMarkingMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
                showTriangleDetail()}>
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
      {renderIcon()}
      {renderText()}
      {renderExpandIcon()}
      {renderLinkMarkingMaybe()}
    </>
  );
}
