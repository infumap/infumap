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

import imgUrl from '../../assets/circle.png'

import { Component, Index, Match, Show, Switch, createMemo } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { commitActiveToolbarTitleEdit } from "../../input/toolbar_title";
import { NONE_VISUAL_ELEMENT, VeFns, VisualElementFlags } from "../../layout/visual-element";
import { Toolbar_Note } from "./item/Toolbar_Note";
import { Toolbar_Navigation } from "./Toolbar_Navigation";
import { Toolbar_NetworkStatus } from "./Toolbar_NetworkStatus";
import { initialEditUserSettingsBounds } from "../overlay/UserSettings";
import { itemState } from "../../store/ItemState";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { hexToRGBA } from "../../util/color";
import { BORDER_COLOR, BorderType, Colors, LIGHT_BORDER_COLOR, borderColorForColorIdx, linearGradient, mainPageBorderColor, mainPageBorderWidth } from "../../style";
import { InfuIconButton } from '../library/InfuIconButton';
import { Toolbar_Page } from './item/Toolbar_Page';
import { Toolbar_Table } from './item/Toolbar_Table';
import { requestArrange } from '../../layout/arrange';
import { GRID_SIZE, LINE_HEIGHT_PX, NATURAL_BLOCK_SIZE_PX, Z_INDEX_GLOBAL_TOOLBAR_OVERLAY, Z_INDEX_GLOBAL_TOOLBAR_TRIGGER } from '../../constants';
import { isNote } from '../../items/note-item';
import { isTable } from '../../items/table-item';
import { isRating } from '../../items/rating-item';
import { Toolbar_Rating } from './item/Toolbar_Rating';
import { isPassword } from '../../items/password-item';
import { Toolbar_Password } from './item/Toolbar_Password';
import { isImage } from '../../items/image-item';
import { Toolbar_Image } from './item/Toolbar_Image';
import { isFile } from '../../items/file-item';
import { Toolbar_File } from './item/Toolbar_File';
import { isText } from '../../items/text-item';
import { Toolbar_Text } from './item/Toolbar_Text';
import { isLink } from '../../items/link-item';
import { Toolbar_Link } from './item/Toolbar_Link';
import { isComposite } from '../../items/composite-item';
import { Toolbar_Composite } from './item/Toolbar_Composite';
import { isQueryItem } from '../../items/query-item';
import { Toolbar_Search } from './item/Toolbar_Search';
import { isDivider } from '../../items/divider-item';
import { Toolbar_Divider } from './item/Toolbar_Divider';
import { VesCache } from '../../layout/ves-cache';
import { logout } from '../Main';
import { getFocusedSearchWorkspaceChromeSpec } from '../../util/search-focus-chrome';
import { getToolbarFocusItem } from './toolbarFocus';
import { SOLO_ITEM_HOLDER_PAGE_UID } from '../../util/uid';


const TOOLBAR_LOGO_VISIBLE_SIZE_PX = 28 * 419 / 448;
const TOOLBAR_LOGO_VISIBLE_OFFSET_PX = 28 * 11 / 448;
const TOOLBAR_BACKGROUND_COLOR = "#fafafa";
// Radius of the corners of the page outline in the toolbar area.
const TOOLBAR_OUTLINE_CORNER_RADIUS_PX = 6;

/**
 * Rounds a top corner of the page outline where its vertical and top edges are borders of two different elements, so
 * cannot be rounded with border-radius. The two border segments are redrawn as a rounded corner over the top, and the
 * area outside the curve is painted with the toolbar background. Inside the curve is transparent, so the title
 * background shows through. positionStyle places the patch so its outer vertical edge is on the vertical border.
 */
