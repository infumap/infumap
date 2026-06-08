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

import { LINK_TRIANGLE_SIZE_PX, NATURAL_BLOCK_SIZE_PX, GRID_SIZE, PAGE_DOCUMENT_BOTTOM_PADDING_PX, PAGE_DOCUMENT_LEFT_MARGIN_BL, PAGE_DOCUMENT_RIGHT_MARGIN_BL, PAGE_DOCUMENT_TOP_MARGIN_PX } from "../../constants";
import { NoteFlags, PageFlags, noteHasListStyle, noteIndentLevelFromFlags } from "../../items/base/flags-item";
import { Item, ItemType, Measurable } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { CompositeFns, asCompositeItem, isComposite } from "../../items/composite-item";
import { DividerFns, isDivider } from "../../items/divider-item";
import { LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { NoteFns, asNoteItem, isNote } from "../../items/note-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "../../items/page-item";
import { asTableItem, isTable } from "../../items/table-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { BoundingBox, Dimensions, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { compositeMoveOutHitboxBoundsPx, documentPageMoveOutBoxPx } from "../composite-move-out";
import { HitboxFlags, HitboxFns } from "../hitbox";
import { ItemGeometry } from "../item-geometry";
import { assignFlowListItemNumbers } from "../list-numbering";
import { initiateLoadChildItemsMaybe } from "../load";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItem, arrangeItemPath, getCommonVisualElementFlags } from "./item";
import { movingItemCellBoundsInPagePx } from "./moving";
import { arrangeCellPopupPath } from "./popup";
import { arrangeTable } from "./table";
import { arrangeComposite } from "./composite";
import { addContiguousStackedGapHitboxes, addContiguousStackedRowMarginHitboxes, getMovingTreeItemInParentMaybe, getVePropertiesForItem } from "./util";


const pxToBl = (px: number): number => px / NATURAL_BLOCK_SIZE_PX.h;

const DOCUMENT_GAP_4PX_BL = pxToBl(4);
const DOCUMENT_GAP_8PX_BL = pxToBl(8);
const DOCUMENT_GAP_12PX_BL = pxToBl(12);
const DOCUMENT_GAP_16PX_BL = pxToBl(16);
const DOCUMENT_GAP_24PX_BL = pxToBl(24);
const DOCUMENT_GAP_32PX_BL = pxToBl(32);
const DOCUMENT_PAGE_TITLE_GAP_BL = DOCUMENT_GAP_24PX_BL;

function noteHeadingLevel(item: Item): number | null {
  if (!isNote(item)) { return null; }
  const flags = asNoteItem(item).flags;
  if (flags & NoteFlags.Heading1) { return 1; }
  if (flags & NoteFlags.Heading2) { return 2; }
  if (flags & NoteFlags.Heading3) { return 3; }
  if (flags & NoteFlags.Heading4) { return 4; }
  return null;
}

function noteIsListItem(item: Item): boolean {
  return isNote(item) && noteHasListStyle(asNoteItem(item).flags);
}

function noteIsCode(item: Item): boolean {
  return isNote(item) && !!(asNoteItem(item).flags & NoteFlags.Code);
}

function sameListRun(prev: Item, next: Item): boolean {
  if (!noteIsListItem(prev) || !noteIsListItem(next)) { return false; }
  return noteIndentLevelFromFlags(asNoteItem(prev).flags) == noteIndentLevelFromFlags(asNoteItem(next).flags);
}

function gapBeforeHeadingBl(level: number): number {
  if (level == 1) { return DOCUMENT_GAP_32PX_BL; }
  if (level == 2) { return DOCUMENT_GAP_24PX_BL; }
  if (level == 3) { return DOCUMENT_GAP_16PX_BL; }
  return DOCUMENT_GAP_12PX_BL;
}

function gapAfterHeadingBl(level: number, next: Item): number {
  if (isTable(next)) { return DOCUMENT_GAP_12PX_BL; }
  return level <= 2 ? DOCUMENT_GAP_12PX_BL : DOCUMENT_GAP_8PX_BL;
}

