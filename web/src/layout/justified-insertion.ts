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

import { StoreContextModel } from "../store/StoreProvider";
import { BoundingBox, Vector } from "../util/geometry";
import { VesCache } from "./ves-cache";
import { VeFns, VisualElement } from "./visual-element";


/**
 * An insertion point in a justified page. An index at a row boundary is ambiguous (end of one row vs
 * start of the next), so afterPrevious records which one the pointer indicated: the line is drawn
 * after child index-1 if set, else before child index.
 */
export interface JustifiedInsertion {
  index: number,
  afterPrevious: boolean,
}

interface JustifiedRow {
  first: number,
  last: number,
  top: number,
  bottom: number,
}

/**
 * Groups the (in order) child boxes of a justified page into rows. Rows are separated by box spacing,
 * so a child starts a new row iff it is entirely below everything in the current row.
 */
function justifiedRows(childBoundsPx: Array<BoundingBox>): Array<JustifiedRow> {
  const rows: Array<JustifiedRow> = [];
  for (let i = 0; i < childBoundsPx.length; ++i) {
    const b = childBoundsPx[i];
    const row = rows.length > 0 ? rows[rows.length - 1] : null;
    if (row == null || b.y >= row.bottom) {
      rows.push({ first: i, last: i, top: b.y, bottom: b.y + b.h });
    } else {
      row.last = i;
      row.top = Math.min(row.top, b.y);
      row.bottom = Math.max(row.bottom, b.y + b.h);
    }
  }
  return rows;
}

/**
 * Hit tests against the layout as currently displayed (which excludes the moving item). The row is
 * chosen by y (split halfway between rows), then the insertion point is before the first child in
 * that row whose horizontal center is right of the pointer, or after the last child in the row.
 */
export function justifiedInsertionFromChildAreaPx(childBoundsPx: Array<BoundingBox>, posPx: Vector): JustifiedInsertion {
  const rows = justifiedRows(childBoundsPx);
  if (rows.length == 0) {
    return { index: 0, afterPrevious: false };
  }

  let row = rows[rows.length - 1];
  for (let i = 0; i < rows.length - 1; ++i) {
    if (posPx.y < (rows[i].bottom + rows[i + 1].top) / 2) {
      row = rows[i];
      break;
    }
  }

  for (let i = row.first; i <= row.last; ++i) {
    const b = childBoundsPx[i];
    if (posPx.x < b.x + b.w / 2) {
      return { index: i, afterPrevious: false };
    }
  }
  return { index: row.last + 1, afterPrevious: true };
}

/**
 * The insertion point in justified page pageVe under desktop position desktopPx, hit tested against the
 * page's displayed (non-moving) children.
 */
export function justifiedInsertionFromDesktopPx(store: StoreContextModel, pageVe: VisualElement, desktopPx: Vector): JustifiedInsertion {
  const viewportBoundsPx = VeFns.veViewportBoundsRelativeToDesktopPx(store, pageVe);
  const veid = VeFns.actualVeidFromVe(pageVe);
  const scrollYPx = store.perItem.getPageScrollYProp(veid)
    * Math.max(0, pageVe.childAreaBoundsPx!.h - pageVe.viewportBoundsPx!.h);
  const scrollXPx = store.perItem.getPageScrollXProp(veid)
    * Math.max(0, pageVe.childAreaBoundsPx!.w - pageVe.viewportBoundsPx!.w);
  const childAreaPosPx = {
    x: desktopPx.x - viewportBoundsPx.x + scrollXPx,
    y: desktopPx.y - viewportBoundsPx.y + scrollYPx,
  };
  const childBoundsPx = VesCache.render.getNonMovingChildren(VeFns.veToPath(pageVe))().map(childVe => childVe.get().boundsPx);
  return justifiedInsertionFromChildAreaPx(childBoundsPx, childAreaPosPx);
}

/**
 * The bounds of the vertical insertion line, in child area coordinates. gapPx is the spacing between
 * boxes, used to center the line in the gap at row ends.
 */
export function justifiedInsertionLineBoundsPx(
  childBoundsPx: Array<BoundingBox>,
  insertion: JustifiedInsertion,
  gapPx: number,
): BoundingBox | null {
  const index = insertion.index;
  if (childBoundsPx.length == 0 || index < 0 || index > childBoundsPx.length) {
    return null;
  }

  const rows = justifiedRows(childBoundsPx);
  const afterPrevious = index == childBoundsPx.length || (insertion.afterPrevious && index > 0);
  const anchorIndex = afterPrevious ? index - 1 : index;
  const row = rows.find(r => anchorIndex >= r.first && anchorIndex <= r.last)!;

  let x;
  if (afterPrevious) {
    const prev = childBoundsPx[index - 1];
    x = index <= row.last
      ? (prev.x + prev.w + childBoundsPx[index].x) / 2
      : prev.x + prev.w + gapPx / 2;
  } else {
    const next = childBoundsPx[index];
    x = index > row.first
      ? (childBoundsPx[index - 1].x + childBoundsPx[index - 1].w + next.x) / 2
      : next.x - gapPx / 2;
  }

  return { x, y: row.top, w: 0, h: row.bottom - row.top };
}
