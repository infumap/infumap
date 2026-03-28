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

import { ItemFns } from "../../items/base/item-polymorphism";
import { compareBoundingBox, compareDimensions } from "../../util/geometry";
import { panic } from "../../util/lang";
import { Uid } from "../../util/uid";
import { HitboxFns } from "../hitbox";
import { NONE_VISUAL_ELEMENT, VisualElement, VisualElementSpec } from "../visual-element";

export function prepareVisualElementSpec(spec: VisualElementSpec): VisualElementSpec {
  if (spec.displayItemFingerprint) {
    panic("displayItemFingerprint is already set.");
  }
  return {
    ...spec,
    displayItemFingerprint: ItemFns.getFingerprint(spec.displayItem),
  };
}

export function cloneVisualElementSnapshot(ve: VisualElement): VisualElement {
  return {
    ...ve,
    resizingFromBoundsPx: ve.resizingFromBoundsPx ? { ...ve.resizingFromBoundsPx } : null,
    boundsPx: { ...ve.boundsPx },
    viewportBoundsPx: ve.viewportBoundsPx ? { ...ve.viewportBoundsPx } : null,
    childAreaBoundsPx: ve.childAreaBoundsPx ? { ...ve.childAreaBoundsPx } : null,
    listViewportBoundsPx: ve.listViewportBoundsPx ? { ...ve.listViewportBoundsPx } : null,
    listChildAreaBoundsPx: ve.listChildAreaBoundsPx ? { ...ve.listChildAreaBoundsPx } : null,
    tableDimensionsPx: ve.tableDimensionsPx ? { ...ve.tableDimensionsPx } : null,
    blockSizePx: ve.blockSizePx ? { ...ve.blockSizePx } : null,
    cellSizePx: ve.cellSizePx ? { ...ve.cellSizePx } : null,
    hitboxes: ve.hitboxes.slice(),
  };
}

function specValueOrDefault<T>(value: T | undefined, fallback: T): T {
  return typeof value === "undefined" ? fallback : value;
}

function sameUidMaybe(a: { id: Uid } | null | undefined, b: { id: Uid } | null | undefined): boolean {
  return (a?.id ?? null) === (b?.id ?? null);
}

export function visualElementMatchesPreparedSpec(preparedSpec: VisualElementSpec, existingVe: VisualElement): boolean {
  if (existingVe.displayItemFingerprint !== preparedSpec.displayItemFingerprint) { return false; }
  if (existingVe.displayItem.id !== preparedSpec.displayItem.id) { return false; }
  if (!sameUidMaybe(existingVe.linkItemMaybe, specValueOrDefault(preparedSpec.linkItemMaybe, NONE_VISUAL_ELEMENT.linkItemMaybe))) { return false; }
  if (!sameUidMaybe(existingVe.actualLinkItemMaybe, specValueOrDefault(preparedSpec.actualLinkItemMaybe, NONE_VISUAL_ELEMENT.actualLinkItemMaybe))) { return false; }
  if (existingVe.flags !== specValueOrDefault(preparedSpec.flags, NONE_VISUAL_ELEMENT.flags)) { return false; }
  if (existingVe._arrangeFlags_useForPartialRearrangeOnly !== specValueOrDefault(preparedSpec._arrangeFlags_useForPartialRearrangeOnly, NONE_VISUAL_ELEMENT._arrangeFlags_useForPartialRearrangeOnly)) { return false; }
  if (compareBoundingBox(existingVe.resizingFromBoundsPx, NONE_VISUAL_ELEMENT.resizingFromBoundsPx) !== 0) { return false; }
  if (compareBoundingBox(existingVe.boundsPx, preparedSpec.boundsPx) !== 0) { return false; }
  if (compareBoundingBox(existingVe.viewportBoundsPx, specValueOrDefault(preparedSpec.viewportBoundsPx, NONE_VISUAL_ELEMENT.viewportBoundsPx)) !== 0) { return false; }
  if (compareBoundingBox(existingVe.childAreaBoundsPx, specValueOrDefault(preparedSpec.childAreaBoundsPx, NONE_VISUAL_ELEMENT.childAreaBoundsPx)) !== 0) { return false; }
  if (compareBoundingBox(existingVe.listViewportBoundsPx, specValueOrDefault(preparedSpec.listViewportBoundsPx, NONE_VISUAL_ELEMENT.listViewportBoundsPx)) !== 0) { return false; }
  if (compareBoundingBox(existingVe.listChildAreaBoundsPx, specValueOrDefault(preparedSpec.listChildAreaBoundsPx, NONE_VISUAL_ELEMENT.listChildAreaBoundsPx)) !== 0) { return false; }
  if (compareDimensions(existingVe.tableDimensionsPx, specValueOrDefault(preparedSpec.tableDimensionsPx, NONE_VISUAL_ELEMENT.tableDimensionsPx)) !== 0) { return false; }
  if ((existingVe.indentBl ?? null) !== (specValueOrDefault(preparedSpec.indentBl, NONE_VISUAL_ELEMENT.indentBl) ?? null)) { return false; }
  if (compareDimensions(existingVe.blockSizePx, specValueOrDefault(preparedSpec.blockSizePx, NONE_VISUAL_ELEMENT.blockSizePx)) !== 0) { return false; }
  if (compareDimensions(existingVe.cellSizePx, specValueOrDefault(preparedSpec.cellSizePx, NONE_VISUAL_ELEMENT.cellSizePx)) !== 0) { return false; }
  if ((existingVe.row ?? null) !== (specValueOrDefault(preparedSpec.row, NONE_VISUAL_ELEMENT.row) ?? null)) { return false; }
  if ((existingVe.col ?? null) !== (specValueOrDefault(preparedSpec.col, NONE_VISUAL_ELEMENT.col) ?? null)) { return false; }
  if ((existingVe.numRows ?? null) !== (specValueOrDefault(preparedSpec.numRows, NONE_VISUAL_ELEMENT.numRows) ?? null)) { return false; }
  if (HitboxFns.ArrayCompare(existingVe.hitboxes, specValueOrDefault(preparedSpec.hitboxes, NONE_VISUAL_ELEMENT.hitboxes)) !== 0) { return false; }
  if ((existingVe.parentPath ?? null) !== (specValueOrDefault(preparedSpec.parentPath, NONE_VISUAL_ELEMENT.parentPath) ?? null)) { return false; }
  if ((existingVe.evaluatedTitle ?? null) !== (specValueOrDefault(preparedSpec.evaluatedTitle, NONE_VISUAL_ELEMENT.evaluatedTitle) ?? null)) { return false; }

  return true;
}
