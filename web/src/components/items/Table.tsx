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
import { ITEM_TYPE_TABLE } from "../../store/desktop/items/base/item";
import { asTableItem } from "../../store/desktop/items/table-item";
import { VisualElement_Reactive } from "../../store/desktop/visual-element";
import { HTMLDivElementWithData } from "../../util/html";
import { VisualElementInTable, VisualElementInTableProps } from "../VisualElementInTable";
import { VisualElementOnDesktop, VisualElementOnDesktopProps } from "../VisualElementOnDesktop";


export const HEADER_HEIGHT_BL = 1.0;


export const Table: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const desktopStore = useDesktopStore();
  let nodeElement: HTMLDivElementWithData | undefined;

  const tableItem = () => asTableItem(desktopStore.getItem(props.visualElement.itemId)!);
  const boundsPx = () => {
    let currentBoundsPx = props.visualElement.boundsPx();
    if (nodeElement == null) { return currentBoundsPx; }
    nodeElement!.data = {
      itemType: ITEM_TYPE_TABLE,
      itemId: props.visualElement.itemId,
      parentId: tableItem().parentId,
      boundsPx: currentBoundsPx,
      childAreaBoundsPx: props.visualElement.childAreaBoundsPx(),
      hitboxes: props.visualElement.hitboxes(),
      children: []
    };
    return currentBoundsPx;
  };
  const blockSizePx = () => {
    const sizeBl = { w: tableItem().spatialWidthGr / GRID_SIZE, h: tableItem().spatialHeightGr / GRID_SIZE };
    return { w: boundsPx().w / sizeBl.w, h: boundsPx().h / sizeBl.h };
  }
  const headerHeightPx = () => blockSizePx().h * HEADER_HEIGHT_BL;
  const scale = () => blockSizePx().h / LINE_HEIGHT_PX;

  return (
    <>
      <Show when={!props.visualElement.isTopLevel}>
        <div ref={nodeElement}
             id={props.visualElement.itemId}
             class={`absolute border border-slate-700 rounded-sm shadow-lg`}
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
          <VisualElementOnDesktop visualElement={attachment} />
        }</For>
        <TableChildArea visualElement={props.visualElement} />
      </Show>
    </>
  );
}


const TableChildArea: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const desktopStore = useDesktopStore();
  let outerDiv: HTMLDivElementWithData | undefined;

  const tableItem = () => asTableItem(desktopStore.getItem(props.visualElement.itemId)!);
  const blockHeightPx = () => {
    let heightBr = tableItem().spatialHeightGr / GRID_SIZE - HEADER_HEIGHT_BL;
    let heightPx = props.visualElement.childAreaBoundsPx()!.h;
    return heightPx / heightBr;
  }
  const totalScrollableHeightPx = () =>
    tableItem().computed_children.get().length * blockHeightPx();
  const scrollHandler = (_ev: Event) => {
    tableItem().scrollYPx.set((outerDiv!)!.scrollTop);
  }
  onMount(() => {
    outerDiv!.scrollTop = tableItem().scrollYPx.get();
  });
  const childAreaBoundsPx = () => {
    let currentChildAreaBoundsPx = props.visualElement.childAreaBoundsPx();
    if (outerDiv! == null) { return currentChildAreaBoundsPx; }
    outerDiv!.data = {
      itemType: ITEM_TYPE_TABLE,
      itemId: props.visualElement.itemId,
      parentId: tableItem().parentId,
      boundsPx: props.visualElement.boundsPx(),
      childAreaBoundsPx: currentChildAreaBoundsPx,
      hitboxes: props.visualElement.hitboxes(),
      children: []
    };
    return currentChildAreaBoundsPx;
  };

  const drawVisibleItems = () => {
    const children = props.visualElement.children();
    const visibleChildrenIds = [];
    const firstItemIdx = Math.floor(tableItem().scrollYPx.get() / blockHeightPx());
    let lastItemIdx = Math.ceil((tableItem().scrollYPx.get() + props.visualElement.childAreaBoundsPx()!.h) / blockHeightPx());
    if (lastItemIdx > children.length - 1) { lastItemIdx = children.length - 1; }
    for (let i=firstItemIdx; i<=lastItemIdx; ++i) {
      visibleChildrenIds.push(children[i]);
    }

    const drawChild = (child: VisualElement_Reactive) => {
      // const item = desktopStore.getItem(childId)!;
      // let attachments: Array<Item> = [];
      // if (isAttachmentsItem(item)) {
      //   attachments = asAttachmentsItem(item).computed_attachments.map(attachmentId => desktopStore.getItem(attachmentId)!);
      // }

      return (
        <>
          <VisualElementInTable visualElement={child} parentVisualElement={props.visualElement} />
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
         id={props.visualElement.itemId}
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
  const desktopStore = useDesktopStore();
  let nodeElement: HTMLDivElementWithData | undefined;

  const tableItem = () => asTableItem(desktopStore.getItem(props.visualElement.itemId)!);
  const boundsPx = () => {
    let currentBoundsPx = props.visualElement.boundsPx();
    if (nodeElement == null) { return currentBoundsPx; }
    nodeElement!.data = {
      itemType: ITEM_TYPE_TABLE,
      itemId: props.visualElement.itemId,
      parentId: tableItem().parentId,
      boundsPx: currentBoundsPx,
      childAreaBoundsPx: null,
      hitboxes: props.visualElement.hitboxes(),
      children: []
    };
    return currentBoundsPx;
  };
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const widthBl = asTableItem(desktopStore.getItem(props.parentVisualElement.itemId)!).spatialWidthGr / GRID_SIZE;
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
      <div ref={nodeElement}
           id={props.visualElement.itemId}
           class="absolute overflow-hidden"
           style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <span>{tableItem().title}</span>
        <For each={props.visualElement.attachments()}>{attachment =>
          <VisualElementInTable visualElement={attachment} parentVisualElement={props.parentVisualElement} />
        }</For>
      </div>
    </>
  );
}
