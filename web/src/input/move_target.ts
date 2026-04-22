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

import { isContainer } from "../items/base/container-item";
import { isPage } from "../items/page-item";
import { TEMP_SEARCH_RESULTS_ORIGIN } from "../items/search-item";
import { VesCache } from "../layout/ves-cache";
import { VisualElement, VisualElementPath, VeFns } from "../layout/visual-element";
import { panic } from "../util/lang";
import { Uid } from "../util/uid";
import { HitInfo, HitInfoFns } from "./hit";


export type InternalMoveTargetValidity =
  | "valid"
  | "transient-ui"
  | "unsupported";

export interface ResolvedInternalMoveTarget {
  hoverContainerVe: VisualElement,
  hoverContainerPath: VisualElementPath,
  positioningPageVe: VisualElement,
  positioningPagePath: VisualElementPath,
  resolvedParentId: Uid | null,
  displayedInTransientUi: boolean,
  backedByPersistentContainer: boolean,
  validity: InternalMoveTargetValidity,
}

export function resolveMoveTargetPageVe(moveToVe: VisualElement): VisualElement {
  let candidate: VisualElement | null = moveToVe;
  while (candidate) {
    if (isPage(candidate.displayItem)) { return candidate; }
    if (!candidate.parentPath) { break; }
    candidate = VesCache.current.readNode(candidate.parentPath) ?? null;
  }
  panic(`unexpected move target type: ${moveToVe.displayItem.itemType}`);
}

export function isDisplayedInTransientSearchUi(ve: VisualElement | null): boolean {
  let current = ve;
  while (current) {
    if (current.displayItem.origin == TEMP_SEARCH_RESULTS_ORIGIN) {
      return true;
    }
    if (!current.parentPath) {
      return false;
    }
    current = VesCache.current.readNode(current.parentPath) ?? null;
  }
  return false;
}

export function resolveInternalMoveTarget(
  hitInfo: HitInfo,
  ignoreItems: Array<Uid> | Set<Uid> = [],
): ResolvedInternalMoveTarget {
  const hoverContainerVe = HitInfoFns.getOverContainerVe(hitInfo, ignoreItems);
  const positioningPageVe = resolveMoveTargetPageVe(hitInfo.overPositionableVe ?? hoverContainerVe);
  const displayedInTransientUi = isDisplayedInTransientSearchUi(hoverContainerVe);
  const backedByPersistentContainer =
    displayedInTransientUi &&
    isContainer(hoverContainerVe.displayItem) &&
    hoverContainerVe.displayItem.origin != TEMP_SEARCH_RESULTS_ORIGIN;
  const resolvedParentId =
    isContainer(hoverContainerVe.displayItem) &&
      hoverContainerVe.displayItem.origin != TEMP_SEARCH_RESULTS_ORIGIN
      ? hoverContainerVe.displayItem.id
      : null;

  return {
    hoverContainerVe,
    hoverContainerPath: VeFns.veToPath(hoverContainerVe),
    positioningPageVe,
    positioningPagePath: VeFns.veToPath(positioningPageVe),
    resolvedParentId,
    displayedInTransientUi,
    backedByPersistentContainer,
    validity:
      resolvedParentId != null
        ? "valid"
        : displayedInTransientUi
          ? "transient-ui"
          : "unsupported",
  };
}
