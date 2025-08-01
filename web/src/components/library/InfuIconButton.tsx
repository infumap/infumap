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

import { Show, onCleanup, onMount } from "solid-js";


export function InfuIconButton(props: { icon: string; highlighted: boolean; clickHandler: () => void }) {
  let outerDivElement : HTMLDivElement | undefined;

  onMount(() => { outerDivElement?.addEventListener('click', props.clickHandler); });

  onCleanup(() => { outerDivElement?.removeEventListener('click', props.clickHandler); });

  const icon = () => {
    if (props.icon == "fa fa-header-1") { return "fa fa-header"; }
    if (props.icon == "fa fa-header-2") { return "fa fa-header"; }
    if (props.icon == "fa fa-header-3") { return "fa fa-header"; }
    if (props.icon == "fa fa-info-circle-1") { return "fa fa-info-circle"; }
    if (props.icon == "fa fa-info-circle-2") { return "fa fa-info-circle"; }
    if (props.icon == "fa fa-info-circle-3") { return "fa fa-info-circle"; }
    return props.icon;
  }

  const subscript = () => {
    if (props.icon == "fa fa-header-1") { return "1"; }
    if (props.icon == "fa fa-header-2") { return "2"; }
    if (props.icon == "fa fa-header-3") { return "3"; }
    if (props.icon == "fa fa-info-circle-1") { return "1"; }
    if (props.icon == "fa fa-info-circle-2") { return "2"; }
    if (props.icon == "fa fa-info-circle-3") { return "3"; }
    return null;
  }

  const divClass = () => {
    if (props.highlighted) {
      return "hover:border font-bold rounded w-[21px] h-[21px] inline-block text-center cursor-pointer ml-[3px] text-[14px] bg-slate-300 hover:bg-slate-400 relative text-gray-800";
    }
    return "hover:border font-bold rounded w-[21px] h-[21px] inline-block text-center cursor-pointer ml-[3px] text-[14px] hover:bg-slate-300 relative text-gray-800";
  }

  return (
    <div ref={outerDivElement} class={divClass()}>
      <Show when={props.icon == "expression"}>
        <span class="w-[21px] h-[16px] inline-block text-center relative">∑</span>
      </Show>
      <Show when={props.icon != "expression"}>
        <i class={`${icon()}`} />
        <Show when={subscript() != null}>
          <div class="absolute text-[9px] left-[18px] top-[9px]">{subscript()}</div>
        </Show>
      </Show>
    </div>
  );
}
