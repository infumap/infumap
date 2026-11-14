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
import { dialogButtonClass } from "./dialogStyle";


interface InfuButtonProps {
  text: string,
  onClick?: (() => void),
  disabled?: boolean,
  fullWidth?: boolean,
  /** The size of a button in a dialog, rather than the larger one of the login page. */
  compact?: boolean,
}


export const InfuButton: Component<InfuButtonProps> = (props: InfuButtonProps) => {

  const handleClick = (_ev: MouseEvent) => {
    if (props.onClick) { props.onClick() }
  }

  const handleMouseDown = (ev: MouseEvent) => {
    ev.stopPropagation();
  }

  return (
    <button class={props.compact
              ? `${dialogButtonClass()} ${props.fullWidth ? "w-full" : ""}`
              : `rounded-control border border-control-border bg-white hover:bg-control-hover px-4 py-2 focus-visible:outline-2 ` +
                `focus-visible:outline-offset-1 focus-visible:outline-focus ${props.fullWidth ? "w-full" : ""} ${props.disabled ? "opacity-70 cursor-not-allowed" : ""}`}
            onclick={handleClick}
            onmousedown={handleMouseDown}
            disabled={props.disabled}>
      {props.text}
    </button>
  );
}
