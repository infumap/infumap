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
import { linearGradient } from "../../style";
import { createInfuSignal } from "../../util/signals";


export const InfuColorButton: Component<{ col: number, onClick: (col: number) => void }> = (props: { col: number, onClick: (col: number) => void }) => {
  let isOver = createInfuSignal<boolean>(false);
  const clickHandler = (_ev: MouseEvent) => { props.onClick(props.col); }
  const handleMouseEnter = () => { isOver.set(true); }
  const handleMouseLeave = () => { isOver.set(false); }
  return (
    <div onClick={clickHandler}
         onMouseEnter={handleMouseEnter}
         onMouseLeave={handleMouseLeave}
         class="border border-slate-950 rounded w-[19px] h-[19px] inline-block text-center cursor-pointer text-[18px]"
         style={`background-image: ${isOver.get() ? linearGradient(props.col, 0.2) : linearGradient(props.col, 0.05)};`}></div>
  );
}
