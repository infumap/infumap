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

// A composite that has grown too big can be put away in a document page in its place, and a document page that has
// become short can be brought back into its parent as a composite. The server decides the details (see
// handle_convert_page_composite); this reconciles the result into the current view.

import { arrangeNow } from "../layout/arrange";
import { initiateLoadChildItemsMaybe, initiateLoadItemMaybe } from "../layout/load";
import { VeFns, VisualElementPath } from "../layout/visual-element";
import { VesCache } from "../layout/ves-cache";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { Uid } from "../util/uid";
import { CompositeItem, asCompositeItem, isComposite } from "./composite-item";
import {
  ContainerConversionRefused, ContainerConversionRejection, applyConvertedItem, containerConversionSource,
  validateConvertedObject,
} from "./container-conversion";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, autoPageAspect, isPage } from "./page-item";

export type PageCompositeConvertibleItem = PageItem | CompositeItem;

export type PageCompositeConversionRejection = ContainerConversionRejection | "not-document-page";

export type PageCompositeConversionEligibility =
  | { allowed: true; source: PageCompositeConvertibleItem; parent: PageItem | null; parentId: Uid; targetType: "page" | "composite" }
  | { allowed: false; reason: PageCompositeConversionRejection };

/**
 * Eligibility for the original item, as displayed in the current toolbar view. Content that prevents a page becoming
 * a composite isn't considered, so that the action is offered and can say why it is refused.
 */
export function pageCompositeConversionEligibility(
  store: StoreContextModel,
  focusPath: VisualElementPath | null,
): PageCompositeConversionEligibility {
  const common = containerConversionSource(store, focusPath, item => isPage(item) || isComposite(item));
  if (!common.allowed) { return common; }
  const source = isPage(common.source) ? asPageItem(common.source) : asCompositeItem(common.source);
  if (isPage(source) && asPageItem(source).arrangeAlgorithm != ArrangeAlgorithm.Document) {
    return { allowed: false, reason: "not-document-page" };
  }
  return { ...common, source, targetType: isPage(source) ? "composite" : "page" };
}

/** Mirrors the server's checks, so the user is told why rather than given a generic failure. */
function pageToCompositeRefusalMaybe(page: PageItem): string | null {
  if (page.computed_attachments.length > 0) { return "can't convert a page with attachments to a composite"; }
  if (page.computed_children.length == 0) { return "can't convert an empty page to a composite"; }
  if (page.computed_children.some(childId => { const child = itemState.get(childId); return child != null && isComposite(child); })) {
    return "can't convert a page that contains composites to a composite";
  }
  return null;
}

/** Convert the original item, then reconcile its authoritative replacement into the current view. */
export async function convertPageCompositeAtPath(
  store: StoreContextModel,
  focusPath: VisualElementPath,
): Promise<PageCompositeConvertibleItem> {
  const eligibility = pageCompositeConversionEligibility(store, focusPath);
  if (!eligibility.allowed) {
    throw new Error(`Page/composite conversion is unavailable: ${eligibility.reason}.`);
  }

  const { source, targetType } = eligibility;
  let parent = eligibility.parent;
  if (parent == null) {
    await initiateLoadItemMaybe(store, eligibility.parentId);
    const rechecked = pageCompositeConversionEligibility(store, focusPath);
    if (!rechecked.allowed || rechecked.parent == null) {
      throw new Error(`Cannot load an editable parent page for item '${source.id}'.`);
    }
    parent = rechecked.parent;
  }
  if (isPage(source)) {
    // A page shown as a box in its parent may not have its children loaded yet.
    await initiateLoadChildItemsMaybe(store, VeFns.veidFromId(source.id));
    const refusal = pageToCompositeRefusalMaybe(asPageItem(itemState.get(source.id)!));
    if (refusal != null) { throw new ContainerConversionRefused(refusal); }
  }

  const { item: convertedObject, removedItemId } = await server.convertPageComposite(
    source.id,
    isPage(source) ? "page" : "composite",
    targetType,
    targetType == "page" ? autoPageAspect(store) : null,
  );
  validateConvertedObject(source, parent, targetType, convertedObject);
  // The composite's heading note became the page's title. It goes first, so the page takes the remaining children.
  if (removedItemId != null && itemState.get(removedItemId) != null) {
    itemState.delete(removedItemId);
  }
  const converted = await applyConvertedItem(store, source, parent, convertedObject);

  // The page box shows only its title, so an untitled page needs one straight away.
  if (isPage(converted) && asPageItem(converted).title.trim() == "") {
    arrangeNow(store, "page-composite-conversion-title");
    const pagePath = store.history.getFocusPathMaybe();
    const pageVe = pagePath == null ? null : VesCache.current.readNode(pagePath);
    if (pageVe != null && pageVe.displayItem.id == converted.id && document.getElementById(pagePath + ":title") != null) {
      PageFns.handleEditTitleClick(pageVe, store);
    }
  }

  return isPage(converted) ? asPageItem(converted) : asCompositeItem(converted);
}
