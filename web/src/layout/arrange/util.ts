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

import { Item } from "../../items/base/item";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { MouseAction, MouseActionState } from "../../input/state";
import { LinkFns, LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { EMPTY_UID } from "../../util/uid";
import { initiateLoadItemMaybe, initiateLoadItemFromRemoteMaybe, retryLinkIfVisible, RemoteLoadStatus, itemLoadFromRemoteStatus, linkIdToRemoteInfo, itemLoadLastSessionId } from "../load";
import { RemoteSessions } from "../../store/RemoteSessions";
import { ItemGeometry } from "../item-geometry";
import { BoundingBox } from "../../util/geometry";
import { HitboxFlags, HitboxFns } from "../hitbox";
import { VeFns } from "../visual-element";
import { isQuerySearchResultLink } from "../../items/search-item";
import { LINK_TRIANGLE_SIZE_PX, MIN_DETAILED_CHILD_SCALE } from "../../constants";
import { NoteFlags } from "../../items/base/flags-item";
import { asNoteItem, isNote } from "../../items/note-item";
import { getTextStyleForNote } from "../text";


/**
 * Whether a child of a non-interactive page, drawn at the given scale (relative to natural size), should be drawn in
 * detail (with text) rather than as an outline. Larger text (e.g. headings) remains detailed at smaller scales.
 */
export function previewChildIsDetailed(displayItem: Item, scale: number): boolean {
  const textSizeMultiplier = isNote(displayItem)
    ? getTextStyleForNote(asNoteItem(displayItem).flags).fontSize / getTextStyleForNote(NoteFlags.None).fontSize
    : 1.0;
  return scale * textSizeMultiplier >= MIN_DETAILED_CHILD_SCALE;
}


export interface VePropertiesForItem {
  displayItem: Item,
  linkItemMaybe: LinkItem | null,
  spatialWidthGr: number,
};


/**
 * Given an item, calculate the visual element display item (what is visually depicted), linkItemMaybe and spatialWidthGr.
 */
export function getVePropertiesForItem(store: StoreContextModel, item: Item): VePropertiesForItem {
  let displayItem = item;
  let linkItemMaybe: LinkItem | null = null;
  let spatialWidthGr = isXSizableItem(displayItem)
    ? asXSizableItem(displayItem).spatialWidthGr
    : 0;
  if (!isLink(item)) {
    return { displayItem, linkItemMaybe, spatialWidthGr };
  }

  linkItemMaybe = asLinkItem(item);
  const linkToId = LinkFns.getLinkToId(linkItemMaybe);
  const activeLinkIdMaybe = MouseActionState.getActiveLinkIdMaybe();
  const activeLinkedDisplayItemMaybe = MouseActionState.getActiveLinkedDisplayItemMaybe();
  const displayItemMaybe = itemState.get(linkToId)!;
  if (displayItemMaybe != null) {
    displayItem = displayItemMaybe!;
    if (isXSizableItem(displayItem)) {
      spatialWidthGr = linkItemMaybe.spatialWidthGr;
    }
  } else if (!MouseActionState.empty() && activeLinkIdMaybe === linkItemMaybe.id && activeLinkedDisplayItemMaybe) {
    displayItem = activeLinkedDisplayItemMaybe;
    if (isXSizableItem(displayItem)) {
      spatialWidthGr = linkItemMaybe.spatialWidthGr;
    }
  } else {
    if (linkItemMaybe.linkTo != EMPTY_UID && linkItemMaybe.linkTo != '') {
      if (!linkItemMaybe.linkTo.startsWith("http")) {
        const parentIdToSort = item.parentId;
        initiateLoadItemMaybe(store, linkItemMaybe.linkTo, parentIdToSort);
      } else {
        const lastIdx = linkItemMaybe.linkTo.lastIndexOf('/');
        if (lastIdx != -1) {
          const baseUrl = linkItemMaybe.linkTo.substring(0, lastIdx);
          // baseUrl may not be the base URL of the infumap instance because identifiers
          // in the form {user}/{id} are allowed. however, the server responds to all
          // urls that end in /command (restricted to the user, if specified, else not).
          const id = linkItemMaybe.linkTo.substring(lastIdx + 1);
          const parentIdToSort = item.parentId;
          const remoteInfo = linkIdToRemoteInfo[linkItemMaybe.id];
          if (remoteInfo) {
            const status = itemLoadFromRemoteStatus[remoteInfo.itemId];
            if (status === RemoteLoadStatus.AuthRequired || status === RemoteLoadStatus.Failed) {
              const session = RemoteSessions.get(baseUrl);
              if (session) {
                let sessionId: string | null = null;
                try {
                  const sessionData = JSON.parse(session.sessionDataString);
                  sessionId = sessionData.sessionId;
                } catch (_e) { }

                if (sessionId && itemLoadLastSessionId[remoteInfo.itemId] === sessionId) {
                  return { displayItem, linkItemMaybe, spatialWidthGr };
                }

                initiateLoadItemFromRemoteMaybe(store, remoteInfo.itemId, remoteInfo.baseUrl, linkItemMaybe.id, parentIdToSort, true);
                return { displayItem, linkItemMaybe, spatialWidthGr };
              } else {
                return { displayItem, linkItemMaybe, spatialWidthGr };
              }
            }
          }
          const currentStatus = itemLoadFromRemoteStatus[id];
          if (currentStatus === undefined) {
            initiateLoadItemFromRemoteMaybe(store, id, baseUrl, linkItemMaybe.id, parentIdToSort);
          }
        }
      }
    }
  }

  return { displayItem, linkItemMaybe, spatialWidthGr };
}

export function getMovingTreeItemInParentMaybe(parentId: string): Item | null {
  if (MouseActionState.empty() || !MouseActionState.isAction(MouseAction.Moving)) {
    return null;
  }

  const activeElementPath = MouseActionState.getActiveElementPath();
  const movingItem = activeElementPath != null
    ? VeFns.treeItemFromPath(activeElementPath)
    : (() => {
      const activeVisualElement = MouseActionState.getActiveVisualElement();
      return activeVisualElement ? VeFns.treeItem(activeVisualElement) : null;
    })();

  if (movingItem == null || movingItem.parentId != parentId) {
    return null;
  }

  return movingItem;
}

export function addContiguousStackedGapHitboxes(
  childGeometries: Array<ItemGeometry>,
  bandWidthPx: number,
  focusOnly: boolean = true,
  inertRow: (index: number) => boolean = () => false,
): void {
  // Adjacent bands must claim their shared edges; strict rectangle containment
  // otherwise leaves a seam that falls through to page-background selection.
  for (let i = 0; i < childGeometries.length; ++i) {
    const geometry = childGeometries[i];
    const inert = inertRow(i);
    const prevGeometry = i > 0 ? childGeometries[i - 1] : null;
    const nextGeometry = i + 1 < childGeometries.length ? childGeometries[i + 1] : null;

    const bandTopPx = prevGeometry == null
      ? geometry.boundsPx.y
      : (prevGeometry.boundsPx.y + prevGeometry.boundsPx.h + geometry.boundsPx.y) / 2;
    const bandBottomPx = nextGeometry == null
      ? geometry.boundsPx.y + geometry.boundsPx.h
      : (geometry.boundsPx.y + geometry.boundsPx.h + nextGeometry.boundsPx.y) / 2;

    const gapAboveHeightPx = geometry.boundsPx.y - bandTopPx;
    if (gapAboveHeightPx > 0) {
      geometry.hitboxes.unshift(HitboxFns.create(HitboxFlags.Click, {
        x: -geometry.boundsPx.x,
        y: bandTopPx - geometry.boundsPx.y,
        w: bandWidthPx,
        h: gapAboveHeightPx,
      }, { focusOnly, inert, allowOutsideBounds: true, includeEdges: true }));
    }

    const gapBelowHeightPx = bandBottomPx - (geometry.boundsPx.y + geometry.boundsPx.h);
    if (gapBelowHeightPx > 0) {
      geometry.hitboxes.unshift(HitboxFns.create(HitboxFlags.Click, {
        x: -geometry.boundsPx.x,
        y: geometry.boundsPx.h,
        w: bandWidthPx,
        h: gapBelowHeightPx,
      }, { focusOnly, inert, allowOutsideBounds: true, includeEdges: true }));
    }
  }
}

export function addContiguousStackedRowMarginHitboxes(
  childGeometries: Array<ItemGeometry>,
  bandWidthPx: number,
  focusOnly: boolean = true,
  inertRow: (index: number) => boolean = () => false,
): void {
  for (let i = 0; i < childGeometries.length; ++i) {
    const geometry = childGeometries[i];
    const inert = inertRow(i);

    if (geometry.boundsPx.x > 0) {
      geometry.hitboxes.unshift(HitboxFns.create(HitboxFlags.Click, {
        x: -geometry.boundsPx.x,
        y: 0,
        w: geometry.boundsPx.x,
        h: geometry.boundsPx.h,
      }, { focusOnly, inert, allowOutsideBounds: true, includeEdges: true }));
    }

    const rightMarginWidthPx = bandWidthPx - (geometry.boundsPx.x + geometry.boundsPx.w);
    if (rightMarginWidthPx > 0) {
      geometry.hitboxes.unshift(HitboxFns.create(HitboxFlags.Click, {
        x: geometry.boundsPx.w,
        y: 0,
        w: rightMarginWidthPx,
        h: geometry.boundsPx.h,
      }, { focusOnly, inert, allowOutsideBounds: true, includeEdges: true }));
    }
  }
}

/**
 * Adds the link triangle hitbox to the geometry of an item rendered via a link in a cell based arrangement.
 * Search result links are not real items, so their triangle is not interactive.
 */
export function addLinkTriangleHitboxMaybe(geometry: ItemGeometry, actualLinkItemMaybe: LinkItem | null): void {
  if (actualLinkItemMaybe == null || isQuerySearchResultLink(actualLinkItemMaybe)) { return; }
  geometry.hitboxes.push(HitboxFns.create(HitboxFlags.TriangleLinkSettings, {
    x: 0, y: 0, w: LINK_TRIANGLE_SIZE_PX + 2, h: LINK_TRIANGLE_SIZE_PX + 2,
  }));
}


/**
 * Scales geometry laid out relative to the origin of an area by the given factor, and positions it in that area.
 */
export function scaleGeometry(geometry: ItemGeometry, areaBoundsPx: BoundingBox, scale: number): ItemGeometry {
  const scaleBoundsPx = (b: BoundingBox): BoundingBox => ({
    x: areaBoundsPx.x + b.x * scale,
    y: areaBoundsPx.y + b.y * scale,
    w: b.w * scale,
    h: b.h * scale,
  });
  return {
    ...geometry,
    boundsPx: scaleBoundsPx(geometry.boundsPx),
    viewportBoundsPx: geometry.viewportBoundsPx == null ? null : scaleBoundsPx(geometry.viewportBoundsPx),
    blockSizePx: { w: geometry.blockSizePx.w * scale, h: geometry.blockSizePx.h * scale },
    attachmentBlockSizePx: geometry.attachmentBlockSizePx == null ? undefined : geometry.attachmentBlockSizePx * scale,
    // Hitbox bounds are relative to the item's bounds.
    hitboxes: geometry.hitboxes.map(hitbox => ({
      ...hitbox,
      boundsPx: { x: hitbox.boundsPx.x * scale, y: hitbox.boundsPx.y * scale, w: hitbox.boundsPx.w * scale, h: hitbox.boundsPx.h * scale },
    })),
  };
}
