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

import { HitboxFlags } from "../../layout/hitbox";
import { isComposite } from "../../items/composite-item";
import { isPage } from "../../items/page-item";
import { isTable } from "../../items/table-item";
import { getBoundingBoxTopLeft, isInside, offsetBoundingBoxTopLeftBy } from "../../util/geometry";
import { panic } from "../../util/lang";
import { VesCache } from "../../layout/ves-cache";
import { VeFns, VisualElement, VisualElementFlags } from "../../layout/visual-element";
import { VisualElementSignal } from "../../util/signals";
import { HitHandler, HitInfo, HitTraversalContext } from "./types";
import { HitBuilder } from "./builder";
import { findAttachmentHit, isInsideBottomRightTriangle, isInsideBoundsOrAllowedHitbox, scanHitboxes, toCompositeChildAreaPos, toTableChildAreaPos } from "./utils";

function parentVe(ve: VisualElement): VisualElement {
  return VesCache.current.readNode(ve.parentPath!)!;
}

export const HitHandlers: Array<HitHandler> = [];

const _tableHandler: HitHandler = {
  canHandle: (ve: VisualElement) => isTable(ve.displayItem) && !(ve.flags & VisualElementFlags.LineItem),
  handle: (childVe: VisualElement, childVes: VisualElementSignal, ctx: HitTraversalContext): HitInfo | null => {
    const { store, rootVes, parentRootVe, posRelativeToRootVeViewportPx, ignoreItems, allowOutsideBoundsHitboxes } = ctx;
    if (!isInsideBoundsOrAllowedHitbox(childVe, posRelativeToRootVeViewportPx, getBoundingBoxTopLeft(childVe.boundsPx), allowOutsideBoundsHitboxes)) { return null; }
    const tableVes = childVes;
    const tableVe = childVe;
    const resizeHitbox = tableVe.hitboxes[tableVe.hitboxes.length - 1];
    if (resizeHitbox.type != HitboxFlags.Resize) { panic("Last table hitbox type is not Resize."); }
    if (isInsideBottomRightTriangle(
      posRelativeToRootVeViewportPx,
      offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(tableVe.boundsPx!)))) {
      return new HitBuilder(parentRootVe, rootVes).over(tableVes).hitboxes(HitboxFlags.Resize, HitboxFlags.None).meta(resizeHitbox.meta).pos(posRelativeToRootVeViewportPx).allowEmbeddedInteractive(false).createdAt("table-handler-resize").build();
    }
    for (let j = tableVe.hitboxes.length - 2; j >= 0; j--) {
      const hb = tableVe.hitboxes[j];
      if (hb.type != HitboxFlags.HorizontalResize) { break; }
      if (isInside(posRelativeToRootVeViewportPx, offsetBoundingBoxTopLeftBy(hb.boundsPx, getBoundingBoxTopLeft(tableVe.boundsPx!)))) {
        return new HitBuilder(parentRootVe, rootVes).over(tableVes).hitboxes(HitboxFlags.HorizontalResize, HitboxFlags.None).meta(hb.meta).pos(posRelativeToRootVeViewportPx).allowEmbeddedInteractive(false).createdAt("table-handler-hresize").build();
      }
    }
    const tableVeChildren = VesCache.render.getChildren(VeFns.veToPath(tableVe))();
    for (let j = 0; j < tableVeChildren.length; ++j) {
      const tableChildVes = tableVeChildren[j];
      const tableChildVe = tableChildVes.get();
      const posRelativeToTableChildAreaPx = toTableChildAreaPos(store, tableVe, tableChildVe, posRelativeToRootVeViewportPx);
      if (isInsideBoundsOrAllowedHitbox(tableChildVe, posRelativeToTableChildAreaPx, getBoundingBoxTopLeft(tableChildVe.boundsPx), allowOutsideBoundsHitboxes)) {
        const { flags: hitboxType, meta } = scanHitboxes(tableChildVe, posRelativeToTableChildAreaPx, getBoundingBoxTopLeft(tableChildVe.boundsPx));
        if (!ignoreItems.has(tableChildVe.displayItem.id)) {
          if (!ignoreItems.has(tableVe.displayItem.id)) {
            return new HitBuilder(parentRootVe, rootVes).over(tableChildVes).hitboxes(hitboxType, HitboxFlags.None).meta(meta).pos(posRelativeToRootVeViewportPx).allowEmbeddedInteractive(false).createdAt("table-handler-child").build();
          }
        }
      }
      {
        const hit = findAttachmentHit(VesCache.render.getAttachments(VeFns.veToPath(tableChildVe))(), posRelativeToTableChildAreaPx, ignoreItems, false);
        if (hit) {
          const tableParentVe = parentVe(tableVe);
          const tableIsInsideComposite = !!(tableVe.flags & VisualElementFlags.InsideCompositeOrDoc);
          return {
            overVes: hit.attachmentVes,
            parentRootVe,
            rootVes,
            subRootVe: tableIsInsideComposite ? tableParentVe : tableVe,
            subSubRootVe: tableIsInsideComposite ? tableVe : null,
            hitboxType: hit.flags,
            compositeHitboxTypeMaybe: HitboxFlags.None,
            overElementMeta: hit.meta,
            overPositionableVe: tableIsInsideComposite ? parentVe(tableParentVe) : tableParentVe,
            overPositionGr: { x: 0, y: 0 },
            debugCreatedAt: "table-handler-attachment",
          };
        }
      }
    }
    return null;
  }
};

