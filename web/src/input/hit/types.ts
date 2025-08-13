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

import { HitboxMeta, HitboxFlags } from "../../layout/hitbox";
import { VisualElement } from "../../layout/visual-element";
import { VisualElementSignal } from "../../util/signals";
import { StoreContextModel } from "../../store/StoreProvider";
import { Vector } from "../../util/geometry";
import { Uid } from "../../util/uid";

export interface HitInfo {
  overVes: VisualElementSignal | null,
  rootVes: VisualElementSignal,
  subRootVe: VisualElement | null,
  subSubRootVe: VisualElement | null,
  parentRootVe: VisualElement | null,
  hitboxType: HitboxFlags,
  compositeHitboxTypeMaybe: HitboxFlags,
  overElementMeta: HitboxMeta | null,
  overPositionableVe: VisualElement | null,
  overPositionGr: Vector | null,
  debugCreatedAt: string,
}

export interface HitTraversalContext {
  store: StoreContextModel,
  rootVes: VisualElementSignal,
  parentRootVe: VisualElement | null,
  posRelativeToRootVeViewportPx: Vector,
  ignoreItems: Set<Uid>,
  ignoreAttachments: boolean,
  posOnDesktopPx: Vector,
  canHitEmbeddedInteractive: boolean
}

export interface HitHandler {
  canHandle: (ve: VisualElement) => boolean,
  handle: (
    childVe: VisualElement,
    childVes: VisualElementSignal,
    ctx: HitTraversalContext
  ) => HitInfo | null
}

export interface RootInfo {
  parentRootVe: VisualElement | null,
  rootVes: VisualElementSignal,
  rootVe: VisualElement,
  posRelativeToRootVeViewportPx: Vector,
  posRelativeToRootVeBoundsPx: Vector,
  hitMaybe: HitInfo | null
}


