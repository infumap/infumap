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
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { asTableItem } from "../../store/desktop/items/table-item";
import { VisualElement } from "../../store/desktop/visual-element";
import { VisualElementInTableFn, VisualElementInTableProps } from "../VisualElementInTable";
import { VisualElementOnDesktopFn, VisualElementOnDesktopProps } from "../VisualElementOnDesktop";


export const HEADER_HEIGHT_BL = 1.0;


export const TableFn: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const desktopStore = useDesktopStore();
  const tableItem = () => asTableItem(desktopStore.getItem(props.visualElement.itemId)!);
  const boundsPx = props.visualElement.boundsPx;
  const blockSizePx = () => {
    const sizeBl = { w: tableItem().spatialWidthGr / GRID_SIZE, h: tableItem().spatialHeightGr / GRID_SIZE };
    return { w: boundsPx().w / sizeBl.w, h: boundsPx().h / sizeBl.h };
  }
  const headerHeightPx = () => blockSizePx().h * HEADER_HEIGHT_BL;
  const scale = () => blockSizePx().h / LINE_HEIGHT_PX;

  return (
    <>
      <Show when={!props.visualElement.isTopLevel}>
        <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
            style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; `}>
        </div>
      </Show>
      <Show when={props.visualElement.isTopLevel}>
        <div class="absolute"
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
          <div class="absolute font-bold"
               style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${headerHeightPx()}px; ` +
                      `line-height: ${LINE_HEIGHT_PX * HEADER_HEIGHT_BL}px; transform: scale(${scale()}); transform-origin: top left; ` +
                      `overflow-wrap: break-word;`}>
            {tableItem().title}
          </div>
          <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
               style={`left: 0px; top: ${headerHeightPx()}px; width: ${boundsPx().w}px; height: ${boundsPx().h - headerHeightPx()}px;`}>
          </div>
        </div>
        <For each={props.visualElement.attachments()}>{attachment =>
          <VisualElementOnDesktopFn visualElement={attachment} />
        }</For>
        <TableChildItems visualElement={props.visualElement} />
      </Show>
    </>
  );
}


const TableChildItems: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const desktopStore = useDesktopStore();

  let outerDiv: HTMLDivElement | undefined;

  const tableItem = () => asTableItem(desktopStore.getItem(props.visualElement.itemId)!);

  const blockHeightPx = () => {
    let heightBr = tableItem().spatialHeightGr / GRID_SIZE - HEADER_HEIGHT_BL;
    let heightPx = props.visualElement.childAreaBoundsPx()!.h;
    return heightPx / heightBr;
  }

  const totalScrollableHeightPx = () =>
    tableItem().computed_children.length * blockHeightPx();

  const scrollHandler = (_ev: Event) => {
    tableItem().setScrollYPx((outerDiv!)!.scrollTop);
  }

  onMount(() => {
    outerDiv!.scrollTop = tableItem().scrollYPx();
  });

  const drawVisibleItems = () => {
    const children = props.visualElement.children();
    const visibleChildrenIds = [];
    const firstItemIdx = Math.floor(tableItem().scrollYPx() / blockHeightPx());
    let lastItemIdx = Math.ceil((tableItem().scrollYPx() + props.visualElement.childAreaBoundsPx()!.h) / blockHeightPx());
    if (lastItemIdx > children.length - 1) { lastItemIdx = children.length - 1; }
    for (let i=firstItemIdx; i<=lastItemIdx; ++i) {
      visibleChildrenIds.push(children[i]);
    }

    const drawChild = (child: VisualElement) => {
      // const item = desktopStore.getItem(childId)!;
      // let attachments: Array<Item> = [];
      // if (isAttachmentsItem(item)) {
      //   attachments = asAttachmentsItem(item).computed_attachments.map(attachmentId => desktopStore.getItem(attachmentId)!);
      // }

      return (
        <>
          <VisualElementInTableFn visualElement={child} parentVisualElement={props.visualElement} />
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
         class="absolute"
         style={`left: ${props.visualElement.childAreaBoundsPx()!.x}px; top: ${props.visualElement.childAreaBoundsPx()!.y}px; ` +
                `width: ${props.visualElement.childAreaBoundsPx()!.w}px; height: ${props.visualElement.childAreaBoundsPx()!.h}px; overflow-y: auto;`}
                onscroll={scrollHandler}>
      <div class="absolute" style={`width: ${props.visualElement.childAreaBoundsPx()!.w}px; height: ${totalScrollableHeightPx()}px;`}>
        {drawVisibleItems()}
      </div>
    </div>
  );
}


export const TableInTableFn: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  const desktopStore = useDesktopStore();
  const tableItem = () => asTableItem(desktopStore.getItem(props.visualElement.itemId)!);
  const boundsPx = props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const widthBl = asTableItem(desktopStore.getItem(props.parentVisualElement.itemId)!).spatialWidthGr / GRID_SIZE;
    return boundsPx().w / widthBl;
  }

  return (
    <div class="absolute overflow-hidden"
         style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      {tableItem().title}
      <For each={props.visualElement.attachments()}>{attachment =>
        <VisualElementInTableFn visualElement={attachment} parentVisualElement={props.parentVisualElement} />
      }</For>
    </div>
  );
}