const ToolbarOutlineCorner = (props: {
  side: "left" | "right",
  positionStyle: string,
  verticalBorderWidthPx: number,
  verticalBorderColor: string,
  topBorderWidthPx: number,
  topBorderColor: string,
}) => {
  const sizePx = () => TOOLBAR_OUTLINE_CORNER_RADIUS_PX + props.verticalBorderWidthPx + 1;
  // A blank title spec border color leaves the border color of the outline elements at the default (index.css), whereas
  // here it would leave the color out of the border shorthand, which then falls back to the text color.
  const color = (c: string) => c.trim() == "" ? "var(--color-gray-200)" : c;
  return (
    <div class="absolute pointer-events-none overflow-hidden"
      style={`${props.positionStyle} top: 0px; width: ${sizePx()}px; height: ${sizePx()}px; z-index: 1;`}>
      <div class="absolute"
        style={`${props.side}: 0px; top: 0px; width: ${2 * sizePx()}px; height: ${2 * sizePx()}px; ` +
          `border-${props.side}: ${props.verticalBorderWidthPx}px solid ${color(props.verticalBorderColor)}; ` +
          `border-top: ${props.topBorderWidthPx}px solid ${color(props.topBorderColor)}; ` +
          `border-top-${props.side}-radius: ${TOOLBAR_OUTLINE_CORNER_RADIUS_PX}px; ` +
          `box-shadow: 0 0 0 ${sizePx()}px ${TOOLBAR_BACKGROUND_COLOR};`} />
    </div>
  );
};