function itemIsLargeDocumentObject(item: Item): boolean {
  return item.itemType == ItemType.Image ||
    item.itemType == ItemType.Page ||
    item.itemType == ItemType.Composite;
}

function itemIsCompactDocumentRow(item: Item): boolean {
  return item.itemType == ItemType.File ||
    item.itemType == ItemType.Text ||
    item.itemType == ItemType.Password ||
    item.itemType == ItemType.Rating ||
    item.itemType == ItemType.Search;
}

function documentGapBetweenBl(prev: Item, next: Item): number {
  const nextHeadingLevel = noteHeadingLevel(next);
  if (nextHeadingLevel != null) { return gapBeforeHeadingBl(nextHeadingLevel); }

  const prevHeadingLevel = noteHeadingLevel(prev);
  if (prevHeadingLevel != null) { return gapAfterHeadingBl(prevHeadingLevel, next); }

  if (sameListRun(prev, next)) { return DOCUMENT_GAP_4PX_BL; }
  if (noteIsListItem(prev) && noteIsListItem(next)) { return DOCUMENT_GAP_8PX_BL; }
  if (noteIsListItem(prev) || noteIsListItem(next)) { return DOCUMENT_GAP_16PX_BL; }

  if (noteIsCode(prev) || noteIsCode(next)) { return DOCUMENT_GAP_16PX_BL; }
  if (isTable(prev) || isTable(next)) { return DOCUMENT_GAP_24PX_BL; }
  if (isDivider(prev) || isDivider(next)) { return DOCUMENT_GAP_16PX_BL; }
  if (itemIsLargeDocumentObject(prev) || itemIsLargeDocumentObject(next)) { return DOCUMENT_GAP_24PX_BL; }
  if (itemIsCompactDocumentRow(prev) || itemIsCompactDocumentRow(next)) { return DOCUMENT_GAP_12PX_BL; }

  return DOCUMENT_GAP_16PX_BL;
}


