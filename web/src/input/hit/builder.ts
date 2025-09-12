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

import { HitboxFlags, HitboxMeta } from "../../layout/hitbox";
import { isComposite } from "../../items/composite-item";
import { PageFns, asPageItem, isPage } from "../../items/page-item";
import { isTable } from "../../items/table-item";
import { VesCache } from "../../layout/ves-cache";
import { VisualElementSignal } from "../../util/signals";
import { Vector } from "../../util/geometry";
import { VisualElement, VisualElementFlags } from "../../layout/visual-element";
import { GRID_SIZE } from "../../constants";
import { HitInfo } from "./types";
import { panic } from "../../util/lang";

export class HitBuilder {
  private _parentRootVe: VisualElement | null;
  private _rootVes: VisualElementSignal;
  private _overVes: VisualElementSignal | null = null;
  private _hitboxType: HitboxFlags = HitboxFlags.None;
  private _containerHitboxType: HitboxFlags = HitboxFlags.None;
  private _overElementMeta: HitboxMeta | null = null;
  private _posRelativeToRootVePx: Vector = { x: 0, y: 0 };
  private _canHitEmbeddedInteractive: boolean = false;
  private _debugCreatedAt: string = "";

  constructor(parentRootVe: VisualElement | null, rootVes: VisualElementSignal) {
    this._parentRootVe = parentRootVe;
    this._rootVes = rootVes;
  }

  over(ves: VisualElementSignal): HitBuilder {
    this._overVes = ves;
    return this;
  }

  hitboxes(hitboxType: HitboxFlags, containerHitboxType: HitboxFlags): HitBuilder {
    this._hitboxType = hitboxType;
    this._containerHitboxType = containerHitboxType;
    return this;
  }

  meta(meta: HitboxMeta | null): HitBuilder {
    this._overElementMeta = meta;
    return this;
  }

  pos(posRelativeToRootVePx: Vector): HitBuilder {
    this._posRelativeToRootVePx = posRelativeToRootVePx;
    return this;
  }

  allowEmbeddedInteractive(can: boolean): HitBuilder {
    this._canHitEmbeddedInteractive = can;
    return this;
  }

  createdAt(debugCreatedAt: string): HitBuilder {
    this._debugCreatedAt = debugCreatedAt;
    return this;
  }

  build(): HitInfo {
    return finalize(
      this._hitboxType,
      this._containerHitboxType,
      this._parentRootVe,
      this._rootVes,
      this._overVes!,
      this._overElementMeta,
      this._posRelativeToRootVePx,
      this._canHitEmbeddedInteractive,
      this._debugCreatedAt
    );
  }
}

function parentVe(ve: VisualElement): VisualElement {
  return VesCache.get(ve.parentPath!)!.get();
}

export function computeGridPositionForPage(pageVe: VisualElement, prop: { x: number, y: number }): Vector {
  const inner = asPageItem(pageVe.displayItem).innerSpatialWidthGr;
  const aspect = asPageItem(pageVe.displayItem).naturalAspect;
  return {
    x: Math.round(prop.x * inner / (GRID_SIZE / 2)) * (GRID_SIZE / 2),
    y: Math.round(prop.y * inner / aspect / (GRID_SIZE / 2)) * (GRID_SIZE / 2)
  };
}

export function finalize(
  hitboxType: HitboxFlags,
  containerHitboxType: HitboxFlags,
  parentRootVe: VisualElement | null,
  rootVes: VisualElementSignal,
  overVes: VisualElementSignal,
  overElementMeta: HitboxMeta | null,
  posRelativeToRootVePx: Vector,
  canHitEmbeddedInteractive: boolean,
  debugCreatedAt: string,
): HitInfo {
  if (!overVes) { panic("finalize called with undefined overVes"); }
  const overVe = overVes.get();
  if (overVe.displayItem.id == PageFns.umbrellaPage().id) {
    return finalizeUmbrella(parentRootVe, overVes, debugCreatedAt);
  }
  if (overVe.flags & VisualElementFlags.InsideTable) {
    return finalizeInsideTableChild(hitboxType, containerHitboxType, parentRootVe, rootVes, overVes, overElementMeta, debugCreatedAt);
  }
  if (isTable(overVe.displayItem) && !(overVe.flags & VisualElementFlags.InsideCompositeOrDoc)) {
    return finalizeTopLevelTable(hitboxType, containerHitboxType, parentRootVe, rootVes, overVes, overElementMeta, posRelativeToRootVePx, debugCreatedAt);
  }
  if (isPage(overVe.displayItem) && (overVe.flags & VisualElementFlags.ShowChildren)) {
    return finalizePageWithChildren(hitboxType, containerHitboxType, parentRootVe, rootVes, overVes, overElementMeta, posRelativeToRootVePx, canHitEmbeddedInteractive, debugCreatedAt);
  }
  if (overVe.flags & VisualElementFlags.InsideCompositeOrDoc && isComposite(VesCache.get(overVe.parentPath!)!.get().displayItem)) {
    return finalizeInsideCompositeParent(hitboxType, containerHitboxType, parentRootVe, rootVes, overVes, overElementMeta, posRelativeToRootVePx, debugCreatedAt);
  }
  return finalizeGeneric(hitboxType, containerHitboxType, parentRootVe, rootVes, overVes, overElementMeta, posRelativeToRootVePx, debugCreatedAt);
}


