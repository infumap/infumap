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
import { ATTACH_AREA_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, TABLE_COL_HEADER_HEIGHT_BL, TABLE_TITLE_HEADER_HEIGHT_BL } from "../../constants";
import { asTableItem } from "../../items/table-item";
import { VisualElement_LineItem, VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { BoundingBox, cloneBoundingBox } from "../../util/geometry";
import { useStore } from "../../store/StoreProvider";
import { VisualElementFlags, VeFns } from "../../layout/visual-element";
import { TableFlags } from "../../items/base/flags-item";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { rearrangeTableAfterScroll } from "../../layout/arrange/table";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

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
        <div id={VeFns.veToPath(props.visualElement) + ":title"}
             class={`absolute font-bold ${store.overlay.tableEditInfo() == null ? 'hidden-selection' : ''}`}
             style={`left: 0px; top: 0px; ` +
                    `width: ${boundsPx().w / scale()}px; height: ${headerHeightPx() / scale()}px; ` +
                    `line-height: ${LINE_HEIGHT_PX * TABLE_TITLE_HEADER_HEIGHT_BL}px; ` +
                    `transform: scale(${scale()}); transform-origin: top left; ` +
                    `overflow-wrap: break-word; ` +
                    `outline: 0px solid transparent; ` +
                    `${store.overlay.tableEditInfo() == null ? 'caret-color: transparent' : ''}`}
              contentEditable={true}
              spellcheck={store.overlay.tableEditInfo() != null}>
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
          <InfuLinkTriangle />
        </Show>
      </div>
      <TableChildArea visualElement={props.visualElement} />
      <div class='absolute'
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
              <div id={VeFns.veToPath(props.visualElement) + ":col" + spec.idx}
                   class={`absolute whitespace-nowrap overflow-hidden ${store.overlay.tableEditInfo() == null ? 'hidden-selection' : ''}`}
                   style={`left: ${spec.startPosPx + 0.15 * blockSizePx().w}px; top: 0px; ` +
                          `width: ${(spec.endPosPx - spec.startPosPx - 0.15 * blockSizePx().w) / scale()}px; height: ${headerHeightPx() / scale()}px; ` +
                          `line-height: ${LINE_HEIGHT_PX * TABLE_TITLE_HEADER_HEIGHT_BL}px; ` +
                          `transform: scale(${scale()}); transform-origin: top left;` +
                          `outline: 0px solid transparent; ` +
                          `${store.overlay.tableEditInfo() == null ? 'caret-color: transparent' : ''}`}
                   contentEditable={true}
                   spellcheck={store.overlay.tableEditInfo() != null}>
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
  const tableItem = () => asTableItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = () => {
    if (props.visualElement.displayItem.relationshipToParent == RelationshipToParent.Child &&
        props.visualElement.tableDimensionsPx) { // not set if not in table.
      let r = cloneBoundingBox(boundsPx())!;
      r.w = props.visualElement.tableDimensionsPx!.w;
      return r;
    }
    return boundsPx();
  }
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={!props.visualElement.mouseIsOverOpenPopup.get() && props.visualElement.mouseIsOver.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${highlightBoundsPx().x+2}px; top: ${highlightBoundsPx().y+2}px; width: ${highlightBoundsPx().w-4}px; height: ${highlightBoundsPx().h-4}px;`} />
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
      {renderIcon()}
      {renderText()}
      {renderLinkMarkingMaybe()}
    </>
  );
}