export function arrange_document_page(
  store: StoreContextModel,
  parentPath: VisualElementPath,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  actualLinkItemMaybe_pageWithChildren: LinkItem | null,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags): { spec: VisualElementSpec, relationships: VisualElementRelationships } {

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : actualLinkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const parentIsPopup = flags & ArrangeItemFlags.IsPopupRoot;

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  if (isFull) {
    VesCache.titles.pushTopTitledPage(pageWithChildrenVePath);
  }

  const movingItemInThisPage = getMovingTreeItemInParentMaybe(displayItem_pageWithChildren.id);

  const totalMarginBl = PAGE_DOCUMENT_LEFT_MARGIN_BL + PAGE_DOCUMENT_RIGHT_MARGIN_BL;
  const totalWidthBl = displayItem_pageWithChildren.docWidthBl + totalMarginBl;
  const requiredWidthPx = totalWidthBl * NATURAL_BLOCK_SIZE_PX.w;
  let scale = geometry.boundsPx.w / requiredWidthPx;
  if (scale > 1.0) { scale = 1.0; }
  const blockSizePx = { w: NATURAL_BLOCK_SIZE_PX.w * scale, h: NATURAL_BLOCK_SIZE_PX.h * scale };
  const documentWidthPx = totalWidthBl * blockSizePx.w;

  const childrenPaths: Array<VisualElementPath> = [];
  const childArrangeData: Array<{
    childItem: Item,
    displayItem: Item,
    actualLinkItemMaybe: LinkItem | null,
    geometry: ItemGeometry,
    displayWidthBl: number,
    childItemIsEmbeddedInteractive: boolean,
  }> = [];
  const documentChildren: Array<{
    childItem: Item,
    displayItem: Item,
    linkItemMaybe: LinkItem | null,
    actualLinkItemMaybe: LinkItem | null,
    displayWidthBl: number,
    childItemIsEmbeddedInteractive: boolean,
  }> = [];

  let topPx = PAGE_DOCUMENT_TOP_MARGIN_PX * scale;
  for (let idx = 0; idx < displayItem_pageWithChildren.computed_children.length; ++idx) {
    const childId = displayItem_pageWithChildren.computed_children[idx];
    const childItem = itemState.get(childId)!;
    if (movingItemInThisPage && childItem.id == movingItemInThisPage.id) {
      continue;
    }
    const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;

    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);

    const documentContentWidthBl = totalWidthBl - totalMarginBl;
    const displayWidthBl = documentChildDisplayWidthBl(displayItem_childItem, linkItemMaybe_childItem, documentContentWidthBl);
    documentChildren.push({
      childItem,
      displayItem: displayItem_childItem,
      linkItemMaybe: linkItemMaybe_childItem,
      actualLinkItemMaybe,
      displayWidthBl,
      childItemIsEmbeddedInteractive: !!(isPage(childItem) && (asPageItem(childItem).flags & PageFlags.EmbeddedInteractive)),
    });
  }

  if (PageFns.showDocumentTitleInDocument(displayItem_pageWithChildren)) {
    topPx += PageFns.calcDocumentTitleHeightBl(displayItem_pageWithChildren) * blockSizePx.h;
    if (documentChildren.length > 0) {
      topPx += DOCUMENT_PAGE_TITLE_GAP_BL * blockSizePx.h;
    }
  }

  let displayIdx = 0;
  for (let idx = 0; idx < documentChildren.length; ++idx) {
    const child = documentChildren[idx];
    const geometry = calcDocumentChildGeometry(
      store,
      child.displayItem,
      child.linkItemMaybe,
      child.displayWidthBl,
      blockSizePx,
      PAGE_DOCUMENT_LEFT_MARGIN_BL,
      topPx,
      store.smallScreenMode());
    if (isPage(child.displayItem)) {
      geometry.hitboxes.push(HitboxFns.create(HitboxFlags.Move, zeroBoundingBoxTopLeft(geometry.boundsPx)));
    }
    if (isDivider(child.displayItem)) {
      geometry.hitboxes = geometry.hitboxes.filter(hitbox => !(hitbox.type & HitboxFlags.Resize));
      geometry.hitboxes.push(HitboxFns.create(HitboxFlags.Move, zeroBoundingBoxTopLeft(geometry.boundsPx)));
    }
    alignDocumentMoveOutHitbox(geometry, blockSizePx, displayItem_pageWithChildren.docWidthBl);
    const documentChildGeometry: ItemGeometry = {
      ...geometry,
      row: displayIdx,
      col: 0,
    };
    displayIdx += 1;

    childArrangeData.push({
      childItem: child.childItem,
      displayItem: child.displayItem,
      actualLinkItemMaybe: child.actualLinkItemMaybe,
      geometry: documentChildGeometry,
      displayWidthBl: child.displayWidthBl,
      childItemIsEmbeddedInteractive: child.childItemIsEmbeddedInteractive,
    });

    topPx += geometry.boundsPx.h;
    if (idx < documentChildren.length - 1) {
      topPx += documentGapBetweenBl(child.displayItem, documentChildren[idx + 1].displayItem) * blockSizePx.h;
    }
  }

  assignFlowListItemNumbers(childArrangeData.map(child => ({
    displayItem: child.displayItem,
    geometry: child.geometry,
  })));
  addContiguousStackedRowMarginHitboxes(childArrangeData.map(child => child.geometry), documentWidthPx, false);
  addContiguousStackedGapHitboxes(childArrangeData.map(child => child.geometry), documentWidthPx, false);

  const renderChildrenAsFull = flags & ArrangeItemFlags.IsPopupRoot || arrangeFlagIsRoot(flags);
  for (const child of childArrangeData) {
    childrenPaths.push(arrangeDocumentChildItemPath(
      store,
      pageWithChildrenVePath,
      child.childItem,
      child.actualLinkItemMaybe,
      child.geometry,
      child.displayWidthBl,
      (renderChildrenAsFull ? ArrangeItemFlags.RenderChildrenAsFull : ArrangeItemFlags.None) |
      ArrangeItemFlags.InsideCompositeOrDoc |
      (child.childItemIsEmbeddedInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
      (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None)));
  }

  const movingItemReservedHeightPx = movingItemInThisPage == null
    ? 0
    : calcMovingItemReservedHeightPx(store, movingItemInThisPage, displayItem_pageWithChildren.docWidthBl, blockSizePx);
  const childAreaBoundsPx = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.boundsPx)!);
  childAreaBoundsPx.w = documentWidthPx;
  const chatComposerBottomPaddingPx = displayItem_pageWithChildren.flags & PageFlags.Chat ? 96 : 0;
  childAreaBoundsPx.h = topPx + movingItemReservedHeightPx + PAGE_DOCUMENT_BOTTOM_PADDING_PX + chatComposerBottomPaddingPx;

  if (movingItemInThisPage) {
    const movingVes = arrangeMovingItemInDocument(
      store,
      movingItemInThisPage,
      displayItem_pageWithChildren,
      linkItemMaybe_pageWithChildren,
      pageWithChildrenVePath,
      geometry,
      childAreaBoundsPx,
      blockSizePx,
      flags,
      parentIsPopup,
    );
    childrenPaths.push(VeFns.veToPath(movingVes.get()));
  }

  const isEmbeddedInteractive =
    !!(displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) &&
    (VeFns.pathDepth(parentPath) >= 2) &&
    !(flags & ArrangeItemFlags.IsTopRoot) &&
    !(flags & ArrangeItemFlags.IsPopupRoot) &&
    !(flags & ArrangeItemFlags.IsListPageMainRoot);

  const highlightedPath = store.find.highlightedPath.get();
  const isHighlighted = highlightedPath !== null && highlightedPath === pageWithChildrenVePath;
  const isSelectionHighlighted = (() => {
    const sel = store.overlay.selectedVeids.get();
    if (!sel || sel.length === 0) { return false; }
    const veid = VeFns.veidFromItems(displayItem_pageWithChildren, actualLinkItemMaybe_pageWithChildren);
    for (let i = 0; i < sel.length; ++i) {
      if (sel[i].itemId === veid.itemId && sel[i].linkIdMaybe === veid.linkIdMaybe) { return true; }
    }
    return false;
  })();

  const pageSpec: VisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    actualLinkItemMaybe: actualLinkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
      getCommonVisualElementFlags(flags) |
      (flags & ArrangeItemFlags.IsPopupRoot && store.history.getFocusItem().id == pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
      (isHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None) |
      (isSelectionHighlighted ? VisualElementFlags.SelectionHighlighted : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: geometry.viewportBoundsPx!,
    hitboxes: geometry.hitboxes,
    childAreaBoundsPx,
    parentPath,
  };

  const pageRelationships: VisualElementRelationships = {
    childrenPaths,
  };

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageRelationships.popupPath = arrangeCellPopupPath(store);
    }
  }

  return { spec: pageSpec, relationships: pageRelationships };
}

