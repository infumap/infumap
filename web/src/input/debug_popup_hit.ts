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

import { HitboxFlags, HitboxFns } from "../layout/hitbox";
import { VisualElement, VisualElementFlags, VeFns } from "../layout/visual-element";
import { HitInfo } from "./hit/types";

export function popupHitDebugEnabled(): boolean {
  try {
    return typeof window != "undefined" && window.localStorage.getItem("infumapDebugPopupHit") == "1";
  } catch {
    return false;
  }
}

export function popupHitDebugVerboseEnabled(): boolean {
  try {
    return popupHitDebugEnabled() && window.localStorage.getItem("infumapDebugPopupHitVerbose") == "1";
  } catch {
    return false;
  }
}

function visualElementFlagsDebugSummary(flags: VisualElementFlags): Array<string> {
  const result: Array<string> = [];
  if (flags & VisualElementFlags.Selected) { result.push("Selected"); }
  if (flags & VisualElementFlags.HasToolbarFocus) { result.push("HasToolbarFocus"); }
  if (flags & VisualElementFlags.LineItem) { result.push("LineItem"); }
  if (flags & VisualElementFlags.Detailed) { result.push("Detailed"); }
  if (flags & VisualElementFlags.ShowChildren) { result.push("ShowChildren"); }
  if (flags & VisualElementFlags.InsideCompositeOrDoc) { result.push("InsideCompositeOrDoc"); }
  if (flags & VisualElementFlags.Popup) { result.push("Popup"); }
  if (flags & VisualElementFlags.TopLevelRoot) { result.push("TopLevelRoot"); }
  if (flags & VisualElementFlags.ListPageRoot) { result.push("ListPageRoot"); }
  if (flags & VisualElementFlags.EmbeddedInteractiveRoot) { result.push("EmbeddedInteractiveRoot"); }
  if (flags & VisualElementFlags.IsDock) { result.push("IsDock"); }
  if (flags & VisualElementFlags.DockItem) { result.push("DockItem"); }
  return result;
}

export function hitboxFlagsDebugSummary(flags: HitboxFlags): { raw: HitboxFlags, text: string } {
  return {
    raw: flags,
    text: HitboxFns.hitboxFlagsToString(flags),
  };
}

export function visualElementDebugSummary(ve: VisualElement | null | undefined): unknown {
  if (ve == null) { return null; }
  const item = ve.displayItem as any;
  let path: string | null = null;
  let actualVeid: unknown = null;
  try {
    path = VeFns.veToPath(ve);
  } catch {
    path = "<path-error>";
  }
  try {
    actualVeid = VeFns.actualVeidFromVe(ve);
  } catch {
    actualVeid = "<actual-veid-error>";
  }
  return {
    id: ve.displayItem.id,
    itemType: ve.displayItem.itemType,
    title: typeof item.title == "string" ? item.title : undefined,
    path,
    parentPath: ve.parentPath,
    actualVeid,
    flagsRaw: ve.flags,
    flags: visualElementFlagsDebugSummary(ve.flags),
    boundsPx: ve.boundsPx,
    viewportBoundsPx: ve.viewportBoundsPx,
    listViewportBoundsPx: ve.listViewportBoundsPx,
  };
}

export function hitInfoDebugSummary(hitInfo: HitInfo): unknown {
  const overVe = hitInfo.overVes ? hitInfo.overVes.get() : null;
  return {
    debugCreatedAt: hitInfo.debugCreatedAt,
    hitboxType: hitboxFlagsDebugSummary(hitInfo.hitboxType),
    compositeHitboxTypeMaybe: hitboxFlagsDebugSummary(hitInfo.compositeHitboxTypeMaybe),
    overElementMeta: hitInfo.overElementMeta,
    overVe: visualElementDebugSummary(overVe),
    hitVe: visualElementDebugSummary(overVe ?? hitInfo.rootVes.get()),
    rootVe: visualElementDebugSummary(hitInfo.rootVes.get()),
    parentRootVe: visualElementDebugSummary(hitInfo.parentRootVe),
    subRootVe: visualElementDebugSummary(hitInfo.subRootVe),
    subSubRootVe: visualElementDebugSummary(hitInfo.subSubRootVe),
    overPositionableVe: visualElementDebugSummary(hitInfo.overPositionableVe),
    overPositionGr: hitInfo.overPositionGr,
  };
}

export function popupHitDebugLog(label: string, data: unknown): void {
  if (!popupHitDebugEnabled()) { return; }
  console.log(`[popup-hit] ${label}`, data);
}
