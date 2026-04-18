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

import { Component, createMemo, For, Match, onMount, Show, Switch, createEffect } from "solid-js";
import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, PADDING_PROP, TABLE_COL_HEADER_HEIGHT_BL, TABLE_TITLE_HEADER_HEIGHT_BL, Z_INDEX_HIGHLIGHT, Z_INDEX_ITEMS_OVERLAY } from "../../constants";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW } from "../../style";
import { asTableItem } from "../../items/table-item";
import { VisualElement_LineItem, VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { VesCache } from "../../layout/ves-cache";
import { BoundingBox } from "../../util/geometry";
import { useStore } from "../../store/StoreProvider";
import { VisualElementFlags, VeFns } from "../../layout/visual-element";
import { TableFlags } from "../../items/base/flags-item";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { rearrangeTableAfterScroll } from "../../layout/arrange/table";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { itemState } from "../../store/ItemState";
import { asCompositeItem, isComposite } from "../../items/composite-item";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { arrangeNow } from "../../layout/arrange";
import { CompositeMoveOutHandle } from "./CompositeMoveOutHandle";
import { desktopStackRootStyle, shouldShowFocusRingForVisualElement } from "./helper";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Table_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const tableItem = () => asTableItem(props.visualElement.displayItem);
  const isPopup = () => !(!(props.visualElement.flags & VisualElementFlags.Popup));
  const vePath = () => VeFns.veToPath(props.visualElement);
  const showColHeader = () => tableItem().flags & TableFlags.ShowColHeader;
  const boundsPx = () => props.visualElement.boundsPx;
  const viewportBoundsPx = () => {
    if (props.visualElement.viewportBoundsPx == null) {
      throw "Table_Desktop: viewportBoundsPx is null " + VeFns.veToPath(props.visualElement);
    }
    return props.visualElement.viewportBoundsPx;
  }
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
  const rootTopPx = () => boundsPx().y + ((props.visualElement.flags & VisualElementFlags.Fixed) ? store.topToolbarHeightPx() : 0);
  const viewportBoundsLocalPx = (): BoundingBox => ({
    x: viewportBoundsPx().x - boundsPx().x,
    y: viewportBoundsPx().y - boundsPx().y,
    w: viewportBoundsPx().w,
    h: viewportBoundsPx().h,
  });
  const showTriangleDetail = () => (blockSizePx().h / LINE_HEIGHT_PX) > 0.5;
  const positionClass = () => (props.visualElement.flags & VisualElementFlags.Fixed) ? 'fixed' : 'absolute';
  const headerHeightPx = () => blockSizePx().h * TABLE_TITLE_HEADER_HEIGHT_BL;
  const scale = () => blockSizePx().h / LINE_HEIGHT_PX;
  const overPosRowPx = (): number => {
    const heightBl = spatialHeightGr() / GRID_SIZE;
    const rowHeightPx = boundsPx().h / heightBl;
    const rowNumber = store.perVe.getMoveOverRowNumber(vePath()) - store.perItem.getTableScrollYPos(VeFns.veidFromVe(props.visualElement)) + TABLE_TITLE_HEADER_HEIGHT_BL + (showColHeader() ? TABLE_COL_HEADER_HEIGHT_BL : 0);
    const rowPx = rowNumber * rowHeightPx;
    return rowPx;
  };
  const insertBoundsPx = (): BoundingBox => {
    const colNum = store.perVe.getMoveOverColAttachmentNumber(vePath());
    let offsetBl = 0;
    for (let i = 0; i <= colNum; ++i) {
      offsetBl += tableItem().tableColumns[i].widthGr / GRID_SIZE;
    }
    return {
      x: blockSizePx().w * offsetBl,
      y: overPosRowPx(),
      w: 4,
      h: blockSizePx().h
    };
  }
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX - 2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  }
  const attachInsertBarPx = (): BoundingBox => {
    const insertIndex = store.perVe.getMoveOverAttachmentIndex(vePath());
    const attachmentBlockSizePx = boundsPx().w / (tableItem().spatialWidthGr / GRID_SIZE);
    const xOffset = insertIndex === 0 ? -4 : -2;
    return {
      x: boundsPx().w - insertIndex * attachmentBlockSizePx + xOffset,
      y: -attachmentBlockSizePx / 2,
      w: 4,
      h: attachmentBlockSizePx,
    };
  }
  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: 0,
      y: boundsPx().h - 1,
      w: boundsPx().w - 2,
      h: 1,
    };
  };
  const moveOutOfCompositeBox = (): BoundingBox => {
    return ({
      x: boundsPx().w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    });
  };
  const isSortedByTitle = () => {
    store.touchToolbarDependency();
    return tableItem().orderChildrenBy == "title[ASC]";
  }
  const moveOverChildContainerPath = () => store.perVe.getMoveOverChildContainerPath(vePath());

  const columnSpecs = createMemo(() => {
    // TODO (LOW): I believe this would be more optimized if this calc was done at arrange time.
    const specsBl = [];
    let accumBl = 0;
    for (let i = 0; i < tableItem().numberOfVisibleColumns; ++i) {
      let tc = tableItem().tableColumns[i];
      const prevAccumBl = accumBl;
      accumBl += tc.widthGr / GRID_SIZE;
      if (accumBl >= spatialWidthGr() / GRID_SIZE) {
        break;
      }
      specsBl.push({ idx: i, prevAccumBl, accumBl, name: tc.name, isLast: i == tableItem().numberOfVisibleColumns - 1 });
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

  const keyDownHandler = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      store.overlay.setTextEditInfo(store.history, null, true);
      arrangeNow(store, "table-escape-exit-edit");
    }
  };

  // Check if this table is currently focused (via focusPath or textEditInfo)
  const isFocused = () => {
    const focusPath = store.history.getFocusPath();
    const textEditInfo = store.overlay.textEditInfo();
    return focusPath === vePath() || (textEditInfo != null && textEditInfo.itemPath === vePath());
  };

  const shadowClass = () => {
    if (isPopup()) {
      return `absolute border border-transparent rounded-xs shadow-xl blur-md bg-slate-700`;
    }
    return `absolute border border-transparent rounded-xs shadow-xl`;
  };

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) &&
      !(props.visualElement.flags & VisualElementFlags.DockItem)}>
      <>
        <div class={`${shadowClass()}`}
          style={`left: 0px; top: ${blockSizePx().h}px; width: ${boundsPx().w}px; height: ${boundsPx().h - blockSizePx().h}px; z-index: 0;`} />
        <div class="absolute bg-white pointer-events-none"
          style={`left: 0px; top: ${blockSizePx().h}px; width: ${boundsPx().w}px; height: ${boundsPx().h - blockSizePx().h}px; z-index: 0;`} />
      </>
    </Show>;

  const renderFocusRingMaybe = () =>
    <Show when={isFocused() && shouldShowFocusRingForVisualElement(store, () => props.visualElement)}>
      <div class="absolute pointer-events-none rounded-xs"
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
          `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_HIGHLIGHT};`} />
    </Show>;

  const renderNotDetailed = () =>
    <div class="absolute border border-[#999] rounded-xs bg-white hover:shadow-md"
      style={`left: 0px; top: ${blockSizePx().h}px; width: ${boundsPx().w}px; height: ${boundsPx().h - blockSizePx().h}px; z-index: 1;`} />;

  const renderDetailed = () =>
    <>
      <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute pointer-events-none rounded-xs"
          style={`left: 0px; top: 0px; ` +
            `width: ${boundsPx().w}px; height: ${headerHeightPx()}px; ` +
            `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR}; ` +
            `z-index: ${Z_INDEX_HIGHLIGHT};`} />
      </Show>
      <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute pointer-events-none rounded-xs"
          style={`left: ${viewportBoundsLocalPx().x}px; top: ${viewportBoundsLocalPx().y}px; ` +
            `width: ${viewportBoundsLocalPx().w}px; height: ${viewportBoundsLocalPx().h}px; ` +
            `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR}; ` +
            `z-index: ${Z_INDEX_HIGHLIGHT};`} />
      </Show>
      <TableChildArea visualElement={props.visualElement} />
      <div class={`absolute pointer-events-none ${store.perVe.getMouseIsOver(vePath()) ? 'shadow-md' : ''}`}
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; z-index: 2;`}>
        <div id={VeFns.veToPath(props.visualElement) + ":title"}
          class={`absolute font-bold`}
          style={`left: 0px; top: 0px; ` +
            `width: ${boundsPx().w / scale()}px; height: ${headerHeightPx() / scale()}px; ` +
            `line-height: ${LINE_HEIGHT_PX * TABLE_TITLE_HEADER_HEIGHT_BL}px; ` +
            `transform: scale(${scale()}); transform-origin: top left; ` +
            `overflow-wrap: break-word; ` +
            `outline: 0px solid transparent;`}
          contentEditable={store.overlay.textEditInfo() != null}
          spellcheck={store.overlay.textEditInfo() != null}
          onKeyDown={keyDownHandler}>
          {tableItem().title}
        </div>
        <div class={`absolute border border-[#999] rounded-xs pointer-events-none`}
          style={`left: 0px; top: ${headerHeightPx()}px; width: ${boundsPx().w}px; height: ${boundsPx().h - headerHeightPx()}px;`} />
        <Show when={showColHeader()}>
          <div class={`absolute border border-[#999] bg-slate-300 rounded-xs`}
            style={`left: 0px; top: ${headerHeightPx()}px; width: ${boundsPx().w}px; height: ${headerHeightPx()}px;`} />
        </Show>

        <For each={VesCache.render.getAttachments(VeFns.veToPath(props.visualElement))()}>{attachmentVe =>
          <VisualElement_Desktop visualElement={attachmentVe.get()} />
        }</For>
        <Show when={showMoveOutOfCompositeArea()}>
          <CompositeMoveOutHandle boundsPx={moveOutOfCompositeBox()} active={store.perVe.getMouseIsOverCompositeMoveOut(vePath())} />
        </Show>
        <Show when={props.visualElement.linkItemMaybe != null &&
          (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
          !(isPopup() && (props.visualElement.actualLinkItemMaybe == null)) &&
          showTriangleDetail()}>
          <InfuLinkTriangle />
        </Show>
        <Show when={showTriangleDetail()}>
          <InfuResizeTriangle />
        </Show>
      </div>
      <Show when={showColHeader()}>
        <div class="absolute"
          style={`left: ${viewportBoundsLocalPx().x}px; top: ${viewportBoundsLocalPx().y - blockSizePx().h}px; ` +
            `width: ${viewportBoundsLocalPx().w}px; height: ${blockSizePx().h}px; z-index: 2;`}>
          <For each={columnSpecs()}>{spec =>
            <div id={VeFns.veToPath(props.visualElement) + ":col" + spec.idx}
              class={`absolute whitespace-nowrap overflow-hidden`}
              style={`left: ${spec.startPosPx + PADDING_PROP * blockSizePx().w}px; top: 0px; ` +
                `width: ${(spec.endPosPx - spec.startPosPx - PADDING_PROP * blockSizePx().w) / scale()}px; height: ${headerHeightPx() / scale()}px; ` +
                `line-height: ${LINE_HEIGHT_PX * TABLE_TITLE_HEADER_HEIGHT_BL}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;` +
                `outline: 0px solid transparent;`}
              contentEditable={store.overlay.textEditInfo() != null}
              spellcheck={store.overlay.textEditInfo() != null}
              onKeyDown={keyDownHandler}>
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
      <div class="absolute pointer-events-none"
        style={`left: ${viewportBoundsLocalPx().x}px; top: ${viewportBoundsLocalPx().y - (showColHeader() ? blockSizePx().h : 0)}px; ` +
          `width: ${viewportBoundsLocalPx().w}px; height: ${viewportBoundsLocalPx().h + (showColHeader() ? blockSizePx().h : 0)}px; z-index: 2;`}>
        <For each={columnSpecs()}>{spec =>
          <Show when={!spec.isLast}>
            <div class="absolute"
              style={`background-color: #999; left: ${spec.endPosPx}px; width: 1px; top: 0px; height: ${viewportBoundsLocalPx().h + (showColHeader() ? blockSizePx().h : 0)}px`} />
          </Show>
        }</For>
      </div>
      <Show when={store.perVe.getMovingItemIsOverAttach(vePath()) &&
        store.perVe.getMoveOverAttachmentIndex(vePath()) >= 0}>
        <div class="absolute bg-black pointer-events-none"
          style={`left: ${attachInsertBarPx().x}px; top: ${attachInsertBarPx().y}px; width: ${attachInsertBarPx().w}px; height: ${attachInsertBarPx().h}px; z-index: ${Z_INDEX_ITEMS_OVERLAY};`} />
      </Show>
      <Show when={store.perVe.getMovingItemIsOver(vePath()) &&
        store.perVe.getMoveOverRowNumber(vePath()) > -1 &&
        store.perVe.getMoveOverColAttachmentNumber(vePath()) < 0 &&
        moveOverChildContainerPath() == null &&
        !store.perVe.getMovingItemIsOverAttach(vePath()) &&
        !store.perVe.getMovingItemIsOverAttachComposite(vePath()) &&
        !isSortedByTitle()}>
        <div class="absolute border border-black"
          style={`left: 0px; top: ${overPosRowPx()}px; width: ${boundsPx().w}px; height: 1px; z-index: ${Z_INDEX_ITEMS_OVERLAY};`} />
      </Show>
      <Show when={store.perVe.getMovingItemIsOver(vePath()) &&
        store.perVe.getMoveOverColAttachmentNumber(vePath()) >= 0 &&
        moveOverChildContainerPath() == null &&
        !store.perVe.getMovingItemIsOverAttach(vePath()) &&
        !store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
        <div class="absolute border border-black bg-black"
          style={`left: ${insertBoundsPx().x}px; top: ${insertBoundsPx().y}px; width: ${insertBoundsPx().w}px; height: ${insertBoundsPx().h}px; z-index: ${Z_INDEX_ITEMS_OVERLAY};`} />
      </Show>
      <Show when={store.perVe.getMovingItemIsOver(vePath()) &&
        store.perVe.getMoveOverRowNumber(vePath()) > -2 && // always true, create dependency.
        store.perVe.getMoveOverColAttachmentNumber(vePath()) < 0 &&
        moveOverChildContainerPath() == null &&
        !store.perVe.getMovingItemIsOverAttach(vePath()) &&
        !store.perVe.getMovingItemIsOverAttachComposite(vePath()) &&
        isSortedByTitle()}>
        <div class="absolute pointer-events-none"
          style={`background-color: #0044ff0a; ` +
            `left: ${viewportBoundsLocalPx().x + 1}px; top: ${viewportBoundsLocalPx().y + 1}px; ` +
            `width: ${viewportBoundsLocalPx().w - 2}px; height: ${viewportBoundsLocalPx().h - 2}px; z-index: ${Z_INDEX_ITEMS_OVERLAY};`} />
      </Show>
      <Show when={store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
        <div class="absolute border border-black pointer-events-none"
          style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; z-index: ${Z_INDEX_ITEMS_OVERLAY};`} />
      </Show>
    </>;

  return (
    <div class={positionClass()}
      style={`left: ${boundsPx().x}px; top: ${rootTopPx()}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ${desktopStackRootStyle(props.visualElement)}`}>
      <Switch>
        <Match when={!(props.visualElement.flags & VisualElementFlags.Detailed)}>
          {renderShadowMaybe()}
          {renderNotDetailed()}
          {renderFocusRingMaybe()}
        </Match>
        <Match when={props.visualElement.flags & VisualElementFlags.Detailed}>
          {renderShadowMaybe()}
          {renderDetailed()}
          {renderFocusRingMaybe()}
        </Match>
      </Switch>
    </div>
  );
}


const TableChildArea: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  let outerDiv: HTMLDivElement | undefined;

  const QUANTIZE_SCROLL_TIMEOUT_MS = 600;

  let scrollDoneTimer: any = null;
  function scrollDoneHandler() {
    const newScrollYPos = Math.round(store.perItem.getTableScrollYPos(VeFns.veidFromVe(props.visualElement)));
    store.perItem.setTableScrollYPos(VeFns.veidFromVe(props.visualElement), newScrollYPos);
    (outerDiv!)!.scrollTop = newScrollYPos * blockHeightPx();
    scrollDoneTimer = null;
    rearrangeTableAfterScroll(store, props.visualElement.parentPath!, VeFns.veidFromVe(props.visualElement), newScrollYPos);
  }

  const blockHeightPx = () => props.visualElement.blockSizePx!.h;
  const viewportBoundsPx = () => {
    if (props.visualElement.viewportBoundsPx == null) {
      throw "TableChildArea: viewportBoundsPx is null " + VeFns.veToPath(props.visualElement);
    }
    return props.visualElement.viewportBoundsPx;
  }
  const viewportBoundsLocalPx = (): BoundingBox => ({
    x: viewportBoundsPx().x - props.visualElement.boundsPx.x,
    y: viewportBoundsPx().y - props.visualElement.boundsPx.y,
    w: viewportBoundsPx().w,
    h: viewportBoundsPx().h,
  });

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

  createEffect(() => {
    const scrollPos = store.perItem.getTableScrollYPos(VeFns.veidFromVe(props.visualElement));
    if (outerDiv && outerDiv.scrollTop !== scrollPos * blockHeightPx()) {
      outerDiv.scrollTop = scrollPos * blockHeightPx();
    }
  });

  const renderVisibleItems = () =>
    <For each={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()}>{childVes =>

      <>
        <VisualElement_LineItem visualElement={childVes.get()} />
        <For each={VesCache.render.getAttachments(VeFns.veToPath(childVes.get()))()}>{attachment =>
          <VisualElement_LineItem visualElement={attachment.get()} />
        }</For>
      </>
    }</For>;

  return (
    <div ref={outerDiv}
      id={props.visualElement.displayItem.id}
      class="absolute"
      style={`left: ${viewportBoundsLocalPx().x}px; top: ${viewportBoundsLocalPx().y}px; ` +
        `width: ${viewportBoundsLocalPx().w}px; height: ${viewportBoundsLocalPx().h}px; overflow-y: auto; z-index: 1;`}
      onscroll={scrollHandler}>
      <div class='absolute' style={`width: ${viewportBoundsLocalPx().w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
        {renderVisibleItems()}
      </div>
    </div>
  );
}