function documentChildDisplayWidthBl(
  displayItem: Item,
  linkItemMaybe: LinkItem | null,
  documentContentWidthBl: number,
): number {
  if (!isTable(displayItem)) {
    return documentContentWidthBl;
  }

  const persistedWidthBl = (linkItemMaybe?.spatialWidthGr ?? asTableItem(displayItem).spatialWidthGr) / GRID_SIZE;
  return Math.max(1, Math.min(persistedWidthBl, documentContentWidthBl));
}

function documentChildMeasurableForGeometry(
  displayItem: Item,
  linkItemMaybe: LinkItem | null,
  displayWidthBl: number,
): Measurable {
  if (isDivider(displayItem)) {
    if (linkItemMaybe != null) {
      const clonedLink: LinkItem = {
        ...linkItemMaybe,
        spatialHeightGr: GRID_SIZE,
      };
      return clonedLink;
    }
    const clonedDivider = DividerFns.asDividerMeasurable(ItemFns.cloneMeasurableFields(displayItem));
    clonedDivider.spatialHeightGr = GRID_SIZE;
    return clonedDivider;
  }

  if (!isTable(displayItem)) {
    if (isComposite(displayItem)) {
      const clonedComposite = CompositeFns.asCompositeMeasurable(ItemFns.cloneMeasurableFields(displayItem));
      clonedComposite.spatialWidthGr = displayWidthBl * GRID_SIZE;
      return clonedComposite;
    }
    return linkItemMaybe ? linkItemMaybe : displayItem;
  }

  const spatialWidthGr = displayWidthBl * GRID_SIZE;
  if (linkItemMaybe != null) {
    const clonedLink: LinkItem = {
      ...linkItemMaybe,
      spatialWidthGr,
    };
    return clonedLink;
  }

  const clonedTable = asTableItem(ItemFns.cloneMeasurableFields(asTableItem(displayItem)));
  clonedTable.spatialWidthGr = spatialWidthGr;
  return clonedTable;
}

