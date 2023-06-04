/*
  Copyright (C) 2023 The Infumap Authors
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
import { GRID_SIZE, LINE_HEIGHT_PX } from "../../constants";
import { asTableItem } from "../../store/desktop/items/table-item";
import { HTMLDivElementWithData } from "../../util/html";
import { VisualElementInTable, VisualElementInTableProps } from "../VisualElementInTable";
import { VisualElementOnDesktop, VisualElementOnDesktopProps } from "../VisualElementOnDesktop";
import { VisualElementSignal } from "../../util/signals";


export const HEADER_HEIGHT_BL = 1.0;


export const Table: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {

  const tableItem = () => asTableItem(props.visualElement.item);
  const boundsPx = () => props.visualElement.boundsPx;
  const blockSizePx = () => {
    const sizeBl = { w: tableItem().spatialWidthGr / GRID_SIZE, h: tableItem().spatialHeightGr / GRID_SIZE };
    return { w: boundsPx().w / sizeBl.w, h: boundsPx().h / sizeBl.h };
  }
  const headerHeightPx = () => blockSizePx().h * HEADER_HEIGHT_BL;
  const scale = () => blockSizePx().h / LINE_HEIGHT_PX;
  const overPosRowPx = () => {
    const heightBl = tableItem().spatialHeightGr / GRID_SIZE;
    const rowHeightPx = boundsPx().h / heightBl;
    const rowNumber = props.visualElement.moveOverRowNumber.get() + 1;
    const rowPx = rowNumber * rowHeightPx + boundsPx().y;
    return rowPx;
  };

  return (
    <>
      <Show when={!props.visualElement.isInteractive}>
        <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; `}>
        </div>
      </Show>
      <Show when={props.visualElement.isInteractive}>
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
        </div>
        <For each={props.visualElement.attachments}>{attachment =>
          <VisualElementOnDesktop visualElement={attachment.get()} />
        }</For>
        <TableChildArea visualElement={props.visualElement} />
        <Show when={props.visualElement.movingItemIsOver.get() && props.visualElement.moveOverRowNumber.get() > -1}>
          <div class={`absolute border border-black`}
               style={`left: ${boundsPx().x}px; top: ${overPosRowPx()}px; width: ${boundsPx().w}px; height: 2px;`}></div>
        </Show>
      </Show>
    </>
  );
}


const TableChildArea: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  let outerDiv: HTMLDivElementWithData | undefined;

  const QUANTIZE_SCROLL_TIMEOUT_MS = 600;

  let scrollDoneTimer: number | null = null;
  function scrollDoneHandler() {
    const row = Math.round(tableItem().scrollYProp.get());
    tableItem().scrollYProp.set(row);
    (outerDiv!)!.scrollTop = row * blockHeightPx();
  }

  const tableItem = () => asTableItem(props.visualElement.item);
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
      // const item = desktopStore.getItem(childId)!;
      // let attachments: Array<Item> = [];
      // if (isAttachmentsItem(item)) {
      //   attachments = asAttachmentsItem(item).computed_attachments.map(attachmentId => desktopStore.getItem(attachmentId)!);
      // }

      return (
        <>
          <VisualElementInTable visualElement={child.get()} parentVisualElement={props.visualElement} />
          {/* <For each={attachments}>{attachmentItem =>
            <ItemInTable item={attachmentItem} parentTable={tableItem()} renderArea={props.renderArea} renderTreeParentId={tableItem().id} />
          }</For> */}
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
         id={props.visualElement.item.id}
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


export const TableInTable: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  const tableItem = () => asTableItem(props.visualElement.item);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const widthBl = asTableItem(props.parentVisualElement.item).spatialWidthGr / GRID_SIZE;
    return boundsPx().w / widthBl;
  }

  return (
    <>
      <div class="absolute text-center"
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-sticky-note`} />
      </div>
      <div class="absolute overflow-hidden"
           style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <span>{tableItem().title}</span>
        <For each={props.visualElement.attachments}>{attachment =>
          <VisualElementInTable visualElement={attachment.get()} parentVisualElement={props.parentVisualElement} />
        }</For>
      </div>
    </>
  );
}