HitHandlers.push(_tableHandler);

const _compositeHandler: HitHandler = {
  canHandle: (ve: VisualElement) => isComposite(ve.displayItem) && !(ve.flags & VisualElementFlags.LineItem),
  handle: (childVe: VisualElement, childVes: VisualElementSignal, ctx: HitTraversalContext): HitInfo | null => {
    const { store, rootVes, parentRootVe, posRelativeToRootVeViewportPx, ignoreItems, allowOutsideBoundsHitboxes } = ctx;
    if (!isInsideBoundsOrAllowedHitbox(childVe, posRelativeToRootVeViewportPx, getBoundingBoxTopLeft(childVe.boundsPx), allowOutsideBoundsHitboxes)) { return null; }
    const compositeVes = childVes;
    const compositeVe = childVe;
    const resizeHitbox = compositeVe.hitboxes[compositeVe.hitboxes.length - 1];
    if (resizeHitbox.type != HitboxFlags.Resize) { panic("Last composite hitbox type is not Resize."); }
    if (isInsideBottomRightTriangle(
      posRelativeToRootVeViewportPx,
      offsetBoundingBoxTopLeftBy(resizeHitbox.boundsPx, getBoundingBoxTopLeft(compositeVe.boundsPx!)))) {
      return new HitBuilder(parentRootVe, rootVes).over(compositeVes).hitboxes(HitboxFlags.Resize, HitboxFlags.None).meta(resizeHitbox.meta).pos(posRelativeToRootVeViewportPx).allowEmbeddedInteractive(false).createdAt("composite-handler-resize").build();
    }
    const { flags: compositeHitboxType, meta: compositeMeta } = scanHitboxes(compositeVe, posRelativeToRootVeViewportPx, getBoundingBoxTopLeft(compositeVe.boundsPx!));
    const compositeVeChildren = VesCache.render.getChildren(VeFns.veToPath(compositeVe))();
    for (let j = 0; j < compositeVeChildren.length; ++j) {
      const compositeChildVes = compositeVeChildren[j];
      const compositeChildVe = compositeChildVes.get();
      const posRelativeToCompositeChildAreaPx = toCompositeChildAreaPos(compositeVe, posRelativeToRootVeViewportPx);
      const { flags: hitboxType, meta } = scanHitboxes(compositeChildVe, posRelativeToCompositeChildAreaPx, getBoundingBoxTopLeft(compositeChildVe.boundsPx));
      if ((hitboxType & HitboxFlags.AttachComposite) && !ignoreItems.has(compositeChildVe.displayItem.id)) {
        return new HitBuilder(parentRootVe, rootVes).over(compositeChildVes).hitboxes(hitboxType, compositeHitboxType).meta(meta).pos(posRelativeToRootVeViewportPx).allowEmbeddedInteractive(false).createdAt("composite-handler-attach-child").build();
      }
      if (isTable(compositeChildVe.displayItem) && !(compositeChildVe.flags & VisualElementFlags.LineItem)) {
        const tableHit = _tableHandler.handle(compositeChildVe, compositeChildVes, {
          ...ctx,
          posRelativeToRootVeViewportPx: posRelativeToCompositeChildAreaPx,
        });
        if (tableHit) { return tableHit; }
      }
      const isInPageGutter =
        isPage(compositeChildVe.displayItem) &&
        isInside(posRelativeToCompositeChildAreaPx, {
          x: compositeChildVe.boundsPx.x + compositeChildVe.boundsPx.w,
          y: compositeChildVe.boundsPx.y,
          w: compositeVe.boundsPx.w - (compositeChildVe.boundsPx.x + compositeChildVe.boundsPx.w),
          h: compositeChildVe.boundsPx.h,
        });
      const hitExtendedPageMoveArea =
        isPage(compositeChildVe.displayItem) &&
        !!(hitboxType & HitboxFlags.Move);
      if (isInsideBoundsOrAllowedHitbox(compositeChildVe, posRelativeToCompositeChildAreaPx, getBoundingBoxTopLeft(compositeChildVe.boundsPx), allowOutsideBoundsHitboxes) || hitExtendedPageMoveArea || isInPageGutter) {
        if (!ignoreItems.has(compositeChildVe.displayItem.id)) {
          // table will be delegated to the table handler later in traversal
        }
        if (isInPageGutter && hitboxType == HitboxFlags.None && !ignoreItems.has(compositeChildVe.displayItem.id)) {
          return new HitBuilder(parentRootVe, rootVes)
            .over(compositeChildVes)
            .hitboxes(HitboxFlags.Click, compositeHitboxType)
            .meta({ focusOnly: true })
            .pos(posRelativeToRootVeViewportPx)
            .allowEmbeddedInteractive(false)
            .createdAt("composite-handler-page-gutter")
            .build();
        }
        if (hitboxType == HitboxFlags.None && !isTable(compositeChildVe.displayItem)) {
          if (!ignoreItems.has(compositeVe.displayItem.id)) {
            return new HitBuilder(parentRootVe, rootVes).over(compositeVes).hitboxes(compositeHitboxType, HitboxFlags.None).meta(compositeMeta).pos(posRelativeToRootVeViewportPx).allowEmbeddedInteractive(false).createdAt("composite-handler-fallback").build();
          }
        } else {
          if (!ignoreItems.has(compositeChildVe.displayItem.id)) {
            return new HitBuilder(parentRootVe, rootVes).over(compositeChildVes).hitboxes(hitboxType, compositeHitboxType).meta(meta).pos(posRelativeToRootVeViewportPx).allowEmbeddedInteractive(false).createdAt("composite-handler-child").build();
          }
        }
      }
    }
    return null;
  }
};