function calcDocumentChildGeometry(
  store: StoreContextModel,
  displayItem: Item,
  linkItemMaybe: LinkItem | null,
  displayWidthBl: number,
  blockSizePx: Dimensions,
  leftMarginBl: number,
  topPx: number,
  smallScreenMode: boolean,
): ItemGeometry {
  if (isNote(displayItem)) {
    const geometry = NoteFns.calcGeometry_InDocument(asNoteItem(displayItem), blockSizePx, displayWidthBl, leftMarginBl, topPx);
    if (linkItemMaybe != null) {
      geometry.hitboxes.push(HitboxFns.create(HitboxFlags.TriangleLinkSettings, {
        x: 0,
        y: 0,
        w: LINK_TRIANGLE_SIZE_PX + 2,
        h: LINK_TRIANGLE_SIZE_PX + 2,
      }));
    }
    return geometry;
  }

  if (isComposite(displayItem)) {
    const compositeIsCollapsed = store.perItem.getCompositeIsCollapsed(VeFns.veidFromItems(displayItem, linkItemMaybe));
    return CompositeFns.calcGeometry_InDocument(asCompositeItem(displayItem), blockSizePx, displayWidthBl, leftMarginBl, topPx, compositeIsCollapsed);
  }

  return ItemFns.calcGeometry_InComposite(
    documentChildMeasurableForGeometry(displayItem, linkItemMaybe, displayWidthBl),
    blockSizePx,
    displayWidthBl,
    leftMarginBl,
    topPx,
    smallScreenMode);
}

function calcDocumentChildSizeBl(store: StoreContextModel, displayItem: Item, linkItemMaybe: LinkItem | null, displayWidthBl: number): Dimensions {
  if (isNote(displayItem)) {
    const cloned = NoteFns.asNoteMeasurable(ItemFns.cloneMeasurableFields(displayItem));
    cloned.spatialWidthGr = displayWidthBl * GRID_SIZE;
    return NoteFns.calcDocumentSpatialDimensionsBl(cloned);
  }
  if (isComposite(displayItem)) {
    const cloned = CompositeFns.asCompositeMeasurable(ItemFns.cloneMeasurableFields(displayItem));
    cloned.spatialWidthGr = displayWidthBl * GRID_SIZE;
    const compositeIsCollapsed = store.perItem.getCompositeIsCollapsed(VeFns.veidFromItems(displayItem, linkItemMaybe));
    return CompositeFns.calcSpatialDimensionsBl(cloned, compositeIsCollapsed);
  }
  return ItemFns.calcSpatialDimensionsBl(documentChildMeasurableForGeometry(displayItem, linkItemMaybe, displayWidthBl));
}

function calcMovingItemReservedHeightPx(
  store: StoreContextModel,
  movingItem: Item,
  documentContentWidthBl: number,
  blockSizePx: Dimensions,
): number {
  const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, movingItem);
  const displayWidthBl = documentChildDisplayWidthBl(displayItem, linkItemMaybe, documentContentWidthBl);
  const dimensionsBl = calcDocumentChildSizeBl(store, displayItem, linkItemMaybe, displayWidthBl);
  return (dimensionsBl.h + DOCUMENT_GAP_16PX_BL) * blockSizePx.h;
}

