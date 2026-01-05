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
import { VeFns, VisualElementFlags } from "../../layout/visual-element";


import { VisualElement_Desktop, VisualElement_LineItem } from "../VisualElement";
import { useStore } from "../../store/StoreProvider";
import { LINE_HEIGHT_PX, Z_INDEX_SHADOW, NATURAL_BLOCK_SIZE_PX } from "../../constants";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR } from "../../style";
import { FEATURE_COLOR, linearGradient } from "../../style";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { ArrangeAlgorithm } from "../../items/page-item";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { VesCache } from "../../layout/ves-cache";
import { PageVisualElementProps } from "./Page";
import { CALENDAR_LAYOUT_CONSTANTS, getCurrentDayInfo } from "../../util/calendar-layout";
import { itemState } from "../../store/ItemState";
import { Item } from "../../items/base/item";
import { isLink, LinkFns } from "../../items/link-item";
import { Uid } from "../../util/uid";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Translucent: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  let updatingTranslucentScrollTop = false;
  let translucentDiv: any = undefined; // HTMLDivElement | undefined

  const pageFns = () => props.pageFns;

  onMount(() => {
    let veid = VeFns.veidFromVe(props.visualElement);

    const scrollXProp = store.perItem.getPageScrollXProp(veid);
    const scrollXPx = scrollXProp * (pageFns().childAreaBoundsPx().w - pageFns().viewportBoundsPx().w);

    const scrollYProp = store.perItem.getPageScrollYProp(veid);
    const scrollYPx = scrollYProp * (pageFns().childAreaBoundsPx().h - pageFns().viewportBoundsPx().h);

    translucentDiv.scrollTop = scrollYPx;
    translucentDiv.scrollLeft = scrollXPx;
  });

  createEffect(() => {
    // occurs on page arrange algorithm change.
    if (!pageFns().childAreaBoundsPx()) { return; }

    updatingTranslucentScrollTop = true;
    if (translucentDiv) {
      translucentDiv.scrollTop =
        store.perItem.getPageScrollYProp(VeFns.veidFromVe(props.visualElement)) *
        (pageFns().childAreaBoundsPx().h - props.visualElement.boundsPx.h);
      translucentDiv.scrollLeft =
        store.perItem.getPageScrollXProp(VeFns.veidFromVe(props.visualElement)) *
        (pageFns().childAreaBoundsPx().w - props.visualElement.boundsPx.w);
    }

    setTimeout(() => {
      updatingTranslucentScrollTop = false;
    }, 0);
  });

  const translucentTitleInBoxScale = createMemo((): number => pageFns().calcTitleInBoxScale("lg"));

  const calendarTitleStyle = (): string => {
    const base = `left: ${pageFns().boundsPx().x}px; ` +
      `top: ${pageFns().boundsPx().y}px; ` +
      `width: ${pageFns().boundsPx().w}px; ` +
      `height: ${pageFns().boundsPx().h}px;` +
      `font-size: ${20 * translucentTitleInBoxScale()}px; ` +
      `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}` +
      `outline: 0px solid transparent;`;
    if (pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
      const scale = pageFns().parentPageArrangeAlgorithm() == ArrangeAlgorithm.List ? pageFns().listViewScale() : 1.0;
      const padLeft = (CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN + 4) * scale;
      return base + `justify-content: flex-start; align-items: flex-start; text-align: left; padding-top: 6px; padding-left: ${padLeft}px;`;
    } else {
      return base + `justify-content: center; align-items: center; text-align: center;`;
    }
  };

  const translucentScrollHandler = (_ev: Event) => {
    if (!translucentDiv) { return; }
    if (updatingTranslucentScrollTop) { return; }

    const pageBoundsPx = props.visualElement.boundsPx;
    const childAreaBounds = pageFns().childAreaBoundsPx();
    const pageVeid = VeFns.veidFromVe(props.visualElement);

    if (childAreaBounds.h > pageBoundsPx.h) {
      const scrollYProp = translucentDiv!.scrollTop / (childAreaBounds.h - pageBoundsPx.h);
      store.perItem.setPageScrollYProp(pageVeid, scrollYProp);
    }
  };

  const renderListPage = () =>
    <>
      <div class={`absolute ${borderClass()}`}
        style={`overflow-y: auto; overflow-x: hidden; ` +
          `width: ${LINE_HEIGHT_PX * pageFns().listColumnWidthBl() * pageFns().listViewScale()}px; ` +
          `height: ${pageFns().boundsPx().h}px; ` +
          `left: ${pageFns().boundsPx().x}px; ` +
          `top: ${pageFns().boundsPx().y}px; ` +
          `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <div class="absolute"
          style={`width: ${LINE_HEIGHT_PX * pageFns().listColumnWidthBl()}px; ` +
            `height: ${LINE_HEIGHT_PX * pageFns().lineChildren().length}px`}>
          <For each={pageFns().lineChildren()}>{childVe =>
            <VisualElement_LineItem visualElement={childVe.get()} />
          }</For>
        </div>
      </div>
      <div ref={translucentDiv}
        class={`absolute`}
        style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px;` +
          `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <For each={pageFns().desktopChildren()}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
        <Show when={VesCache.getSelectedVes(VeFns.veToPath(props.visualElement))() != null}>
          <VisualElement_Desktop visualElement={VesCache.getSelectedVes(VeFns.veToPath(props.visualElement))()!.get()} />
        </Show>
      </div>
    </>;

  const renderPage = () =>
  (
    pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.Calendar
      ? renderCalendarTranslucentPage()
      : <div ref={translucentDiv}
        class={`absolute ${borderClass()} rounded-xs`}
        style={`left: ${pageFns().boundsPx().x}px; ` +
          `top: ${pageFns().boundsPx().y}px; ` +
          `width: ${pageFns().boundsPx().w}px; ` +
          `height: ${pageFns().boundsPx().h}px; ` +
          `background-color: #ffffff; ` +
          `overflow-y: ${pageFns().boundsPx().h < pageFns().childAreaBoundsPx().h ? "auto" : "hidden"}; ` +
          `overflow-x: ${pageFns().boundsPx().w < pageFns().childAreaBoundsPx().w ? "auto" : "hidden"}; ` +
          `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}
        onscroll={translucentScrollHandler}>
        <div class="absolute"
          style={`left: ${0}px; top: ${0}px; ` +
            `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
          <For each={VesCache.getChildrenVes(VeFns.veToPath(props.visualElement))()}>{childVes =>

            <VisualElement_Desktop visualElement={childVes.get()} />
          }</For>
          {pageFns().renderMoveOverAnnotationMaybe()}
        </div>
      </div>
  );

  const renderBoxTitleMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.ListPageRoot)}>
      <div id={VeFns.veToPath(props.visualElement) + ":title"}
        class={`absolute flex font-bold text-white pointer-events-none`}
        style={calendarTitleStyle()}
        spellcheck={store.overlay.textEditInfo() != null}
        contentEditable={store.overlay.textEditInfo() != null}>
        {pageFns().pageItem().title}
      </div>
    </Show>;

  const renderCalendarTranslucentPage = () => {
    const childArea = pageFns().childAreaBoundsPx();
    const bounds = pageFns().boundsPx();
    const scale = pageFns().parentPageArrangeAlgorithm() == ArrangeAlgorithm.List ? pageFns().listViewScale() : 1.0;

    // Prepare date range: today + next 6 days
    const todayInfo = getCurrentDayInfo();
    const baseDate = new Date(todayInfo.year, todayInfo.month - 1, todayInfo.day);
    const todayKey = `${todayInfo.year}-${todayInfo.month}-${todayInfo.day}`;
    const days: Array<{ key: string, display: string, date: Date }> = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(baseDate.getTime() + i * 24 * 60 * 60 * 1000);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return { key: `${yyyy}-${d.getMonth() + 1}-${d.getDate()}`, display: `${yyyy}-${mm}-${dd}`, date: d };
    });

    // Collect all children once and group by date key
    const allChildren = pageFns().pageItem().computed_children
      .map((id: Uid) => itemState.get(id)!)
      .filter((it: Item | null): it is Item => it != null)
      .sort((a: Item, b: Item) => a.dateTime - b.dateTime);

    const itemsByDate = new Map<string, Array<Item>>();
    for (const item of allChildren) {
      const d = new Date(item.dateTime * 1000);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (!itemsByDate.has(key)) { itemsByDate.set(key, []); }
      itemsByDate.get(key)!.push(item);
    }

    const leftMargin = CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN;
    const innerWidth = childArea.w - leftMargin * 2;
    const textLeft = leftMargin + 3; // align with item title text (after icon)
    const rowH = LINE_HEIGHT_PX;
    const titleTopOffsetPx = 30; // keep items below page title on first render
    const dayHeaderTextH = 18;
    const daySeparatorSpacing = 4;
    const daySeparatorH = 1;
    const dayHeaderH = dayHeaderTextH + daySeparatorSpacing + daySeparatorH;
    const dayHeaderTopMargin = 12; // extra space above each section heading

    // Compute total height needed
    const totalHeight = days.reduce((acc, day) => {
      const items = itemsByDate.get(day.key) || [];
      const rows = Math.max(1, items.length);
      return acc + dayHeaderTopMargin + dayHeaderH + rowH * rows;
    }, titleTopOffsetPx) + 12;

    return (
      <div ref={translucentDiv}
        class={`absolute ${borderClass()} rounded-xs`}
        style={`left: ${bounds.x}px; top: ${bounds.y}px; width: ${bounds.w}px; height: ${bounds.h}px; background-color: #ffffff; overflow-y: auto; overflow-x: hidden; ${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}
        onscroll={translucentScrollHandler}>
        <div class="absolute"
          style={`left: 0px; top: 0px; width: ${childArea.w / scale}px; height: ${totalHeight / scale}px; transform: scale(${scale}); transform-origin: top left;`}>
          {(() => {
            // Render sequentially to maintain running Y
            let runningY = titleTopOffsetPx;
            const sections: any[] = [];
            for (const day of days) {
              const items = (itemsByDate.get(day.key) || []).sort((a, b) => a.dateTime - b.dateTime);
              const sectionTop = runningY + dayHeaderTopMargin;
              // Date header text
              sections.push(
                <div class="absolute font-semibold"
                  style={`left: ${textLeft}px; top: ${sectionTop}px; width: ${innerWidth - NATURAL_BLOCK_SIZE_PX.w}px; height: ${dayHeaderTextH}px; line-height: ${dayHeaderTextH}px;`}>
                  {day.display}{day.key === todayKey ? " (today)" : ""}
                </div>
              );
              // Separator line spanning inner width
              sections.push(
                <div class="absolute"
                  style={`left: ${textLeft}px; top: ${sectionTop + dayHeaderTextH + daySeparatorSpacing}px; width: ${childArea.w - 2 * textLeft - 4}px; height: ${daySeparatorH}px; background-color: #aaaaaa;`} />
              );

              const contentTop = sectionTop + dayHeaderH;
              if (items.length === 0) {
                sections.push(
                  <div class="absolute text-[#666] italic"
                    style={`left: ${textLeft}px; top: ${contentTop}px; width: ${childArea.w - textLeft - leftMargin}px; height: ${rowH}px; line-height: ${rowH}px;`}>
                    [no items]
                  </div>
                );
                runningY += dayHeaderTopMargin + dayHeaderH + rowH;
              } else {
                for (let i = 0; i < items.length; i++) {
                  const y = contentTop + i * rowH;
                  const child = items[i];

                  // Resolve links to their targets, but keep link metadata for rendering markers
                  let displayItem: Item = child;
                  let linkItemMaybe: any = null;
                  if (isLink(child)) {
                    linkItemMaybe = child as any;
                    const linkToId = LinkFns.getLinkToId(linkItemMaybe);
                    const target = itemState.get(linkToId);
                    if (target) { displayItem = target; }
                  }

                  const ve = VeFns.create({
                    displayItem,
                    linkItemMaybe,
                    flags: VisualElementFlags.LineItem,
                    boundsPx: { x: leftMargin, y, w: innerWidth, h: rowH },
                    blockSizePx: NATURAL_BLOCK_SIZE_PX,
                    hitboxes: [],
                    parentPath: VeFns.veToPath(props.visualElement),
                    col: 0,
                    row: i,
                  });
                  sections.push(<VisualElement_LineItem visualElement={ve} />);
                }
                runningY += dayHeaderTopMargin + dayHeaderH + rowH * items.length;
              }
            }
            return sections;
          })()}
        </div>
      </div>
    );
  };

  const renderHoverOverMaybe = () =>
    <Show when={store.perVe.getMouseIsOver(pageFns().vePath()) && !store.anItemIsMoving.get()}>
      <>
        <Show when={!pageFns().isInComposite()}>
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
    <Show when={store.perVe.getMovingItemIsOver(pageFns().vePath())}>
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
    <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || pageFns().isPoppedUp()}>
      <div class="absolute pointer-events-none"
        style={`left: ${pageFns().innerBoundsPx().x}px; top: ${pageFns().innerBoundsPx().y}px; width: ${pageFns().innerBoundsPx().w}px; height: ${pageFns().innerBoundsPx().h}px; ` +
          `background-color: #dddddd88;`} />
    </Show>;

  const renderIsLinkMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
      pageFns().showTriangleDetail()}>
      <InfuLinkTriangle />
    </Show>;

  const backgroundStyle = () => pageFns().parentPageArrangeAlgorithm() == ArrangeAlgorithm.List
    ? ''
    : `background-image: ${linearGradient(pageFns().pageItem().backgroundColorIndex, 0.636)};`;

  const borderClass = () => pageFns().parentPageArrangeAlgorithm() == ArrangeAlgorithm.List
    ? ''
    : 'border border-[#777] hover:shadow-md';

  // Check if this page is currently focused (via focusPath or textEditInfo)
  const isFocused = () => {
    const focusPath = store.history.getFocusPath();
    const textEditInfo = store.overlay.textEditInfo();
    return focusPath === pageFns().vePath() || (textEditInfo != null && textEditInfo.itemPath === pageFns().vePath());
  };

  const shadowClass = () => {
    if (pageFns().parentPageArrangeAlgorithm() == ArrangeAlgorithm.List) {
      return '';
    }
    return isFocused() ? 'shadow-xl blur-md bg-slate-700' : 'shadow-xl';
  };

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc)}>
      <div class={`absolute border border-transparent rounded-xs ${shadowClass()} overflow-hidden`}
        style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
    </Show>;

  const renderResizeTriangleMaybe = () =>
    <Show when={pageFns().showTriangleDetail()}>
      <div class={`absolute border border-transparent rounded-xs overflow-hidden pointer-events-none`}
        style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          `${VeFns.opacityStyle(props.visualElement)}; ${VeFns.zIndexStyle(props.visualElement)}`}>
        <InfuResizeTriangle />
      </div>
    </Show>;

  return (
    <>
      {renderShadowMaybe()}
      <Switch>
        <Match when={pageFns().pageItem().arrangeAlgorithm == ArrangeAlgorithm.List}>
          {renderListPage()}
        </Match>
        <Match when={pageFns().pageItem().arrangeAlgorithm != ArrangeAlgorithm.List}>
          {renderPage()}
        </Match>
      </Switch>
      {renderResizeTriangleMaybe()}
      <div class={`absolute ${borderClass()} rounded-xs pointer-events-none`}
        style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          backgroundStyle() +
          `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
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
        <For each={VesCache.getAttachmentsVes(VeFns.veToPath(props.visualElement))()}>{attachmentVe =>
          <VisualElement_Desktop visualElement={attachmentVe.get()} />
        }</For>
        <Show when={pageFns().showMoveOutOfCompositeArea()}>
          <div class={`absolute rounded-xs`}
            style={`left: ${pageFns().moveOutOfCompositeBox().x}px; top: ${pageFns().moveOutOfCompositeBox().y}px; width: ${pageFns().moveOutOfCompositeBox().w}px; height: ${pageFns().moveOutOfCompositeBox().h}px; ` +
              `background-color: ${FEATURE_COLOR};`} />
        </Show>
        {renderIsLinkMaybe()}
      </div>
      {renderBoxTitleMaybe()}
    </>
  );
}
