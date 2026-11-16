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

/**
 * The faint caret that brings back a hidden toolbar or dock. The hover matches InfuIconButton in the toolbar.
 *
 * When both bars are hidden (presenting), the caret is concealed: transparent rather than coloured to blend in, so it
 * doesn't show on a page with a non-white background. It still takes clicks and shows itself on hover, so it stays
 * usable for someone who knows where it is.
 */
export function InfuRevealCaret(props: { icon: string, concealed: boolean, title: string, style: string, onMouseDown: () => void }) {
  return (
    <div class={"absolute print:hidden w-[20px] h-[20px] rounded-control flex items-center justify-center cursor-pointer " +
      "text-xs text-neutral-400 hover:text-neutral-800 hover:bg-control-hover " +
      (props.concealed ? "opacity-0 hover:opacity-100" : "")}
      style={props.style}
      title={props.title}
      onMouseDown={props.onMouseDown}>
      <i class={props.icon} />
    </div>
  );
}
