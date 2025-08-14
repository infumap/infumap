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
import { VisualElement, VeFns } from "../../layout/visual-element";
import { StoreContextModel } from "../../store/StoreProvider";
import { Vector, getBoundingBoxTopLeft, isInside, offsetBoundingBoxTopLeftBy, vectorSubtract } from "../../util/geometry";
import { BoundingBox } from "../../util/geometry";
import { VisualElementSignal } from "../../util/signals";
import { Uid } from "../../util/uid";


export function isIgnored(id: Uid, ignoreItems: Set<Uid>): boolean {
  return ignoreItems.has(id);
}

export function scanHitboxes(
  ve: VisualElement,
  localPos: Vector,
  offsetTopLeft?: Vector,
): { flags: HitboxFlags, meta: HitboxMeta | null } {
  let flags = HitboxFlags.None;
  let meta: HitboxMeta | null = null;
  for (let i = ve.hitboxes.length - 1; i >= 0; --i) {
    const hbBounds = typeof offsetTopLeft === 'undefined'
      ? ve.hitboxes[i].boundsPx
      : offsetBoundingBoxTopLeftBy(ve.hitboxes[i].boundsPx, offsetTopLeft);
    let inside = isInside(localPos, hbBounds);
    if (inside) {
      const type = ve.hitboxes[i].type;
      if (type & HitboxFlags.TriangleLinkSettings) {
        inside = isInsideTopLeftTriangle(localPos, hbBounds);
      } else if (type & HitboxFlags.Resize) {
        inside = isInsideBottomRightTriangle(localPos, hbBounds);
      }
    }
    if (inside) {
      flags |= ve.hitboxes[i].type;
      if (ve.hitboxes[i].meta != null) { meta = ve.hitboxes[i].meta; }
    }
  }
  return { flags, meta };
}

export function findAttachmentHit(
  attachmentsVes: Array<VisualElementSignal>,
  localPos: Vector,
  ignoreItems: Set<Uid>,
  reverse: boolean,
): { attachmentVes: VisualElementSignal, flags: HitboxFlags, meta: HitboxMeta | null } | null {
  if (attachmentsVes.length === 0) { return null; }
  const start = reverse ? attachmentsVes.length - 1 : 0;
  const end = reverse ? -1 : attachmentsVes.length;
  const step = reverse ? -1 : 1;
  for (let i = start; i !== end; i += step) {
    const attachmentVes = attachmentsVes[i];
    const attachmentVe = attachmentVes.get();
    if (!isInside(localPos, attachmentVe.boundsPx)) { continue; }
    if (isIgnored(attachmentVe.displayItem.id, ignoreItems)) { continue; }
    const { flags, meta } = scanHitboxes(
      attachmentVe,
      localPos,
      getBoundingBoxTopLeft(attachmentVe.boundsPx)
    );
    return { attachmentVes, flags, meta };
  }
  return null;
}

export function toChildBoundsLocalFromViewport(parentViewportLocalPos: Vector, childVe: VisualElement): Vector {
  return vectorSubtract(parentViewportLocalPos, { x: childVe.boundsPx.x, y: childVe.boundsPx.y });
}

export function toCompositeChildAreaPos(compositeVe: VisualElement, parentBoundsLocalPos: Vector): Vector {
  return vectorSubtract(parentBoundsLocalPos, { x: compositeVe.boundsPx!.x, y: compositeVe.boundsPx!.y });
}

export function toTableChildAreaPos(
  store: StoreContextModel,
  tableVe: VisualElement,
  tableChildVe: VisualElement,
  parentBoundsLocalPos: Vector,
): Vector {
  const tableBlockHeightPx = tableChildVe.boundsPx.h;
  return vectorSubtract(
    parentBoundsLocalPos,
    { x: tableVe.viewportBoundsPx!.x,
      y: tableVe.viewportBoundsPx!.y - store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVe)) * tableBlockHeightPx }
  );
}

export function toInnerAttachmentLocalInComposite(
  parentChildVe: VisualElement,
  innerVe: VisualElement,
  parentViewportLocalPos: Vector,
): Vector {
  return vectorSubtract(parentViewportLocalPos, { x: parentChildVe.boundsPx.x, y: parentChildVe.boundsPx.y + innerVe.boundsPx.y });
}

export function isInsideTopLeftTriangle(localPos: Vector, rect: BoundingBox): boolean {
  const dx = localPos.x - rect.x;
  const dy = localPos.y - rect.y;
  if (dx < 0 || dy < 0 || dx > rect.w || dy > rect.h) { return false; }
  const size = Math.min(rect.w, rect.h);
  return (dx + dy) <= size;
}

export function isInsideBottomRightTriangle(localPos: Vector, rect: BoundingBox): boolean {
  const dx = (rect.x + rect.w) - localPos.x;
  const dy = (rect.y + rect.h) - localPos.y;
  if (dx < 0 || dy < 0 || dx > rect.w || dy > rect.h) { return false; }
  const size = Math.min(rect.w, rect.h);
  return (dx + dy) <= size;
}


