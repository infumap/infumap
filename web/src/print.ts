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

import { commitActiveTextEdit } from "./input/edit";
import { clearMouseOverState } from "./input/mouse_move";
import { commitActiveToolbarTitleEdit } from "./input/toolbar_title";
import { ArrangeAlgorithm, asPageItem, isPage } from "./items/page-item";
import { arrangeNow } from "./layout/arrange";
import { pageHasPrintLayout } from "./layout/print-bands";
import { VesCache } from "./layout/ves-cache";
import { Veid, VisualElementPath } from "./layout/visual-element";
import { itemState } from "./store/ItemState";
import { StoreContextModel } from "./store/StoreProvider";


const PRINT_MODE_CLASS = "infumap-print-mode";
const PRINT_FIT_PAGE_CLASS = "print-fit-page";
const PRINT_FLOW_CLASS = "print-flow";

interface StateBeforePrint {
  dockVisible: boolean,
  topToolbarVisible: boolean,
  documentTitle: string,
  pageScroll: { veid: Veid, xProp: number, yProp: number } | null,
  selectedVeids: Array<Veid>,
  findHighlightedPath: VisualElementPath | null,
}

let stateBeforePrint: StateBeforePrint | null = null;
let scrollWritesSuppressed = false;

/**
 * True while page scroll positions must not be recorded: layout changes made for printing fire scroll events that
 * would otherwise overwrite the user's scroll position.
 */
export function printScrollWritesSuppressed(): boolean {
  return scrollWritesSuppressed;
}

/**
 * Lays the current page out for printing. The arrange is synchronous, since the browser lays out the printed page
 * as soon as beforeprint returns. Entering when already in print mode does nothing.
 */
export function enterPrintMode(store: StoreContextModel): void {
  if (stateBeforePrint != null) { return; }

  commitActiveToolbarTitleEdit(store);
  commitActiveTextEdit(store, false, "text-edit-print", false);

  const pageVeid = store.history.currentPageVeid();
  stateBeforePrint = {
    dockVisible: store.dockVisible.get(),
    topToolbarVisible: store.topToolbarVisible.get(),
    documentTitle: document.title,
    pageScroll: pageVeid == null ? null : {
      veid: pageVeid,
      xProp: store.perItem.getPageScrollXProp(pageVeid),
      yProp: store.perItem.getPageScrollYProp(pageVeid),
    },
    selectedVeids: store.overlay.selectedVeids.get(),
    findHighlightedPath: store.find.highlightedPath.get(),
  };
  scrollWritesSuppressed = true;

  // Chrome uses the document title as the default PDF filename and in the page header.
  const pageTitle = currentPageTitle(store);
  if (pageTitle != null) { document.title = pageTitle; }

  // Highlights and hover affordances aren't part of the page. Hover state is re-established by the next mouse move.
  store.overlay.selectedVeids.set([]);
  store.find.highlightedPath.set(null);
  clearMouseOverState(store);

  // Dock and toolbar are hidden via the layout (not just css) so the desktop offsets they occupy are removed too.
  store.dockVisible.set(false);
  store.topToolbarVisible.set(false);
  store.printMode.set(true);
  document.documentElement.classList.add(PRINT_MODE_CLASS);
  arrangeNow(store, "enter-print-mode");

  if (currentPageHasPrintLayout(store)) {
    // The page is rendered as normal-flow content for the browser to paginate (see index.css).
    document.documentElement.classList.add(PRINT_FLOW_CLASS);
  } else if (currentPageFitsViewport(store)) {
    // A page that doesn't scroll is scaled to fit a single sheet (see index.css).
    const desktopBoundsPx = store.desktopBoundsPx();
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--print-fit-width", `${desktopBoundsPx.w}px`);
    rootStyle.setProperty("--print-fit-height", `${desktopBoundsPx.h}px`);
    document.documentElement.classList.add(PRINT_FIT_PAGE_CLASS);
  }
}

export function exitPrintMode(store: StoreContextModel): void {
  if (stateBeforePrint == null) { return; }
  const state = stateBeforePrint;
  stateBeforePrint = null;

  const rootElement = document.documentElement;
  rootElement.classList.remove(PRINT_FLOW_CLASS);
  rootElement.classList.remove(PRINT_FIT_PAGE_CLASS);
  rootElement.style.removeProperty("--print-fit-width");
  rootElement.style.removeProperty("--print-fit-height");
  rootElement.classList.remove(PRINT_MODE_CLASS);

  document.title = state.documentTitle;
  if (state.pageScroll != null) {
    store.perItem.setPageScrollXProp(state.pageScroll.veid, state.pageScroll.xProp);
    store.perItem.setPageScrollYProp(state.pageScroll.veid, state.pageScroll.yProp);
  }
  store.overlay.selectedVeids.set(state.selectedVeids);
  store.find.highlightedPath.set(state.findHighlightedPath);
  store.printMode.set(false);
  store.dockVisible.set(state.dockVisible);
  store.topToolbarVisible.set(state.topToolbarVisible);
  arrangeNow(store, "exit-print-mode");

  // Scroll events caused by the layout changes above are dispatched on a later frame.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (stateBeforePrint == null) { scrollWritesSuppressed = false; }
  }));
}

function currentPageTitle(store: StoreContextModel): string | null {
  const pagePath = store.history.currentPagePath();
  if (pagePath == null) { return null; }
  const pageVe = VesCache.current.readNode(pagePath);
  if (!pageVe || !isPage(pageVe.displayItem)) { return null; }
  const title = asPageItem(pageVe.displayItem).title.trim();
  return title == "" ? null : title;
}

function currentPageHasPrintLayout(store: StoreContextModel): boolean {
  const pageVeid = store.history.currentPageVeid();
  if (pageVeid == null) { return false; }
  const pageItem = itemState.get(pageVeid.itemId);
  return pageItem != null && isPage(pageItem) && pageHasPrintLayout(asPageItem(pageItem));
}

function currentPageFitsViewport(store: StoreContextModel): boolean {
  const pagePath = store.history.currentPagePath();
  if (pagePath == null) { return false; }
  const pageVe = VesCache.current.readNode(pagePath);
  if (!pageVe || !isPage(pageVe.displayItem)) { return false; }
  const arrangeAlgorithm = asPageItem(pageVe.displayItem).arrangeAlgorithm;
  // list pages have their own scroll areas, so the page bounds don't indicate whether the content fits.
  if (arrangeAlgorithm == ArrangeAlgorithm.List) { return false; }
  const childAreaBoundsPx = pageVe.childAreaBoundsPx;
  const viewportBoundsPx = pageVe.viewportBoundsPx;
  if (!childAreaBoundsPx || !viewportBoundsPx) { return false; }
  return childAreaBoundsPx.w <= viewportBoundsPx.w && childAreaBoundsPx.h <= viewportBoundsPx.h;
}