function finalizeUmbrella(
  parentRootVe: VisualElement | null,
  overVes: VisualElementSignal,
  debugCreatedAt: string,
): HitInfo {
  return {
    overVes: null,
    rootVes: overVes,
    parentRootVe,
    subRootVe: null,
    subSubRootVe: null,
    hitboxType: HitboxFlags.None,
    compositeHitboxTypeMaybe: HitboxFlags.None,
    overElementMeta: null,
    overPositionableVe: null,
    overPositionGr: null,
    debugCreatedAt: "finalize/umbrella " + debugCreatedAt,
  };
}


function finalizeInsideTableChild(
  hitboxType: HitboxFlags,
  containerHitboxType: HitboxFlags,
  parentRootVe: VisualElement | null,
  rootVes: VisualElementSignal,
  overVes: VisualElementSignal,
  overElementMeta: HitboxMeta | null,
  debugCreatedAt: string,
): HitInfo {
  const overVe = overVes.get();
  const parentTableVe = parentVe(overVe);
  const tableParentVe = parentVe(parentTableVe);
  let overPositionableVe = tableParentVe;
  const overPositionGr = { x: 0, y: 0 };
  if ((tableParentVe.flags & VisualElementFlags.InsideCompositeOrDoc)) {
    overPositionableVe = VesCache.get(tableParentVe.parentPath!)!.get();
    return {
      overVes,
      rootVes,
      parentRootVe,
      subRootVe: tableParentVe,
      subSubRootVe: parentTableVe,
      hitboxType,
      compositeHitboxTypeMaybe: containerHitboxType,
      overElementMeta,
      overPositionableVe,
      overPositionGr,
      debugCreatedAt: "finalize/tableChild-inComposite " + debugCreatedAt,
    };
  }
  return {
    overVes,
    rootVes,
    parentRootVe,
    subRootVe: parentTableVe,
    subSubRootVe: null,
    hitboxType,
    compositeHitboxTypeMaybe: HitboxFlags.None,
    overElementMeta,
    overPositionableVe,
    overPositionGr,
    debugCreatedAt: "finalize/tableChild-inPage " + debugCreatedAt,
  };
}


function finalizeTopLevelTable(
  hitboxType: HitboxFlags,
  containerHitboxType: HitboxFlags,
  parentRootVe: VisualElement | null,
  rootVes: VisualElementSignal,
  overVes: VisualElementSignal,
  overElementMeta: HitboxMeta | null,
  posRelativeToRootVePx: Vector,
  debugCreatedAt: string,
): HitInfo {
  const overVe = overVes.get();
  const parentVeLocal = parentVe(overVe);
  let prop = {
    x: (posRelativeToRootVePx.x - parentVeLocal.viewportBoundsPx!.x) / parentVeLocal.childAreaBoundsPx!.w,
    y: (posRelativeToRootVePx.y - parentVeLocal.viewportBoundsPx!.y) / parentVeLocal.childAreaBoundsPx!.h,
  };
  let overPositionGr = { x: 0, y: 0 };
  let overPositionableVe = parentVeLocal;
  if (isPage(parentVeLocal.displayItem)) {
    overPositionGr = computeGridPositionForPage(parentVeLocal, prop);
  } else if ((parentVeLocal.flags & VisualElementFlags.InsideCompositeOrDoc)) {
    overPositionableVe = parentVe(parentVeLocal);
  } else {
    panic("unexpected table parent ve type: " + parentVeLocal.displayItem.itemType);
  }
  return {
    overVes,
    rootVes,
    parentRootVe,
    subRootVe: null,
    subSubRootVe: null,
    hitboxType,
    compositeHitboxTypeMaybe: containerHitboxType,
    overElementMeta,
    overPositionableVe,
    overPositionGr,
    debugCreatedAt: "finalize/topLevelTable " + debugCreatedAt,
  };
}


