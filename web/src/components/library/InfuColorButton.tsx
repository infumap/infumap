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
import { Colors } from "../../style";


export const InfuColorButton: Component<{ col: number, onClick: (col: number) => void }> = (props: { col: number, onClick: (col: number) => void }) => {
  const clickHandler = (_ev: MouseEvent) => { props.onClick(props.col); }
  return (
    <div onClick={clickHandler}
         class="border rounded w-[19px] h-[18px] inline-block text-center cursor-pointer text-[18px]"
         style={`background-color: ${Colors[props.col]};`}></div>
  );
}
