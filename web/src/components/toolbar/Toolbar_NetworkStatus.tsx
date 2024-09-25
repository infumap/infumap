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

import { Component } from "solid-js"
import { useStore } from "../../store/StoreProvider";
import { NETWORK_STATUS_ERROR, NETWORK_STATUS_IN_PROGRESS } from "../../store/StoreProvider_General";


export const Toolbar_NetworkStatus: Component = () => {
  const store = useStore();

  const col = () => {
    const status = store.general.networkStatus.get();
    if (status == NETWORK_STATUS_ERROR) { return "#9b3333"; }
    if (status == NETWORK_STATUS_IN_PROGRESS) { return "#9a9b33"; }
    return "#3b9b33";
  }

  return (
    <div class="w-[21px] h-[21px] inline-block ml-[7px] mr-[-2px]">
      <div class={`w-[16px] h-[16px] mt-[7px] rounded`} style={`background-color: ${col()};`} />
    </div>
  );
}