export const Toolbar: Component = () => {
  const store = useStore();

  const handleLogin = () => {
    logout!(); // ensures all state is cleared, so old state can never be visible briefly after login.
    window.location.pathname = "/login";
  }

  const showUserSettings = () => {
    store.overlay.editUserSettingsInfo.set({ desktopBoundsPx: initialEditUserSettingsBounds(store) });
  }

  const calcFocusPageIdx = () => {
    store.touchToolbarDependency();
    const topPageVePaths = store.topTitledPages.get();
    const focusPath = store.history.getFocusPathMaybe();
    if (focusPath == null) {
      return -1;
    }
    const currentFocusVeid = VeFns.veidFromPath(focusPath);
    let focusPageIdx = -1;
    for (let i = 0; i < topPageVePaths.length; ++i) {
      if (!VeFns.compareVeids(VeFns.veidFromPath(topPageVePaths[i]), currentFocusVeid)) {
        focusPageIdx = i;
      }
    }
    return focusPageIdx;
  };

  const titleSpecs = createMemo(() => {
    store.touchToolbarDependency();

    const defaultBg = 'background-color: #fafafa;';
    const defaultCol = hexToRGBA(Colors[0], 1.0);

    if (store.history.currentPageVeid() == null) {
      return [{ title: "", idx: 0, lPosPx: 0, rPosPx: -1, bg: defaultBg, col: defaultCol, hasFocus: false, nextHasFocus: false, borderColor: ' ', borderWidthPx: 1, canEdit: false }];
    }

    let aTopPageHasFocus = isPage(store.history.getFocusItem());
    const fVes = VesCache.render.getNode(store.history.getFocusPath()!);
    if (fVes) {
      const fVe = fVes.get();
      // Check if focus is inside a popup (has Popup flag or is descendant of popup)
      const focusIsInsidePopup = !!(fVe.flags & VisualElementFlags.Popup) ||
        (store.history.currentPopupSpecVeid() != null &&
          !(fVe.flags & VisualElementFlags.ListPageRoot) &&
          !(fVe.flags & VisualElementFlags.TopLevelRoot));
      if (focusIsInsidePopup) {
        aTopPageHasFocus = false;
      }
      // Also disable if focus is not on a root-level page
      if (!(fVe.flags & VisualElementFlags.ListPageRoot) && !(fVe.flags & VisualElementFlags.TopLevelRoot)) {
        aTopPageHasFocus = false;
      }
    }

    const topPageVePaths = store.topTitledPages.get();
    const topPageVeids = [];
    for (let i = 0; i < topPageVePaths.length; ++i) {
      topPageVeids.push(VeFns.veidFromPath(topPageVePaths[i]));
    }
    if (topPageVeids.length === 0) {
      return [{ title: "", idx: 0, lPosPx: 0, rPosPx: -1, bg: defaultBg, col: defaultCol, hasFocus: false, nextHasFocus: false, borderColor: ' ', borderWidthPx: 1, canEdit: false }];
    }

    const firstTopPageMaybe = itemState.get(topPageVeids[0].itemId);
    if (!firstTopPageMaybe || !isPage(firstTopPageMaybe)) {
      return [{ title: "", idx: 0, lPosPx: 0, rPosPx: -1, bg: defaultBg, col: defaultCol, hasFocus: false, nextHasFocus: false, borderColor: ' ', borderWidthPx: 1, canEdit: false }];
    }
    const firstTopPage = asPageItem(firstTopPageMaybe);

    let focusPageIdx = -1;
    let focusPageItem = null;
    if (aTopPageHasFocus) {
      focusPageIdx = calcFocusPageIdx();
      if (focusPageIdx == -1 || focusPageIdx >= topPageVeids.length) {
        return [{ title: "", idx: 0, lPosPx: 0, rPosPx: -1, bg: defaultBg, col: defaultCol, hasFocus: false, nextHasFocus: false, borderColor: ' ', borderWidthPx: 1, canEdit: false }];
      }
      const focusPageMaybe = itemState.get(topPageVeids[focusPageIdx].itemId);
      if (!focusPageMaybe || !isPage(focusPageMaybe)) {
        return [{ title: "", idx: 0, lPosPx: 0, rPosPx: -1, bg: defaultBg, col: defaultCol, hasFocus: false, nextHasFocus: false, borderColor: ' ', borderWidthPx: 1, canEdit: false }];
      }
      focusPageItem = asPageItem(focusPageMaybe);
    }

    let r = [];

    let lPosPx = 0;
    let rPosPx = (firstTopPage.listWidthGr / GRID_SIZE) * LINE_HEIGHT_PX;
    if (topPageVeids.length == 1) { rPosPx = -1; }
    r.push({
      title: firstTopPage.title,
      idx: 0,
      lPosPx,
      rPosPx,
      bg: focusPageIdx == 0 ? `background-image: ${linearGradient(firstTopPage.backgroundColorIndex, 0.92)};` : defaultBg,
      col: `${hexToRGBA(Colors[firstTopPage.backgroundColorIndex], 1.0)}; `,
      hasFocus: focusPageIdx == 0,
      nextHasFocus: focusPageIdx == 1,
      borderColor: focusPageIdx == 0
        ? borderColorForColorIdx(firstTopPage.backgroundColorIndex, BorderType.MainPage)
        : ' ',
      borderWidthPx: focusPageIdx == 0 ? 2 : 1,
      canEdit: firstTopPage.id != SOLO_ITEM_HOLDER_PAGE_UID && itemCanEdit(firstTopPage),
    });

    for (let i = 1; i < topPageVeids.length; ++i) {
      let pUid = topPageVeids[i].itemId;
      const pageMaybe = itemState.get(pUid);
      if (!pageMaybe || !isPage(pageMaybe)) {
        continue;
      }
      let page = asPageItem(pageMaybe);
      lPosPx = rPosPx;
      rPosPx = lPosPx + (page.listWidthGr / GRID_SIZE) * LINE_HEIGHT_PX;
      if (i == topPageVeids.length - 1) {
        rPosPx = -1;
      }

      r.push({
        title: page.title,
        idx: i,
        lPosPx,
        rPosPx,
        bg: aTopPageHasFocus && focusPageIdx <= i ? `background-image: ${linearGradient(focusPageItem!.backgroundColorIndex, 0.92)};` : defaultBg,
        col: `${hexToRGBA(Colors[page.backgroundColorIndex], 1.0)}; `,
        hasFocus: focusPageIdx == i,
        nextHasFocus: focusPageIdx == i + 1,
        borderColor: aTopPageHasFocus && focusPageIdx <= i
          ? borderColorForColorIdx(focusPageItem!.backgroundColorIndex, BorderType.MainPage)
          : ' ',
        borderWidthPx: focusPageIdx <= i ? 2 : 1,
        canEdit: page.id != SOLO_ITEM_HOLDER_PAGE_UID && itemCanEdit(page),
      });
    }

    return r;
  });

  const rightMostTitleSpec = () =>
    titleSpecs()[titleSpecs().length - 1];

  const focusedSearchChrome = () => getFocusedSearchWorkspaceChromeSpec(store);
  const toolbarFocusItem = () => getToolbarFocusItem(store);

  const tableHeaderBorderBounds = createMemo(() => {
    const pages = store.topTitledPages.get();
    const path = pages[pages.length - 1];
    if (!path) { return null; }
    const ve = VesCache.render.getNode(path)?.get();
    if (!ve?.viewportBoundsPx || !ve.tableBodyViewportBoundsPx ||
      ve.tableBodyViewportBoundsPx.y <= ve.viewportBoundsPx.y) {
      return null;
    }
    return VeFns.veViewportBoundsRelativeToDesktopPx(store, ve);
  });

  const hideToolbar = () => {
    store.topToolbarVisible.set(false);
    store.resetDesktopSizePx();
    requestArrange(store, "toolbar-visibility-change");
  }

  const showToolbar = () => {
    store.topToolbarVisible.set(true);
    store.resetDesktopSizePx();
    requestArrange(store, "toolbar-visibility-change");
  }

  const handleTitleClick = () => {
    return;
  }

  const handleLogoClick = () => {
    store.history.writeBrowserEntry("/", "push", false);
    window.location.reload();
  }

  const dockToolbarAreaMaybe = () =>
    <Show when={store.dockVisible.get()}>
      <>
        <div class="fixed left-0 top-0 border-r border-b overflow-hidden"
          style={`width: ${store.getCurrentDockWidthPx()}px; height: ${store.topToolbarHeightPx()}px; background-color: #fafafa; ` +
            `border-bottom-color: ${LIGHT_BORDER_COLOR}; border-right-color: ${mainPageBorderColor(store, itemState.get)}; ` +
            `border-right-width: ${mainPageBorderWidth(store)}px`}>
          <div class="flex flex-row flex-nowrap" style={'width: 100%; margin-top: 4px; margin-left: 6px;'}>
            <Show when={store.getCurrentDockWidthPx() > NATURAL_BLOCK_SIZE_PX.w}>
              <div class="align-middle inline-block" style="margin-top: 2px; margin-left: 2px; flex-grow: 0; flex-basis: 28px; flex-shrink: 0;">
                <a href="/" onClick={handleLogoClick}>
                  <img
                    src={imgUrl}
                    class="inline-block"
                    style={`width: ${TOOLBAR_LOGO_VISIBLE_SIZE_PX}px; height: ${TOOLBAR_LOGO_VISIBLE_SIZE_PX}px; ` +
                      `margin-left: ${TOOLBAR_LOGO_VISIBLE_OFFSET_PX}px; margin-top: ${TOOLBAR_LOGO_VISIBLE_OFFSET_PX}px;`}
                  />
                </a>
              </div>
            </Show>
            <div class="inline-block" style="flex-grow: 1;" />
            <div class="inline-block"
              style={"flex-grow: 0; margin-right: 8px;" +
                `padding-right: ${2 - (mainPageBorderWidth(store) - 1)}px; `}>
              <Show when={store.getCurrentDockWidthPx() > NATURAL_BLOCK_SIZE_PX.w * 2}>
                <Toolbar_Navigation />
              </Show>
            </div>
          </div>
        </div>
        {/* this a hack to cover over a barely visible visual issue at the intersection of the toolbar and dock borders. */}
        <div class="absolute"
          style={`width: ${mainPageBorderWidth(store)}px; ` +
            `height: 10px; ` +
            `left: ${store.getCurrentDockWidthPx() - mainPageBorderWidth(store)}px; ` +
            `top: ${store.topToolbarHeightPx() - 5}px; ` +
            `background-color: ${mainPageBorderColor(store, itemState.get)};`} />
      </>
    </Show>;

  const rightToolbarSection = () =>
    <div id="toolbarRightSectionDiv"
      class="relative border-l border-b pl-[4px] flex flex-row"
      style={`border-color: ${rightMostTitleSpec().borderColor}; background-color: ${TOOLBAR_BACKGROUND_COLOR}; ` +
        `border-left-width: ${rightMostTitleSpec().borderWidthPx}px; border-bottom-width: ${rightMostTitleSpec().borderWidthPx}px; ` +
        `border-bottom-left-radius: ${TOOLBAR_OUTLINE_CORNER_RADIUS_PX}px; ` +
        `align-items: baseline;`}>

      <ToolbarOutlineCorner side="right"
        positionStyle={`right: 100%;`}
        verticalBorderWidthPx={rightMostTitleSpec().borderWidthPx}
        verticalBorderColor={rightMostTitleSpec().borderColor}
        topBorderWidthPx={rightMostTitleSpec().borderWidthPx - 1}
        topBorderColor={rightMostTitleSpec().borderColor} />

      <Show when={store.umbrellaVisualElement.get().displayItem.itemType != NONE_VISUAL_ELEMENT.displayItem.itemType}>
        <Switch fallback={<div id="toolbarItemOptionsDiv">[no context]</div>}>
          <Match when={isPage(toolbarFocusItem())}>
            <Show when={asPageItem(toolbarFocusItem()).arrangeAlgorithm != ArrangeAlgorithm.SingleCell}>
              <Toolbar_Page />
            </Show>
          </Match>
          <Match when={isNote(toolbarFocusItem())}>
            <Toolbar_Note />
          </Match>
          <Match when={isTable(toolbarFocusItem())}>
            <Toolbar_Table />
          </Match>
          <Match when={isRating(toolbarFocusItem())}>
            <Toolbar_Rating />
          </Match>
          <Match when={isPassword(toolbarFocusItem())}>
            <Toolbar_Password />
          </Match>
          <Match when={isImage(toolbarFocusItem())}>
            <Toolbar_Image />
          </Match>
          <Match when={isFile(toolbarFocusItem())}>
            <Toolbar_File />
          </Match>
          <Match when={isText(toolbarFocusItem())}>
            <Toolbar_Text />
          </Match>
          <Match when={isLink(toolbarFocusItem())}>
            <Toolbar_Link />
          </Match>
          <Match when={isComposite(toolbarFocusItem())}>
            <Toolbar_Composite />
          </Match>
          <Match when={isQueryItem(toolbarFocusItem())}>
            <Toolbar_Search />
          </Match>
          <Match when={isDivider(toolbarFocusItem())}>
            <Toolbar_Divider />
          </Match>
        </Switch>
      </Show>

      <div class="grow-0 ml-[7px] mr-[7px] relative" style="flex-order: 1; height: 25px;">
        {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
        <div class="fixed border-r border-slate-300" style="height: 25px; right: 87px; top: 7px;"></div>
      </div>

      <div class="grow-0 pr-[8px]" style="flex-order: 2;">
        <Show when={!store.user.getUserMaybe()}>
          <InfuIconButton icon="fa fa-sign-in" highlighted={false} clickHandler={handleLogin} />
        </Show>
        <Show when={store.user.getUserMaybe()}>
          <InfuIconButton icon="fa fa-user" highlighted={false} clickHandler={showUserSettings} />
        </Show>
        <Toolbar_NetworkStatus />
        <InfuIconButton icon="fa fa-chevron-up" highlighted={false} clickHandler={hideToolbar} />
      </div>

    </div>;

  const mainToolbarArea = () =>
    <div class="fixed right-0 top-0" style={`left: ${store.getCurrentDockWidthPx()}px;}`}>
      <Show when={store.dockVisible.get() && titleSpecs().length > 0}>
        <ToolbarOutlineCorner side="left"
          positionStyle={`left: -${mainPageBorderWidth(store)}px;`}
          verticalBorderWidthPx={mainPageBorderWidth(store)}
          verticalBorderColor={mainPageBorderColor(store, itemState.get)}
          topBorderWidthPx={titleSpecs()[0].borderWidthPx - 1}
          topBorderColor={titleSpecs()[0].borderColor} />
      </Show>
      <div class="flex flex-row">

        <Index each={titleSpecs()}>{tSpec =>
          <>
            {/* spacer before title text */}
            <div class="border-b grow-0"
              style={`width: ${tSpec().lPosPx == 0 ? '5' : (tSpec().hasFocus ? '7' : '6')}px; border-bottom-color: ${LIGHT_BORDER_COLOR}; ` +
                `${tSpec().bg}` +
                (tSpec().lPosPx != 0 ? `border-left-width: ${tSpec().hasFocus ? '2' : '1'}px; border-left-color: ${tSpec().hasFocus ? tSpec().borderColor : BORDER_COLOR}; ` : '') +
                `border-top-color: ${tSpec().borderColor};` +
                `border-top-width: ${tSpec().borderWidthPx - 1}px; `} />

            <div id={`toolbarTitleDiv-${tSpec().idx}`}
              class={`p-[3px] inline-block border-b grow-0 overflow-hidden whitespace-nowrap ${tSpec().canEdit ? "cursor-text" : "cursor-pointer"}`}
              contentEditable={tSpec().canEdit}
              onInput={() => { commitActiveToolbarTitleEdit(store, false); }}
              style={`font-size: 22px; color: ${tSpec().col}; font-weight: 700; border-bottom-color: ${LIGHT_BORDER_COLOR}; ` +
                `${tSpec().bg} ` +
                `border-top-color: ${tSpec().borderColor};` +
                `border-top-width: ${tSpec().borderWidthPx - 1}px; ` +
                `padding-top: ${2 - (tSpec().borderWidthPx - 1)}px; ` +
                `height: ${store.topToolbarHeightPx()}px; ` +
                (tSpec().rPosPx > 0 ? `width: ${tSpec().rPosPx - tSpec().lPosPx - 6 - (tSpec().nextHasFocus ? 1 : 0)}px;` : '') +
                "outline: 0px solid transparent;"}
              onClick={handleTitleClick}>
              {tSpec().title}
            </div>
          </>
        }</Index>

        <div id="toolbarTrailingTitleEditArea"
          class={`inline-block flex-nowrap border-b ${rightMostTitleSpec().canEdit ? "cursor-text" : "cursor-pointer"}`}
          style={`flex-grow: 1; border-bottom-color: ${LIGHT_BORDER_COLOR}; margin-right: -${TOOLBAR_OUTLINE_CORNER_RADIUS_PX}px; ` +
            `${rightMostTitleSpec().bg} ` +
            `border-top-color: ${rightMostTitleSpec().borderColor};` +
            `border-top-width: ${rightMostTitleSpec().borderWidthPx - 1}px; `}></div>

        {rightToolbarSection()}

      </div>
    </div>;

  const toolbar = () =>
    <>
      {dockToolbarAreaMaybe()}
      {mainToolbarArea()}
      {/* Share the toolbar's bottom pixel with the table header, leaving one page-border pixel above it. */}
      <Show when={tableHeaderBorderBounds()}>{bounds =>
        <div class="fixed pointer-events-none bg-[#999]"
          style={`left: ${bounds().x}px; top: ${store.topToolbarHeightPx() - 1}px; ` +
            `width: ${bounds().w}px; height: 1px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY};`} />
      }</Show>
      <Show when={focusedSearchChrome()}>
        <div class="fixed pointer-events-none"
          style={`left: ${Math.max(0, focusedSearchChrome()!.desktopBoundsPx.x - focusedSearchChrome()!.borderWidthPx)}px; ` +
            `right: 0px; ` +
            `top: ${Math.max(0, store.topToolbarHeightPx() + focusedSearchChrome()!.desktopBoundsPx.y - focusedSearchChrome()!.borderWidthPx)}px; ` +
            `height: ${focusedSearchChrome()!.borderWidthPx}px; ` +
            `background-color: ${focusedSearchChrome()!.borderColor}; ` +
            `z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY};`} />
      </Show>
    </>;

  const showToolbarButton = () =>
    <div class="absolute print:hidden"
      style={`z-index: ${Z_INDEX_GLOBAL_TOOLBAR_TRIGGER}; ` +
        `right: 6px; top: -3px;`} onmousedown={showToolbar}>
      <i class={`fa fa-chevron-down hover:bg-slate-300 p-[2px] text-xs ${!store.dockVisible.get() ? 'text-white' : 'text-slate-400'}`} />
    </div>;

  return (
    <>
      <Show when={store.topToolbarVisible.get() && !store.smallScreenMode()}>
        {toolbar()}
      </Show>
      <Show when={!store.topToolbarVisible.get() && !store.smallScreenMode()}>
        {showToolbarButton()}
      </Show>
    </>
  );
}
