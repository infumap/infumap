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

import { Component, For, onMount, Show } from "solid-js";
import { ATTACH_AREA_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX } from "../../constants";
import { asTableItem } from "../../items/table-item";
import { HTMLDivElementWithData } from "../../util/html";
import { VisualElement_LineItem, VisualElementProps_LineItem, VisualElement_Desktop, VisualElementProps_Desktop } from "../VisualElement";
import { VisualElementSignal } from "../../util/signals";
import { BoundingBox } from "../../util/geometry";
import { panic } from "../../util/lang";


export const HEADER_HEIGHT_BL = 1.0;


export const Table_Desktop: Component<VisualElementProps_Desktop> = (props: VisualElementProps_Desktop) => {
  const tableItem = () => asTableItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const childAreaBoundsPx = () => props.visualElement.childAreaBoundsPx;
  const blockSizePx = () => {
    const sizeBl = { w: tableItem().spatialWidthGr / GRID_SIZE, h: tableItem().spatialHeightGr / GRID_SIZE };
    return { w: boundsPx().w / sizeBl.w, h: boundsPx().h / sizeBl.h };
  }
  const headerHeightPx = () => blockSizePx().h * HEADER_HEIGHT_BL;
  const scale = () => blockSizePx().h / LINE_HEIGHT_PX;
  const overPosRowPx = (): number => {
    const heightBl = tableItem().spatialHeightGr / GRID_SIZE;
    const rowHeightPx = boundsPx().h / heightBl;
    const rowNumber = props.visualElement.moveOverRowNumber.get() + 1;
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
      y: overPosRowPx() - blockSizePx().h,
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
  const columnPositions = () => {
    const colsBl = [];
    let accumBl = 0;
    for (let i=0; i<tableItem().tableColumns.length-1; ++i) {
      let tc = tableItem().tableColumns[i];
      accumBl += tc.widthGr / GRID_SIZE;
      if (accumBl >= tableItem().spatialWidthGr / GRID_SIZE) {
        break;
      }
      colsBl.push(accumBl);
    }
    return colsBl.map(bl => bl * blockSizePx().w);
  };

  return (
    <>
      <Show when={!props.visualElement.isDetailed}>
        <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; `}>
        </div>
      </Show>
      <Show when={props.visualElement.isDetailed}>
        <div class="absolute"
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
          <div class="absolute font-bold"
               style={`left: 0px; top: 0px; width: ${boundsPx().w / scale()}px; height: ${headerHeightPx() / scale()}px; ` +
                      `line-height: ${LINE_HEIGHT_PX * HEADER_HEIGHT_BL}px; transform: scale(${scale()}); transform-origin: top left; ` +
                      `overflow-wrap: break-word;`}>
            {tableItem().title}
          </div>
          <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
               style={`left: 0px; top: ${headerHeightPx()}px; width: ${boundsPx().w}px; height: ${boundsPx().h - headerHeightPx()}px;`}>
          </div>
          <Show when={props.visualElement.movingItemIsOverAttach.get()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                        `background-color: #ff0000;`}>
            </div>
          </Show>
          <For each={props.visualElement.attachments}>{attachmentVe =>
            <VisualElement_Desktop visualElement={attachmentVe.get()} />
          }</For>
          <Show when={props.visualElement.linkItemMaybe != null}>
            <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`}></div>
          </Show>
        </div>
        <TableChildArea visualElement={props.visualElement} />
        <div class="absolute pointer-events-none"
             style={`left: ${childAreaBoundsPx()!.x}px; top: ${childAreaBoundsPx()!.y}px; ` +
                    `width: ${childAreaBoundsPx()!.w}px; height: ${childAreaBoundsPx()!.h}px;`}>
          <For each={columnPositions()}>{posPx=>
            <div class="absolute bg-slate-700"
                 style={`left: ${posPx}px; width: 1px; top: $0px; height: ${childAreaBoundsPx()!.h}px`}></div>
          }</For>
        </div>
        <Show when={props.visualElement.movingItemIsOver.get() && props.visualElement.moveOverRowNumber.get() > -1 && props.visualElement.moveOverColAttachmentNumber.get() < 0}>
          <div class={`absolute border border-black`}
               style={`left: ${boundsPx().x}px; top: ${overPosRowPx()}px; width: ${boundsPx().w}px; height: 2px;`}></div>
        </Show>
        <Show when={props.visualElement.movingItemIsOver.get() && props.visualElement.moveOverColAttachmentNumber.get() >= 0}>
          <div class={`absolute border border-black bg-black`}
               style={`left: ${insertBoundsPx().x}px; top: ${insertBoundsPx().y}px; width: ${insertBoundsPx().w}px; height: ${insertBoundsPx().h}px;`}></div>
        </Show>
      </Show>
    </>
  );
}


const TableChildArea: Component<VisualElementProps_Desktop> = (props: VisualElementProps_Desktop) => {
  let outerDiv: HTMLDivElementWithData | undefined;

  const QUANTIZE_SCROLL_TIMEOUT_MS = 600;

  let scrollDoneTimer: number | null = null;
  function scrollDoneHandler() {
    const row = Math.round(tableItem().scrollYProp.get());
    tableItem().scrollYProp.set(row);
    (outerDiv!)!.scrollTop = row * blockHeightPx();
    scrollDoneTimer = null;
  }

  const tableItem = () => asTableItem(props.visualElement.displayItem);
  const blockHeightPx = () => {
    let heightBr = tableItem().spatialHeightGr / GRID_SIZE - HEADER_HEIGHT_BL;
    let heightPx = props.visualElement.childAreaBoundsPx!.h;
    return heightPx / heightBr;
  }
  const totalScrollableHeightPx = () =>
    tableItem().computed_children.length * blockHeightPx();
  const childAreaBoundsPx = () => props.visualElement.childAreaBoundsPx;

  const scrollHandler = (_ev: Event) => {
    if (scrollDoneTimer != null) { clearTimeout(scrollDoneTimer); }
    scrollDoneTimer = setTimeout(scrollDoneHandler, QUANTIZE_SCROLL_TIMEOUT_MS);
    tableItem().scrollYProp.set((outerDiv!)!.scrollTop / blockHeightPx());
  }

  onMount(() => {
    outerDiv!.scrollTop = tableItem().scrollYProp.get() * blockHeightPx();
  });

  const drawVisibleItems = () => {
    const children = props.visualElement.children;
    const visibleChildrenIds = [];
    const firstItemIdx = Math.floor(tableItem().scrollYProp.get());
    let lastItemIdx = Math.ceil((tableItem().scrollYProp.get() * blockHeightPx() + props.visualElement.childAreaBoundsPx!.h) / blockHeightPx());
    if (lastItemIdx > children.length - 1) { lastItemIdx = children.length - 1; }
    for (let i=firstItemIdx; i<=lastItemIdx; ++i) {
      visibleChildrenIds.push(children[i]);
    }

    const drawChild = (child: VisualElementSignal) => {
      if (!child.get().isLineItem) { panic(); }
      return (
        <>
          <VisualElement_LineItem visualElement={child.get()} />
          <For each={child.get().attachments}>{attachment =>
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
         class="absolute"
         style={`left: ${childAreaBoundsPx()!.x}px; top: ${childAreaBoundsPx()!.y}px; ` +
                `width: ${childAreaBoundsPx()!.w}px; height: ${childAreaBoundsPx()!.h}px; overflow-y: auto;`}
                onscroll={scrollHandler}>
      <div class="absolute" style={`width: ${childAreaBoundsPx()!.w}px; height: ${totalScrollableHeightPx()}px;`}>
        {drawVisibleItems()}
      </div>
    </div>
  );
}


export const Table_LineItem: Component<VisualElementProps_LineItem> = (props: VisualElementProps_LineItem) => {
  const tableItem = () => asTableItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.oneBlockWidthPx!;

  return (
    <>
      <div class="absolute text-center"
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-table`} />
      </div>
      <div class="absolute overflow-hidden"
           style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <span>{tableItem().title}</span>
      </div>
    </>
  );
}
