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

import { Component, JSX, createEffect } from "solid-js";

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
