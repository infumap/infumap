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

import { Component, For, Match, Show, Switch, createEffect, onMount } from "solid-js";
import { ANCHOR_BOX_SIZE_PX, ANCHOR_OFFSET_PX, LINE_HEIGHT_PX, CALENDAR_DAY_LABEL_LEFT_MARGIN_PX } from "../../constants";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { BorderType, Colors, LIGHT_BORDER_COLOR, borderColorForColorIdx, linearGradient } from "../../style";
import { hexToRGBA } from "../../util/color";
import { VisualElement_Desktop, VisualElement_LineItem } from "../VisualElement";
import { ArrangeAlgorithm, PageFns, asPageItem } from "../../items/page-item";
import { PageVisualElementProps } from "./Page";
import { getMonthInfo } from "../../util/time";
import { calculateCalendarDimensions, CALENDAR_LAYOUT_CONSTANTS, isCurrentDay } from "../../util/calendar-layout";
import { fullArrange } from "../../layout/arrange";
import { itemState } from "../../store/ItemState";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Popup: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  let updatingPopupScrollTop = false;
  let popupDiv: any = undefined; // HTMLDivElement | undefined

  const pageFns = () => props.pageFns;

  onMount(() => {
    let veid = store.history.currentPopupSpec()!.actualVeid;

    const scrollXProp = store.perItem.getPageScrollXProp(veid);
    const scrollXPx = scrollXProp * (pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);

    const scrollYProp = store.perItem.getPageScrollYProp(veid);
    const scrollYPx = scrollYProp * (pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);

    popupDiv.scrollTop = scrollYPx;
    popupDiv.scrollLeft = scrollXPx;
  });

  createEffect(() => {
    // occurs on page arrange algorithm change.
    if (!pageFns().childAreaBoundsPx()) { return; }

    updatingPopupScrollTop = true;

    if (popupDiv && store.history.currentPopupSpec()) {
      popupDiv.scrollTop =
        store.perItem.getPageScrollYProp(store.history.currentPopupSpec()!.actualVeid) *
        (pageFns().childAreaBoundsPx().h - props.visualElement.viewportBoundsPx!.h);
      popupDiv.scrollLeft =
        store.perItem.getPageScrollXProp(store.history.currentPopupSpec()!.actualVeid) *
        (pageFns().childAreaBoundsPx().w - props.visualElement.viewportBoundsPx!.w);
    }

    setTimeout(() => {
      updatingPopupScrollTop = false;
    }, 0);
  });

  const borderColorVal = () => {
    if (props.visualElement.flags & VisualElementFlags.HasToolbarFocus) {
      return `${borderColorForColorIdx(pageFns().pageItem().backgroundColorIndex, BorderType.Popup)}; `
    }
    return LIGHT_BORDER_COLOR;
  };

  const titleScale = () => (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h) / LINE_HEIGHT_PX;

  const titleColor = () => `${hexToRGBA(Colors[pageFns().pageItem().backgroundColorIndex], 1.0)}; `;

  const popupScrollHandler = (_ev: Event) => {
    if (!popupDiv) { return; }
    if (updatingPopupScrollTop) { return; }

    const viewportBoundsPx = props.visualElement.viewportBoundsPx!;
    const childAreaBoundsPx_ = pageFns().childAreaBoundsPx();
    const popupVeid = store.history.currentPopupSpec()!.actualVeid;

    if (childAreaBoundsPx_.h > viewportBoundsPx.h) {
      const scrollYProp = popupDiv!.scrollTop / (childAreaBoundsPx_.h - viewportBoundsPx.h);
      store.perItem.setPageScrollYProp(popupVeid, scrollYProp);
    }
    if (childAreaBoundsPx_.w > viewportBoundsPx.w) {
      const scrollXProp = popupDiv!.scrollLeft / (childAreaBoundsPx_.w - viewportBoundsPx.w);
      store.perItem.setPageScrollXProp(popupVeid, scrollXProp);
    }
  };

  const renderShadow = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} text-xl font-bold rounded-md p-8 blur-md`}
         style={`left: ${pageFns().boundsPx().x - 10}px; ` +
                `top: ${pageFns().boundsPx().y-10 + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                `width: ${pageFns().boundsPx().w+20}px; height: ${pageFns().boundsPx().h+20}px; ` +
                `background-color: #606060e8;` +
                `${VeFns.zIndexStyle(props.visualElement)}`}>
    </div>;

  const renderPopupTitle = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"}`}
         style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h - pageFns().viewportBoundsPx().h}px; ` +
                `background-color: #fff; ` +
                `${VeFns.zIndexStyle(props.visualElement)}` +
                `background-image: ${linearGradient(pageFns().pageItem().backgroundColorIndex, 0.9)};`}>
          <div class="absolute font-bold"
           style={`left: 0px; top: ${(pageFns().boundsPx().h - pageFns().viewportBoundsPx().h) / titleScale() * 0.05}px; ` +
                  `width: ${pageFns().boundsPx().w / titleScale() * 0.9}px; ` +
                  `height: ${(pageFns().boundsPx().h - pageFns().viewportBoundsPx().h) / titleScale() * 0.9}px; ` +
                  `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${titleScale() * 0.9}); ` +
                  `transform-origin: top left; ` +
                  `overflow-wrap: break-word; ` +
                  `padding-left: 4px; ` +
                  `margin-left: 3px;` +
                  `color: ${titleColor()}`}>
        {props.visualElement.evaluatedTitle ?? pageFns().pageItem().title}
      </div>
    </div>;

  const renderListPage = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"}`}
         style={`width: ${pageFns().viewportBoundsPx().w}px; ` +
                `height: ${pageFns().viewportBoundsPx().h}px; ` +
                `left: ${pageFns().viewportBoundsPx().x}px; ` +
                `top: ${pageFns().viewportBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                `background-color: #ffffff;` +
                `${VeFns.zIndexStyle(props.visualElement)}`}>
      <div ref={popupDiv}
           class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} border-r border-slate-100`}
           style={`overflow-y: auto; overflow-x: hidden; ` +
                  `width: ${LINE_HEIGHT_PX * pageFns().listColumnWidthBl() * pageFns().listViewScale()}px; ` +
                  `height: ${pageFns().viewportBoundsPx().h}px; ` +
                  `background-color: #ffffff;` +
                  `${VeFns.zIndexStyle(props.visualElement)}`}>
        <div class="absolute"
             style={`width: ${LINE_HEIGHT_PX * pageFns().listColumnWidthBl()}px; height: ${LINE_HEIGHT_PX * pageFns().lineChildren().length}px`}>
          <For each={pageFns().lineChildren()}>{childVe =>
            <VisualElement_LineItem visualElement={childVe.get()} />
          }</For>
        </div>
      </div>
      <For each={pageFns().desktopChildren()}>{childVe =>
        <VisualElement_Desktop visualElement={childVe.get()} />
      }</For>
      <Show when={props.visualElement.selectedVes != null && props.visualElement.selectedVes.get() != null}>
        <VisualElement_Desktop visualElement={props.visualElement.selectedVes!.get()} />
      </Show>
    </div>;

  const renderPage = () =>
    <div ref={popupDiv}
         class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} border-t border-slate-300`}
         style={`left: ${pageFns().viewportBoundsPx().x}px; ` +
                `top: ${pageFns().viewportBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
                `background-color: #ffffff;` +
                `overflow-y: ${pageFns().viewportBoundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
                `overflow-x: ${pageFns().viewportBoundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
                `${VeFns.zIndexStyle(props.visualElement)}`}
         onscroll={popupScrollHandler}>
      <div class="absolute"
           style={`left: ${pageFns().viewportBoundsPx().w - pageFns().childAreaBoundsPx().w}px; ` +
                  `top: ${0}px; ` +
                  `width: ${pageFns().childAreaBoundsPx().w}px; ` +
                  `height: ${pageFns().childAreaBoundsPx().h}px;`}>
        <For each={props.visualElement.childrenVes}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
        {pageFns().renderGridLinesMaybe()}
        {pageFns().renderMoveOverAnnotationMaybe()}
      </div>
    </div>;

  const renderCalendarPage = () => {
    const currentYear = store.perVe.getCalendarYear(VeFns.veToPath(props.visualElement));
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const calendarDimensions = calculateCalendarDimensions(pageFns().childAreaBoundsPx());
    const baseDayRowPx = asPageItem(props.visualElement.displayItem).calendarDayRowHeightBl * LINE_HEIGHT_PX;
    const popupTopPadding = 5;
    const popupTitleToMonthSpacing = 8;
    const popupMonthTitleHeight = 26;
    const popupBottomMargin = 3;
    const headerTotal = popupTopPadding + CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + popupTitleToMonthSpacing + popupMonthTitleHeight + popupBottomMargin;
    const naturalTotal = headerTotal + CALENDAR_LAYOUT_CONSTANTS.DAYS_COUNT * baseDayRowPx;
    const scale = baseDayRowPx > 0 ? (pageFns().childAreaBoundsPx().h / naturalTotal) : 1.0;
    const effectiveDayRowHeight = baseDayRowPx * scale;
    const isWeekend = (dayOfWeek: number) => dayOfWeek === 0 || dayOfWeek === 6;

    return (
      <div ref={popupDiv}
           class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} border-t border-slate-300`}
           style={`left: ${pageFns().viewportBoundsPx().x}px; ` +
                  `top: ${pageFns().viewportBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                  `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
                  `background-color: #ffffff; ` +
                  `overflow: hidden; ` +
                  `${VeFns.zIndexStyle(props.visualElement)} `}
           onscroll={popupScrollHandler}>
        <div class="absolute"
             style={`left: 0px; top: 0px; ` +
                    `width: ${pageFns().childAreaBoundsPx().w}px; ` +
                    `height: ${pageFns().childAreaBoundsPx().h}px;` +
                    `outline: 0px solid transparent; `}>
          <div class="absolute flex items-center justify-center"
               style={`left: 0px; top: ${popupTopPadding * scale}px; width: ${pageFns().childAreaBoundsPx().w}px; height: ${CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT * scale}px;`}>
            <div class="flex items-center justify-center font-bold"
                 style={`transform: scale(${scale}); transform-origin: center center;`}>
              <div class="cursor-pointer hover:bg-gray-200 rounded p-2 mr-2 text-gray-300"
                   onMouseDown={(e) => e.stopPropagation()}
                   onClick={() => {
                     store.perVe.setCalendarYear(VeFns.veToPath(props.visualElement), currentYear - 1);
                     fullArrange(store);
                   }}>
                <i class="fas fa-angle-left" />
              </div>
              <span class="mx-2 text-2xl">{currentYear}</span>
              <div class="cursor-pointer hover:bg-gray-200 rounded p-2 ml-2 text-gray-300"
                   onMouseDown={(e) => e.stopPropagation()}
                   onClick={() => {
                     store.perVe.setCalendarYear(VeFns.veToPath(props.visualElement), currentYear + 1);
                     fullArrange(store);
                   }}>
                <i class="fas fa-angle-right" />
              </div>
            </div>
          </div>

          <For each={Array.from({length: 12}, (_, i) => i + 1)}>{month => {
            const monthInfo = getMonthInfo(month, currentYear);
            const leftPos = CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN + (month - 1) * (calendarDimensions.columnWidth + CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING);

            return (
               <div class="absolute"
                    style={`left: ${leftPos}px; top: ${(popupTopPadding + CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + popupTitleToMonthSpacing) * scale}px; width: ${calendarDimensions.columnWidth}px;`}>
                <div class="text-center font-semibold"
                     style={`height: ${popupMonthTitleHeight}px; line-height: ${popupMonthTitleHeight}px; width: ${calendarDimensions.columnWidth}px; transform: scale(${scale}); transform-origin: top left;`}>
                  <span class="text-base" style={`position: relative; top: 3px;`}>{monthNames[month - 1]}</span>
                </div>

                <For each={Array.from({length: monthInfo.daysInMonth}, (_, i) => i + 1)}>{day => {
                  const dayOfWeek = (monthInfo.firstDayOfWeek + day - 1) % 7;
                   const topPos = popupMonthTitleHeight * scale + (day - 1) * effectiveDayRowHeight;
                  const isToday = isCurrentDay(month, day, currentYear);

                  let backgroundColor = '#ffffff';
                  if (isToday) {
                    backgroundColor = '#fef3c7';
                  } else if (isWeekend(dayOfWeek)) {
                    backgroundColor = '#f5f5f5';
                  }

                  return (
                    <div class="absolute"
                          style={`left: 0px; top: ${topPos}px; width: ${calendarDimensions.columnWidth}px; height: ${effectiveDayRowHeight}px; ` +
                                `background-color: ${backgroundColor}; ` +
                                `border-bottom: 1px solid #e5e5e5; box-sizing: border-box;`}>
                      <div class="flex items-start"
                           style={`width: ${calendarDimensions.columnWidth / scale}px; height: ${effectiveDayRowHeight / scale}px; transform: scale(${scale}); transform-origin: top left; padding-top: 5px;`}>
                        <div style={`width: ${CALENDAR_DAY_LABEL_LEFT_MARGIN_PX / scale}px; display: flex; align-items: flex-start; justify-content: flex-end;`}>
                          <span style="font-size: 10px; margin-right: 2px;">{day}</span>
                        </div>
                        <div style={`width: ${(calendarDimensions.columnWidth - CALENDAR_DAY_LABEL_LEFT_MARGIN_PX) / scale}px;`} />
                      </div>
                    </div>
                  );
                }}</For>
              </div>
            );
          }}</For>

          <For each={props.visualElement.childrenVes}>{childVes =>
            <VisualElement_LineItem visualElement={childVes.get()} />
          }</For>

          {(() => {
            const childArea = pageFns().childAreaBoundsPx();
            const dims = calculateCalendarDimensions(childArea);
            const block = { w: LINE_HEIGHT_PX, h: LINE_HEIGHT_PX } as const;
            const rowsPerDay = Math.max(1, Math.floor(effectiveDayRowHeight / block.h));

            const itemCounts = new Map<string, number>();
            const pageItem = asPageItem(props.visualElement.displayItem);
            const year = store.perVe.getCalendarYear(VeFns.veToPath(props.visualElement));
            for (const childId of pageItem.computed_children) {
              const it = itemState.get(childId);
              if (!it) continue;
              const d = new Date(it.dateTime * 1000);
              if (d.getFullYear() !== year) continue;
              const key = `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
              itemCounts.set(key, (itemCounts.get(key) || 0) + 1);
            }

            const overlays: any[] = [];
            itemCounts.forEach((totalCount, key) => {
              if (totalCount <= rowsPerDay) return;
              const [y, m, dd] = key.split('-').map(n => parseInt(n, 10));
              const month = m;
              const day = dd;
              const monthLeftPos = CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN + (month - 1) * (dims.columnWidth + CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING);
              const dayAreaTopPopup = (popupTopPadding + CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + popupTitleToMonthSpacing + popupMonthTitleHeight) * scale;
              const dayTopPos = dayAreaTopPopup + (day - 1) * effectiveDayRowHeight;
              const rightEdge = monthLeftPos + dims.columnWidth;
              const baseX = rightEdge - block.w;
              const baseY = dayTopPos + (rowsPerDay - 1) * effectiveDayRowHeight + 1;
              const overlayWidth = block.w - 2;
              const overlayHeight = Math.max(8, Math.round(effectiveDayRowHeight)) - 4;
              const overlayX = baseX + 2;
              const overlayY = baseY + 2;
              overlays.push(
                <div class="absolute flex items-center justify-center font-semibold text-gray-700 bg-gray-100 border border-gray-300 rounded"
                      style={`left: ${overlayX}px; top: ${overlayY}px; width: ${overlayWidth}px; height: ${overlayHeight}px; font-size: ${Math.max(8, Math.round(10*scale))}px;`}>{totalCount}</div>
              );
            });
            return overlays;
          })()}
        </div>
      </div>
    );
  };

  const hasChildChanges = () => {
    const parentPage = pageFns().parentPage();
    if (!parentPage) return false;
    if (parentPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
      return PageFns.childPopupPositioningHasChanged(parentPage, pageFns().pageItem());
    } else {
      return PageFns.childCellPopupPositioningHasChanged(parentPage, pageFns().pageItem());
    }
  };
  const hasDefaultChanges = () => {
    const parentPage = pageFns().parentPage();
    if (!parentPage) return false;
    if (parentPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
      return PageFns.defaultPopupPositioningHasChanged(parentPage, pageFns().pageItem());
    } else {
      return PageFns.defaultCellPopupPositioningHasChanged(parentPage, pageFns().pageItem());
    }
  };

  const renderAnchorChildMaybe = () => {
    const rightOffset = ANCHOR_OFFSET_PX * titleScale();
    return (
      <Show when={hasChildChanges()}>
        <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm text-gray-900 pointer-events-none`}
              style={`left: ${1 + pageFns().boundsPx().x + pageFns().boundsPx().w - ANCHOR_BOX_SIZE_PX * titleScale() - rightOffset}px; ` +
                     `top: ${1 + pageFns().boundsPx().y + ANCHOR_OFFSET_PX * titleScale() / 3 * 2 + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                     `width: ${ANCHOR_BOX_SIZE_PX * titleScale()}px; ` +
                     `height: ${ANCHOR_BOX_SIZE_PX * titleScale()}px; ` +
                     `${VeFns.zIndexStyle(props.visualElement)}`}>
          <div class={`absolute text-gray-600 rounded-sm pointer-events-none`}
                style={`transform: scale(${titleScale() * 0.9}) translate(${2}px, ${-1}px); ` +
                       `transform-origin: top left; `}>
            <i class={`fa fa-anchor`} />
          </div>
        </div>
      </Show>
    );
  };

  const renderAnchorDefaultMaybe = () => {
    let rightOffset = ANCHOR_OFFSET_PX * titleScale();
    if (hasChildChanges()) {
      rightOffset += ANCHOR_BOX_SIZE_PX * titleScale() + ANCHOR_OFFSET_PX * titleScale();
    }
    return (
      <Show when={hasDefaultChanges()}>
        <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} rounded-sm text-gray-900 pointer-events-none`}
              style={`left: ${1 + pageFns().boundsPx().x + pageFns().boundsPx().w - ANCHOR_BOX_SIZE_PX * titleScale() - rightOffset}px; ` +
                     `top: ${1 + pageFns().boundsPx().y + ANCHOR_OFFSET_PX * titleScale() / 3 * 2 + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                     `width: ${ANCHOR_BOX_SIZE_PX * titleScale()}px; ` +
                     `height: ${ANCHOR_BOX_SIZE_PX * titleScale()}px; ` +
                     `${VeFns.zIndexStyle(props.visualElement)}`}>
          <div class={`absolute text-gray-600 rounded-sm pointer-events-none`}
                style={`transform: scale(${titleScale() * 0.9}) translate(${2}px, ${-1}px); ` +
                       `transform-origin: top left; `}>
            <i class={`fa fa-home`} />
          </div>
        </div>
      </Show>
    );
  };

  const renderBorder = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} pointer-events-none`}
         style={`left: ${pageFns().boundsPx().x}px; ` +
                `top: ${pageFns().boundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                `border-width: 2px;` +
                `border-color: ${borderColorVal()}; ` +
                `width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
                `${VeFns.zIndexStyle(props.visualElement)}`} />;

  return (
    <>
      {renderShadow()}
      <Switch>
        <Match when={(props.visualElement.linkItemMaybe as any)?.overrideArrangeAlgorithm === ArrangeAlgorithm.List || pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
          {renderListPage()}
        </Match>
        <Match when={(props.visualElement.linkItemMaybe as any)?.overrideArrangeAlgorithm === ArrangeAlgorithm.Calendar || pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.Calendar}>
          {renderCalendarPage()}
        </Match>
        <Match when={(props.visualElement.linkItemMaybe as any)?.overrideArrangeAlgorithm !== ArrangeAlgorithm.List && (props.visualElement.linkItemMaybe as any)?.overrideArrangeAlgorithm !== ArrangeAlgorithm.Calendar && pageFns().pageItem().arrangeAlgorithm != ArrangeAlgorithm.List && pageFns().pageItem().arrangeAlgorithm != ArrangeAlgorithm.Calendar}>
          {renderPage()}
        </Match>
      </Switch>
      {renderPopupTitle()}
      {renderAnchorChildMaybe()}
      {renderAnchorDefaultMaybe()}
      {renderBorder()}
    </>
  );
}
