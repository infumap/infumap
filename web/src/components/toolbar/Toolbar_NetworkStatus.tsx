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

import { Component, Show } from "solid-js"
import { useStore } from "../../store/StoreProvider";
import { NETWORK_STATUS_ERROR, NETWORK_STATUS_IN_PROGRESS } from "../../store/StoreProvider_General";
import { createBooleanSignal } from "../../util/signals";


export const Toolbar_NetworkStatus: Component = () => {
  const store = useStore();

  const hoveringOver = createBooleanSignal(false);

  const col = () => {
    const status = store.general.networkStatus.get();
    if (status == NETWORK_STATUS_ERROR) { return "#bb7373"; }
    if (status == NETWORK_STATUS_IN_PROGRESS) { return "#babb73"; }
    return "#7bbb73";
  };

  const hoverText = () => {
    const status = store.general.networkStatus.get();
    if (status == NETWORK_STATUS_ERROR) { return "Network Status: Error"; }
    if (status == NETWORK_STATUS_IN_PROGRESS) { return "Network Status: In Progress"; }
    return "Network Status: OK";
  };

  const handleMouseEnter = () => {
    hoveringOver.set(true);
  };

  const handleMouseLeave = () => {
    hoveringOver.set(false);
  };

  return (
    <div class="w-[21px] h-[21px] inline-block ml-[7px] mr-[-2px] relative">
      <div class={`w-[19px] h-[19px] mt-[7px] rounded border-slate-500 border`}
           style={`background-color: ${col()};`}
           onMouseEnter={handleMouseEnter}
           onMouseLeave={handleMouseLeave}
           />
      <Show when={hoveringOver.get()}>
        <div class={`absolute rounded border-slate-500 border`}
             style={'top: 40px; right: -25px; width: 200px; padding-left: 8px; padding-top: 4px; padding-bottom: 4px; padding-right: 8px;'}>
          {hoverText()}
        </div>
      </Show>
    </div>
  );
}
