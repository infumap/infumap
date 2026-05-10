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

import { Hitbox, hitboxFlagsToString } from "../layout/hitbox";
import { VeFns, VisualElement } from "../layout/visual-element";
import { asNoteItem, isNote } from "../items/note-item";
import { asPageItem, isPage } from "../items/page-item";
import { asPositionalItem, isPositionalItem } from "../items/base/positional-item";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asLinkItem, isLink } from "../items/link-item";
import { Item } from "../items/base/item";
import { NoteFlags } from "../items/base/flags-item";
import { GRID_SIZE } from "../constants";


export function resizeDebugLog(event: string, details: Record<string, unknown>): void {
  console.debug(`[resize-debug] ${event}`, {
    at: new Date().toISOString(),
    ...details,
  });
}

export function resizeDebugItem(item: Item | null | undefined): Record<string, unknown> | null {
  if (!item) { return null; }
  const result: Record<string, unknown> = {
    id: item.id,
    itemType: item.itemType,
    parentId: item.parentId,
    relationshipToParent: item.relationshipToParent,
    origin: item.origin,
  };
  if (isPositionalItem(item)) {
    result.spatialPositionGr = { ...asPositionalItem(item).spatialPositionGr };
  }
  if (isXSizableItem(item)) {
    result.spatialWidthGr = asXSizableItem(item).spatialWidthGr;
    result.spatialWidthBl = asXSizableItem(item).spatialWidthGr / GRID_SIZE;
  }
  if (isYSizableItem(item)) {
    result.spatialHeightGr = asYSizableItem(item).spatialHeightGr;
    result.spatialHeightBl = asYSizableItem(item).spatialHeightGr / GRID_SIZE;
  }
  if (isNote(item)) {
    result.noteFlags = asNoteItem(item).flags;
    result.noteExplicitHeight = !!(asNoteItem(item).flags & NoteFlags.ExplicitHeight);
    result.noteSpatialHeightGr = asNoteItem(item).spatialHeightGr;
    result.noteSpatialHeightBl = asNoteItem(item).spatialHeightGr / GRID_SIZE;
  }
  if (isLink(item)) {
    result.linkTo = asLinkItem(item).linkTo;
    result.linkToResolvedId = asLinkItem(item).linkToResolvedId;
    result.linkSpatialWidthGr = asLinkItem(item).spatialWidthGr;
    result.linkSpatialHeightGr = asLinkItem(item).spatialHeightGr;
  }
  if (isPage(item)) {
    result.arrangeAlgorithm = asPageItem(item).arrangeAlgorithm;
    result.innerSpatialWidthGr = asPageItem(item).innerSpatialWidthGr;
    result.naturalAspect = asPageItem(item).naturalAspect;
    result.docWidthBl = asPageItem(item).docWidthBl;
  }
  return result;
}

export function resizeDebugVisualElement(ve: VisualElement | null | undefined): Record<string, unknown> | null {
  if (!ve) { return null; }
  let path: string | null = null;
  try {
    path = VeFns.veToPath(ve);
  } catch (_e) {
    path = "[veToPath failed]";
  }
  return {
    path,
    flags: ve.flags,
    parentPath: ve.parentPath,
    displayItem: resizeDebugItem(ve.displayItem),
    treeItem: resizeDebugItem(VeFns.treeItem(ve)),
    linkItemMaybe: resizeDebugItem(ve.linkItemMaybe),
    actualLinkItemMaybe: resizeDebugItem(ve.actualLinkItemMaybe),
    boundsPx: { ...ve.boundsPx },
    viewportBoundsPx: ve.viewportBoundsPx ? { ...ve.viewportBoundsPx } : null,
    childAreaBoundsPx: ve.childAreaBoundsPx ? { ...ve.childAreaBoundsPx } : null,
    blockSizePx: ve.blockSizePx ? { ...ve.blockSizePx } : null,
    hitboxes: ve.hitboxes.map(resizeDebugHitbox),
  };
}

export function resizeDebugHitbox(hitbox: Hitbox): Record<string, unknown> {
  return {
    type: hitbox.type,
    typeString: hitboxFlagsToString(hitbox.type),
    boundsPx: { ...hitbox.boundsPx },
    meta: hitbox.meta == null ? null : { ...hitbox.meta },
  };
}

export function resizeDebugParentVisualElement(ve: VisualElement | null | undefined): Record<string, unknown> | null {
  if (!ve) { return null; }
  return {
    path: (() => {
      try {
        return VeFns.veToPath(ve);
      } catch (_e) {
        return "[veToPath failed]";
      }
    })(),
    flags: ve.flags,
    displayItem: resizeDebugItem(ve.displayItem),
    boundsPx: { ...ve.boundsPx },
    viewportBoundsPx: ve.viewportBoundsPx ? { ...ve.viewportBoundsPx } : null,
    childAreaBoundsPx: ve.childAreaBoundsPx ? { ...ve.childAreaBoundsPx } : null,
    blockSizePx: ve.blockSizePx ? { ...ve.blockSizePx } : null,
  };
}
