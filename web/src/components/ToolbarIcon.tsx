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

import { onCleanup, onMount } from "solid-js";


export default function ToolbarIcon(props: { icon: string; margin: number; clickHandler: () => void }) {
  let outerDivElement : HTMLDivElement | undefined;

  onMount(() => { outerDivElement?.addEventListener('click', props.clickHandler); });
  onCleanup(() => { outerDivElement?.removeEventListener('click', props.clickHandler); });

  return (
    <div ref={outerDivElement}
         class="border rounded w-[29px] h-[28px] inline-block text-center cursor-move ml-[5px] text-[18px]"
         style={`background-color: rgba(40, 57, 83, 0.47); border-color: rgba(23, 32, 47, 0.47); margin-bottom: ${props.margin}px`}>
      <i class={`fa fa-${props.icon}`} />
    </div>
  );
}
