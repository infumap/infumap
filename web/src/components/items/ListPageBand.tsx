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

import { VisualElement, listPageBandScrollYPx, listPageScrollVeid } from "../../layout/visual-element";
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
      listPageScrollVeid(store, props.pageVisualElement), props.band, bandDiv.scrollTop / scrollableHeightPx_);
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
 * Faint lines between the list of a list page and its pinned bands, where it has them. They are drawn over the bands,
 * rather than as borders of them, so they don't take a pixel from a band, which would put its rows out of line with
 * where hit testing has them.
 */
export const ListPageBandSeparators: Component<{
  pageVisualElement: VisualElement,
  /** Positioning class, as for the bands. */
  class: string,
  widthPx: number,
  /** The height the bands are laid out in. */
  heightPx: number,
  /** Any further style, e.g. the z-index the bands have. */
  style?: string,
}> = (props) => {
  const lineStyle = (topPx: number) =>
    `left: 0px; top: ${topPx}px; width: ${props.widthPx}px; height: 1px; pointer-events: none; ${props.style ?? ""}`;
  return (
    <>
      <Show when={props.pageVisualElement.listPagePinnedTopHeightPx > 0}>
        <div class={`${props.class} bg-slate-300`}
          style={lineStyle(props.pageVisualElement.listPagePinnedTopHeightPx - 1)} />
      </Show>
      <Show when={props.pageVisualElement.listPagePinnedBottomHeightPx > 0}>
        <div class={`${props.class} bg-slate-300`}
          style={lineStyle(props.heightPx - props.pageVisualElement.listPagePinnedBottomHeightPx)} />
      </Show>
    </>
  );
};
