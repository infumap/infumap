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
    if (props.icon == "header-1") { return "header"; }
    if (props.icon == "header-2") { return "header"; }
    if (props.icon == "header-3") { return "header"; }
    if (props.icon == "info-circle-1") { return "info-circle"; }
    if (props.icon == "info-circle-2") { return "info-circle"; }
    if (props.icon == "info-circle-3") { return "info-circle"; }
    return props.icon;
  }

  const subscript = () => {
    if (props.icon == "header-1") { return "1"; }
    if (props.icon == "header-2") { return "2"; }
    if (props.icon == "header-3") { return "3"; }
    if (props.icon == "info-circle-1") { return "1"; }
    if (props.icon == "info-circle-2") { return "2"; }
    if (props.icon == "info-circle-3") { return "3"; }
    return null;
  }

  const divClass = () => {
    if (props.highlighted) {
      return "hover:border font-bold rounded w-[22px] h-[21px] inline-block text-center cursor-pointer ml-[3px] text-[14px] bg-slate-200 hover:bg-slate-300 relative";
    }
    return "hover:border font-bold rounded w-[22px] h-[21px] inline-block text-center cursor-pointer ml-[3px] text-[14px] hover:bg-slate-200 relative";
  }

  return (
    <div ref={outerDivElement} class={divClass()}>
      <i class={`fa fa-${icon()}`} />
      <Show when={subscript() != null}>
        <div class="absolute text-[9px] left-[18px] top-[9px]">{subscript()}</div>
      </Show>
    </div>
  );
}
