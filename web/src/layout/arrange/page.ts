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

import { LinkItem } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem } from "../../items/page-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { panic } from "../../util/lang";
import { VisualElementSignal } from "../../util/signals";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElementPath, VisualElementSpec } from "../visual-element";
import { arrangeItemAttachments } from "./attachments";
import { ArrangeItemFlags } from "./item";
import { arrange_document_page } from "./page_document";
import { arrange_grid_page } from "./page_grid";
import { arrange_justified_page } from "./page_justified";
import { arrange_list_page } from "./page_list";
import { arrange_spatial_page } from "./page_spatial";


export const arrangePageWithChildren = (
    store: StoreContextModel,
    parentPath: VisualElementPath,
    realParentVeid: Veid | null,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSignal => {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  switch (displayItem_pageWithChildren.arrangeAlgorithm) {
    case ArrangeAlgorithm.Grid:
      pageWithChildrenVisualElementSpec = arrange_grid_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, flags);
      break;
    case ArrangeAlgorithm.Justified:
      pageWithChildrenVisualElementSpec = arrange_justified_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, flags);
      break;
    case ArrangeAlgorithm.Document:
      pageWithChildrenVisualElementSpec = arrange_document_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, flags);
      break;
    case ArrangeAlgorithm.SpatialStretch:
      pageWithChildrenVisualElementSpec = arrange_spatial_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, flags);
      break;
    case ArrangeAlgorithm.List:
      pageWithChildrenVisualElementSpec = arrange_list_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, flags);
      break;
    default:
      panic(`arrangePageWithChildren: unknown arrangeAlgorithm: ${displayItem_pageWithChildren.arrangeAlgorithm}.`);
  }

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const outerBoundsPx = geometry.boundsPx;

  if (!(flags & ArrangeItemFlags.IsRoot)) {
    const attachments = arrangeItemAttachments(store, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, outerBoundsPx, pageWithChildrenVePath);
    pageWithChildrenVisualElementSpec.attachmentsVes = attachments;
  }

  const pageWithChildrenVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(pageWithChildrenVisualElementSpec, pageWithChildrenVePath);
  return pageWithChildrenVisualElementSignal;
}
