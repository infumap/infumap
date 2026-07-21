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

import { Component, For, Match, Show, Switch, createEffect, createMemo, onMount } from "solid-js";
import { VeFns, VisualElementFlags, type VisualElement } from "../../layout/visual-element";


import { VisualElement_Desktop, VisualElement_LineItem } from "../VisualElement";
import { VisualElement_DesktopShadowLayer } from "../VisualElementShadow";
import { useStore } from "../../store/StoreProvider";
import { CALENDAR_DAY_LABEL_LEFT_MARGIN_PX, LINE_HEIGHT_PX, Z_INDEX_LOCAL_HIGHLIGHT, Z_INDEX_LOCAL_SHADOW } from "../../constants";
import { BORDER_COLOR, FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW } from "../../style";
import { linearGradient } from "../../style";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { ArrangeAlgorithm } from "../../items/page-item";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { VesCache } from "../../layout/ves-cache";
import { PageVisualElementProps } from "./Page";
import {
  CALENDAR_LAYOUT_CONSTANTS,
  calendarMiniTitleHeightPx,
  calendarMiniTitleTopPx,
  decodeCalendarCombinedIndex,
  formatCalendarMiniRangeTitle,
  getCalendarMiniDayLayoutForPosition,
  getCalendarMiniRowHeightPx,
  isCurrentDay,
} from "../../util/calendar-layout";
import { itemCanEdit, itemCanResize } from "../../items/base/capabilities-item";
import { appendNewlineIfEmpty } from "../../util/string";
import { autoMovedIntoViewWarningStyle, createPageTitleEditHandlers, desktopStackRootStyle, pageIsFocusedOpenPopupSource, scrollGestureStyleForArrangeAlgorithm, shouldShowFocusRingForVisualElement } from "./helper";
import { CompositeMoveOutHandle } from "./CompositeMoveOutHandle";
import { isQueryItem } from "../../items/query-item";
import { MouseAction, MouseActionState } from "../../input/state";
import { PageGroupBoxes } from "./PageGroupBoxes";
import { CalendarRangeOverlays } from "./CalendarRangeOverlays";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Translucent: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  let updatingTranslucentScrollTop = false;
  let previousChildAreaHeightPx: number | null = null;
  let latestTranslucentScrollTopPx = 0;
  let translucentDiv: any = undefined; // HTMLDivElement | undefined

  const pageFns = () => props.pageFns;
  const canEditPage = () => itemCanEdit(pageFns().pageItem());
  const canResizePage = () => itemCanResize(pageFns().pageItem());
  const titleEditHandlers = createPageTitleEditHandlers(store, () => props.visualElement);

  onMount(() => {
    let veid = VeFns.veidFromVe(props.visualElement);

    if (pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List &&
      props.visualElement.listChildAreaBoundsPx &&
      props.visualElement.listViewportBoundsPx) {
      const scrollYProp = store.perItem.getPageScrollYProp(veid);
      const scrollYPx = scrollYProp * Math.max(0, props.visualElement.listChildAreaBoundsPx.h - props.visualElement.listViewportBoundsPx.h);
      translucentDiv.scrollTop = scrollYPx;
      translucentDiv.scrollLeft = 0;
      latestTranslucentScrollTopPx = scrollYPx;
      return;
    }

    const scrollXProp = store.perItem.getPageScrollXProp(veid);
    const scrollXPx = scrollXProp * (pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);

    const scrollYProp = store.perItem.getPageScrollYProp(veid);
    const scrollYPx = scrollYProp * (pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);

    translucentDiv.scrollTop = scrollYPx;
    translucentDiv.scrollLeft = scrollXPx;
    latestTranslucentScrollTopPx = scrollYPx;
  });

  createEffect(() => {
    // occurs on page arrange algorithm change.
    if (!pageFns().childAreaBoundsPx()) { return; }

    updatingTranslucentScrollTop = true;
    if (translucentDiv) {
      const pageVeid = VeFns.veidFromVe(props.visualElement);
      if (pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List &&
        props.visualElement.listChildAreaBoundsPx &&
        props.visualElement.listViewportBoundsPx) {
        const maxScrollYPx = Math.max(0, props.visualElement.listChildAreaBoundsPx.h - props.visualElement.listViewportBoundsPx.h);
        const nextScrollTopPx = store.perItem.getPageScrollYProp(pageVeid) * maxScrollYPx;
        translucentDiv.scrollTop = nextScrollTopPx;
        translucentDiv.scrollLeft = 0;
        latestTranslucentScrollTopPx = nextScrollTopPx;
        previousChildAreaHeightPx = props.visualElement.listChildAreaBoundsPx.h;
        setTimeout(() => {
          updatingTranslucentScrollTop = false;
        }, 0);
        return;
      }

      const maxScrollYPx = Math.max(0, pageFns().childAreaBoundsPx().h - props.visualElement.boundsPx.h);
      const shouldPreserveAbsoluteScrollTop =
        pageFns().hasCatalogResultContext() &&
        previousChildAreaHeightPx != null &&
        pageFns().childAreaBoundsPx().h > previousChildAreaHeightPx;

      if (shouldPreserveAbsoluteScrollTop) {
        const preservedScrollTopPx = Math.min(latestTranslucentScrollTopPx, maxScrollYPx);
        translucentDiv.scrollTop = preservedScrollTopPx;
        latestTranslucentScrollTopPx = preservedScrollTopPx;
        store.perItem.setPageScrollYProp(pageVeid, maxScrollYPx > 0 ? preservedScrollTopPx / maxScrollYPx : 0);
      } else {
        const nextScrollTopPx =
          store.perItem.getPageScrollYProp(pageVeid) *
          maxScrollYPx;
        translucentDiv.scrollTop = nextScrollTopPx;
        latestTranslucentScrollTopPx = nextScrollTopPx;
      }
      translucentDiv.scrollLeft =
        store.perItem.getPageScrollXProp(pageVeid) *
        (pageFns().childAreaBoundsPx().w - props.visualElement.boundsPx.w);
    }
    previousChildAreaHeightPx = pageFns().childAreaBoundsPx().h;

    setTimeout(() => {
      updatingTranslucentScrollTop = false;
    }, 0);
  });

  const translucentTitleInBoxScale = createMemo((): number => pageFns().calcTitleInBoxScale("lg"));
  const isCalendarTranslucentPage = () => pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.Calendar;
  const translucentTitleClass = () => {
    const pointerClass = titleEditHandlers.isEditingTitle()
      ? "pointer-events-auto select-text cursor-text"
      : "pointer-events-none";
    return isCalendarTranslucentPage()
      ? `absolute flex text-white ${pointerClass}`
      : `absolute flex font-bold text-white ${pointerClass}`;
  };

  const calendarTitleStyle = (): string => {
    const fontSizePx = isCalendarTranslucentPage()
      ? 18 * translucentTitleInBoxScale()
      : 20 * translucentTitleInBoxScale();
    const base = `left: 0px; ` +
      `top: 0px; ` +
      `width: ${pageFns().boundsPx().w}px; ` +
      `height: ${pageFns().boundsPx().h}px;` +
      `font-size: ${fontSizePx}px; ` +
      `z-index: 3; ` +
      `outline: 0px solid transparent;`;
    if (isCalendarTranslucentPage()) {
      const scale = pageFns().parentPageArrangeAlgorithm() == ArrangeAlgorithm.List ? pageFns().listViewScale() : 1.0;
      const padLeft = (CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN + 4) * scale;
      return base + `justify-content: flex-start; align-items: flex-start; text-align: left; padding-top: 11px; padding-left: ${padLeft}px; ` +
        `font-weight: 600; letter-spacing: -0.03em; line-height: 1.05; text-shadow: 0 1px 2px rgba(57, 81, 118, 0.18);`;
    } else {
      return base + `justify-content: center; align-items: center; text-align: center;`;
    }
  };

  const translucentScrollHandler = (_ev: Event) => {
    if (!translucentDiv) { return; }
    if (updatingTranslucentScrollTop) { return; }

    if (pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List &&
      props.visualElement.listChildAreaBoundsPx &&
      props.visualElement.listViewportBoundsPx) {
      const pageVeid = VeFns.veidFromVe(props.visualElement);
      const maxScrollYPx = Math.max(0, props.visualElement.listChildAreaBoundsPx.h - props.visualElement.listViewportBoundsPx.h);
      if (maxScrollYPx > 0) {
        const scrollYProp = translucentDiv!.scrollTop / maxScrollYPx;
        latestTranslucentScrollTopPx = translucentDiv!.scrollTop;
        store.perItem.setPageScrollYProp(pageVeid, scrollYProp);
      } else {
        latestTranslucentScrollTopPx = 0;
      }
      return;
    }

    const pageBoundsPx = props.visualElement.boundsPx;
    const childAreaBounds = pageFns().childAreaBoundsPx();
    const pageVeid = VeFns.veidFromVe(props.visualElement);

    if (childAreaBounds.h > pageBoundsPx.h) {
      const scrollYProp = translucentDiv!.scrollTop / (childAreaBounds.h - pageBoundsPx.h);
      latestTranslucentScrollTopPx = translucentDiv!.scrollTop;
      store.perItem.setPageScrollYProp(pageVeid, scrollYProp);
    } else {
      latestTranslucentScrollTopPx = 0;
    }
  };

  const selectedVeIntersectsPageBounds = (selectedVe: VisualElement | null): boolean => {
    if (!selectedVe) {
      return false;
    }
    return selectedVe.boundsPx.x < pageFns().boundsPx().w &&
      selectedVe.boundsPx.x + selectedVe.boundsPx.w > 0 &&
      selectedVe.boundsPx.y < pageFns().boundsPx().h &&
      selectedVe.boundsPx.y + selectedVe.boundsPx.h > 0;
  };

  const renderListPage = () => {
    const renderListBand = (band: "top" | "middle" | "bottom") => {
      const bandTopPx = () => {
        if (band == "top") { return 0; }
        if (band == "middle") { return props.visualElement.listViewportBoundsPx?.y ?? 0; }
        return Math.max(0, pageFns().boundsPx().h - props.visualElement.listPagePinnedBottomHeightPx);
      };
      const bandHeightPx = () => {
        if (band == "top") { return props.visualElement.listPagePinnedTopHeightPx; }
        if (band == "middle") { return props.visualElement.listViewportBoundsPx?.h ?? pageFns().boundsPx().h; }
        return props.visualElement.listPagePinnedBottomHeightPx;
      };
      const childAreaBoundsPx = () => pageFns().listBandChildAreaBoundsPx(band);
      const childVes = () => pageFns().lineChildrenForListBand(band);
      const inner =
        <div class="absolute"
          style={`width: ${childAreaBoundsPx().w}px; ` +
            `height: ${childAreaBoundsPx().h}px`}>
          <PageGroupBoxes childVes={childVes()} childAreaBoundsPx={childAreaBoundsPx()} pageItemId={props.visualElement.displayItem.id} />
          <For each={childVes()}>{childVe =>
            <VisualElement_LineItem visualElement={childVe.get()} />
          }</For>
          <Show when={band == "middle"}>
            {pageFns().renderMoveOverAnnotationMaybe()}
          </Show>
        </div>;
      const commonStyle = () =>
        `width: ${pageFns().listViewportWidthPx()}px; ` +
        `height: ${bandHeightPx()}px; ` +
        `left: 0px; ` +
        `top: ${bandTopPx()}px; ` +
        `border-right: 1px solid ${BORDER_COLOR};`;

      if (band == "middle") {
        return (
          <div ref={translucentDiv}
            class="absolute"
            style={`${commonStyle()} overflow-y: auto; overflow-x: hidden;`}
            onscroll={translucentScrollHandler}>
            {inner}
          </div>
        );
      }

      return (
        <Show when={bandHeightPx() > 0}>
          <div class="absolute"
            style={`${commonStyle()} overflow: hidden;`}>
            {inner}
          </div>
        </Show>
      );
    };

    return (
      <div class={`absolute rounded-xs`}
        style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; overflow: hidden; z-index: 1;`}>
        <div class={`absolute rounded-xs`}
          style={`width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; left: 0px; top: 0px; background-color: #ffffff;`} />
        <Show when={Math.min(pageFns().listViewportWidthPx(), pageFns().boundsPx().w) > 0}>
          {renderListBand("top")}
          {renderListBand("middle")}
          {renderListBand("bottom")}
        </Show>
        <div
          class={`absolute`}
          style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px;`}>
          <VisualElement_DesktopShadowLayer visualElementSignals={pageFns().desktopChildren()} />
          <For each={pageFns().desktopChildren()}>{childVe =>
            <VisualElement_Desktop visualElement={childVe.get()} suppressLocalShadow={true} />
          }</For>
        </div>
      </div>
    );
  };

  const renderPage = () =>
  (
    pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.Calendar
      ? renderCalendarTranslucentPage()
      : <div ref={translucentDiv}
        class={`absolute ${borderClass()} rounded-xs`}
        style={`left: 0px; ` +
          `top: 0px; ` +
          `width: ${pageFns().boundsPx().w}px; ` +
          `height: ${pageFns().boundsPx().h}px; ` +
          `background-color: #ffffff; ` +
          `overflow-y: ${pageFns().boundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
          `overflow-x: ${pageFns().boundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
          `${scrollGestureStyleForArrangeAlgorithm(pageFns().pageItem().arrangeAlgorithm)}` +
          `z-index: 1;`}
        onscroll={translucentScrollHandler}>
        <div class="absolute"
          style={`left: ${0}px; top: ${0}px; ` +
            `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
          <PageGroupBoxes childVes={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()} childAreaBoundsPx={pageFns().childAreaBoundsPx()} pageItemId={props.visualElement.displayItem.id} />
          {pageFns().renderCatalogResultSelectionMaybe()}
          <VisualElement_DesktopShadowLayer visualElementSignals={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()} />
          <For each={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()}>{childVes =>
            <VisualElement_Desktop visualElement={childVes.get()} suppressLocalShadow={true} />
          }</For>
          {pageFns().renderCatalogFooterHostMaybe()}
          {pageFns().renderGridLinesMaybe()}
          {pageFns().renderCatalogResultHoverMaybe()}
          {pageFns().renderCatalogMetadataMaybe()}
          {pageFns().renderMoveOverAnnotationMaybe()}
        </div>
      </div>
  );

  const renderBoxTitleMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.ListPageRoot) &&
      pageFns().pageItem().arrangeAlgorithm != ArrangeAlgorithm.Calendar}>
      <div id={VeFns.veToPath(props.visualElement) + ":title"}
        class={translucentTitleClass()}
        style={calendarTitleStyle()}
        spellcheck={canEditPage() && titleEditHandlers.isEditingTitle()}
        contentEditable={canEditPage() && titleEditHandlers.isEditingTitle()}
        onKeyDown={titleEditHandlers.titleKeyDownHandler}
        onKeyUp={titleEditHandlers.titleKeyUpHandler}
        onInput={titleEditHandlers.titleInputListener}>
        {appendNewlineIfEmpty(pageFns().pageItem().title)}
      </div>
    </Show>;

  const renderCalendarTranslucentPage = () => {
    const childArea = pageFns().childAreaBoundsPx();
    const bounds = pageFns().boundsPx();
    const dayLayouts = props.visualElement.calendarMiniDayLayouts ?? [];
    const baseRowHeightPx = props.visualElement.blockSizePx?.h ?? LINE_HEIGHT_PX;
    const rowHeightPx = getCalendarMiniRowHeightPx(dayLayouts, baseRowHeightPx);
    const scale = Math.max(0.001, baseRowHeightPx / LINE_HEIGHT_PX);
    const leftRightMarginPx = CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN * scale;
    const columnLeftPx = leftRightMarginPx;
    const columnWidthPx = Math.max(0, childArea.w - leftRightMarginPx * 2);
    const titleTopPx = calendarMiniTitleTopPx(baseRowHeightPx);
    const titleHeightPx = calendarMiniTitleHeightPx(baseRowHeightPx);
    const dayLabelWidthPx = CALENDAR_DAY_LABEL_LEFT_MARGIN_PX * scale;
    const dayLabelFontSizePx = Math.max(7, 10 * Math.min(scale, rowHeightPx / LINE_HEIGHT_PX));
    const titleFontSizePx = Math.max(10, 24 * scale);
    const visibleCalendarPosition = (combinedIndex: number, year?: number) => {
      const decoded = decodeCalendarCombinedIndex(combinedIndex);
      return getCalendarMiniDayLayoutForPosition(dayLayouts, { ...decoded, year });
    };
    const renderMovingDayHighlight = (
      getInfo: () => { pageItemId: string, combinedIndex: number, year?: number } | null,
      backgroundColor: string,
      borderColor: string,
    ) =>
      <Show when={store.anItemIsMoving.get() &&
        getInfo() != null &&
        getInfo()!.pageItemId === props.visualElement.displayItem.id}>
        {(() => {
          const info = getInfo()!;
          const dayLayout = visibleCalendarPosition(info.combinedIndex, info.year);
          if (dayLayout == null) {
            return null;
          }
          return (
            <div class="absolute pointer-events-none"
              style={`left: ${columnLeftPx}px; top: ${dayLayout.topPx}px; width: ${columnWidthPx}px; height: ${dayLayout.heightPx}px; ` +
                `background-color: ${backgroundColor}; border: 1px solid ${borderColor};`} />
          );
        })()}
      </Show>;

    return (
      <div ref={translucentDiv}
        class={`absolute ${borderClass()} rounded-xs`}
        style={`left: 0px; top: 0px; width: ${bounds.w}px; height: ${bounds.h}px; background-color: #ffffff; overflow: hidden; z-index: 1;`}>
        <div class="absolute"
          style={`left: 0px; top: 0px; width: ${childArea.w}px; height: ${childArea.h}px;`}>
          <div class="absolute flex items-center justify-center font-bold"
            style={`left: ${leftRightMarginPx}px; top: ${titleTopPx}px; width: ${columnWidthPx}px; height: ${titleHeightPx}px; ` +
              `font-size: ${titleFontSizePx}px; color: #111827; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;`}>
            {formatCalendarMiniRangeTitle(dayLayouts)}
          </div>

          <For each={dayLayouts}>{dayLayout => {
            const isWeekend = dayLayout.dayOfWeek == 0 || dayLayout.dayOfWeek == 6;
            let backgroundColor = "#ffffff";
            if (isCurrentDay(dayLayout.month, dayLayout.day, dayLayout.year)) {
              backgroundColor = "#fef3c7";
            } else if (isWeekend) {
              backgroundColor = "#f5f5f5";
            }
            return (
              <div class="absolute flex items-start"
                style={`left: ${columnLeftPx}px; top: ${dayLayout.topPx}px; width: ${columnWidthPx}px; height: ${dayLayout.heightPx}px; ` +
                  `background-color: ${backgroundColor}; border-bottom: 1px solid #e5e5e5; box-sizing: border-box; padding-top: ${Math.min(5 * scale, Math.max(0, rowHeightPx * 0.2))}px;`}>
                <span style={`width: ${dayLabelWidthPx}px; text-align: right; font-size: ${dayLabelFontSizePx}px; margin-left: ${2 * scale}px;`}>
                  {dayLayout.day}
                </span>
              </div>
            );
          }}</For>

          <CalendarRangeOverlays visualElement={props.visualElement} />
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
          {renderMovingDayHighlight(() => store.movingItemSourceCalendarInfo.get(), "#f59e0b33", "#f59e0b")}
          {renderMovingDayHighlight(() => store.movingItemTargetCalendarInfo.get(), "#3b82f633", "#3b82f6")}
        </div>
      </div>
    );
  };

  const renderHoverOverMaybe = () =>
    <Show when={store.perVe.getMouseIsOver(pageFns().vePath()) && !store.anItemIsMoving.get()}>
      <>
        <Show when={!pageFns().isInComposite() && pageFns().clickBoundsPx() != null}>
          <div class={`absolute rounded-xs pointer-events-none`}
            style={`left: ${pageFns().clickBoundsPx()!.x}px; top: ${pageFns().clickBoundsPx()!.y}px; width: ${pageFns().clickBoundsPx()!.w}px; height: ${pageFns().clickBoundsPx()!.h}px; ` +
              `background-color: #ffffff33;`} />
        </Show>
        <Show when={pageFns().hasPopupClickBoundsPx()}>
          <div class={`absolute rounded-xs pointer-events-none`}
            style={`left: ${pageFns().popupClickBoundsPx()!.x}px; top: ${pageFns().popupClickBoundsPx()!.y}px; width: ${pageFns().popupClickBoundsPx()!.w}px; height: ${pageFns().popupClickBoundsPx()!.h}px; ` +
              `background-color: ${pageFns().isInComposite() ? '#ffffff33' : '#ffffff55'};`} />
        </Show>
      </>
    </Show>;

  const renderMovingOverMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOver(pageFns().vePath()) && pageFns().clickBoundsPx() != null}>
      <div class={`absolute rounded-xs pointer-events-none`}
        style={`left: ${pageFns().clickBoundsPx()!.x}px; top: ${pageFns().clickBoundsPx()!.y}px; width: ${pageFns().clickBoundsPx()!.w}px; height: ${pageFns().clickBoundsPx()!.h}px; ` +
          `background-color: #ffffff33;`} />
    </Show>;

  const renderMovingOverAttachMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOverAttach(pageFns().vePath()) &&
      store.perVe.getMoveOverAttachmentIndex(pageFns().vePath()) >= 0}>
      <div class={`absolute bg-black pointer-events-none`}
        style={`left: ${pageFns().attachInsertBarPx().x}px; top: ${pageFns().attachInsertBarPx().y}px; ` +
          `width: ${pageFns().attachInsertBarPx().w}px; height: ${pageFns().attachInsertBarPx().h}px;`} />
    </Show>;

  const renderMovingOverAttachCompositeMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOverAttachComposite(pageFns().vePath())}>
      <div class={`absolute border border-black`}
        style={`left: ${pageFns().attachCompositeBoundsPx().x}px; top: ${pageFns().attachCompositeBoundsPx().y}px; width: ${pageFns().attachCompositeBoundsPx().w}px; height: ${pageFns().attachCompositeBoundsPx().h}px;`} />
    </Show>;

  const renderPopupSelectedOverlayMaybe = () =>
    <Show when={!useFlatWorkspaceChrome() && ((props.visualElement.flags & VisualElementFlags.Selected) || pageFns().isPoppedUp())}>
      <div class="absolute pointer-events-none"
        style={`left: ${pageFns().innerBoundsPx().x}px; top: ${pageFns().innerBoundsPx().y}px; width: ${pageFns().innerBoundsPx().w}px; height: ${pageFns().innerBoundsPx().h}px; ` +
          `background-color: #dddddd88;`} />
    </Show>;

  const renderIsLinkMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
      pageFns().showTriangleDetail()}>
      <InfuLinkTriangle />
    </Show>;

  const isInsideSearchWorkspace = () => {
    if (props.visualElement.parentPath == null) {
      return false;
    }
    const parentVe = VesCache.current.readNode(props.visualElement.parentPath!);
    return parentVe != null && isQueryItem(parentVe.displayItem);
  };

  const useFlatWorkspaceChrome = () =>
    pageFns().parentPageArrangeAlgorithm() == ArrangeAlgorithm.List || isInsideSearchWorkspace();

  // Check if this page is currently focused (via focusPath or textEditInfo)
  const isFocused = () => {
    const focusPath = store.history.getFocusPath();
    const textEditInfo = store.overlay.textEditInfo();
    return focusPath === pageFns().vePath() ||
      pageIsFocusedOpenPopupSource(store, () => props.visualElement) ||
      (textEditInfo != null && textEditInfo.itemPath === pageFns().vePath());
  };

  const shadowClass = () => {
    if (useFlatWorkspaceChrome()) {
      return '';
    }
    return 'shadow-xl';
  };

  const backgroundStyle = () => useFlatWorkspaceChrome() || pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.Calendar
    ? ''
    : `background-image: ${linearGradient(pageFns().pageItem().backgroundColorIndex, 0.636)};`;

  const borderClass = () => useFlatWorkspaceChrome()
    ? ''
    : `border border-[#777] ${props.suppressLocalShadow ? "" : "hover:shadow-md"}`;

  const renderShadowMaybe = () =>
    <Show when={!props.suppressLocalShadow &&
      !(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc)}>
      <div class={`absolute border border-transparent rounded-xs ${shadowClass()} overflow-hidden`}
        style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          `z-index: ${Z_INDEX_LOCAL_SHADOW};`} />
    </Show>;

  const renderFocusRingMaybe = () =>
    <Show when={isFocused() && !pageFns().isInComposite() && shouldShowFocusRingForVisualElement(store, () => props.visualElement)}>
      <div class="absolute pointer-events-none rounded-xs"
        style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
    </Show>;

  const renderResizeTriangleMaybe = () =>
    <Show when={pageFns().showTriangleDetail() && canResizePage()}>
      <div class={`absolute border border-transparent rounded-xs overflow-hidden pointer-events-none`}
        style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; z-index: 3;`}>
        <InfuResizeTriangle />
      </div>
    </Show>;

  const selectedRootVeMaybe = () => {
    const selectedVe = VesCache.render.getSelected(VeFns.veToPath(props.visualElement))()?.get() ?? null;
    if (!selectedVe || !MouseActionState.isAction(MouseAction.Moving)) {
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
  const popupRootVeMaybe = () => VesCache.render.getPopup(VeFns.veToPath(props.visualElement))()?.get() ?? null;

  const renderSelectedRootMaybe = () =>
    <Show when={selectedRootVeMaybe()}>
      {selectedVe =>
        <Show when={selectedVeIntersectsPageBounds(selectedVe())}>
          <VisualElement_Desktop visualElement={selectedVe()} />
        </Show>
      }
    </Show>;

  const renderPopupRootMaybe = () =>
    <Show when={popupRootVeMaybe()}>
      {popupVe => <VisualElement_Desktop visualElement={popupVe()} />}
    </Show>;

  return (
    <div class="absolute"
      style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ${desktopStackRootStyle(props.visualElement)}`}>
      {renderShadowMaybe()}
      <div class="absolute"
        style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; overflow: hidden;`}>
        <Switch>
          <Match when={pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
            {renderListPage()}
          </Match>
          <Match when={pageFns().pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
            {renderPage()}
          </Match>
        </Switch>
        {renderSelectedRootMaybe()}
      </div>
      {renderPopupRootMaybe()}
      <div class="absolute pointer-events-none"
        style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px;`}>
        {renderResizeTriangleMaybe()}
        <div class={`absolute ${borderClass()} rounded-xs pointer-events-none`}
          style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; z-index: 2; ` +
            backgroundStyle()}>
          {renderHoverOverMaybe()}
          {renderMovingOverMaybe()}
          {renderMovingOverAttachMaybe()}
          {renderMovingOverAttachCompositeMaybe()}
          {renderPopupSelectedOverlayMaybe()}
          <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
            <div class="absolute pointer-events-none rounded-xs"
              style={`left: 0px; top: 0px; ` +
                `width: 100%; height: 100%; ` +
                `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR};`} />
          </Show>
          <For each={VesCache.render.getAttachments(VeFns.veToPath(props.visualElement))()}>{attachmentVe =>
            <VisualElement_Desktop visualElement={attachmentVe.get()} suppressLocalShadow={props.suppressLocalShadow} />
          }</For>
          <Show when={pageFns().showMoveOutOfCompositeArea()}>
            <CompositeMoveOutHandle boundsPx={pageFns().moveOutOfCompositeBox()} active={store.perVe.getMouseIsOverCompositeMoveOut(pageFns().vePath())} vePath={pageFns().vePath()} />
          </Show>
          {renderIsLinkMaybe()}
        </div>
        {renderBoxTitleMaybe()}
        {renderFocusRingMaybe()}
        <Show when={store.perVe.getAutoMovedIntoView(pageFns().vePath())}>
          <div class="absolute pointer-events-none rounded-xs"
            style={autoMovedIntoViewWarningStyle(pageFns().boundsPx().w, pageFns().boundsPx().h)} />
        </Show>
      </div>
    </div>
  );
}
