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

import { Component, For, Match, Show, Switch, onMount, createEffect } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { VisualElement_Desktop, VisualElement_LineItem } from "../VisualElement";
import { LINE_HEIGHT_PX, PAGE_DOCUMENT_LEFT_MARGIN_BL, CALENDAR_DAY_LABEL_LEFT_MARGIN_PX } from "../../constants";
import { UMBRELLA_PAGE_UID } from "../../util/uid";
import { ArrangeAlgorithm, asPageItem } from "../../items/page-item";
import { edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";
import { PageVisualElementProps } from "./Page";
import { BorderType, borderColorForColorIdx } from "../../style";
import { getMonthInfo } from "../../util/time";
import { calculateCalendarDimensions, CALENDAR_LAYOUT_CONSTANTS, isCurrentDay } from "../../util/calendar-layout";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Root: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  let updatingRootScrollTop = false;
  let rootDiv: any = undefined;

  const pageFns = () => props.pageFns;

  onMount(() => {
    let veid = store.history.currentPageVeid()!;
    if (props.visualElement.flags & VisualElementFlags.ListPageRoot) {
      const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath!);
      veid = store.perItem.getSelectedListPageItem(parentVeid);
    }

    const scrollXProp = store.perItem.getPageScrollXProp(veid);
    const scrollXPx = scrollXProp * (pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);

    const scrollYProp = store.perItem.getPageScrollYProp(veid);
    const scrollYPx = scrollYProp * (pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);

    rootDiv.scrollTop = scrollYPx;
    rootDiv.scrollLeft = scrollXPx;
  });

  createEffect(() => {
    // occurs on page arrange algorithm change.
    if (!pageFns().childAreaBoundsPx()) { return; }

    updatingRootScrollTop = true;

    if (rootDiv) {
      let veid = store.history.currentPageVeid()!;
      if (props.visualElement.flags & VisualElementFlags.ListPageRoot) {
        const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath!);
        veid = store.perItem.getSelectedListPageItem(parentVeid);
      }

      rootDiv.scrollTop =
        store.perItem.getPageScrollYProp(veid) *
        (pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);
      rootDiv.scrollLeft =
        store.perItem.getPageScrollXProp(veid) *
        (pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);
    }

    setTimeout(() => {
      updatingRootScrollTop = false;
    }, 0);
  });

  const listRootScrollHandler = (_ev: Event) => {
    if (!rootDiv || updatingRootScrollTop) { return; }

    const pageBoundsPx = props.visualElement.listChildAreaBoundsPx!.h;
    const desktopSizePx = props.visualElement.boundsPx;

    let veid = store.history.currentPageVeid()!;
    if (props.visualElement.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
      veid = VeFns.actualVeidFromVe(props.visualElement);
    } else if (props.visualElement.parentPath != UMBRELLA_PAGE_UID) {
      const parentVeid = VeFns.actualVeidFromPath(props.visualElement.parentPath!);
      veid = store.perItem.getSelectedListPageItem(parentVeid);
    }

    if (desktopSizePx.h < pageBoundsPx) {
      const scrollYProp = rootDiv!.scrollTop / (pageBoundsPx - desktopSizePx.h);
      store.perItem.setPageScrollYProp(veid, scrollYProp);
    }
  }

  const renderBorderOverlay = () => {
    if (!pageFns().isPublic() || store.user.getUserMaybe() == null) {
      return null;
    }

    const borderWidth = 3;
    const bounds = pageFns().viewportBoundsPx();
    const dockWidthPx = store.getCurrentDockWidthPx();

    const leftOffset = dockWidthPx;
    const topOffset = store.topToolbarHeightPx() + (pageFns().boundsPx().h - bounds.h);

    return (
      <>
        <div class="fixed" style={`left: ${leftOffset}px; top: ${topOffset}px; width: ${bounds.w}px; height: ${borderWidth}px; background-color: #ff0000; pointer-events: none; ${VeFns.zIndexStyle(props.visualElement)} z-index: 9999;`} />
        <div class="fixed" style={`left: ${leftOffset}px; top: ${topOffset + bounds.h - borderWidth}px; width: ${bounds.w}px; height: ${borderWidth}px; background-color: #ff0000; pointer-events: none; ${VeFns.zIndexStyle(props.visualElement)} z-index: 9999;`} />
        <div class="fixed" style={`left: ${leftOffset}px; top: ${topOffset}px; width: ${borderWidth}px; height: ${bounds.h}px; background-color: #ff0000; pointer-events: none; ${VeFns.zIndexStyle(props.visualElement)} z-index: 9999;`} />
        <div class="fixed" style={`left: ${leftOffset + bounds.w - borderWidth}px; top: ${topOffset}px; width: ${borderWidth}px; height: ${bounds.h}px; background-color: #ff0000; pointer-events: none; ${VeFns.zIndexStyle(props.visualElement)} z-index: 9999;`} />
      </>
    );
  };

  const renderListPage = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
         style={`width: ${pageFns().viewportBoundsPx().w}px; ` +
                `height: ${pageFns().viewportBoundsPx().h + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; left: 0px; ` +
                `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
                `background-color: #ffffff;` +
                `${VeFns.zIndexStyle(props.visualElement)}`}>
      <div ref={rootDiv}
           class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} `}
           style={`width: ${pageFns().viewportBoundsPx().w}px; ` +
                  `height: ${pageFns().viewportBoundsPx().h}px; ` +
                  `overflow-y: auto; `}
           onscroll={listRootScrollHandler}>
        <div class={`absolute ${props.visualElement.flags & VisualElementFlags.DockItem ? "" : "border-slate-300"}`}
             style={`width: ${LINE_HEIGHT_PX * pageFns().listColumnWidthBl()}px; height: ${props.visualElement.listChildAreaBoundsPx!.h}px;` +
                    `border-right-width: ${props.visualElement.focusedChildItemMaybe == null ? 1 : 2}px;` +
                    `${props.visualElement.focusedChildItemMaybe == null ? '' : 'border-right-color: ' + borderColorForColorIdx(asPageItem(props.visualElement.focusedChildItemMaybe).backgroundColorIndex, BorderType.MainPage) + ';' }`}>
          <For each={pageFns().lineChildren()}>{childVe =>
            <VisualElement_LineItem visualElement={childVe.get()} />
          }</For>
          {pageFns().renderMoveOverAnnotationMaybe()}
        </div>
      </div>
      <For each={pageFns().desktopChildren()}>{childVe =>
        <VisualElement_Desktop visualElement={childVe.get()} />
      }</For>
      <Show when={props.visualElement.selectedVes != null && props.visualElement.selectedVes.get() != null}>
        <VisualElement_Desktop visualElement={props.visualElement.selectedVes!.get()!} />
      </Show>
      <Show when={props.visualElement.popupVes != null && props.visualElement.popupVes.get() != null}>
        <VisualElement_Desktop visualElement={props.visualElement.popupVes!.get()!} />
      </Show>
      {renderBorderOverlay()}
    </div>;

  const keyUpHandler = (ev: KeyboardEvent) => {
    edit_keyUpHandler(store, ev);
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    edit_keyDownHandler(store, props.visualElement, ev);
  }

  const inputListener = (ev: InputEvent) => {
    edit_inputListener(store, ev);
  }
  
  const rootScrollHandler = (_ev: Event) => {
    if (!rootDiv || updatingRootScrollTop) { return; }

    const pageBoundsPx = props.visualElement.childAreaBoundsPx!;
    const desktopSizePx = props.visualElement.boundsPx;

    let veid = store.history.currentPageVeid()!;
    if (props.visualElement.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
      veid = VeFns.actualVeidFromVe(props.visualElement);
    } else if (props.visualElement.parentPath != UMBRELLA_PAGE_UID) {
      const parentVeid = VeFns.actualVeidFromPath(props.visualElement.parentPath!);
      veid = store.perItem.getSelectedListPageItem(parentVeid);
    }

    if (desktopSizePx.w < pageBoundsPx.w) {
      const scrollXProp = rootDiv!.scrollLeft / (pageBoundsPx.w - desktopSizePx.w);
      store.perItem.setPageScrollXProp(veid, scrollXProp);
    }

    if (desktopSizePx.h < pageBoundsPx.h) {
      const scrollYProp = rootDiv!.scrollTop / (pageBoundsPx.h - desktopSizePx.h);
      store.perItem.setPageScrollYProp(veid, scrollYProp);
    }
  }

  const renderCalendarPage = () => {
    const currentYear = new Date().getFullYear();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

    const calendarDimensions = calculateCalendarDimensions(pageFns().childAreaBoundsPx());

    const isWeekend = (dayOfWeek: number) => dayOfWeek === 0 || dayOfWeek === 6; // Sunday or Saturday

    return (
      <div ref={rootDiv}
           class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
           style={`left: 0px; ` +
                 `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
                  `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
                  `overflow-y: ${pageFns().viewportBoundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                  `overflow-x: ${pageFns().viewportBoundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                  `${VeFns.zIndexStyle(props.visualElement)} `}
          onscroll={rootScrollHandler}>
        <div class="absolute"
             style={`left: 0px; top: 0px; ` +
                    `width: ${pageFns().childAreaBoundsPx().w}px; ` +
                    `height: ${pageFns().childAreaBoundsPx().h}px;` +
                    `outline: 0px solid transparent; `}
            contentEditable={store.overlay.textEditInfo() != null && pageFns().isDocumentPage()}
            onKeyUp={keyUpHandler}
            onKeyDown={keyDownHandler}
            onInput={inputListener}>

          {/* Year title */}
          <div class="absolute text-center font-bold text-2xl"
               style={`left: ${CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN}px; top: ${CALENDAR_LAYOUT_CONSTANTS.TOP_PADDING}px; width: ${pageFns().childAreaBoundsPx().w - 2 * CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN}px; height: ${CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT}px; line-height: ${CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT}px;`}>
            {currentYear}
          </div>

          {/* Calendar months */}
          <For each={Array.from({length: 12}, (_, i) => i + 1)}>{month => {
            const monthInfo = getMonthInfo(month, currentYear);
            const leftPos = CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN + (month - 1) * (calendarDimensions.columnWidth + CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING);

            return (
              <div class="absolute"
                   style={`left: ${leftPos}px; top: ${CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + CALENDAR_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING}px; width: ${calendarDimensions.columnWidth}px;`}>

                {/* Month title */}
                <div class="text-center font-semibold text-base"
                     style={`height: ${CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT}px; line-height: ${CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT}px;`}>
                  {monthNames[month - 1]}
                </div>

                {/* Days in month */}
                <For each={Array.from({length: monthInfo.daysInMonth}, (_, i) => i + 1)}>{day => {
                  const dayOfWeek = (monthInfo.firstDayOfWeek + day - 1) % 7;
                  const topPos = CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT + (day - 1) * calendarDimensions.dayRowHeight;
                  const isToday = isCurrentDay(month, day, currentYear);

                  let backgroundColor = '#ffffff';
                  if (isToday) {
                    backgroundColor = '#fef3c7';
                  } else if (isWeekend(dayOfWeek)) {
                    backgroundColor = '#f5f5f5';
                  }

                  return (
                    <div class="absolute flex items-start"
                         style={`left: 0px; top: ${topPos}px; width: ${calendarDimensions.columnWidth}px; height: ${calendarDimensions.dayRowHeight}px; ` +
                                `background-color: ${backgroundColor}; ` +
                                `border-bottom: 1px solid #e5e5e5; padding-top: 5px;`}>
                      <span style="width: 14px; text-align: right; font-size: 10px; margin-left: 2px;">{day}</span>
                      <span class="text-gray-600" style="font-size: 10px; margin-left: 3px;">{dayNames[dayOfWeek]}</span>
                    </div>
                  );
                }}</For>
              </div>
            );
          }}</For>

          {/* Render child items arranged in calendar grid */}
          <For each={props.visualElement.childrenVes}>{childVes =>
            <VisualElement_LineItem visualElement={childVes.get()} />
          }</For>
          <Show when={props.visualElement.popupVes != null && props.visualElement.popupVes.get() != null}>
            <VisualElement_Desktop visualElement={props.visualElement.popupVes!.get()!} />
          </Show>
        </div>
        {renderBorderOverlay()}
      </div>
    );
  };

  const renderPage = () =>
    <div ref={rootDiv}
         class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm`}
         style={`left: 0px; ` +
                `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
                `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
                `overflow-y: ${pageFns().viewportBoundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                `overflow-x: ${pageFns().viewportBoundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                `${VeFns.zIndexStyle(props.visualElement)} `}
         onscroll={rootScrollHandler}>
      <div class="absolute"
           style={`left: 0px; top: 0px; ` +
                  `width: ${pageFns().childAreaBoundsPx().w}px; ` +
                  `height: ${pageFns().childAreaBoundsPx().h}px;` +
                  `outline: 0px solid transparent; `}
           contentEditable={store.overlay.textEditInfo() != null && pageFns().isDocumentPage()}
           onKeyUp={keyUpHandler}
           onKeyDown={keyDownHandler}
           onInput={inputListener}>
        <For each={props.visualElement.childrenVes}>{childVes =>
          <VisualElement_Desktop visualElement={childVes.get()} />
        }</For>
        <Show when={props.visualElement.popupVes != null && props.visualElement.popupVes.get() != null}>
          <VisualElement_Desktop visualElement={props.visualElement.popupVes!.get()!} />
        </Show>
        <Show when={pageFns().isDocumentPage()}>
          <>
            <div class="absolute" style={`left: ${(PAGE_DOCUMENT_LEFT_MARGIN_BL - 0.5) * LINE_HEIGHT_PX}px; top: 0px; width: 1px; height: ${pageFns().childAreaBoundsPx().h}px; background-color: #eee;`} />
            <div class="absolute" style={`left: ${(asPageItem(props.visualElement.displayItem).docWidthBl + PAGE_DOCUMENT_LEFT_MARGIN_BL + 0.5) * LINE_HEIGHT_PX}px; top: 0px; width: 1px; height: ${pageFns().childAreaBoundsPx().h}px; background-color: #eee;`} />
          </>
        </Show>
        {pageFns().renderGridLinesMaybe()}
        {pageFns().renderMoveOverAnnotationMaybe()}
      </div>
      {renderBorderOverlay()}
    </div>;

  return (
    <>
      <div class={`absolute`}
           style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
                  `background-color: #ffffff;`}>
        <Switch>
          <Match when={pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
            {renderListPage()}
          </Match>
          <Match when={pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.Calendar}>
            {renderCalendarPage()}
          </Match>
          <Match when={pageFns().pageItem().arrangeAlgorithm != ArrangeAlgorithm.List && pageFns().pageItem().arrangeAlgorithm != ArrangeAlgorithm.Calendar}>
            {renderPage()}
          </Match>
        </Switch>
      </div>
    </>
  );
}
