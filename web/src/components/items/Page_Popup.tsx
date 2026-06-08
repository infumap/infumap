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
import { LINE_HEIGHT_PX, CALENDAR_DAY_LABEL_LEFT_MARGIN_PX, GRID_SIZE } from "../../constants";
import { VeFns, VisualElementFlags, VisualElement } from "../../layout/visual-element";
import { VesCache } from "../../layout/ves-cache";



import { useStore } from "../../store/StoreProvider";
import { BorderType, Colors, LIGHT_BORDER_COLOR, borderColorForColorIdx, linearGradient } from "../../style";
import { hexToRGBA } from "../../util/color";
import { VisualElement_Desktop, VisualElement_LineItem } from "../VisualElement";
import { VisualElement_DesktopShadowLayer } from "../VisualElementShadow";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../../items/page-item";
import { PageVisualElementProps } from "./Page";
import { getMonthInfo } from "../../util/time";
import {
  CALENDAR_MONTH_NAMES,
  calculateCalendarWindow,
  calculateCalendarDimensionsForVisualElement,
  calculateCalendarVerticalLayout,
  CALENDAR_LAYOUT_CONSTANTS,
  CALENDAR_POPUP_LAYOUT_CONSTANTS,
  decodeCalendarCombinedIndex,
  formatCalendarWindowTitle,
  calculateCalendarWindowForPage,
  calculateDefaultCalendarWindowStartMonthIndex,
  getCalendarDayMetrics,
  getCalendarMonthLeftPx,
  getCalendarMonthWidthPx,
  isCurrentDay,
} from "../../util/calendar-layout";
import { requestArrange } from "../../layout/arrange";
import { autoMovedIntoViewBackgroundImage, scrollGestureStyleForArrangeAlgorithm } from "./helper";
import { DocumentPageTitle } from "./DocumentPageTitle";
import { PopupActionStrip } from "../library/PopupActionStrip";
import { calcPopupActionStripLayout } from "../../util/popupHeaderActions";
import { MouseAction, MouseActionState } from "../../input/state";
import { PageGroupBoxes } from "./PageGroupBoxes";
import { ChatComposer } from "./ChatComposer";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Popup: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();
  type PopupPageActionKey = "child" | "default";

  let updatingPopupScrollTop = false;
  let popupDiv: any = undefined; // HTMLDivElement | undefined

  const pageFns = () => props.pageFns;
  const selectedRootVeMaybe = () => {
    const selectedVe = VesCache.render.getSelected(VeFns.veToPath(props.visualElement))()?.get() ?? null;
    if (selectedVe == null || !MouseActionState.isAction(MouseAction.Moving)) {
      return selectedVe;
    }
    const activeMovingVe = MouseActionState.getActiveVisualElement();
    if (!activeMovingVe) {
      return selectedVe;
    }
    return VeFns.compareVeids(VeFns.actualVeidFromVe(selectedVe), VeFns.actualVeidFromVe(activeMovingVe)) == 0
      ? null
      : selectedVe;
  };

  onMount(() => {
    const veid = store.history.currentPopupSpec()!.actualVeid;

    // For list pages, use listChildAreaBoundsPx; for other pages, use childAreaBoundsPx
    const isListPage = (props.visualElement.linkItemMaybe as any)?.overrideArrangeAlgorithm === ArrangeAlgorithm.List ||
      pageFns().pageItem().arrangeAlgorithm === ArrangeAlgorithm.List;

    if (isListPage && props.visualElement.listChildAreaBoundsPx) {
      const listChildAreaH = props.visualElement.listChildAreaBoundsPx.h;
      const viewportH = pageFns().viewportBoundsPx().h;
      const scrollYProp = store.perItem.getPageScrollYProp(veid);
      const scrollYPx = scrollYProp * (listChildAreaH - viewportH);
      popupDiv.scrollTop = scrollYPx;
      popupDiv.scrollLeft = 0;
    } else {
      const scrollXProp = store.perItem.getPageScrollXProp(veid);
      const scrollXPx = scrollXProp * Math.max(0, pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);

      const scrollYProp = store.perItem.getPageScrollYProp(veid);
      const scrollYPx = scrollYProp * Math.max(0, pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);

      popupDiv.scrollTop = scrollYPx;
      popupDiv.scrollLeft = scrollXPx;
    }
  });

  createEffect(() => {
    // occurs on page arrange algorithm change.
    if (!pageFns().childAreaBoundsPx()) { return; }

    updatingPopupScrollTop = true;

    if (popupDiv && store.history.currentPopupSpec()) {
      const veid = store.history.currentPopupSpec()!.actualVeid;

      // For list pages, use listChildAreaBoundsPx; for other pages, use childAreaBoundsPx
      const isListPage = (props.visualElement.linkItemMaybe as any)?.overrideArrangeAlgorithm === ArrangeAlgorithm.List ||
        pageFns().pageItem().arrangeAlgorithm === ArrangeAlgorithm.List;

      if (isListPage && props.visualElement.listChildAreaBoundsPx) {
        const listChildAreaH = props.visualElement.listChildAreaBoundsPx.h;
        const viewportH = pageFns().viewportBoundsPx().h;
        popupDiv.scrollTop =
          store.perItem.getPageScrollYProp(veid) *
          (listChildAreaH - viewportH);
        popupDiv.scrollLeft = 0;
      } else {
        popupDiv.scrollTop =
          store.perItem.getPageScrollYProp(veid) *
          Math.max(0, pageFns().childAreaBoundsPx().h - props.visualElement.viewportBoundsPx!.h);
        popupDiv.scrollLeft =
          store.perItem.getPageScrollXProp(veid) *
          Math.max(0, pageFns().childAreaBoundsPx().w - props.visualElement.viewportBoundsPx!.w);
      }
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

  const headerHeightPx = () => pageFns().boundsPx().h - pageFns().viewportBoundsPx().h;

  const titleColor = () => hexToRGBA(Colors[pageFns().pageItem().backgroundColorIndex], 1.0);
  const popupWasAutoAdjusted = () => store.perVe.getAutoMovedIntoView(VeFns.veToPath(props.visualElement));
  const titleBackgroundImage = () => popupWasAutoAdjusted()
    ? `${autoMovedIntoViewBackgroundImage()}, ${linearGradient(pageFns().pageItem().backgroundColorIndex, 0.9)}`
    : linearGradient(pageFns().pageItem().backgroundColorIndex, 0.9);
  const titleWarningChromeStyle = () => popupWasAutoAdjusted()
    ? `box-shadow: inset 0 -2px 0 rgba(245, 158, 11, 0.95), inset 0 0 0 1px rgba(255, 251, 235, 0.75); `
    : "";

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

  const popupListScrollHandler = (_ev: Event) => {
    if (!popupDiv) { return; }
    if (updatingPopupScrollTop) { return; }

    const listChildAreaBoundsPx = props.visualElement.listChildAreaBoundsPx!;
    const viewportH = pageFns().viewportBoundsPx().h;
    const popupVeid = store.history.currentPopupSpec()!.actualVeid;

    if (listChildAreaBoundsPx.h > viewportH) {
      const scrollYProp = popupDiv!.scrollTop / (listChildAreaBoundsPx.h - viewportH);
      store.perItem.setPageScrollYProp(popupVeid, scrollYProp);
    }
  };

  const renderShadow = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} text-xl font-bold rounded-md p-8 blur-md`}
      style={`left: ${pageFns().boundsPx().x - 10}px; ` +
        `top: ${pageFns().boundsPx().y - 10 + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
        `width: ${pageFns().boundsPx().w + 20}px; height: ${pageFns().boundsPx().h + 20}px; ` +
        `background-color: #606060e8;` +
        `${VeFns.zIndexStyle(props.visualElement)}`}>
    </div>;

  // Collect all nested pages by traversing through selectedVes
  const getPopupTitledPages = (): Array<{ ve: VisualElement; pageItem: ReturnType<typeof asPageItem>; leftPx: number; widthPx: number }> => {
    const result: Array<{ ve: VisualElement; pageItem: ReturnType<typeof asPageItem>; leftPx: number; widthPx: number }> = [];

    // Start with the root popup page
    const rootPageItem = pageFns().pageItem();
    const rootIsListPage = (props.visualElement.linkItemMaybe as any)?.overrideArrangeAlgorithm === ArrangeAlgorithm.List ||
      rootPageItem.arrangeAlgorithm === ArrangeAlgorithm.List;

    if (!rootIsListPage) {
      return result; // Not a list page, no nested titles to show
    }

    // Add the root popup page using the arranged list viewport width
    const widthPx = pageFns().listViewportWidthPx();
    result.push({
      ve: props.visualElement,
      pageItem: rootPageItem,
      leftPx: 0,
      widthPx: widthPx,
    });

    // Traverse through selectedVes to find nested pages
    let currentVes = VesCache.render.getSelected(VeFns.veToPath(props.visualElement))();
    let currentLeftPx = widthPx;

    while (currentVes != null && currentVes.get() != null) {
      const selectedVe = currentVes.get();

      if (isPage(selectedVe.displayItem)) {
        const selectedPageItem = asPageItem(selectedVe.displayItem);
        const selectedIsListPage = (selectedVe.linkItemMaybe as any)?.overrideArrangeAlgorithm === ArrangeAlgorithm.List ||
          selectedPageItem.arrangeAlgorithm === ArrangeAlgorithm.List;

        if (selectedIsListPage) {
          const selectedWidthPx =
            selectedVe.listViewportBoundsPx?.w ??
            ((selectedPageItem.tableColumns[0].widthGr / GRID_SIZE) * LINE_HEIGHT_PX * (selectedVe.viewportBoundsPx!.w / store.desktopMainAreaBoundsPx().w));
          result.push({
            ve: selectedVe,
            pageItem: selectedPageItem,
            leftPx: currentLeftPx,
            widthPx: selectedWidthPx,
          });
          currentLeftPx += selectedWidthPx;
          // Continue traversing for list pages
          currentVes = VesCache.render.getSelected(VeFns.veToPath(selectedVe))();
        } else {
          // For non-list pages (spatial, document, etc.), add to result with remaining width
          // The width is the remaining space in the popup
          const remainingWidthPx = pageFns().boundsPx().w - currentLeftPx;
          result.push({
            ve: selectedVe,
            pageItem: selectedPageItem,
            leftPx: currentLeftPx,
            widthPx: remainingWidthPx,
          });
          // Stop traversing - non-list pages don't have further nested selected items
          break;
        }
      } else {
        break; // Not a page, stop traversing
      }
    }

    return result;
  };

  const renderPopupTitle = () => {
    const titledPages = getPopupTitledPages();

    // If no nested list pages (or not a list page), render original single title
    if (titledPages.length === 0) {
      return (
        <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"}`}
          style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; width: ${pageFns().boundsPx().w}px; height: ${headerHeightPx()}px; ` +
            `background-color: #fff; ` +
            `${VeFns.zIndexStyle(props.visualElement)}` +
            `background-image: ${titleBackgroundImage()};` +
            `${titleWarningChromeStyle()}`}>
          <div class="absolute font-bold"
            style={`left: 0px; top: ${headerHeightPx() / titleScale() * 0.05}px; ` +
              `width: ${pageFns().boundsPx().w / titleScale() * 0.92}px; ` +
              `height: ${headerHeightPx() / titleScale() * 0.9}px; ` +
              `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${titleScale() * 0.9}); ` +
              `transform-origin: top left; ` +
              `overflow-wrap: break-word; ` +
              `padding-left: 6px; ` +
              `margin-left: 4px; ` +
              `letter-spacing: -0.035em; ` +
              `color: ${titleColor()};`}>
            {props.visualElement.evaluatedTitle ?? pageFns().pageItem().title}
          </div>
        </div>
      );
    }

    // Render multiple nested list page titles
    const titleBarHeight = pageFns().boundsPx().h - pageFns().viewportBoundsPx().h;

    return (
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} flex flex-row`}
        style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; width: ${pageFns().boundsPx().w}px; height: ${titleBarHeight}px; ` +
          `background-color: #fff; ` +
          `${VeFns.zIndexStyle(props.visualElement)}` +
          `background-image: ${titleBackgroundImage()};` +
          `${titleWarningChromeStyle()}`}>
        <For each={titledPages}>{(titledPage, idx) => {
          const isLast = idx() === titledPages.length - 1;
          const titleWidth = isLast ? pageFns().boundsPx().w - titledPage.leftPx : titledPage.widthPx;
          const pageTitle = titledPage.ve.evaluatedTitle ?? titledPage.pageItem.title;
          const pageTitleColor = hexToRGBA(Colors[titledPage.pageItem.backgroundColorIndex], 1.0);

          return (
            <div class={`relative font-bold ${!isLast ? 'border-r border-slate-300' : ''}`}
              style={`width: ${titleWidth}px; height: ${titleBarHeight}px; flex-shrink: 0; overflow: hidden;`}>
              <div class="absolute"
                style={`left: 0px; top: ${titleBarHeight / titleScale() * 0.05}px; ` +
                  `width: ${titleWidth / titleScale() * 0.9}px; ` +
                  `height: ${titleBarHeight / titleScale() * 0.9}px; ` +
                  `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${titleScale() * 0.9}); ` +
                  `transform-origin: top left; ` +
                  `white-space: nowrap; overflow: hidden; text-overflow: ellipsis; ` +
                  `padding-left: 6px; ` +
                  `margin-left: 4px; ` +
                  `letter-spacing: -0.03em; ` +
                  `color: ${pageTitleColor};`}>
                {pageTitle}
              </div>
            </div>
          );
        }}</For>
      </div>
    );
  };

  const renderListPage = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"}`}
      style={`width: ${pageFns().viewportBoundsPx().w}px; ` +
        `height: ${pageFns().viewportBoundsPx().h}px; ` +
        `left: ${pageFns().viewportBoundsPx().x}px; ` +
        `top: ${pageFns().viewportBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
        `background-color: #ffffff;` +
        `${VeFns.zIndexStyle(props.visualElement)}`}>
      <div ref={popupDiv}
        class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} border-r border-slate-300`}
        style={`overflow-y: auto; overflow-x: hidden; ` +
          `width: ${pageFns().listViewportWidthPx()}px; ` +
          `height: ${pageFns().viewportBoundsPx().h}px; ` +
          `background-color: #ffffff;` +
          `${VeFns.zIndexStyle(props.visualElement)}`}
        onscroll={popupListScrollHandler}>
        <div class="absolute"
          style={`width: ${props.visualElement.listChildAreaBoundsPx!.w}px; height: ${props.visualElement.listChildAreaBoundsPx!.h}px`}>
          <PageGroupBoxes childVes={pageFns().lineChildren()} childAreaBoundsPx={props.visualElement.listChildAreaBoundsPx!} pageItemId={props.visualElement.displayItem.id} />
          <For each={pageFns().lineChildren()}>{childVe =>
            <VisualElement_LineItem visualElement={childVe.get()} />
          }</For>
          {pageFns().renderMoveOverAnnotationMaybe()}
        </div>
      </div>
      <VisualElement_DesktopShadowLayer visualElementSignals={pageFns().desktopChildren()} />
      <For each={pageFns().desktopChildren()}>{childVe =>
        <VisualElement_Desktop visualElement={childVe.get()} suppressLocalShadow={true} />
      }</For>
      <Show when={selectedRootVeMaybe()}>
        {selectedVe => <VisualElement_Desktop visualElement={selectedVe()} />}
      </Show>
    </div>;

  const renderPage = () =>
    <div ref={popupDiv}
      class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} border-t border-slate-300`}
      style={`left: ${pageFns().viewportBoundsPx().x}px; ` +
        `top: ${pageFns().viewportBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
        `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
        `background-color: #ffffff;` +
        `overflow-y: ${pageFns().viewportBoundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
        `overflow-x: ${pageFns().viewportBoundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
        `${scrollGestureStyleForArrangeAlgorithm(pageFns().pageItem().arrangeAlgorithm)}` +
        `${VeFns.zIndexStyle(props.visualElement)}`}
      onscroll={popupScrollHandler}>
      <div class="absolute"
        style={`left: ${pageFns().isDocumentPage() ? pageFns().documentContentLeftPx() : pageFns().viewportBoundsPx().w - pageFns().childAreaBoundsPx().w}px; ` +
          `top: ${0}px; ` +
          `width: ${pageFns().childAreaBoundsPx().w}px; ` +
          `height: ${pageFns().childAreaBoundsPx().h}px;`}>
        <PageGroupBoxes childVes={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()} childAreaBoundsPx={pageFns().childAreaBoundsPx()} pageItemId={props.visualElement.displayItem.id} />
        <Show when={PageFns.showDocumentTitleInDocument(pageFns().pageItem())}>
          <DocumentPageTitle visualElement={props.visualElement} pageFns={props.pageFns} />
        </Show>
        {pageFns().renderSearchSelectionMaybe()}
        <VisualElement_DesktopShadowLayer visualElementSignals={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()} />
        <For each={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} suppressLocalShadow={true} />
        }</For>
        {pageFns().renderGridLinesMaybe()}
        {pageFns().renderSearchHoverMaybe()}
        {pageFns().renderCatalogMetadataMaybe()}
        {pageFns().renderMoveOverAnnotationMaybe()}
      </div>
      <ChatComposer visualElement={props.visualElement} pageFns={props.pageFns} />
    </div>;

  const renderCalendarPage = () => {
    const pagePath = VeFns.veToPath(props.visualElement);
    const calendarWindow = calculateCalendarWindowForPage(store, pagePath, pageFns().childAreaBoundsPx().w, pageFns().pageItem());
    const calendarResizeMaybe = calendarWindow.monthsPerPage == 12
      ? store.perVe.getCalendarMonthResize(pagePath)
      : null;
    const calendarDimensions = calculateCalendarDimensionsForVisualElement(props.visualElement, calendarResizeMaybe, calendarWindow);
    const calendarVerticalLayout = calculateCalendarVerticalLayout(
      pageFns().childAreaBoundsPx(),
      true,
    );
    const calendarMonthLayouts = props.visualElement.calendarMonthLayouts;
    const scale = calendarVerticalLayout.scale;
    const navigateCalendarWindow = (monthDelta: number) => {
      store.perVe.setCalendarMonthIndex(pagePath, calendarWindow.startMonthIndex + monthDelta);
      requestArrange(store, "page-calendar-window-change");
    };
    const resetCalendarWindow = () => {
      store.perVe.setCalendarMonthIndex(
        pagePath,
        calculateDefaultCalendarWindowStartMonthIndex(
          pageFns().childAreaBoundsPx().w,
          pageFns().pageItem(),
          store.smallScreenMode(),
        ),
      );
      requestArrange(store, "page-calendar-window-reset");
    };
    const calendarTitleButtonWidthPx = 30;
    const calendarTitleGapPx = 6;
    const calendarTitleTextWidthPx = () => Math.max(
      96,
      Math.min(
        320,
        pageFns().childAreaBoundsPx().w / scale -
        4 * calendarTitleButtonWidthPx -
        4 * calendarTitleGapPx,
      ),
    );
    const calendarTitleControlStyle = () => {
      return `display: grid; grid-template-columns: ${calendarTitleButtonWidthPx}px ${calendarTitleButtonWidthPx}px ${calendarTitleTextWidthPx()}px ${calendarTitleButtonWidthPx}px ${calendarTitleButtonWidthPx}px; ` +
        `column-gap: ${calendarTitleGapPx}px; align-items: center; width: ${calendarTitleTextWidthPx() + 4 * calendarTitleButtonWidthPx + 4 * calendarTitleGapPx}px;`;
    };
    const calendarTitleButtonClass = "inline-flex items-center justify-center w-[30px] h-[28px] rounded-sm text-[18px] text-slate-300 hover:text-slate-600 hover:bg-gray-100 active:bg-gray-200 cursor-pointer transition-colors";
    const isWeekend = (dayOfWeek: number) => dayOfWeek === 0 || dayOfWeek === 6;
    const visibleMonthSet = new Set(calendarWindow.months.map(({ month }) => month));
    const renderMovingDayHighlight = (
      getInfo: () => { pageItemId: string, combinedIndex: number } | null,
      backgroundColor: string,
      borderColor: string,
    ) =>
      <Show when={store.anItemIsMoving.get() &&
        getInfo() != null &&
        getInfo()!.pageItemId === props.visualElement.displayItem.id}>
        {(() => {
          const info = getInfo()!;
          const { month, day } = decodeCalendarCombinedIndex(info.combinedIndex);
          if (!visibleMonthSet.has(month)) {
            return null;
          }
          const leftPx = getCalendarMonthLeftPx(calendarDimensions, month);
          const widthPx = getCalendarMonthWidthPx(calendarDimensions, month);
          const dayMetrics = getCalendarDayMetrics(calendarDimensions, calendarMonthLayouts, month, day);
          return (
            <div class="absolute pointer-events-none"
              style={`left: ${leftPx}px; top: ${dayMetrics.topPx}px; width: ${widthPx}px; height: ${dayMetrics.heightPx}px; ` +
                `background-color: ${backgroundColor}; border: 1px solid ${borderColor};`} />
          );
        })()}
      </Show>;

    return (
      <div ref={popupDiv}
        class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} border-t border-slate-300`}
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
            style={`left: 0px; top: ${CALENDAR_POPUP_LAYOUT_CONSTANTS.TOP_PADDING * scale}px; width: ${pageFns().childAreaBoundsPx().w}px; height: ${CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT * scale}px;`}>
            <div class="flex items-center justify-center font-bold"
              style={`transform: scale(${scale}); transform-origin: center center;`}>
              <div style={calendarTitleControlStyle()}>
                <div class={calendarTitleButtonClass}
                  title="Previous period"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => navigateCalendarWindow(-calendarWindow.monthsPerPage)}>
                  <i class="fas fa-angle-double-left" />
                </div>
                <div class={calendarTitleButtonClass}
                  title="Previous month"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => navigateCalendarWindow(-1)}>
                  <i class="fas fa-angle-left" />
                </div>
                <span class="text-center text-2xl overflow-hidden whitespace-nowrap text-ellipsis cursor-pointer hover:text-slate-700"
                  title="Reset to current window"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={resetCalendarWindow}>
                  {formatCalendarWindowTitle(calendarWindow)}
                </span>
                <div class={calendarTitleButtonClass}
                  title="Next month"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => navigateCalendarWindow(1)}>
                  <i class="fas fa-angle-right" />
                </div>
                <div class={calendarTitleButtonClass}
                  title="Next period"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => navigateCalendarWindow(calendarWindow.monthsPerPage)}>
                  <i class="fas fa-angle-double-right" />
                </div>
              </div>
            </div>
          </div>

          <For each={calendarWindow.months}>{visibleMonth => {
            const month = visibleMonth.month;
            const monthInfo = getMonthInfo(month, visibleMonth.year);
            const leftPos = getCalendarMonthLeftPx(calendarDimensions, month);
            const monthWidth = getCalendarMonthWidthPx(calendarDimensions, month);

            return (
              <div class="absolute"
                style={`left: ${leftPos}px; top: ${calendarVerticalLayout.monthTitleTopPx}px; width: ${monthWidth}px;`}>
                <div class="text-center font-semibold"
                  style={`height: ${CALENDAR_POPUP_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT}px; line-height: ${CALENDAR_POPUP_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT}px; width: ${monthWidth}px; transform: scale(${scale}); transform-origin: top left;`}>
                  <span class="text-base" style={`position: relative; top: 3px;`}>{CALENDAR_MONTH_NAMES[month - 1]}</span>
                </div>

                <For each={Array.from({ length: monthInfo.daysInMonth }, (_, i) => i + 1)}>{day => {
                  const dayOfWeek = (monthInfo.firstDayOfWeek + day - 1) % 7;
                  const dayMetrics = getCalendarDayMetrics(calendarDimensions, calendarMonthLayouts, month, day);
                  const topPos = dayMetrics.topPx - calendarVerticalLayout.monthTitleTopPx;
                  const isToday = isCurrentDay(month, day, visibleMonth.year);

                  let backgroundColor = '#ffffff';
                  if (isToday) {
                    backgroundColor = '#fef3c7';
                  } else if (isWeekend(dayOfWeek)) {
                    backgroundColor = '#f5f5f5';
                  }

                  return (
                    <div class="absolute"
                      style={`left: 0px; top: ${topPos}px; width: ${monthWidth}px; height: ${dayMetrics.heightPx}px; ` +
                        `background-color: ${backgroundColor}; ` +
                        `border-bottom: 1px solid #e5e5e5; box-sizing: border-box;`}>
                      <div class="flex items-start"
                        style={`width: ${monthWidth / scale}px; height: ${dayMetrics.heightPx / scale}px; transform: scale(${scale}); transform-origin: top left; padding-top: 5px;`}>
                        <div style={`width: ${CALENDAR_DAY_LABEL_LEFT_MARGIN_PX / scale}px; display: flex; align-items: flex-start; justify-content: flex-end;`}>
                          <span style="font-size: 10px; margin-right: 2px;">{day}</span>
                        </div>
                        <div style={`width: ${Math.max(0, monthWidth - CALENDAR_DAY_LABEL_LEFT_MARGIN_PX) / scale}px;`} />
                      </div>
                    </div>
                  );
                }}</For>
              </div>
            );
          }}</For>

          <PageGroupBoxes childVes={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()} childAreaBoundsPx={pageFns().childAreaBoundsPx()} pageItemId={props.visualElement.displayItem.id} />
          <For each={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()}>{childVes => {
            const childVe = () => childVes.get();
            return (
              <Show when={childVe().flags & VisualElementFlags.Moving}
                fallback={<VisualElement_LineItem visualElement={childVe()} />}>
                <VisualElement_Desktop visualElement={childVe()} />
              </Show>
            );
          }}</For>

          <For each={props.visualElement.calendarOverflowCounts}>{overlay =>
            <div class="absolute flex items-center justify-center font-semibold text-gray-700 bg-gray-100 border border-gray-300 rounded"
              style={`left: ${overlay.boundsPx.x}px; top: ${overlay.boundsPx.y}px; width: ${overlay.boundsPx.w}px; height: ${overlay.boundsPx.h}px; font-size: ${overlay.fontSizePx}px;`}>
              {overlay.totalCount}
            </div>
          }</For>
          {renderMovingDayHighlight(() => store.movingItemSourceCalendarInfo.get(), "#f59e0b33", "#f59e0b")}
          {renderMovingDayHighlight(() => store.movingItemTargetCalendarInfo.get(), "#3b82f633", "#3b82f6")}
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

  const popupActionLayout = () => calcPopupActionStripLayout<PopupPageActionKey>([
    ...(hasChildChanges() ? [{ key: "child", label: "pin here" } as const] : []),
    ...(hasDefaultChanges() ? [{ key: "default", label: "set default" } as const] : []),
  ],
  pageFns().boundsPx().x + pageFns().boundsPx().w,
  pageFns().viewportBoundsPx().y - Math.round(19 / 2) + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0),
  {
    fontSizePx: 11,
    gapPx: 4,
    heightPx: 19,
    horizontalPaddingPx: 9,
    minActionWidthPx: 58,
    rightInsetPx: 10,
  });

  const renderPopupActionStripMaybe = () =>
    <PopupActionStrip
      background="rgba(255, 255, 255, 0.96)"
      borderColor={LIGHT_BORDER_COLOR}
      fixed={!!(props.visualElement.flags & VisualElementFlags.Fixed)}
      layout={popupActionLayout()}
      shadow="0 1px 2px rgba(15, 23, 42, 0.06)"
      textColor={hexToRGBA(Colors[pageFns().pageItem().backgroundColorIndex], 0.72)}
      zIndexStyle={VeFns.zIndexStyle(props.visualElement)}
    />;

  const renderBorder = () =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} pointer-events-none`}
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
      {renderPopupActionStripMaybe()}
      {renderBorder()}
    </>
  );
}
