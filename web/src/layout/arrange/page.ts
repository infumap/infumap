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

import { LINE_HEIGHT_PX } from "../../constants";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem } from "../../items/page-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { panic } from "../../util/lang";
import { VisualElementSignal } from "../../util/signals";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { arrangeItemAttachments } from "./attachments";
import { ArrangeItemFlags, arrangeFlagIsRoot } from "./item";
import { arrange_calendar_page } from "./page_calendar";
import { arrange_catalog_page } from "./page_catalog";
import { arrange_document_page } from "./page_document";
import { arrange_grid_page } from "./page_grid";
import { arrange_justified_page } from "./page_justified";
import { arrange_list_page } from "./page_list";
import { arrange_spatial_page } from "./page_spatial";
import { arrange_table_page } from "./page_table";
import { arrange_single_cell_page } from "./page_singleCell";

export const arrangePageWithChildren = (
  store: StoreContextModel,
  parentPath: VisualElementPath,
  displayItem_pageWithChildren: PageItem,
  linkItemMaybe_pageWithChildren: LinkItem | null,
  actualLinkItemMaybe_pageWithChildren: LinkItem | null,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags): VisualElementSignal => {

  let pageSpec: VisualElementSpec;
  let pageRelationships: VisualElementRelationships;
  let tableRenderRows: Array<number> | null = null;

  const arrangeAlgOverride = linkItemMaybe_pageWithChildren?.overrideArrangeAlgorithm || null;
  const effectiveArrange = arrangeAlgOverride || displayItem_pageWithChildren.arrangeAlgorithm;

  switch (effectiveArrange) {
    case ArrangeAlgorithm.Grid:
      ({ spec: pageSpec, relationships: pageRelationships } = arrange_grid_page(store, parentPath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, actualLinkItemMaybe_pageWithChildren, geometry, flags));
      break;
    case ArrangeAlgorithm.Catalog:
      ({ spec: pageSpec, relationships: pageRelationships } = arrange_catalog_page(store, parentPath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, actualLinkItemMaybe_pageWithChildren, geometry, flags));
      break;
    case ArrangeAlgorithm.Justified:
      ({ spec: pageSpec, relationships: pageRelationships } = arrange_justified_page(store, parentPath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, actualLinkItemMaybe_pageWithChildren, geometry, flags));
      break;
    case ArrangeAlgorithm.Document:
      ({ spec: pageSpec, relationships: pageRelationships } = arrange_document_page(store, parentPath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, actualLinkItemMaybe_pageWithChildren, geometry, flags));
      break;
    case ArrangeAlgorithm.SpatialStretch:
      ({ spec: pageSpec, relationships: pageRelationships } = arrange_spatial_page(store, parentPath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, actualLinkItemMaybe_pageWithChildren, geometry, flags));
      break;
    case ArrangeAlgorithm.List:
      ({ spec: pageSpec, relationships: pageRelationships } = arrange_list_page(store, parentPath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, actualLinkItemMaybe_pageWithChildren, geometry, flags));
      break;
    case ArrangeAlgorithm.Table:
      ({ spec: pageSpec, relationships: pageRelationships, renderRows: tableRenderRows } = arrange_table_page(store, parentPath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, actualLinkItemMaybe_pageWithChildren, geometry, flags));
      break;
    case ArrangeAlgorithm.SingleCell:
      ({ spec: pageSpec, relationships: pageRelationships } = arrange_single_cell_page(store, parentPath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, actualLinkItemMaybe_pageWithChildren, geometry, flags));
      break;
    case ArrangeAlgorithm.Calendar:
      ({ spec: pageSpec, relationships: pageRelationships } = arrange_calendar_page(store, parentPath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, actualLinkItemMaybe_pageWithChildren, geometry, flags));
      break;
    default:
      panic(`arrangePageWithChildren: unknown arrangeAlgorithm: ${displayItem_pageWithChildren.arrangeAlgorithm}.`);
  }

  // The auto-moved-into-view state is keyed by ve path, which is independent of the arrange algorithm,
  // and is only maintained by the spatial arrangement. Clear it for other arrangements so stale state
  // (e.g. after switching a page from spatial to grid) doesn't render as an out-of-bounds warning.
  if (effectiveArrange != ArrangeAlgorithm.SpatialStretch) {
    const childrenPaths = pageRelationships.childrenPaths ?? [];
    for (let i = 0; i < childrenPaths.length; ++i) {
      store.perVe.setAutoMovedIntoView(childrenPaths[i], false);
    }
  }

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const attachmentsLayout = pageAttachmentsLayout(store, flags, effectiveArrange, geometry, pageSpec);
  if (attachmentsLayout != null) {
    const parentItemSizeBl = ItemFns.calcSpatialDimensionsBl(linkItemMaybe_pageWithChildren == null ? displayItem_pageWithChildren : linkItemMaybe_pageWithChildren);
    const attachments = arrangeItemAttachments(store, displayItem_pageWithChildren.computed_attachments, parentItemSizeBl, geometry.viewportBoundsPx!, pageWithChildrenVePath, attachmentsLayout.blockSizePx, attachmentsLayout.anchorRightPx);
    pageRelationships.attachmentsPaths = attachments.paths;
    pageSpec.attachmentsOverflowMarkerPx = attachments.overflowMarkerPx;
    pageSpec.attachmentBlockSizePx = attachmentsLayout.blockSizePx ?? null;
    pageSpec.attachmentAnchorRightPx = attachmentsLayout.anchorRightPx ?? null;
  }

  if (flags & ArrangeItemFlags.InsideCompositeOrDoc) {
    pageSpec.blockSizePx = geometry.blockSizePx;
    if (typeof geometry.row !== "undefined") { pageSpec.row = geometry.row; }
    if (typeof geometry.col !== "undefined") { pageSpec.col = geometry.col; }
  }

  pageSpec.evaluatedTitle = linkItemMaybe_pageWithChildren?.overrideTitle ?? null;
  const pageSignal = VesCache.arrange.writeVisualElementSignal(pageSpec, pageRelationships, pageWithChildrenVePath);
  if (tableRenderRows != null) {
    VesCache.table.setRenderRows(pageWithChildrenVePath, tableRenderRows);
  }
  return pageSignal;
}


