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

import { Component, JSX, Show, createEffect } from "solid-js";

import { LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX } from "../../constants";
import { VeFns, VisualElement, listPageBandScrollYPx, pageScrollVeid } from "../../layout/visual-element";
import { printScrollWritesSuppressed } from "../../print";
import { useStore } from "../../store/StoreProvider";


/**
 * The pinned top or bottom band of a list page. Its height is capped (see page_list.ts), and it scrolls when its rows
 * don't fit. Its scroll position is kept in the store, as is the list's, because hit testing reads it.
 */
export const ListPageBand: Component<{
  pageVisualElement: VisualElement,
  band: "top" | "bottom",
  class: string,
  /** Position and size. */
  style: string,
  ondblclick?: (ev: MouseEvent) => void,
  children: JSX.Element,
}> = (props) => {
  const store = useStore();
  let bandDiv: HTMLDivElement | undefined;
  let updatingScrollTop = false;

  const scrollableHeightPx = (): number => props.band == "top"
    ? props.pageVisualElement.listPagePinnedTopContentHeightPx - props.pageVisualElement.listPagePinnedTopHeightPx
    : props.pageVisualElement.listPagePinnedBottomContentHeightPx - props.pageVisualElement.listPagePinnedBottomHeightPx;

  createEffect(() => {
    const scrollTopPx = listPageBandScrollYPx(store, props.pageVisualElement, props.band);
    if (!bandDiv || Math.abs(bandDiv.scrollTop - scrollTopPx) < 1) { return; }
    updatingScrollTop = true;
    bandDiv.scrollTop = scrollTopPx;
    setTimeout(() => { updatingScrollTop = false; }, 0);
  });

  const scrollHandler = () => {
    if (!bandDiv || updatingScrollTop || printScrollWritesSuppressed()) { return; }
    const scrollableHeightPx_ = scrollableHeightPx();
    if (scrollableHeightPx_ <= 0) { return; }
    store.perItem.setListPageBandScrollYProp(
      pageScrollVeid(store, props.pageVisualElement), props.band, bandDiv.scrollTop / scrollableHeightPx_);
  };

  return (
    <div ref={bandDiv}
      class={props.class}
      style={`${props.style} overflow-x: hidden; overflow-y: ${scrollableHeightPx() > 0 ? "auto" : "hidden"};`}
      onscroll={scrollHandler}
      ondblclick={props.ondblclick}>
      {props.children}
    </div>
  );
};


/**
 * Drawn over the bands of a list page: faint lines between its list and its pinned bands, and while an item is moved,
 * the labels of the strips to drop it on to pin it, which empty bands are then (see page_list.ts). The lines are drawn
 * over the bands, rather than as borders of them, so they don't take a pixel from a band, which would put its rows out
 * of line with where hit testing has them.
 */
export const ListPageBandOverlays: Component<{
  pageVisualElement: VisualElement,
  /** Positioning class, as for the bands. */
  class: string,
  widthPx: number,
  /** The height the bands are laid out in. */
  heightPx: number,
  /** Any further style, e.g. the z-index the bands have. */
  style?: string,
}> = (props) => {
  const store = useStore();
  const pageVe = () => props.pageVisualElement;
  const isDropStrip = (band: "top" | "bottom") => band == "top"
    ? pageVe().listPagePinnedTopHeightPx > 0 && pageVe().listPagePinnedTopContentHeightPx == 0
    : pageVe().listPagePinnedBottomHeightPx > 0 && pageVe().listPagePinnedBottomContentHeightPx == 0;
  const dropStripIsActive = (band: "top" | "bottom") =>
    store.perVe.getMovingItemIsOver(VeFns.veToPath(pageVe())) &&
    store.perVe.getMoveOverListBand(VeFns.veToPath(pageVe())) == band;
  // Rows touch, and each band starts with top padding, which is the gap between sections: the list's below the top
  // band (when the list is scrolled to the top) and the bottom band's own below the list (when it is scrolled to the
  // bottom). A line is centred in that gap, so it is half the padding below the section edge, except at a drop strip,
  // which has no rows, where it is on the strip's edge. The page's block width is its row height.
  const gapCentrePx = () =>
    LIST_PAGE_TOP_PADDING_PX * ((pageVe().blockSizePx?.w ?? LINE_HEIGHT_PX) / LINE_HEIGHT_PX) / 2;
  const topLinePx = () => isDropStrip("top")
    ? pageVe().listPagePinnedTopHeightPx - 1
    : Math.round(pageVe().listPagePinnedTopHeightPx + gapCentrePx() - 0.5);
  const bottomLinePx = () => {
    const bottomBandTopPx = props.heightPx - pageVe().listPagePinnedBottomHeightPx;
    return isDropStrip("bottom") ? bottomBandTopPx : Math.round(bottomBandTopPx + gapCentrePx() - 0.5);
  };
  const lineStyle = (topPx: number) =>
    `left: 0px; top: ${topPx}px; width: ${props.widthPx}px; height: 1px; pointer-events: none; ${props.style ?? ""}`;
  const renderDropStrip = (band: "top" | "bottom") => {
    const heightPx = () => band == "top" ? pageVe().listPagePinnedTopHeightPx : pageVe().listPagePinnedBottomHeightPx;
    return (
      <div class={`${props.class} flex items-center justify-center text-slate-500`}
        style={`left: 0px; top: ${band == "top" ? 0 : props.heightPx - heightPx()}px; ` +
          `width: ${props.widthPx}px; height: ${heightPx()}px; pointer-events: none; ` +
          `font-size: ${Math.min(12, Math.round(heightPx() / 2))}px; white-space: nowrap; overflow: hidden; ` +
          `background-color: ${dropStripIsActive(band) ? "#0044ff1f" : "#0044ff0a"}; ${props.style ?? ""}`}>
        {band == "top" ? "Pin to top" : "Pin to bottom"}
      </div>
    );
  };
  return (
    <>
      <Show when={isDropStrip("top")}>{renderDropStrip("top")}</Show>
      <Show when={isDropStrip("bottom")}>{renderDropStrip("bottom")}</Show>
      <Show when={pageVe().listPagePinnedTopHeightPx > 0}>
        <div class={`${props.class} bg-slate-300`} style={lineStyle(topLinePx())} />
      </Show>
      <Show when={pageVe().listPagePinnedBottomHeightPx > 0}>
        <div class={`${props.class} bg-slate-300`} style={lineStyle(bottomLinePx())} />
      </Show>
    </>
  );
};
