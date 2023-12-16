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

import { Component, For, Match, onMount, Show, Switch } from "solid-js";
import { ATTACH_AREA_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX } from "../../constants";
import { asTableItem } from "../../items/table-item";
import { VisualElement_LineItem, VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { VisualElementSignal } from "../../util/signals";
import { BoundingBox } from "../../util/geometry";
import { panic } from "../../util/lang";
import { useStore } from "../../store/StoreProvider";
import { VisualElementFlags, VeFns } from "../../layout/visual-element";
import { TableFlags } from "../../items/base/flags-item";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";


export const TABLE_TITLE_HEADER_HEIGHT_BL = 1;
export const TABLE_COL_HEADER_HEIGHT_BL = 1;

export const Table_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const tableItem = () => asTableItem(props.visualElement.displayItem);
  const showColHeader = () => tableItem().flags & TableFlags.ShowColHeader;
  const boundsPx = () => props.visualElement.boundsPx;
  const viewportBoundsPx = () => props.visualElement.viewportBoundsPx;
  const spatialWidthGr = () => {
    if (props.visualElement.linkItemMaybe != null) {
      return props.visualElement.linkItemMaybe.spatialWidthGr;
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
  const headerHeightPx = () => blockSizePx().h * TABLE_TITLE_HEADER_HEIGHT_BL;
  const scale = () => blockSizePx().h / LINE_HEIGHT_PX;
  const overPosRowPx = (): number => {
    const heightBl = spatialHeightGr() / GRID_SIZE;
    const rowHeightPx = boundsPx().h / heightBl;
    const rowNumber = props.visualElement.moveOverRowNumber.get() - store.perItem.getTableScrollYPos(VeFns.veidFromVe(props.visualElement)) + TABLE_TITLE_HEADER_HEIGHT_BL + (showColHeader() ? TABLE_COL_HEADER_HEIGHT_BL : 0);
    const rowPx = rowNumber * rowHeightPx + boundsPx().y;
    return rowPx;
  };
  const insertBoundsPx = (): BoundingBox => {
    const colNum = props.visualElement.moveOverColAttachmentNumber.get();
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
  const columnSpecs = () => {
    const specsBl = [];
    let accumBl = 0;
    for (let i=0; i<tableItem().tableColumns.length; ++i) {
      let tc = tableItem().tableColumns[i];
      const prevAccumBl = accumBl;
      accumBl += tc.widthGr / GRID_SIZE;
      if (accumBl >= spatialWidthGr() / GRID_SIZE) {
        break;
      }
      specsBl.push({ prevAccumBl, accumBl, name: tc.name, isLast: i == tableItem().tableColumns.length-1 });
    }
    return specsBl.map(s => ({
      startPosPx: s.prevAccumBl * blockSizePx().w,
      endPosPx: s.isLast ? boundsPx().w : s.accumBl * blockSizePx().w,
      name: s.name,
      isLast: s.isLast
    }));
  };

  const renderNotDetailed = () =>
    <div class={`absolute border border-slate-700 rounded-sm shadow-lg bg-white`}
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
        <div class="absolute font-bold"
             style={`left: 0px; top: 0px; width: ${boundsPx().w / scale()}px; height: ${headerHeightPx() / scale()}px; ` +
                    `line-height: ${LINE_HEIGHT_PX * TABLE_TITLE_HEADER_HEIGHT_BL}px; transform: scale(${scale()}); transform-origin: top left; ` +
                    `overflow-wrap: break-word;`}>
          {tableItem().title}
        </div>
        <div class={`absolute border border-slate-700 rounded-sm shadow-lg bg-white`}
             style={`left: 0px; top: ${headerHeightPx()}px; width: ${boundsPx().w}px; height: ${boundsPx().h - headerHeightPx()}px;`} />
        <Show when={showColHeader()}>
          <div class={`absolute border border-slate-700 bg-slate-300 rounded-sm`}
               style={`left: 0px; top: ${headerHeightPx()}px; width: ${boundsPx().w}px; height: ${headerHeightPx()}px;`} />
        </Show>
        <Show when={props.visualElement.movingItemIsOverAttach.get()}>
          <div class={`absolute rounded-sm`}
               style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                      `background-color: #ff0000;`} />
        </Show>
        <For each={props.visualElement.attachmentsVes}>{attachmentVe =>
          <VisualElement_Desktop visualElement={attachmentVe.get()} />
        }</For>
        <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
          <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`} />
        </Show>
      </div>
      <TableChildArea visualElement={props.visualElement} />
      <div class="absolute pointer-events-none"
           style={`left: ${viewportBoundsPx()!.x}px; top: ${viewportBoundsPx()!.y - (showColHeader() ? blockSizePx().h : 0)}px; ` +
                  `width: ${viewportBoundsPx()!.w}px; height: ${viewportBoundsPx()!.h + (showColHeader() ? blockSizePx().h : 0)}px; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <For each={columnSpecs()}>{spec =>
          <>
            <Show when={!spec.isLast}>
              <div class="absolute bg-slate-700"
                   style={`left: ${spec.endPosPx}px; width: 1px; top: $0px; height: ${viewportBoundsPx()!.h + (showColHeader() ? blockSizePx().h : 0)}px`} />
            </Show>
            <Show when={showColHeader()}>
              <div class="absolute whitespace-nowrap overflow-hidden"
                   style={`left: ${spec.startPosPx + 0.15 * blockSizePx().w}px; top: 0px; width: ${(spec.endPosPx - spec.startPosPx - 0.15 * blockSizePx().w) / scale()}px; height: ${headerHeightPx() / scale()}px; ` +
                          `line-height: ${LINE_HEIGHT_PX * TABLE_TITLE_HEADER_HEIGHT_BL}px; transform: scale(${scale()}); transform-origin: top left;`}>
                {spec.name}
              </div>
            </Show>
          </>
        }</For>
      </div>
      <Show when={props.visualElement.movingItemIsOver.get() && props.visualElement.moveOverRowNumber.get() > -1 && props.visualElement.moveOverColAttachmentNumber.get() < 0}>
        <div class={`absolute border border-black`}
             style={`left: ${boundsPx().x}px; top: ${overPosRowPx()}px; width: ${boundsPx().w}px; height: 1px;` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`} />
      </Show>
      <Show when={props.visualElement.movingItemIsOver.get() && props.visualElement.moveOverColAttachmentNumber.get() >= 0}>
        <div class={`absolute border border-black bg-black`}
             style={`left: ${insertBoundsPx().x}px; top: ${insertBoundsPx().y}px; width: ${insertBoundsPx().w}px; height: ${insertBoundsPx().h}px;` +
                    `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`} />
      </Show>
    </>;

  return (
    <Switch>
      <Match when={!(props.visualElement.flags & VisualElementFlags.Detailed)}>
        {renderNotDetailed()}
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Detailed}>
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
    const row = Math.round(store.perItem.getTableScrollYPos(VeFns.veidFromVe(props.visualElement)));
    store.perItem.setTableScrollYPos(VeFns.veidFromVe(props.visualElement), row);
    (outerDiv!)!.scrollTop = row * blockHeightPx();
    scrollDoneTimer = null;
  }

  const blockHeightPx = () => props.visualElement.blockSizePx!.h;
  const viewportBoundsPx = () => props.visualElement.viewportBoundsPx;

  const scrollHandler = (_ev: Event) => {
    if (scrollDoneTimer != null) { clearTimeout(scrollDoneTimer); }
    scrollDoneTimer = setTimeout(scrollDoneHandler, QUANTIZE_SCROLL_TIMEOUT_MS);
    store.perItem.setTableScrollYPos(VeFns.veidFromVe(props.visualElement), (outerDiv!)!.scrollTop / blockHeightPx());
  }

  onMount(() => {
    outerDiv!.scrollTop = store.perItem.getTableScrollYPos(VeFns.veidFromVe(props.visualElement)) * blockHeightPx();
  });

  const drawVisibleItems = () => {
    const children = props.visualElement.childrenVes;
    const visibleChildrenIds = [];
    const yScrollProp = store.perItem.getTableScrollYPos(VeFns.veidFromVe(props.visualElement));
    const firstItemIdx = Math.floor(yScrollProp);
    let lastItemIdx = Math.ceil((yScrollProp * blockHeightPx() + props.visualElement.viewportBoundsPx!.h) / blockHeightPx());
    if (lastItemIdx > children.length - 1) { lastItemIdx = children.length - 1; }
    for (let i=firstItemIdx; i<=lastItemIdx; ++i) {
      visibleChildrenIds.push(children[i]);
    }

    const drawChild = (child: VisualElementSignal) => {
      if (!(child.get().flags & VisualElementFlags.LineItem)) { panic("drawChild: table child is not a line item."); }
      return (
        <>
          <VisualElement_LineItem visualElement={child.get()} />
          <For each={child.get().attachmentsVes}>{attachment =>
            <VisualElement_LineItem visualElement={attachment.get()} />
          }</For>
        </>
      );
    }

    return (
      <For each={visibleChildrenIds}>
        {child => drawChild(child)}
      </For>
    );
  }

  return (
    <div ref={outerDiv}
         id={props.visualElement.displayItem.id}
         class='absolute'
         style={`left: ${viewportBoundsPx()!.x}px; top: ${viewportBoundsPx()!.y}px; ` +
                `width: ${viewportBoundsPx()!.w}px; height: ${viewportBoundsPx()!.h}px; overflow-y: auto;` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}
                onscroll={scrollHandler}>
      <div class='absolute' style={`width: ${viewportBoundsPx()!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
        {drawVisibleItems()}
      </div>
    </div>
  );
}


export const Table_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const tableItem = () => asTableItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={!props.visualElement.mouseIsOverOpenPopup.get() && props.visualElement.mouseIsOver.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${boundsPx().x+2}px; top: ${boundsPx().y+2}px; width: ${boundsPx().w-4}px; height: ${boundsPx().h-4}px;`} />
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

  const renderText = () =>
    <div class="absolute overflow-hidden"
         style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <span>{tableItem().title}</span>
    </div>;

  return (
    <>
      {renderHighlightsMaybe()}
      {renderIcon()}
      {renderText()}
    </>
  );
}
