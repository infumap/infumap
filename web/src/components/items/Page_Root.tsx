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
import { Veid, VeFns, VisualElementFlags, isVeTranslucentPage } from "../../layout/visual-element";
import { VesCache } from "../../layout/ves-cache";
import { VisualElement_Desktop, VisualElement_LineItem } from "../VisualElement";
import { VisualElement_DesktopShadowLayer } from "../VisualElementShadow";
import { Z_INDEX_LOCAL_HIGHLIGHT } from "../../constants";
import { UMBRELLA_PAGE_UID } from "../../util/uid";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../../items/page-item";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";
import { PageVisualElementProps } from "./Page";
import { BorderType, FOCUS_RING_BOX_SHADOW, borderColorForColorIdx } from "../../style";
import { getMonthInfo } from "../../util/time";
import {
  CALENDAR_MONTH_NAMES,
  calculateCalendarWindow,
  calculateCalendarDimensions,
  CALENDAR_LAYOUT_CONSTANTS,
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
import { desktopStackRootStyle, scrollGestureStyleForArrangeAlgorithm, shouldShowFocusRingForVisualElement } from "./helper";
import { DocumentPageTitle } from "./DocumentPageTitle";
import { getFocusedSearchWorkspaceChromeSpec } from "../../util/search-focus-chrome";
import { MouseAction, MouseActionState } from "../../input/state";
import { PageGroupBoxes } from "./PageGroupBoxes";
import { LinearSelectionGapCover, linearSelectionGapAfterBoundsPx } from "./LinearSelectionGapCover";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Root: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  let updatingRootScrollTop = false;
  let rootDiv: any = undefined;
  let calendarSwipeState: {
    startX: number,
    startY: number,
    lastX: number,
    lastY: number,
    horizontalIntent: boolean,
    canceled: boolean,
  } | null = null;

  const pageFns = () => props.pageFns;
  const canEditPage = () => itemCanEdit(pageFns().pageItem());
  const pageChildren = () => VesCache.render.getChildren(VeFns.veToPath(props.visualElement))();
  const documentTextEditIsActive = () => {
    if (!canEditPage() || !pageFns().isDocumentPage()) { return false; }
    const itemPath = store.overlay.textEditInfo()?.itemPath;
    if (itemPath == null) { return false; }
    const pagePath = pageFns().vePath();
    return itemPath == pagePath || VeFns.parentPath(itemPath) == pagePath;
  };

  const getScrollVeid = (): Veid | null => {
    let veid = store.history.currentPageVeid();
    if (veid == null) return null;
    if (props.visualElement.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
      veid = VeFns.actualVeidFromVe(props.visualElement);
    } else if (props.visualElement.flags & VisualElementFlags.ListPageRoot) {
      veid = VeFns.actualVeidFromVe(props.visualElement);
    } else if (props.visualElement.parentPath && props.visualElement.parentPath != UMBRELLA_PAGE_UID) {
      // Use veidFromPath as a fallback if the parent isn't in VesCache yet (e.g. during initial mount)
      const parentVeid = VesCache.render.getNode(props.visualElement.parentPath)
        ? VeFns.actualVeidFromPath(props.visualElement.parentPath)
        : VeFns.veidFromPath(props.visualElement.parentPath);
      veid = store.perItem.getSelectedListPageItem(parentVeid);
    }
    return veid;
  };

  onMount(() => {
    if (!rootDiv) return;

    const veid = getScrollVeid();
    if (!veid) return;
    updatingRootScrollTop = true;

    // For list pages, use listChildAreaBoundsPx; for other pages, use childAreaBoundsPx
    const isListPage = pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List;
    if (isListPage && props.visualElement.listChildAreaBoundsPx) {
      const listChildAreaH = props.visualElement.listChildAreaBoundsPx.h;
      const viewportH = pageFns().viewportBoundsPx().h;
      const scrollYProp = store.perItem.getPageScrollYProp(veid);
      const scrollYPx = scrollYProp * (listChildAreaH - viewportH);
      rootDiv.scrollTop = scrollYPx;
      rootDiv.scrollLeft = 0;
    } else {
      const scrollXProp = store.perItem.getPageScrollXProp(veid);
      const scrollXPx = scrollXProp * Math.max(0, pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);

      const scrollYProp = store.perItem.getPageScrollYProp(veid);
      const scrollYPx = scrollYProp * Math.max(0, pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);

      rootDiv.scrollTop = scrollYPx;
      rootDiv.scrollLeft = scrollXPx;
    }

    setTimeout(() => {
      updatingRootScrollTop = false;
    }, 0);
  });

  createEffect(() => {
    // occurs on page arrange algorithm change.
    if (!pageFns().childAreaBoundsPx()) { return; }

    updatingRootScrollTop = true;

    if (rootDiv) {
      const veid = getScrollVeid();
      if (!veid) return;

      // For list pages, use listChildAreaBoundsPx; for other pages, use childAreaBoundsPx
      const isListPage = pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List;
      if (isListPage && props.visualElement.listChildAreaBoundsPx) {
        const listChildAreaH = props.visualElement.listChildAreaBoundsPx.h;
        const viewportH = pageFns().viewportBoundsPx().h;
        rootDiv.scrollTop =
          store.perItem.getPageScrollYProp(veid) *
          (listChildAreaH - viewportH);
        // List pages typically only scroll vertically, but handle width just in case
        rootDiv.scrollLeft = 0;
      } else {
        rootDiv.scrollTop =
          store.perItem.getPageScrollYProp(veid) *
          Math.max(0, pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);
        rootDiv.scrollLeft =
          store.perItem.getPageScrollXProp(veid) *
          Math.max(0, pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);
      }
    }

    setTimeout(() => {
      updatingRootScrollTop = false;
    }, 0);
  });

  const listRootScrollHandler = (_ev: Event) => {
    if (!rootDiv || updatingRootScrollTop) { return; }

    const listChildAreaH = props.visualElement.listChildAreaBoundsPx!.h;
    const viewportH = pageFns().viewportBoundsPx().h;

    const veid = getScrollVeid();
    if (!veid) return;

    if (viewportH < listChildAreaH) {
      const scrollYProp = rootDiv!.scrollTop / (listChildAreaH - viewportH);
      store.perItem.setPageScrollYProp(veid, scrollYProp);
    }
  }

  const publicBorderSuppressedByAncestor = () => {
    let parentPath = props.visualElement.parentPath;
    while (parentPath && parentPath !== UMBRELLA_PAGE_UID) {
      const parentVe = VesCache.current.readNode(parentPath) ?? VesCache.render.getNode(parentPath)?.get() ?? null;
      if (!parentVe) {
        break;
      }
      if ((parentVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) || isVeTranslucentPage(parentVe)) {
        return true;
      }
      parentPath = parentVe.parentPath;
    }
    return false;
  };

  const renderBorderOverlay = () => {
    if (!pageFns().isPublic() ||
      store.user.getUserMaybe() == null ||
      publicBorderSuppressedByAncestor()) {
      return null;
    }

    const borderWidth = 3;
    const bounds = VeFns.veViewportBoundsRelativeToDesktopPx(store, props.visualElement);
    const leftOffset = bounds.x;
    const topOffset = store.topToolbarHeightPx() + bounds.y;

    return (
      <>
        <div class="fixed" style={`left: ${leftOffset}px; top: ${topOffset}px; width: ${bounds.w}px; height: ${borderWidth}px; background-color: #ff0000; pointer-events: none; ${VeFns.zIndexStyle(props.visualElement)} z-index: 9999;`} />
        <div class="fixed" style={`left: ${leftOffset}px; top: ${topOffset + bounds.h - borderWidth}px; width: ${bounds.w}px; height: ${borderWidth}px; background-color: #ff0000; pointer-events: none; ${VeFns.zIndexStyle(props.visualElement)} z-index: 9999;`} />
        <div class="fixed" style={`left: ${leftOffset}px; top: ${topOffset}px; width: ${borderWidth}px; height: ${bounds.h}px; background-color: #ff0000; pointer-events: none; ${VeFns.zIndexStyle(props.visualElement)} z-index: 9999;`} />
        <div class="fixed" style={`left: ${leftOffset + bounds.w - borderWidth}px; top: ${topOffset}px; width: ${borderWidth}px; height: ${bounds.h}px; background-color: #ff0000; pointer-events: none; ${VeFns.zIndexStyle(props.visualElement)} z-index: 9999;`} />
      </>
    );
  };

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
      {selectedVe => <VisualElement_Desktop visualElement={selectedVe()} />}
    </Show>;

  const renderPopupRootMaybe = () =>
    <Show when={popupRootVeMaybe()}>
      {popupVe => <VisualElement_Desktop visualElement={popupVe()} />}
    </Show>;

  const renderListPage = () => {
    const isInsideEmbeddedInteractiveHierarchy = () => {
      let currentPath = props.visualElement.parentPath;
      while (currentPath && currentPath !== UMBRELLA_PAGE_UID) {
        const currentVe = VesCache.current.readNode(currentPath);
        if (!currentVe) {
          return false;
        }
        if (currentVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
          return true;
        }
        currentPath = currentVe.parentPath;
      }
      return false;
    };
    const focusedChild = () => VesCache.render.getFocusedChild(VeFns.veToPath(props.visualElement))();
    const selectedRootVe = selectedRootVeMaybe;
    const isSelectedRootPageFocused = () => {
      const selectedVe = selectedRootVe();
      const focusPath = store.history.getFocusPathMaybe();
      return isInsideEmbeddedInteractiveHierarchy() &&
        selectedVe != null &&
        isPage(selectedVe.displayItem) &&
        focusPath === VeFns.veToPath(selectedVe) &&
        shouldShowFocusRingForVisualElement(store, () => selectedVe);
    };
    const focusedSearchChrome = () => {
      const spec = getFocusedSearchWorkspaceChromeSpec(store);
      if (!spec || spec.currentPagePath != VeFns.veToPath(props.visualElement)) {
        return null;
      }
      return spec;
    };
    const isInsideTranslucentPage = () => {
      const parentPath = props.visualElement.parentPath;
      if (!parentPath || parentPath === UMBRELLA_PAGE_UID) {
        return false;
      }
      const parentVe = VesCache.current.readNode(parentPath) ?? VesCache.render.getNode(parentPath)?.get() ?? null;
      return parentVe != null && isVeTranslucentPage(parentVe);
    };
    const shouldAccentFocusedChildDivider = () =>
      !isInsideEmbeddedInteractiveHierarchy() &&
      !isInsideTranslucentPage();
    const focusedChildBorderWidthPx = () =>
      shouldAccentFocusedChildDivider()
        ? (focusedSearchChrome()?.borderWidthPx ?? (focusedChild() == null ? 1 : 2))
        : 1;
    const focusedChildBorderColor = () => {
      if (!shouldAccentFocusedChildDivider()) {
        return "";
      }
      const searchChrome = focusedSearchChrome();
      if (searchChrome) {
        return `border-right-color: ${searchChrome.borderColor};`;
      }
      const childItem = focusedChild();
      if (childItem == null || !isPage(childItem)) {
        return "";
      }
      return `border-right-color: ${borderColorForColorIdx(asPageItem(childItem).backgroundColorIndex, BorderType.MainPage)};`;
    };
    const renderSelectedPageFocusRingMaybe = () =>
      <Show when={isSelectedRootPageFocused()}>
        <div class="absolute pointer-events-none rounded-xs"
          style={`left: ${pageFns().listViewportWidthPx()}px; top: 0px; ` +
            `width: ${Math.max(0, pageFns().viewportBoundsPx().w - pageFns().listViewportWidthPx())}px; ` +
            `height: ${pageFns().viewportBoundsPx().h}px; ` +
            `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
      </Show>;

    return (
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} rounded-xs`}
        style={`width: ${pageFns().viewportBoundsPx().w}px; ` +
          `height: ${pageFns().viewportBoundsPx().h + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; left: 0px; ` +
          `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
          `background-color: #ffffff;` +
          `${VeFns.zIndexStyle(props.visualElement)}`}>
        <div ref={rootDiv}
          class="absolute"
          style={`left: 0px; top: 0px; ` +
            `width: ${pageFns().listViewportWidthPx()}px; ` +
            `height: ${pageFns().viewportBoundsPx().h}px; ` +
            `overflow-y: auto; `}
          onscroll={listRootScrollHandler}>
          <div class={`absolute ${props.visualElement.flags & VisualElementFlags.DockItem ? "" : "border-slate-300"}`}
            style={`width: ${props.visualElement.listChildAreaBoundsPx!.w}px; height: ${props.visualElement.listChildAreaBoundsPx!.h}px;` +
              `border-right-width: ${focusedChildBorderWidthPx()}px;` +
              `${focusedChildBorderColor()}`}>
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
        {renderSelectedRootMaybe()}
        {renderSelectedPageFocusRingMaybe()}
        {renderPopupRootMaybe()}
        {renderBorderOverlay()}
      </div>
    );
  };

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

    const veid = getScrollVeid();
    if (!veid) return;

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
    const pagePath = VeFns.veToPath(props.visualElement);
    const calendarWindow = calculateCalendarWindowForPage(store, pagePath, pageFns().childAreaBoundsPx().w, pageFns().pageItem());
    const calendarResizeMaybe = calendarWindow.monthsPerPage == 12
      ? store.perVe.getCalendarMonthResize(pagePath)
      : null;
    const calendarDimensions = calculateCalendarDimensions(pageFns().childAreaBoundsPx(), calendarResizeMaybe, calendarWindow);
    const calendarMonthLayouts = props.visualElement.calendarMonthLayouts;
    const calendarMonthTitleTopPx = CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + CALENDAR_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING;
    const toggleMonthHeadingWidth = (month: number) => {
      if (calendarWindow.monthsPerPage != 12) {
        return;
      }
      const currentResize = store.perVe.getCalendarMonthResize(pagePath);
      if (currentResize != null && currentResize.month == month) {
        store.perVe.setCalendarMonthResize(pagePath, null);
        requestArrange(store, "page-calendar-month-heading-uniform");
        return;
      }

      const childAreaBounds = pageFns().childAreaBoundsPx();
      const defaultWidthPx = calculateCalendarDimensions(childAreaBounds, null, calendarWindow).columnWidth;
      const requestedWidthPx = currentResize?.widthPx ?? defaultWidthPx * 2.0;
      const normalizedDimensions = calculateCalendarDimensions(childAreaBounds, {
        month,
        widthPx: requestedWidthPx,
      }, calendarWindow);
      const normalizedWidthPx = getCalendarMonthWidthPx(normalizedDimensions, month);
      store.perVe.setCalendarMonthResize(pagePath, { month, widthPx: normalizedWidthPx });
      requestArrange(store, currentResize == null
        ? "page-calendar-month-heading-wide"
        : "page-calendar-month-heading-switch-wide");
    };
    const navigateCalendarWindow = (monthDelta: number) => {
      store.perVe.setCalendarMonthIndex(pagePath, calendarWindow.startMonthIndex + monthDelta);
      requestArrange(store, "page-calendar-window-change");
    };
    const resetCalendarSwipe = () => {
      calendarSwipeState = null;
    };
    const canHandleCalendarSwipe = () =>
      store.smallScreenMode() &&
      !store.anItemIsMoving.get() &&
      !store.anItemIsResizing.get() &&
      store.overlay.textEditInfo() == null;
    const calendarTouchStartHandler = (ev: TouchEvent) => {
      if (!canHandleCalendarSwipe() || ev.touches.length != 1) {
        resetCalendarSwipe();
        return;
      }

      const touch = ev.touches[0];
      calendarSwipeState = {
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY,
        horizontalIntent: false,
        canceled: false,
      };
    };
    const calendarTouchMoveHandler = (ev: TouchEvent) => {
      if (calendarSwipeState == null) {
        return;
      }
      if (!canHandleCalendarSwipe() || ev.touches.length != 1) {
        resetCalendarSwipe();
        return;
      }

      const touch = ev.touches[0];
      calendarSwipeState.lastX = touch.clientX;
      calendarSwipeState.lastY = touch.clientY;

      const deltaX = calendarSwipeState.lastX - calendarSwipeState.startX;
      const deltaY = calendarSwipeState.lastY - calendarSwipeState.startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (!calendarSwipeState.horizontalIntent && absY > 14 && absY > absX * 1.15) {
        calendarSwipeState.canceled = true;
        return;
      }
      if (!calendarSwipeState.canceled && absX > 18 && absX > absY * 1.35) {
        calendarSwipeState.horizontalIntent = true;
      }
      if (!calendarSwipeState.horizontalIntent) {
        return;
      }

      if (ev.cancelable) {
        ev.preventDefault();
      }
      ev.stopPropagation();
    };
    const calendarTouchEndHandler = (ev: TouchEvent) => {
      if (calendarSwipeState == null) {
        return;
      }

      const swipeState = calendarSwipeState;
      resetCalendarSwipe();

      if (ev.changedTouches.length > 0) {
        const touch = ev.changedTouches[0];
        swipeState.lastX = touch.clientX;
        swipeState.lastY = touch.clientY;
      }

      if (!canHandleCalendarSwipe() || swipeState.canceled) {
        return;
      }

      const deltaX = swipeState.lastX - swipeState.startX;
      const deltaY = swipeState.lastY - swipeState.startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (absX < 60 || absX < absY * 1.35) {
        return;
      }

      if (ev.cancelable) {
        ev.preventDefault();
      }
      ev.stopPropagation();
      navigateCalendarWindow(deltaX < 0 ? 1 : -1);
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
        pageFns().childAreaBoundsPx().w -
        2 * CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN -
        4 * calendarTitleButtonWidthPx -
        4 * calendarTitleGapPx,
      ),
    );
    const calendarTitleControlStyle = () => {
      return `display: grid; grid-template-columns: ${calendarTitleButtonWidthPx}px ${calendarTitleButtonWidthPx}px ${calendarTitleTextWidthPx()}px ${calendarTitleButtonWidthPx}px ${calendarTitleButtonWidthPx}px; ` +
        `column-gap: ${calendarTitleGapPx}px; align-items: center; width: ${calendarTitleTextWidthPx() + 4 * calendarTitleButtonWidthPx + 4 * calendarTitleGapPx}px;`;
    };
    const calendarTitleButtonClass = "inline-flex items-center justify-center w-[30px] h-[28px] rounded-sm text-[18px] text-slate-300 hover:text-slate-600 hover:bg-gray-100 active:bg-gray-200 cursor-pointer transition-colors";
    const visibleMonthSet = new Set(calendarWindow.months.map(({ month }) => month));

    const isWeekend = (dayOfWeek: number) => dayOfWeek === 0 || dayOfWeek === 6; // Sunday or Saturday

    return (
      <div ref={rootDiv}
        class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} rounded-xs`}
        style={`left: 0px; ` +
          `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
          `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
          `overflow-y: ${pageFns().viewportBoundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
          `overflow-x: ${pageFns().viewportBoundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
          `${store.smallScreenMode() ? "overscroll-behavior: contain; touch-action: pan-y; " : ""}` +
          `${VeFns.zIndexStyle(props.visualElement)} `}
        onscroll={rootScrollHandler}
        onTouchStart={calendarTouchStartHandler}
        onTouchMove={calendarTouchMoveHandler}
        onTouchEnd={calendarTouchEndHandler}
        onTouchCancel={resetCalendarSwipe}>
        <div class="absolute"
          style={`left: 0px; top: 0px; ` +
            `width: ${pageFns().childAreaBoundsPx().w}px; ` +
            `height: ${pageFns().childAreaBoundsPx().h}px;` +
            `outline: 0px solid transparent; `}
          contentEditable={documentTextEditIsActive()}
          onKeyUp={keyUpHandler}
          onKeyDown={keyDownHandler}
          onInput={inputListener}>

          {/* Year title with navigation */}
          <div class="absolute flex items-center justify-center font-bold text-2xl"
            style={`left: ${CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN}px; top: ${CALENDAR_LAYOUT_CONSTANTS.TOP_PADDING}px; width: ${pageFns().childAreaBoundsPx().w - 2 * CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN}px; height: ${CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT}px;`}>
            <div style={calendarTitleControlStyle()}>
              <div class={calendarTitleButtonClass}
                title="Previous period"
                onClick={() => navigateCalendarWindow(-calendarWindow.monthsPerPage)}>
                <i class="fas fa-angle-double-left" />
              </div>
              <div class={calendarTitleButtonClass}
                title="Previous month"
                onClick={() => navigateCalendarWindow(-1)}>
                <i class="fas fa-angle-left" />
              </div>
              <span class="text-center overflow-hidden whitespace-nowrap text-ellipsis cursor-pointer hover:text-slate-700"
                title="Reset to current window"
                onClick={resetCalendarWindow}>
                {formatCalendarWindowTitle(calendarWindow)}
              </span>
              <div class={calendarTitleButtonClass}
                title="Next month"
                onClick={() => navigateCalendarWindow(1)}>
                <i class="fas fa-angle-right" />
              </div>
              <div class={calendarTitleButtonClass}
                title="Next period"
                onClick={() => navigateCalendarWindow(calendarWindow.monthsPerPage)}>
                <i class="fas fa-angle-double-right" />
              </div>
            </div>
          </div>

          {/* Calendar months */}
          <For each={calendarWindow.months}>{visibleMonth => {
            const month = visibleMonth.month;
            const monthInfo = getMonthInfo(month, visibleMonth.year);
            const leftPos = getCalendarMonthLeftPx(calendarDimensions, month);
            const monthWidth = getCalendarMonthWidthPx(calendarDimensions, month);
            const monthTitleClasses = calendarWindow.monthsPerPage == 12
              ? "text-center font-semibold text-base rounded-sm cursor-pointer transition-colors hover:bg-gray-100"
              : "text-center font-semibold text-base rounded-sm";

            return (
              <div class="absolute"
                style={`left: ${leftPos}px; top: ${calendarMonthTitleTopPx}px; width: ${monthWidth}px;`}>

                {/* Month title */}
                <div
                  class={monthTitleClasses}
                  style={`height: ${CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT}px; line-height: ${CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT}px;`}
                  onMouseDown={(ev) => {
                    if (calendarWindow.monthsPerPage != 12) { return; }
                    if (ev.button !== 0) { return; }
                    ev.preventDefault();
                    ev.stopPropagation();
                  }}
                  onClick={(ev) => {
                    if (calendarWindow.monthsPerPage != 12) { return; }
                    ev.preventDefault();
                    ev.stopPropagation();
                    toggleMonthHeadingWidth(month);
                  }}>
                  {CALENDAR_MONTH_NAMES[month - 1]}
                </div>

                {/* Days in month */}
                <For each={Array.from({ length: monthInfo.daysInMonth }, (_, i) => i + 1)}>{day => {
                  const dayOfWeek = (monthInfo.firstDayOfWeek + day - 1) % 7;
                  const dayMetrics = getCalendarDayMetrics(calendarDimensions, calendarMonthLayouts, month, day);
                  const topPos = dayMetrics.topPx - calendarMonthTitleTopPx;
                  const isToday = isCurrentDay(month, day, visibleMonth.year);

                  let backgroundColor = '#ffffff';
                  if (isToday) {
                    backgroundColor = '#fef3c7';
                  } else if (isWeekend(dayOfWeek)) {
                    backgroundColor = '#f5f5f5';
                  }

                  return (
                    <div class="absolute flex items-start"
                      style={`left: 0px; top: ${topPos}px; width: ${monthWidth}px; height: ${dayMetrics.heightPx}px; ` +
                        `background-color: ${backgroundColor}; ` +
                        `border-bottom: 1px solid #e5e5e5; padding-top: 5px;`}>
                      <span style="width: 14px; text-align: right; font-size: 10px; margin-left: 2px;">{day}</span>
                    </div>
                  );
                }}</For>
              </div>
            );
          }}</For>

          {/* Render child items arranged in calendar grid */}
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

          {/* Render overflow count overlays per day */}
          <For each={props.visualElement.calendarOverflowCounts}>{overlay =>
            <div class="absolute flex items-center justify-center font-semibold text-gray-700 bg-gray-100 border border-gray-300 rounded"
              style={`left: ${overlay.boundsPx.x}px; top: ${overlay.boundsPx.y}px; width: ${overlay.boundsPx.w}px; height: ${overlay.boundsPx.h}px; font-size: ${overlay.fontSizePx}px;`}>
              {overlay.totalCount}
            </div>
          }</For>
          <Show when={store.anItemIsMoving.get() &&
            store.movingItemSourceCalendarInfo.get() != null &&
            store.movingItemSourceCalendarInfo.get()!.pageItemId === props.visualElement.displayItem.id}>
            {(() => {
              const info = store.movingItemSourceCalendarInfo.get()!;
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
                    `background-color: #f59e0b33; border: 1px solid #f59e0b;`} />
              );
            })()}
          </Show>
          <Show when={store.anItemIsMoving.get() &&
            store.movingItemTargetCalendarInfo.get() != null &&
            store.movingItemTargetCalendarInfo.get()!.pageItemId === props.visualElement.displayItem.id}>
            {(() => {
              const info = store.movingItemTargetCalendarInfo.get()!;
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
                    `background-color: #3b82f633; border: 1px solid #3b82f6;`} />
              );
            })()}
          </Show>
        </div>
        {renderSelectedRootMaybe()}
        {renderPopupRootMaybe()}
        {renderBorderOverlay()}
      </div>
    );
  };

  const renderPage = () =>
    <div ref={rootDiv}
      class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} rounded-xs`}
      style={`left: 0px; ` +
        `top: ${(props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0) + (pageFns().boundsPx().h - pageFns().viewportBoundsPx().h)}px; ` +
        `width: ${pageFns().viewportBoundsPx().w}px; height: ${pageFns().viewportBoundsPx().h}px; ` +
        `overflow-y: ${pageFns().viewportBoundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
        `overflow-x: ${pageFns().viewportBoundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
        `${scrollGestureStyleForArrangeAlgorithm(pageFns().pageItem().arrangeAlgorithm)}` +
        `${VeFns.zIndexStyle(props.visualElement)} `}
      onscroll={rootScrollHandler}>
      <div class="absolute"
        style={`left: ${pageFns().documentContentLeftPx()}px; top: 0px; ` +
          `width: ${pageFns().childAreaBoundsPx().w}px; ` +
          `height: ${pageFns().childAreaBoundsPx().h}px;` +
          `outline: 0px solid transparent; `}
        contentEditable={documentTextEditIsActive()}
        onKeyUp={keyUpHandler}
        onKeyDown={keyDownHandler}
        onInput={inputListener}>
        <PageGroupBoxes childVes={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()} childAreaBoundsPx={pageFns().childAreaBoundsPx()} pageItemId={props.visualElement.displayItem.id} />
        <Show when={PageFns.showDocumentTitleInDocument(pageFns().pageItem())}>
          <DocumentPageTitle visualElement={props.visualElement} pageFns={props.pageFns} allowEditing={true} />
        </Show>
        {pageFns().renderSearchSelectionMaybe()}
        <VisualElement_DesktopShadowLayer visualElementSignals={pageChildren()} />
        <For each={pageChildren()}>{(childVes, index) => {
          const gapAfterBoundsPx = () => linearSelectionGapAfterBoundsPx(
            childVes.get().boundsPx,
            pageChildren()[index() + 1]?.get().boundsPx ?? null,
            pageFns().childAreaBoundsPx().w,
          );
          return (
            <>
              <VisualElement_Desktop visualElement={childVes.get()} suppressLocalShadow={true} />
              <LinearSelectionGapCover
                enabled={documentTextEditIsActive}
                boundsPx={gapAfterBoundsPx} />
            </>
          );
        }}</For>
        {pageFns().renderGridLinesMaybe()}
        {pageFns().renderSearchHoverMaybe()}
        {pageFns().renderCatalogMetadataMaybe()}
        {pageFns().renderMoveOverAnnotationMaybe()}
      </div>
      {renderSelectedRootMaybe()}
      {renderPopupRootMaybe()}
      {renderBorderOverlay()}
    </div>;

  return (
    <>
      <div class={`absolute`}
        style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          `background-color: #ffffff; ${desktopStackRootStyle(props.visualElement)}`}>
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