/**
 * The block size and right anchor to lay out the attachments of a page with, or null if they are not shown.
 * Undefined values mean the defaults (block size implied by the page's bounds, anchored at its right edge).
 */
function pageAttachmentsLayout(
  store: StoreContextModel,
  flags: ArrangeItemFlags,
  effectiveArrange: ArrangeAlgorithm,
  geometry: ItemGeometry,
  pageSpec: VisualElementSpec): { blockSizePx: number | undefined, anchorRightPx: number | undefined } | null {

  if (!arrangeFlagIsRoot(flags)) {
    return { blockSizePx: geometry.attachmentBlockSizePx, anchorRightPx: geometry.attachmentAnchorRightPx };
  }

  if (flags & ArrangeItemFlags.IsDockRoot) { return null; }

  // A page whose title is shown in the toolbar (the top root, and the selected pages of top level list pages). Its top
  // edge is the bottom of the toolbar. If the toolbar is hidden (e.g. for presentations), attachments are not shown.
  const isTopTitled = !(flags & ArrangeItemFlags.IsPopupRoot) && geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  if (isTopTitled && store.topToolbarHeightPx() == 0) { return null; }

  const blockSizePx = (isTopTitled || (flags & ArrangeItemFlags.IsPopupRoot))
    ? LINE_HEIGHT_PX
    : geometry.attachmentBlockSizePx;

  // The selected item of a list page is shown to the right of the list, so attachments are aligned to the list.
  const anchorRightPx = (effectiveArrange == ArrangeAlgorithm.List && pageSpec.listViewportBoundsPx != null)
    ? pageSpec.listViewportBoundsPx.w
    : geometry.attachmentAnchorRightPx;

  return { blockSizePx, anchorRightPx };
}
