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

import { Component } from "solid-js";
import {
  compositeMoveOutHandleLineGapPx,
  compositeMoveOutHandleLineHeightPx,
  compositeMoveOutHandleLineLeftPx,
  compositeMoveOutHandleLineTopPx,
  compositeMoveOutHandleLineWidthPx,
} from "../../layout/composite-move-out";
import { BoundingBox } from "../../util/geometry";


interface CompositeMoveOutHandleProps {
  boundsPx: BoundingBox,
  active?: boolean,
}

export const CompositeMoveOutHandle: Component<CompositeMoveOutHandleProps> = (props: CompositeMoveOutHandleProps) => {
  const lineClass = () => props.active ? "absolute rounded-full bg-slate-700" : "absolute rounded-full bg-slate-500";
  const lineOpacity = () => props.active ? 0.95 : 0.8;

  return (
    <div class="absolute pointer-events-none"
      style={`left: ${props.boundsPx.x}px; top: ${props.boundsPx.y}px; width: ${props.boundsPx.w}px; height: ${props.boundsPx.h}px;`}>
      <div class={lineClass()}
        style={`left: ${compositeMoveOutHandleLineLeftPx(props.boundsPx)}px; top: ${compositeMoveOutHandleLineTopPx(props.boundsPx)}px; width: ${compositeMoveOutHandleLineWidthPx()}px; height: ${compositeMoveOutHandleLineHeightPx(props.boundsPx)}px; opacity: ${lineOpacity()};`} />
      <div class={lineClass()}
        style={`left: ${compositeMoveOutHandleLineLeftPx(props.boundsPx) + compositeMoveOutHandleLineWidthPx() + compositeMoveOutHandleLineGapPx()}px; top: ${compositeMoveOutHandleLineTopPx(props.boundsPx)}px; width: ${compositeMoveOutHandleLineWidthPx()}px; height: ${compositeMoveOutHandleLineHeightPx(props.boundsPx)}px; opacity: ${lineOpacity()};`} />
    </div>
  );
};
