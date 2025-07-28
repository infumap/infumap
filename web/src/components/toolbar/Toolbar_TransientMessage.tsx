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
import { useStore } from "../../store/StoreProvider";
import { Z_INDEX_TOOLBAR_OVERLAY } from "../../constants";
import { TransientMessageType } from "../../store/StoreProvider_Overlay";


export const Toolbar_TransientMessage: Component = () => {
  const store = useStore();

  const message = () => store.overlay.toolbarTransientMessage.get();
  const isError = () => message()?.type === TransientMessageType.Error;

  return (
    <div class="absolute border rounded mb-1 shadow-md pl-[12px] pr-[12px] pt-[6px] pb-[6px] text-sm"
         classList={{
           "bg-white border-black text-slate-800": !isError(),
           "border-black text-white font-semibold": isError()
         }}
         style={`right: ${5}px; top: ${47}px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY}; ${isError() ? 'background-color: #dc2626;' : ''}`}>
      {message()?.text}
    </div>
  );
}
