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

import { Component, For, Match, Show, Switch } from "solid-js";

import { VesCache } from "../../layout/ves-cache";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../../items/page-item";
import { ATTACH_AREA_SIZE_PX, COMPOSITE_ITEM_GAP_BL, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX, NATURAL_BLOCK_SIZE_PX, PAGE_DOCUMENT_LEFT_MARGIN_BL, PAGE_DOCUMENT_RIGHT_MARGIN_BL, PAGE_DOCUMENT_TOP_MARGIN_PX } from "../../constants";
import { useStore } from "../../store/StoreProvider";
import { VisualElementProps } from "../VisualElement";
import { HitboxFlags } from "../../layout/hitbox";
import { BoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { itemState } from "../../store/ItemState";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { VisualElementFlags, VeFns, VisualElement } from "../../layout/visual-element";
import { PermissionFlags } from "../../items/base/permission-flags-item";
import { asCompositeItem, isComposite } from "../../items/composite-item";
import { Page_Opaque } from "./Page_Opaque";
import { Page_Trash } from "./Page_Trash";
import { Page_Translucent } from "./Page_Translucent";
import { Page_Root } from "./Page_Root";
import { Page_EmbeddedInteractive } from "./Page_EmbeddedInteractive";
import { Page_Umbrella } from "./Page_Umbrella";
import { Page_Dock } from "./Page_Dock";
import { Page_Popup } from "./Page_Popup";
import { ItemFns } from "../../items/base/item-polymorphism";
import { calculateCalendarDimensionsForVisualElement, calculateCalendarWindowForPage, decodeCalendarCombinedIndex, getCalendarDayMetrics, getCalendarMonthLeftPx, getCalendarMonthWidthPx } from "../../util/calendar-layout";
import { stackedInsertionLineBoundsPx } from "../../layout/stacked-insertion";
import {
  calcCatalogContentWidthPx,
  calcCatalogPreviewColumnWidthPx,
  calcCatalogRowHeightPx,
  CATALOG_DETAIL_COLUMN_PADDING_PX,
  CATALOG_HORIZONTAL_MARGIN_PX,
  CATALOG_VERTICAL_MARGIN_PX,
} from "../../layout/catalog";
import { itemPathSegmentsFromItem, resolvedPathTargetItemForItem } from "../../util/item-path";
import { Item, ItemType } from "../../items/base/item";
import { asContainerItem, isContainer } from "../../items/base/container-item";
import { asFileItem, isFile } from "../../items/file-item";
import { asImageItem, isImage } from "../../items/image-item";
import { LinkFns, asLinkItem, isLink } from "../../items/link-item";
import { calculateChildrenStats, formatBytes, type ContainerChildrenStats } from "../../util/item-metadata";
import { catalogSearchResultDisplay, catalogFragmentMatchDisplayFromMatch, type CatalogFragmentMatchDisplay } from "../../util/search-result-display";
import { SELECTED_LIGHT } from "../../style";
import {
  SEARCH_WORKSPACE_ARRANGE_SELECTOR_RESULTS_GAP_PX,
  SEARCH_WORKSPACE_ARRANGE_SELECTOR_RESULTS_OVERLAP_PX,
  TEMP_SEARCH_RESULTS_ORIGIN,
  SEARCH_WORKSPACE_MORE_SECTION_GAP_PX,
  calcSearchWorkspaceResultsFooterHeightPx,
  searchResultsFooterHostId,
} from "../../items/search-item";
import { calcJustifiedPagePaddingPx } from "../../layout/arrange/justified_metrics";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

const CATALOG_DETAIL_PATH_FONT_SIZE_PX = 15;
const CATALOG_DETAIL_SUPPORT_FONT_SIZE_PX = Math.max(FONT_SIZE_PX - 2, 10);
const CATALOG_DETAIL_LINE_HEIGHT_MULTIPLIER = 1.25;
const CATALOG_DETAIL_TOP_PADDING_PX = 8;
const CATALOG_DETAIL_SECTION_GAP_PX = 4;
const CATALOG_SEARCH_SNIPPET_LINE_CLAMP = 2;
const CATALOG_SEARCH_SNIPPET_AVERAGE_CHAR_WIDTH_EM = 0.58;
const CATALOG_SEARCH_SNIPPET_CONTROL_GAP_PX = 18;
const CATALOG_SEARCH_SNIPPET_LINK_GAP_PX = 8;
const CATALOG_SEARCH_SNIPPET_LINK_SIZE_PX = 15;
const catalogDetailLineHeightPx = (fontSizePx: number): number =>
  fontSizePx * CATALOG_DETAIL_LINE_HEIGHT_MULTIPLIER;

export interface PageVisualElementProps {
  visualElement: VisualElement,
  pageFns: any,
  suppressLocalShadow?: boolean,
}

export const Page_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const stopTextSelectionMouseEvent = (ev: MouseEvent) => {
    if (ev.button == MOUSE_RIGHT) {
      const selection = window.getSelection();
      if (selection != null && !selection.isCollapsed) {
        selection.removeAllRanges();
      }
    }
    ev.stopPropagation();
  };

  const clampCatalogSnippetText = (text: string, maxChars: number): string => {
    const trimmed = text.trim();
    const chars = [...trimmed];
    if (chars.length <= maxChars) {
      return trimmed;
    }
    if (maxChars <= 3) {
      return "...";
    }

    const rawClamped = chars.slice(0, maxChars - 3).join("").trimEnd();
    const wordClamped = rawClamped.replace(/\s+\S*$/, "").trimEnd();
    const clamped = (wordClamped.length >= Math.floor(maxChars * 0.6) ? wordClamped : rawClamped)
      .replace(/\s*(?:\.\.\.|…)\s*$/, "")
      .replace(/(?:\s*\.)+$/, "");
    return `${clamped}...`;
  };

  const catalogSourceItem = (item: Item): Item =>
    resolvedPathTargetItemForItem(item) ?? item;

  const catalogChildrenStatsMetadataLines = (stats: ContainerChildrenStats): Array<string> => [
    `Children: ${stats.totalChildren}`,
    `Images & Files: ${stats.imageFileChildren}`,
    `Total Size: ${formatBytes(stats.totalBytes)}`,
  ];

  const catalogMetadataLines = (item: Item): Array<string> => {
    const targetItem = catalogSourceItem(item);
    if (isImage(targetItem)) {
      const imageItem = asImageItem(targetItem);
      const result = [`Size: ${formatBytes(imageItem.fileSizeBytes || 0)}`];
      if (imageItem.imageSizePx.w > 0 && imageItem.imageSizePx.h > 0) {
        result.push(`Image Size: ${imageItem.imageSizePx.w} × ${imageItem.imageSizePx.h}`);
      }
      return result;
    }
    if (isFile(targetItem)) {
      return [`Size: ${formatBytes(asFileItem(targetItem).fileSizeBytes || 0)}`];
    }
    if (isContainer(targetItem)) {
      return catalogChildrenStatsMetadataLines(calculateChildrenStats(asContainerItem(targetItem)));
    }
    return [];
  };

  const catalogFragmentMatches = (item: Item): Array<CatalogFragmentMatchDisplay> => {
    if (!isLink(item)) {
      return [];
    }
    const linkItem = asLinkItem(item);
    const match = linkItem.catalogFragmentMatch;
    if (!match) {
      return [];
    }
    const display = catalogFragmentMatchDisplayFromMatch(LinkFns.getLinkToId(linkItem), match);
    return display ? [display] : [];
  };

  const itemTypeIcon = (itemType: string) => {
    return (
      <Switch>
        <Match when={itemType == ItemType.Page}><i class="fa fa-folder" /></Match>
        <Match when={itemType == ItemType.Table}><i class="fa fa-table" /></Match>
        <Match when={itemType == ItemType.Note}><i class="fa fa-sticky-note" /></Match>
        <Match when={itemType == ItemType.File}><i class="fa fa-file" /></Match>
        <Match when={itemType == ItemType.Image}><i class="fa fa-image" /></Match>
        <Match when={itemType == ItemType.Link}><i class="fa fa-link" /></Match>
        <Match when={itemType == ItemType.Search}><i class="fa fa-search" /></Match>
        <Match when={itemType == ItemType.Password}><i class="fa fa-eye-slash" /></Match>
        <Match when={itemType == ItemType.Rating}><i class="fa fa-star" /></Match>
      </Switch>
    );
  };

  const pageFns = {
    pageItem: () => asPageItem(props.visualElement.displayItem),

    isPublic: () => pageFns.pageItem().permissionFlags != PermissionFlags.None,

    vePath: () => VeFns.veToPath(props.visualElement),

    parentPage: () => {
      const parentId = VeFns.itemIdFromPath(props.visualElement.parentPath!);
      const parent = itemState.get(parentId)!;
      if (isPage(parent)) {
        return asPageItem(parent);
      }
      return null;
    },

    parentPageArrangeAlgorithm: () => {
      const pp = pageFns.parentPage();
      if (!pp) { return ArrangeAlgorithm.None; }
      return pp.arrangeAlgorithm;
    },

    boundsPx: () => props.visualElement.boundsPx,

    attachCompositeBoundsPx: (): BoundingBox => {
      return {
        x: 0,
        y: pageFns.boundsPx().h - 1,
        w: pageFns.boundsPx().w - 2,
        h: 1,
      }
    },

    viewportBoundsPx: () => props.visualElement.viewportBoundsPx!,

    innerBoundsPx: () => {
      let r = zeroBoundingBoxTopLeft(props.visualElement.boundsPx);
      r.w = r.w - 2;
      r.h = r.h - 2;
      return r;
    },

    childAreaBoundsPx: () => props.visualElement.childAreaBoundsPx!,

    gridPagePaddingPx: () =>
      pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid
        ? calcJustifiedPagePaddingPx(pageFns.childAreaBoundsPx().w, pageFns.pageItem().justifiedRowAspect)
        : 0,

    gridPageTopPaddingPx: () =>
      pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid && pageFns.isSearchResultsPage()
        ? SEARCH_WORKSPACE_ARRANGE_SELECTOR_RESULTS_OVERLAP_PX + SEARCH_WORKSPACE_ARRANGE_SELECTOR_RESULTS_GAP_PX
        : pageFns.gridPagePaddingPx(),

    gridContentWidthPx: () =>
      Math.max(0, pageFns.childAreaBoundsPx().w - pageFns.gridPagePaddingPx() * 2.0),

    clickBoundsPx: (): BoundingBox | null => props.visualElement.hitboxes.find(hb => hb.type == HitboxFlags.Click || hb.type == HitboxFlags.OpenAttachment)?.boundsPx ?? null,

    popupClickBoundsPx: (): BoundingBox | null => props.visualElement.hitboxes.find(hb => hb.type == HitboxFlags.OpenPopup)!.boundsPx,

    hasPopupClickBoundsPx: (): boolean => props.visualElement.hitboxes.find(hb => hb.type == HitboxFlags.OpenPopup) != undefined,

    attachBoundsPx: (): BoundingBox => {
      return {
        x: pageFns.boundsPx().w - ATTACH_AREA_SIZE_PX - 2,
        y: 0,
        w: ATTACH_AREA_SIZE_PX,
        h: ATTACH_AREA_SIZE_PX,
      }
    },

    attachInsertBarPx: (): BoundingBox => {
      const innerSizeBl = ItemFns.calcSpatialDimensionsBl(props.visualElement.displayItem);
      const blockSizePx = pageFns.boundsPx().w / innerSizeBl.w;
      const insertIndex = store.perVe.getMoveOverAttachmentIndex(pageFns.vePath());
      // Special case for position 0: align with right edge of parent item
      const xOffset = insertIndex === 0 ? -4 : -2;
      return {
        x: pageFns.boundsPx().w - insertIndex * blockSizePx + xOffset,
        y: -blockSizePx / 2,
        w: 4,
        h: blockSizePx,
      };
    },

    moveOutOfCompositeBox: (): BoundingBox => {
      const parentCompositeWidthPx = pageFns.isInComposite()
        ? props.visualElement.blockSizePx
          ? asCompositeItem(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId)!).spatialWidthGr / GRID_SIZE * props.visualElement.blockSizePx.w
          : pageFns.boundsPx().w
        : pageFns.boundsPx().w;
      return ({
        x: parentCompositeWidthPx
          - pageFns.boundsPx().x
          - COMPOSITE_MOVE_OUT_AREA_SIZE_PX
          - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
          - CONTAINER_IN_COMPOSITE_PADDING_PX
          - 2,
        y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
        w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
        h: pageFns.boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
      });
    },

    isPoppedUp: () =>
      store.history.currentPopupSpecVeid() != null &&
      VeFns.compareVeids(VeFns.actualVeidFromVe(props.visualElement), store.history.currentPopupSpecVeid()!) == 0,

    isInComposite: () =>
      isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId)),

    isDocumentPage: () =>
      pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Document,

    documentContentLeftPx: () =>
      pageFns.isDocumentPage()
        ? Math.max((pageFns.viewportBoundsPx().w - pageFns.childAreaBoundsPx().w) / 2, 0)
        : 0,

    documentScale: () => {
      const totalWidthBl = pageFns.pageItem().docWidthBl + PAGE_DOCUMENT_LEFT_MARGIN_BL + PAGE_DOCUMENT_RIGHT_MARGIN_BL;
      if (totalWidthBl <= 0) {
        return 1;
      }
      return pageFns.childAreaBoundsPx().w / (totalWidthBl * NATURAL_BLOCK_SIZE_PX.w);
    },

    documentInsertStartTopPx: () => {
      if (!pageFns.isDocumentPage()) {
        return 0;
      }

      let topPx = PAGE_DOCUMENT_TOP_MARGIN_PX * pageFns.documentScale();
      if (PageFns.showDocumentTitleInDocument(pageFns.pageItem())) {
        topPx += PageFns.calcDocumentTitleHeightBl(pageFns.pageItem()) * NATURAL_BLOCK_SIZE_PX.h * pageFns.documentScale();
        topPx += COMPOSITE_ITEM_GAP_BL * NATURAL_BLOCK_SIZE_PX.h * pageFns.documentScale();
      }
      return topPx;
    },

    documentMoveOverInsertLineBoundsPx: (): BoundingBox | null => {
      const moveOverIndex = store.perVe.getMoveOverIndex(pageFns.vePath());
      if (moveOverIndex < 0) {
        return null;
      }

      const childVes = pageFns.nonMovingChildren().map(childVe => childVe.get());
      if (childVes.length === 0) {
        return {
          x: 0,
          y: Math.round(pageFns.documentInsertStartTopPx()),
          w: pageFns.childAreaBoundsPx().w,
          h: 1,
        };
      }

      return stackedInsertionLineBoundsPx(childVes, pageFns.childAreaBoundsPx().w, moveOverIndex);
    },

    listMoveOverInsertLineBoundsPx: (): BoundingBox | null => {
      const moveOverIndex = store.perVe.getMoveOverIndex(pageFns.vePath());
      if (moveOverIndex < 0) {
        return null;
      }

      const childVes = pageFns.lineChildren().map(childVe => childVe.get());
      const widthPx = props.visualElement.listChildAreaBoundsPx?.w ?? pageFns.listViewportWidthPx();
      if (childVes.length === 0) {
        return {
          x: 0,
          y: LIST_PAGE_TOP_PADDING_PX,
          w: widthPx,
          h: 1,
        };
      }

      return stackedInsertionLineBoundsPx(childVes, widthPx, moveOverIndex);
    },

    showMoveOutOfCompositeArea: () =>
      store.user.getUserMaybe() != null &&
      store.perVe.getMouseIsOver(pageFns.vePath()) &&
      !store.anItemIsMoving.get() &&
      store.overlay.textEditInfo() == null &&
      pageFns.isInComposite(),

    lineChildren: () => VesCache.render.getLineChildren(VeFns.veToPath(props.visualElement))(),

    desktopChildren: () => VesCache.render.getDesktopChildren(VeFns.veToPath(props.visualElement))(),

    nonMovingChildren: () => VesCache.render.getNonMovingChildren(VeFns.veToPath(props.visualElement))(),


    showTriangleDetail: () => (pageFns.boundsPx().w / (pageFns.pageItem().spatialWidthGr / GRID_SIZE)) > 0.5,

    calcTitleInBoxScale: (textSize: string) => {
      const outerDiv = document.createElement("div");
      outerDiv.setAttribute("class", "flex items-center justify-center");
      outerDiv.setAttribute("style", `width: ${pageFns.boundsPx().w}px; height: ${pageFns.boundsPx().h}px;`);
      const innerDiv = document.createElement("div");
      innerDiv.setAttribute("class", `flex items-center text-center text-${textSize} font-bold text-white`);
      outerDiv.appendChild(innerDiv);
      const txt = document.createTextNode(pageFns.pageItem().title);
      innerDiv.appendChild(txt);
      document.body.appendChild(outerDiv);
      let scale = 0.85 / Math.max(innerDiv.offsetWidth / pageFns.boundsPx().w, innerDiv.offsetHeight / pageFns.boundsPx().h); // 0.85 -> margin.
      document.body.removeChild(outerDiv);
      return scale > 1.0 ? 1.0 : scale;
    },

    listViewScale: () => {
      return props.visualElement.viewportBoundsPx!.w / store.desktopMainAreaBoundsPx().w;
    },

    listColumnWidthBl: () => {
      return asPageItem(props.visualElement.displayItem).tableColumns[0].widthGr / GRID_SIZE;
    },

    listViewportWidthPx: () => {
      return props.visualElement.listViewportBoundsPx?.w ??
        (LINE_HEIGHT_PX * pageFns.listColumnWidthBl() * pageFns.listViewScale());
    },

    renderGridLinesMaybe: () =>
      <Show when={pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid || pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Catalog}>
        <Switch>
          <Match when={pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid}>
            <For each={[...Array(pageFns.pageItem().gridNumberOfColumns).keys()]}>{i =>
              <Show when={i != 0}>
                <div class="absolute bg-slate-100"
                  style={`left: ${pageFns.gridPagePaddingPx() + props.visualElement.cellSizePx!.w * i}px; ` +
                    `height: ${props.visualElement.cellSizePx!.h * props.visualElement.numRows!}px; ` +
                    `width: 1px; top: ${pageFns.gridPageTopPaddingPx()}px;`} />
              </Show>
            }</For>
          </Match>
          <Match when={pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Catalog}>
            <div class="absolute bg-slate-100"
              style={`left: ${pageFns.catalogDividerLeftPx()}px; height: ${pageFns.catalogRowsHeightPx()}px; width: 1px; top: ${pageFns.catalogPageTopPaddingPx()}px;`} />
          </Match>
        </Switch>
        <For each={[...Array(props.visualElement.numRows!).keys()]}>{i =>
          <div class="absolute bg-slate-100"
            style={`left: ${pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Catalog ? pageFns.catalogContentLeftPx() : 0}px; ` +
              `${pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid ? `left: ${pageFns.gridPagePaddingPx()}px; ` : ""}` +
              `height: 1px; ` +
              `width: ${pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Catalog ? pageFns.catalogContentWidthPx() : pageFns.childAreaBoundsPx().w}px; ` +
              `${pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid ? `width: ${pageFns.gridContentWidthPx()}px; ` : ""}` +
              `top: ${props.visualElement.cellSizePx!.h * (i + 1) + (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Catalog ? pageFns.catalogPageTopPaddingPx() : pageFns.gridPageTopPaddingPx())}px;`} />
        }</For>
      </Show>,

    catalogPageTopPaddingPx: () => pageFns.isSearchResultsPage()
      ? SEARCH_WORKSPACE_ARRANGE_SELECTOR_RESULTS_OVERLAP_PX + SEARCH_WORKSPACE_ARRANGE_SELECTOR_RESULTS_GAP_PX
      : CATALOG_VERTICAL_MARGIN_PX,

    catalogContentLeftPx: () => CATALOG_HORIZONTAL_MARGIN_PX,

    catalogContentWidthPx: () => calcCatalogContentWidthPx(pageFns.childAreaBoundsPx().w),

    catalogPreviewColumnWidthPx: () =>
      props.visualElement.cellSizePx?.w ??
      calcCatalogPreviewColumnWidthPx(pageFns.childAreaBoundsPx().w),

    catalogDividerLeftPx: () =>
      pageFns.catalogContentLeftPx() + pageFns.catalogPreviewColumnWidthPx(),

    catalogRowHeightPx: () =>
      props.visualElement.cellSizePx?.h ??
      calcCatalogRowHeightPx(pageFns.catalogPreviewColumnWidthPx(), pageFns.pageItem().gridCellAspect),

    catalogRowsHeightPx: () => pageFns.catalogRowHeightPx() * (props.visualElement.numRows ?? 0),

    isSearchResultsPage: () => pageFns.pageItem().origin == TEMP_SEARCH_RESULTS_ORIGIN,

    searchResultsSourceItemId: () =>
      pageFns.isSearchResultsPage() ? pageFns.pageItem().parentId : null,

    searchResultsFooterHeightPx: () => {
      const searchSourceItemId = pageFns.searchResultsSourceItemId();
      if (!searchSourceItemId) {
        return 0;
      }
      return calcSearchWorkspaceResultsFooterHeightPx(store.perItem.getSearchHasMoreResults(searchSourceItemId));
    },

    searchResultsFooterTopPx: () =>
      Math.max(0, pageFns.childAreaBoundsPx().h - pageFns.searchResultsFooterHeightPx()),

    searchResultsFooterHostId: () => {
      const searchSourceItemId = pageFns.searchResultsSourceItemId();
      return searchSourceItemId ? searchResultsFooterHostId(searchSourceItemId) : "";
    },

    renderSearchResultsFooterHostMaybe: () =>
      <Show when={pageFns.isSearchResultsPage() && pageFns.searchResultsFooterHeightPx() > 0}>
        <div
          id={pageFns.searchResultsFooterHostId()}
          class="absolute flex justify-center"
          style={`left: 0px; top: ${pageFns.searchResultsFooterTopPx()}px; ` +
            `width: ${pageFns.childAreaBoundsPx().w}px; height: ${pageFns.searchResultsFooterHeightPx()}px; ` +
            `padding-top: ${SEARCH_WORKSPACE_MORE_SECTION_GAP_PX}px;`} />
      </Show>,

    renderSearchSelectionMaybe: () => {
      if (!pageFns.isSearchResultsPage()) {
        return <></>;
      }

      const searchSourceItemId = pageFns.searchResultsSourceItemId();
      if (!searchSourceItemId) {
        return <></>;
      }

      const selectedSearchResultIndex = () => store.perItem.getSearchSelectedResultIndex(searchSourceItemId);
      const searchSelectionStyle = () => {
        const numCols = Math.max(1, pageFns.pageItem().gridNumberOfColumns);
        const selectedIndex = selectedSearchResultIndex();
        const row = Math.floor(selectedIndex / numCols);
        const col = selectedIndex % numCols;
        return `left: ${pageFns.gridPagePaddingPx() + col * props.visualElement.cellSizePx!.w}px; ` +
          `top: ${pageFns.gridPageTopPaddingPx() + row * props.visualElement.cellSizePx!.h}px; ` +
          `width: ${props.visualElement.cellSizePx!.w}px; ` +
          `height: ${props.visualElement.cellSizePx!.h}px; ` +
          `background-color: ${SELECTED_LIGHT}; z-index: 1;`;
      };
      return (
        <Show when={pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid &&
          props.visualElement.cellSizePx &&
          selectedSearchResultIndex() >= 0}>
          <div class="absolute pointer-events-none"
            style={searchSelectionStyle()} />
        </Show>
      );
    },

    renderSearchHoverMaybe: () => {
      if (!pageFns.isSearchResultsPage()) {
        return <></>;
      }

      const hoveredIndex = () => store.perVe.getMoveOverIndex(pageFns.vePath());
      const searchHoverStyle = () => {
        const numCols = Math.max(1, pageFns.pageItem().gridNumberOfColumns);
        const index = hoveredIndex();
        const row = Math.floor(index / numCols);
        const col = index % numCols;
        return `left: ${pageFns.gridPagePaddingPx() + col * props.visualElement.cellSizePx!.w}px; ` +
          `top: ${pageFns.gridPageTopPaddingPx() + row * props.visualElement.cellSizePx!.h}px; ` +
          `width: ${props.visualElement.cellSizePx!.w}px; ` +
          `height: ${props.visualElement.cellSizePx!.h}px; ` +
          `background-color: #00000007; z-index: 3;`;
      };
      return (
        <Show when={pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid &&
          props.visualElement.cellSizePx &&
          hoveredIndex() >= 0 &&
          !store.anItemIsMoving.get()}>
          <div class="absolute pointer-events-none"
            style={searchHoverStyle()} />
        </Show>
      );
    },

    renderCatalogMetadataMaybe: () =>
      <Show when={pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Catalog}>
        <For each={VesCache.render.getChildren(VeFns.veToPath(props.visualElement))()}>{childVeSignal => {
          const childVe = () => childVeSignal.get();
          const searchSourceItemId = () => pageFns.searchResultsSourceItemId();
          const selectedSearchRow = () =>
            searchSourceItemId() ? store.perItem.getSearchSelectedResultIndex(searchSourceItemId()!) : -1;
          const isMouseOverRow = () =>
            store.perVe.getMoveOverRowNumber(pageFns.vePath()) == rowIndex() &&
            !store.anItemIsMoving.get();
          const isSelectedSearchRow = () => selectedSearchRow() == rowIndex();
          const catalogItem = () => childVe().actualLinkItemMaybe ?? childVe().linkItemMaybe ?? childVe().displayItem;
          const searchResultForRow = () => {
            const searchItemId = searchSourceItemId();
            if (!searchItemId) {
              return null;
            }
            const results = store.perItem.getSearchResults(searchItemId);
            if (!results) {
              return null;
            }

            let visibleRow = -1;
            for (const result of results) {
              if (!result.path[result.path.length - 1]?.id) {
                continue;
              }
              visibleRow += 1;
              if (visibleRow == rowIndex()) {
                return result;
              }
            }
            return null;
          };
          const searchResultDisplay = () => {
            const result = searchResultForRow();
            return result ? catalogSearchResultDisplay(result) : null;
          };
          const pathSegments = () => searchResultDisplay()?.pathSegments ?? itemPathSegmentsFromItem(catalogItem());
          const metadataLines = () => {
            const display = searchResultDisplay();
            const lines = display?.stats
              ? catalogChildrenStatsMetadataLines(display.stats)
              : catalogMetadataLines(catalogItem());
            const overallScoreLabel = display?.overallScoreLabel;
            return overallScoreLabel ? [...lines, overallScoreLabel] : lines;
          };
          const fragmentMatches = () => searchResultDisplay()?.fragmentMatches ?? catalogFragmentMatches(catalogItem());
          const visibleFragmentMatches = () => {
            const matches = fragmentMatches();
            if (matches.length == 0) {
              return [];
            }

            const metadataHeightPx = metadataLines().length > 0
              ? CATALOG_DETAIL_SECTION_GAP_PX + catalogDetailLineHeightPx(CATALOG_DETAIL_SUPPORT_FONT_SIZE_PX)
              : 0;
            const availableHeightPx = pageFns.catalogRowHeightPx() - CATALOG_DETAIL_TOP_PADDING_PX;
            let usedHeightPx = catalogDetailLineHeightPx(CATALOG_DETAIL_PATH_FONT_SIZE_PX) + metadataHeightPx;
            const snippetHeightPx =
              CATALOG_DETAIL_SECTION_GAP_PX +
              catalogDetailLineHeightPx(CATALOG_DETAIL_SUPPORT_FONT_SIZE_PX) * CATALOG_SEARCH_SNIPPET_LINE_CLAMP;

            let visibleCount = 0;
            while (visibleCount < matches.length && usedHeightPx + snippetHeightPx <= availableHeightPx) {
              visibleCount += 1;
              usedHeightPx += snippetHeightPx;
            }
            return matches.slice(0, visibleCount);
          };
          const inlineSnippetText = (match: CatalogFragmentMatchDisplay) => {
            const averageCharWidthPx =
              CATALOG_DETAIL_SUPPORT_FONT_SIZE_PX * CATALOG_SEARCH_SNIPPET_AVERAGE_CHAR_WIDTH_EM;
            const pageLabelWidthPx = match.pageLabel
              ? match.pageLabel.length * averageCharWidthPx + 12
              : 0;
            const scoreWidthPx = match.scoreLabel
              ? match.scoreLabel.length * averageCharWidthPx
              : 0;
            const linkWidthPx = match.href
              ? CATALOG_SEARCH_SNIPPET_LINK_GAP_PX + CATALOG_SEARCH_SNIPPET_LINK_SIZE_PX
              : 0;
            const reservedWidthPx =
              pageLabelWidthPx +
              CATALOG_SEARCH_SNIPPET_CONTROL_GAP_PX +
              scoreWidthPx +
              linkWidthPx;
            const maxChars = Math.floor(
              Math.max(0, widthPx() * CATALOG_SEARCH_SNIPPET_LINE_CLAMP - reservedWidthPx) / averageCharWidthPx,
            );
            return clampCatalogSnippetText(match.text, maxChars);
          };
          const rowIndex = () => childVe().row ??
            Math.max(0, Math.round((childVe().boundsPx.y - pageFns.catalogPageTopPaddingPx()) / pageFns.catalogRowHeightPx()));
          const topPx = () => pageFns.catalogPageTopPaddingPx() + rowIndex() * pageFns.catalogRowHeightPx();
          const leftPx = () => pageFns.catalogDividerLeftPx() + CATALOG_DETAIL_COLUMN_PADDING_PX;
          const widthPx = () => Math.max(0, pageFns.catalogContentLeftPx() + pageFns.catalogContentWidthPx() - leftPx() - CATALOG_DETAIL_COLUMN_PADDING_PX);
          return (
            <>
              <Show when={isSelectedSearchRow()}>
                <div class="absolute pointer-events-none"
                  style={`left: ${pageFns.catalogContentLeftPx()}px; top: ${topPx()}px; width: ${pageFns.catalogContentWidthPx()}px; height: ${pageFns.catalogRowHeightPx()}px; ` +
                    `background-color: ${SELECTED_LIGHT};`} />
              </Show>
              <Show when={isMouseOverRow()}>
                <div class="absolute pointer-events-none"
                  style={`left: ${pageFns.catalogContentLeftPx()}px; top: ${topPx()}px; width: ${pageFns.catalogContentWidthPx()}px; height: ${pageFns.catalogRowHeightPx()}px; ` +
                    `background-color: #00000007;`} />
              </Show>
              <div class="absolute flex items-start pointer-events-none"
                style={`left: ${leftPx()}px; top: ${topPx()}px; width: ${widthPx()}px; height: ${pageFns.catalogRowHeightPx()}px; ` +
                  `font-size: ${FONT_SIZE_PX}px; color: #000; padding-top: ${CATALOG_DETAIL_TOP_PADDING_PX}px;`}>
                <div class="min-w-0 w-full flex flex-col gap-[2px]">
                  <div class="min-w-0 pointer-events-auto select-text truncate whitespace-nowrap"
                    style={`cursor: text; font-size: ${CATALOG_DETAIL_PATH_FONT_SIZE_PX}px; line-height: ${CATALOG_DETAIL_LINE_HEIGHT_MULTIPLIER}; user-select: text;`}
                    onMouseDown={stopTextSelectionMouseEvent}
                    onMouseMove={stopTextSelectionMouseEvent}
                    onMouseUp={stopTextSelectionMouseEvent}
                    onClick={stopTextSelectionMouseEvent}>
                    <For each={pathSegments()}>{(segment, idx) =>
                      <Show when={segment.itemType != ItemType.Composite}>
                        <span class="inline-flex items-center">
                          <Show when={idx() != 0}>
                            <span class="mx-2">/</span>
                          </Show>
                          <span>{itemTypeIcon(segment.itemType)}</span>
                          <span class="ml-1">{segment.title}</span>
                        </span>
                      </Show>
                    }</For>
                  </div>
                  <For each={visibleFragmentMatches()}>{match =>
                    <div class="min-w-0 w-full pointer-events-auto select-text text-slate-700"
                      style={`cursor: text; font-size: ${CATALOG_DETAIL_SUPPORT_FONT_SIZE_PX}px; line-height: ${CATALOG_DETAIL_LINE_HEIGHT_MULTIPLIER}; margin-top: ${CATALOG_DETAIL_SECTION_GAP_PX}px; user-select: text;`}
                      onMouseDown={stopTextSelectionMouseEvent}
                      onMouseMove={stopTextSelectionMouseEvent}
                      onMouseUp={stopTextSelectionMouseEvent}
                      onClick={stopTextSelectionMouseEvent}>
                      <Show when={match.pageLabel}>
                        <span style="font-weight: 600; color: #475569; margin-right: 12px;">{match.pageLabel}</span>
                      </Show>
                      <span style="font-style: italic;">{inlineSnippetText(match)}</span>
                      <span style="white-space: nowrap;">
                        <Show when={match.scoreLabel}>
                          <span style={`color: #64748b; font-style: italic; margin-left: ${CATALOG_SEARCH_SNIPPET_CONTROL_GAP_PX}px;`}>{match.scoreLabel}</span>
                        </Show>
                        <Show when={match.href}>
                          <a
                            class="pointer-events-auto"
                            style={`align-items: center; background-color: #fff; border: 1px solid #cbd5e1; border-radius: 3px; color: #2563eb; display: inline-flex; font-size: 12px; font-style: normal; height: ${CATALOG_SEARCH_SNIPPET_LINK_SIZE_PX}px; justify-content: center; line-height: 1; margin-left: ${CATALOG_SEARCH_SNIPPET_LINK_GAP_PX}px; text-decoration: none; vertical-align: -1px; width: ${CATALOG_SEARCH_SNIPPET_LINK_SIZE_PX}px;`}
                            href={match.href ?? ""}
                            target="_blank"
                            rel="noopener"
                            title="Open full fragment"
                            aria-label="Open full fragment"
                            onMouseDown={(ev) => ev.stopPropagation()}
                            onClick={(ev) => ev.stopPropagation()}>
                            ↗
                          </a>
                        </Show>
                      </span>
                    </div>
                  }</For>
                  <Show when={metadataLines().length > 0}>
                    <div class="min-w-0 pointer-events-auto select-text flex items-center gap-[18px] overflow-hidden whitespace-nowrap text-slate-700"
                      style={`cursor: text; font-size: ${CATALOG_DETAIL_SUPPORT_FONT_SIZE_PX}px; line-height: ${CATALOG_DETAIL_LINE_HEIGHT_MULTIPLIER}; margin-top: ${CATALOG_DETAIL_SECTION_GAP_PX}px; user-select: text;`}
                      onMouseDown={stopTextSelectionMouseEvent}
                      onMouseMove={stopTextSelectionMouseEvent}
                      onMouseUp={stopTextSelectionMouseEvent}
                      onClick={stopTextSelectionMouseEvent}>
                      <For each={metadataLines()}>{line =>
                        <span class="shrink-0">{line}</span>
                      }</For>
                    </div>
                  </Show>
                </div>
              </div>
            </>
          );
        }}</For>
      </Show>,

    renderMoveOverAnnotationMaybe: () => {
      if (!store.perVe.getMovingItemIsOver(pageFns.vePath())) {
        return <></>;
      }
      if (store.perVe.getMovingItemIsOver(pageFns.vePath()) &&
        pageFns.pageItem().orderChildrenBy != "" &&
        pageFns.pageItem().arrangeAlgorithm != ArrangeAlgorithm.Document) {
        return pageFns.renderMoveOverSortedMaybe();
      }
      if (store.perVe.getMovingItemIsOver(pageFns.vePath())) {
        return pageFns.renderMoveOverIndexMaybe();
      }
    },

    renderMoveOverSortedMaybe: () => {
      if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.List) {
        const topPx = 0;
        const leftPx = 0;
        const widthPx = props.visualElement.listChildAreaBoundsPx?.w ?? pageFns.listViewportWidthPx();
        const heightPx = props.visualElement.viewportBoundsPx!.h;
        return (
          <div class="absolute pointer-events-none"
            style={`background-color: #0044ff0a; ` +
              `left: ${leftPx}px; top: ${topPx}px; ` +
              `width: ${widthPx}px; height: ${heightPx}px; ` +
              `${VeFns.zIndexStyle(props.visualElement)}`} />
        );
      } else if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid ||
        pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Justified) {
        const heightPx = Math.max(pageFns.childAreaBoundsPx().h, pageFns.boundsPx().h);
        return (
          <div class="absolute pointer-events-none"
            style={`background-color: #0044ff0a; ` +
              `left: ${0}px; top: ${0}px; ` +
              `width: ${pageFns.childAreaBoundsPx().w}px; height: ${heightPx}px; ` +
              `${VeFns.zIndexStyle(props.visualElement)}`} />
        );
      } else if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Catalog) {
        const heightPx = Math.max(pageFns.childAreaBoundsPx().h, pageFns.boundsPx().h);
        return (
          <div class="absolute pointer-events-none"
            style={`background-color: #0044ff0a; ` +
              `left: ${pageFns.catalogContentLeftPx()}px; top: ${0}px; ` +
              `width: ${pageFns.catalogContentWidthPx()}px; height: ${heightPx}px; ` +
              `${VeFns.zIndexStyle(props.visualElement)}`} />
        );
      }
      return <></>;
    },

    renderMoveOverIndexMaybe: () => {
      if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid) {
        const topPx = pageFns.gridPageTopPaddingPx() + props.visualElement.cellSizePx!.h * Math.floor((store.perVe.getMoveOverIndex(pageFns.vePath())) / pageFns.pageItem().gridNumberOfColumns);
        const leftPx = pageFns.gridPagePaddingPx() + props.visualElement.cellSizePx!.w * (store.perVe.getMoveOverIndex(pageFns.vePath()) % pageFns.pageItem().gridNumberOfColumns) + 1;
        const heightPx = props.visualElement.cellSizePx!.h;
        return (
          <div class="absolute border border-black" style={`top: ${topPx}px; left: ${leftPx}px; height: ${heightPx}px; width: 1px;`} />
        );
      } else if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Catalog) {
        const children = pageFns.nonMovingChildren().map(childVe => childVe.get());
        const lineBoundsPx = stackedInsertionLineBoundsPx(children, pageFns.catalogContentWidthPx(), store.perVe.getMoveOverIndex(pageFns.vePath()));
        if (!lineBoundsPx) {
          return <></>;
        }
        if (children.length == 0) {
          lineBoundsPx.y = pageFns.catalogPageTopPaddingPx();
        }
        return (
          <div class="absolute pointer-events-none bg-black"
            style={`left: ${lineBoundsPx.x + pageFns.catalogContentLeftPx()}px; top: ${lineBoundsPx.y - 1}px; width: ${lineBoundsPx.w}px; height: 2px;`} />
        );
      } else if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.List) {
        const lineBoundsPx = pageFns.listMoveOverInsertLineBoundsPx();
        if (!lineBoundsPx) {
          return <></>;
        }
        return (
          <div class="absolute pointer-events-none bg-black"
            style={`left: ${lineBoundsPx.x}px; top: ${lineBoundsPx.y}px; width: ${lineBoundsPx.w}px; height: 1px;`} />
        );
      } else if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Document) {
        const lineBoundsPx = pageFns.documentMoveOverInsertLineBoundsPx();
        if (!lineBoundsPx) {
          return <></>;
        }
        return (
          <div class="absolute pointer-events-none bg-black"
            style={`left: ${lineBoundsPx.x}px; top: ${lineBoundsPx.y - 1}px; width: ${lineBoundsPx.w}px; height: 2px;`} />
        );
      } else if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Justified) {
        return pageFns.renderJustifiedMoveOverHighlight();
      } else if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
        const combinedIndex = store.perVe.getMoveOverIndex(pageFns.vePath());
        const { month, day } = decodeCalendarCombinedIndex(combinedIndex);
        const calendarWindow = calculateCalendarWindowForPage(store, pageFns.vePath(), pageFns.childAreaBoundsPx().w, pageFns.pageItem());
        if (!calendarWindow.months.some((visibleMonth) => visibleMonth.month === month)) {
          return <></>;
        }
        const monthResizeMaybe = calendarWindow.monthsPerPage == 12
          ? store.perVe.getCalendarMonthResize(pageFns.vePath())
          : null;
        const dimensions = calculateCalendarDimensionsForVisualElement(props.visualElement, monthResizeMaybe, calendarWindow);
        const leftPx = getCalendarMonthLeftPx(dimensions, month);
        const widthPx = getCalendarMonthWidthPx(dimensions, month);
        const dayMetrics = getCalendarDayMetrics(dimensions, props.visualElement.calendarMonthLayouts, month, day);
        return (
          <div class="absolute pointer-events-none"
            style={`left: ${leftPx}px; top: ${dayMetrics.topPx}px; width: ${widthPx}px; height: ${dayMetrics.heightPx}px; ` +
              `background-color: #3b82f633; border: 1px solid #3b82f6;`} />
        );
      } else {
        return <></>;
      }
    },

    renderJustifiedMoveOverHighlight: () => {
      const moveOverIndex = store.perVe.getMoveOverIndex(pageFns.vePath());

      const nonMovingChildrenVes = pageFns.nonMovingChildren();

      if (moveOverIndex >= 0 && moveOverIndex <= nonMovingChildrenVes.length) {
        let leftPx: number;
        let topPx: number;
        let heightPx: number;

        if (moveOverIndex === 0) {
          // Inserting at the beginning
          const firstVe = nonMovingChildrenVes[0]?.get();
          if (firstVe) {
            leftPx = firstVe.boundsPx.x - 2;
            topPx = firstVe.boundsPx.y;
            heightPx = firstVe.boundsPx.h;
          } else {
            return <></>;
          }
        } else if (moveOverIndex >= nonMovingChildrenVes.length) {
          // Inserting at the end
          const lastVe = nonMovingChildrenVes[nonMovingChildrenVes.length - 1]?.get();
          if (lastVe) {
            leftPx = lastVe.boundsPx.x + lastVe.boundsPx.w + 2;
            topPx = lastVe.boundsPx.y;
            heightPx = lastVe.boundsPx.h;
          } else {
            return <></>;
          }
        } else {
          // Inserting between elements
          const prevVe = nonMovingChildrenVes[moveOverIndex - 1].get();
          const nextVe = nonMovingChildrenVes[moveOverIndex].get();
          leftPx = (prevVe.boundsPx.x + prevVe.boundsPx.w + nextVe.boundsPx.x) / 2;
          topPx = Math.min(prevVe.boundsPx.y, nextVe.boundsPx.y);
          heightPx = Math.max(prevVe.boundsPx.h, nextVe.boundsPx.h);
        }

        return (
          <div class="absolute border border-black"
            style={`left: ${leftPx}px; top: ${topPx}px; width: 1px; height: ${heightPx}px; ${VeFns.zIndexStyle(props.visualElement)}`} />
        );
      }

      return <></>;
    },
  };

  return (
    <Switch>
      <Match when={props.visualElement.flags & VisualElementFlags.UmbrellaPage}>
        <Page_Umbrella visualElement={props.visualElement} pageFns={pageFns} suppressLocalShadow={props.suppressLocalShadow} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.IsDock}>
        <Page_Dock visualElement={props.visualElement} pageFns={pageFns} suppressLocalShadow={props.suppressLocalShadow} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.IsTrash}>
        <Page_Trash visualElement={props.visualElement} pageFns={pageFns} suppressLocalShadow={props.suppressLocalShadow} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Popup}>
        <Page_Popup visualElement={props.visualElement} pageFns={pageFns} suppressLocalShadow={props.suppressLocalShadow} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.TopLevelRoot ||
        props.visualElement.flags & VisualElementFlags.ListPageRoot}>
        <Page_Root visualElement={props.visualElement} pageFns={pageFns} suppressLocalShadow={props.suppressLocalShadow} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.EmbeddedInteractiveRoot}>
        <Page_EmbeddedInteractive visualElement={props.visualElement} pageFns={pageFns} suppressLocalShadow={props.suppressLocalShadow} />
      </Match>
      <Match when={!(props.visualElement.flags & VisualElementFlags.Detailed) ||
        !(props.visualElement.flags & VisualElementFlags.ShowChildren)}>
        <Page_Opaque visualElement={props.visualElement} pageFns={pageFns} suppressLocalShadow={props.suppressLocalShadow} />
      </Match>
      <Match when={true}>
        <Page_Translucent visualElement={props.visualElement} pageFns={pageFns} suppressLocalShadow={props.suppressLocalShadow} />
      </Match>
    </Switch>
  );
}
