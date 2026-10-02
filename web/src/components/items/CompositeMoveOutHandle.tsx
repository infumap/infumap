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

import { Component, For } from "solid-js";
import { compositeMoveOutHandleGeometry } from "../../layout/composite-move-out";
import type { VisualElementPath } from "../../layout/visual-element";
import { BoundingBox } from "../../util/geometry";


interface CompositeMoveOutHandleProps {
  boundsPx: BoundingBox,
  active?: boolean,
  vePath?: VisualElementPath,
}

export const CompositeMoveOutHandle: Component<CompositeMoveOutHandleProps> = (props: CompositeMoveOutHandleProps) => {
  const geometry = () => compositeMoveOutHandleGeometry(props.boundsPx);
  const dotClass = () => props.active ? "absolute rounded-full bg-slate-600" : "absolute rounded-full bg-slate-400";

  return (
    <div class="absolute pointer-events-none"
      data-infumap-composite-move-out-path={props.vePath}
      style={`left: ${props.boundsPx.x}px; top: ${props.boundsPx.y}px; width: ${props.boundsPx.w}px; height: ${props.boundsPx.h}px;`}>
      <div class="absolute rounded bg-slate-200 transition-opacity duration-100"
        style={`left: ${geometry().backgroundBoundsPx.x}px; top: ${geometry().backgroundBoundsPx.y}px; width: ${geometry().backgroundBoundsPx.w}px; height: ${geometry().backgroundBoundsPx.h}px; opacity: ${props.active ? 1 : 0};`} />
      <For each={geometry().dotPositionsPx}>{dot =>
        <div class={dotClass()}
          style={`left: ${dot.x}px; top: ${dot.y}px; width: ${geometry().dotSizePx}px; height: ${geometry().dotSizePx}px; opacity: ${props.active ? 1 : 0.7};`} />
      }</For>
    </div>
  );
};
