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

import { PageFlags } from "../../items/base/flags-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { FlipCardFns, FlipCardItem } from "../../items/flipcard-item";
import { asLinkItem, isLink, LinkItem } from "../../items/link-item";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { VisualElementSignal } from "../../util/signals";
import { ItemGeometry } from "../item-geometry";
import { initiateLoadChildItemsMaybe } from "../load";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { arrangeItemAttachments } from "./attachments";
import { arrangeItem, ArrangeItemFlags } from "./item";


export const arrangeFlipCard = (
  store: StoreContextModel,
  parentPath: VisualElementPath,
  displayItem_flipCard: FlipCardItem,
  linkItemMaybe_flipCard: LinkItem | null,
  actualLinkItemMaybe_flipCard: LinkItem | null,
  geometry: ItemGeometry,
  flags: ArrangeItemFlags): VisualElementSignal => {
  let flipCardVisualElementSpec: VisualElementSpec & VisualElementRelationships;

  const flipCardVeid = VeFns.veidFromItems(displayItem_flipCard, linkItemMaybe_flipCard ? linkItemMaybe_flipCard : actualLinkItemMaybe_flipCard);
  const flipCardVePath = VeFns.addVeidToPath(flipCardVeid, parentPath);

  const childAreaBoundsPx = zeroBoundingBoxTopLeft(cloneBoundingBox(geometry.viewportBoundsPx)!);

  flipCardVisualElementSpec = {
    displayItem: displayItem_flipCard,
    linkItemMaybe: linkItemMaybe_flipCard,
    actualLinkItemMaybe: actualLinkItemMaybe_flipCard,
    flags: (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: geometry.viewportBoundsPx!,
    hitboxes: geometry.hitboxes,
    childAreaBoundsPx,
    parentPath,
  };

  if (displayItem_flipCard.computed_children.length == 2) {
    const side = store.perItem.getFlipCardVisibleSide(flipCardVeid);
    const visiblePageId = displayItem_flipCard.computed_children[side];
    const visiblePageVeid = { itemId: visiblePageId, linkIdMaybe: null };
    initiateLoadChildItemsMaybe(store, visiblePageVeid);
    const visiblePage = asPageItem(itemState.get(visiblePageId)!);
    const visiblePagePath = VeFns.addVeidToPath(visiblePageVeid, flipCardVePath);

    const pageBoundsPx = zeroBoundingBoxTopLeft(geometry.viewportBoundsPx!);

    let pageVisualElementSpec: VisualElementSpec & VisualElementRelationships = {
      displayItem: visiblePage,
      linkItemMaybe: null,
      actualLinkItemMaybe: null,
      flags: VisualElementFlags.FlipCardPage | VisualElementFlags.ShowChildren,
      _arrangeFlags_useForPartialRearrangeOnly: flags,
      boundsPx: pageBoundsPx,
      viewportBoundsPx: pageBoundsPx,
      hitboxes: [],
      childAreaBoundsPx,
      parentPath: flipCardVePath,
    };

    const childrenVes = [];
    for (let i = 0; i < visiblePage.computed_children.length; ++i) {
      const childId = visiblePage.computed_children[i];
      const childItem = itemState.get(childId)!;
      const actualLinkItemMaybe = isLink(childItem) ? asLinkItem(childItem) : null;
      const emitHitboxes = true;
      const childItemIsPopup = false; // never the case.
      const childItemIsEmbeddedInteractive = isPage(childItem) && asPageItem(childItem).flags & PageFlags.EmbeddedInteractive;
      const hasChildChanges = false; // it may do, but only matters for popups.
      const hasDefaultChanges = false;
      const parentPageInnerDimensionsBl = FlipCardFns.calcInnerSpatialDimensionsBl(displayItem_flipCard);
      parentPageInnerDimensionsBl.w = Math.round(parentPageInnerDimensionsBl.w / displayItem_flipCard.scale);
      parentPageInnerDimensionsBl.h = Math.round(parentPageInnerDimensionsBl.h / displayItem_flipCard.scale);
      const itemGeometry = ItemFns.calcGeometry_Spatial(
        childItem,
        zeroBoundingBoxTopLeft(flipCardVisualElementSpec.childAreaBoundsPx!),
        parentPageInnerDimensionsBl,
        false,
        emitHitboxes,
        childItemIsPopup,
        hasChildChanges,
        hasDefaultChanges,
        store.perVe.getFlipCardIsEditing(VeFns.addVeidToPath(VeFns.veidFromItems(childItem, actualLinkItemMaybe), visiblePagePath)),
        store.smallScreenMode(),
      );
      const ves = arrangeItem(
        store, visiblePagePath, ArrangeAlgorithm.SpatialStretch, childItem, actualLinkItemMaybe, itemGeometry,
        ArrangeItemFlags.RenderChildrenAsFull |
        (childItemIsEmbeddedInteractive ? ArrangeItemFlags.IsEmbeddedInteractiveRoot : ArrangeItemFlags.None) |
        (childItemIsPopup ? ArrangeItemFlags.IsPopupRoot : ArrangeItemFlags.None));
      childrenVes.push(ves);
    }
    pageVisualElementSpec.childrenVes = childrenVes;
    const pageVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(pageVisualElementSpec, visiblePagePath);
    flipCardVisualElementSpec.childrenVes = [pageVisualElementSignal];

  } else if (displayItem_flipCard.computed_children.length != 0) {
    console.warn(`expected flipcard item ${displayItem_flipCard.computed_children.length} to have 2 or 0 children`);
  }

  const parentItemSizeBl = ItemFns.calcSpatialDimensionsBl(linkItemMaybe_flipCard == null ? displayItem_flipCard : linkItemMaybe_flipCard);
  const attachments = arrangeItemAttachments(store, displayItem_flipCard.computed_attachments, parentItemSizeBl, geometry.viewportBoundsPx!, flipCardVePath);
  flipCardVisualElementSpec.attachmentsVes = attachments;

  const flipCardVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(flipCardVisualElementSpec, flipCardVePath);
  return flipCardVisualElementSignal;
}