HitHandlers.push(_compositeHandler);

const _defaultHandler: HitHandler = {
  canHandle: (_ve: VisualElement) => true,
  handle: (childVe: VisualElement, childVes: VisualElementSignal, ctx: HitTraversalContext): HitInfo | null => {
    const { rootVes, parentRootVe, posRelativeToRootVeViewportPx, ignoreItems, canHitEmbeddedInteractive, allowOutsideBoundsHitboxes } = ctx;
    if (!isInsideBoundsOrAllowedHitbox(childVe, posRelativeToRootVeViewportPx, getBoundingBoxTopLeft(childVe.boundsPx), allowOutsideBoundsHitboxes)) { return null; }
    const { flags: hitboxType, meta } = scanHitboxes(childVe, posRelativeToRootVeViewportPx, getBoundingBoxTopLeft(childVe.boundsPx));
    if (!ignoreItems.has(childVe.displayItem.id)) {
      return new HitBuilder(parentRootVe, rootVes).over(childVes).hitboxes(hitboxType, HitboxFlags.None).meta(meta).pos(posRelativeToRootVeViewportPx).allowEmbeddedInteractive(canHitEmbeddedInteractive).createdAt("default-handler").build();
    }
    return null;
  }
};

HitHandlers.push(_defaultHandler);