function alignDocumentMoveOutHitbox(
  geometry: ItemGeometry,
  blockSizePx: { w: number, h: number },
  documentContentWidthBl: number,
): void {
  const moveHitbox = geometry.hitboxes.find(hitbox => hitbox.meta?.compositeMoveOut);
  if (moveHitbox == null) {
    return;
  }

  const moveAreaBoundsPx = documentPageMoveOutBoxPx(
    geometry.boundsPx,
    blockSizePx,
    documentContentWidthBl,
    PAGE_DOCUMENT_LEFT_MARGIN_BL,
  );
  moveHitbox.boundsPx = compositeMoveOutHitboxBoundsPx(moveAreaBoundsPx, Number(PAGE_DOCUMENT_LEFT_MARGIN_BL) == 0 ? 2 : 0);
  moveHitbox.meta = {
    ...(moveHitbox.meta ?? {}),
    compositeMoveOut: true,
    allowOutsideBounds: true,
  };
}

function arrangeDocumentChildItemPath(
  store: StoreContextModel,
  parentPath: VisualElementPath,
  childItem: Item,
  actualLinkItemMaybe: LinkItem | null,
  geometry: ItemGeometry,
  displayWidthBl: number,
  flags: ArrangeItemFlags): VisualElementPath {

  const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);
  const shouldRenderTableChildren =
    childItem.parentId == store.history.currentPageVeid()?.itemId ||
    !!(flags & ArrangeItemFlags.RenderChildrenAsFull);
  if (isTable(displayItem) && shouldRenderTableChildren) {
    initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
    return VeFns.veToPath(arrangeTable(
      store,
      parentPath,
      asTableItem(displayItem),
      linkItemMaybe,
      actualLinkItemMaybe,
      geometry,
      flags,
      displayWidthBl).get());
  }

  if (isComposite(displayItem)) {
    initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
    return VeFns.veToPath(arrangeComposite(
      store,
      parentPath,
      asCompositeItem(displayItem),
      linkItemMaybe,
      actualLinkItemMaybe,
      geometry,
      flags,
      displayWidthBl).get());
  }

  return arrangeItemPath(
    store,
    parentPath,
    ArrangeAlgorithm.Document,
    childItem,
    actualLinkItemMaybe,
    geometry,
    flags);
}

function arrangeMovingItemInDocument(
  store: StoreContextModel,
  movingItem: Item,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  pageWithChildrenVePath: VisualElementPath,
  geometry: ItemGeometry,
  childAreaBoundsPx: BoundingBox,
  blockSizePx: { w: number, h: number },
  flags: ArrangeItemFlags,
  parentIsPopup: number,
) {
  const actualMovingItemLinkItemMaybe = isLink(movingItem) ? asLinkItem(movingItem) : null;

  const pageVeid = flags & ArrangeItemFlags.IsPopupRoot
    ? store.history.currentPopupSpec()!.actualVeid
    : VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);

  const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItem);
  const documentContentLeftPx = Math.max((geometry.viewportBoundsPx!.w - childAreaBoundsPx.w) / 2, 0);
  const cellBoundsPx = movingItemCellBoundsInPagePx(
    store,
    pageWithChildrenVePath,
    geometry,
    childAreaBoundsPx,
    pageVeid,
    {
      w: dimensionsBl.w * blockSizePx.w,
      h: dimensionsBl.h * blockSizePx.h,
    },
    flags,
    documentContentLeftPx,
  );

  const cellGeometry = ItemFns.calcGeometry_InCell(
    movingItem,
    cellBoundsPx,
    false,
    !!(flags & ArrangeItemFlags.ParentIsPopup),
    false,
    false,
    false,
    false,
    false,
    false,
    store.smallScreenMode(),
  );

  return arrangeItem(
    store,
    pageWithChildrenVePath,
    ArrangeAlgorithm.Grid,
    movingItem,
    actualMovingItemLinkItemMaybe,
    cellGeometry,
    ArrangeItemFlags.RenderChildrenAsFull |
    (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None),
  );
}