function finalizePageWithChildren(
  hitboxType: HitboxFlags,
  containerHitboxType: HitboxFlags,
  parentRootVe: VisualElement | null,
  rootVes: VisualElementSignal,
  overVes: VisualElementSignal,
  overElementMeta: HitboxMeta | null,
  posRelativeToRootVePx: Vector,
  canHitEmbeddedInteractive: boolean,
  debugCreatedAt: string,
): HitInfo {
  const overVe = overVes.get();
  let prop = {
    x: (posRelativeToRootVePx.x - overVe.viewportBoundsPx!.x) / overVe.childAreaBoundsPx!.w,
    y: (posRelativeToRootVePx.y - overVe.viewportBoundsPx!.y) / overVe.childAreaBoundsPx!.h,
  };
  if (rootVes.get() == overVe) {
    prop = {
      x: posRelativeToRootVePx.x / overVe.childAreaBoundsPx!.w,
      y: posRelativeToRootVePx.y / overVe.childAreaBoundsPx!.h,
    };
  }
  const overPositionGr = computeGridPositionForPage(overVe, prop);
  let overPositionableVe = overVe;
  // If the root is the dock, position and scale should be defined by the dock VE
  // so that moving logic computes dock insert indices and shows insertion lines.
  if (rootVes.get().flags & VisualElementFlags.IsDock) {
    overPositionableVe = rootVes.get();
  }
  if (canHitEmbeddedInteractive) {
    if (overVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
      overPositionableVe = VesCache.get(overVe.parentPath!)!.get();
    }
  }
  if ((overVe.flags & VisualElementFlags.InsideCompositeOrDoc) && isComposite(VesCache.get(overVe.parentPath!)!.get().displayItem)) {
    const parentCompositeVe = parentVe(overVe);
    const compositeParentPageVe = parentVe(parentCompositeVe);
    return {
      overVes,
      rootVes,
      parentRootVe,
      subRootVe: parentCompositeVe,
      subSubRootVe: null,
      overPositionableVe,
      hitboxType,
      compositeHitboxTypeMaybe: containerHitboxType,
      overElementMeta,
      overPositionGr,
      debugCreatedAt: "finalize/pageChildren-inComposite " + debugCreatedAt,
    };
  }
  return {
    overVes,
    rootVes,
    parentRootVe,
    subRootVe: null,
    subSubRootVe: null,
    hitboxType,
    compositeHitboxTypeMaybe: containerHitboxType,
    overElementMeta,
    overPositionableVe,
    overPositionGr,
    debugCreatedAt: "finalize/pageChildren " + debugCreatedAt,
  };
}


function finalizeInsideCompositeParent(
  hitboxType: HitboxFlags,
  containerHitboxType: HitboxFlags,
  parentRootVe: VisualElement | null,
  rootVes: VisualElementSignal,
  overVes: VisualElementSignal,
  overElementMeta: HitboxMeta | null,
  posRelativeToRootVePx: Vector,
  debugCreatedAt: string,
): HitInfo {
  const overVe = overVes.get();
  const parentCompositeVe = parentVe(overVe);
  const compositeParentPageVe = parentVe(parentCompositeVe);
  const overPositionGr = { x: 0, y: 0 };
  return {
    overVes,
    rootVes,
    parentRootVe,
    subRootVe: parentCompositeVe,
    subSubRootVe: null,
    overPositionableVe: compositeParentPageVe,
    hitboxType,
    compositeHitboxTypeMaybe: containerHitboxType,
    overElementMeta,
    overPositionGr,
    debugCreatedAt: "finalize/insideCompositeParent " + debugCreatedAt,
  };
}


function finalizeGeneric(
  hitboxType: HitboxFlags,
  containerHitboxType: HitboxFlags,
  parentRootVe: VisualElement | null,
  rootVes: VisualElementSignal,
  overVes: VisualElementSignal,
  overElementMeta: HitboxMeta | null,
  posRelativeToRootVePx: Vector,
  debugCreatedAt: string,
): HitInfo {
  const overVe = overVes.get();
  const overVeParentVes = VesCache.get(overVe.parentPath!)!;
  const overVeParent = overVeParentVes.get();
  const overPositionGr = { x: 0, y: 0 };
  if (isPage(overVe.displayItem)) {
    return {
      overVes,
      rootVes,
      parentRootVe,
      subRootVe: null,
      subSubRootVe: null,
      hitboxType,
      compositeHitboxTypeMaybe: containerHitboxType,
      overElementMeta,
      overPositionableVe: overVeParent,
      overPositionGr,
      debugCreatedAt: "finalize/generic-page " + debugCreatedAt,
    };
  }
  return {
    overVes,
    rootVes,
    parentRootVe,
    subRootVe: null,
    subSubRootVe: null,
    hitboxType,
    compositeHitboxTypeMaybe: containerHitboxType,
    overElementMeta,
    overPositionableVe: overVeParent,
    overPositionGr,
    debugCreatedAt: "finalize/generic " + debugCreatedAt,
  };
}
