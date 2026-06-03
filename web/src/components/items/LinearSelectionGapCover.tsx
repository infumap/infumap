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

import { Component, Show } from "solid-js";

import { BoundingBox } from "../../util/geometry";


export function linearSelectionGapAfterBoundsPx(
  boundsPx: BoundingBox,
  nextBoundsPx: BoundingBox | null,
  widthPx: number,
): BoundingBox | null {
  if (nextBoundsPx == null) { return null; }

  const topPx = boundsPx.y + boundsPx.h;
  const heightPx = nextBoundsPx.y - topPx;
  if (heightPx <= 0) { return null; }

  return {
    x: 0,
    y: topPx,
    w: widthPx,
    h: heightPx,
  };
}

export const LinearSelectionGapCover: Component<{
  boundsPx: () => BoundingBox | null,
  enabled: () => boolean,
}> = (props) =>
  <Show when={props.enabled() ? props.boundsPx() : null}>{boundsPx =>
    <div
      aria-hidden="true"
      contentEditable={false}
      class="absolute select-none"
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
        `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
        `z-index: 2; cursor: text; user-select: none; -webkit-user-select: none;`} />
  }</Show>;
