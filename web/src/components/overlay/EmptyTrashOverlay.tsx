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

import { Component, Show } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";

export const EmptyTrashOverlay: Component = () => {
    const store = useStore();

    return (
        <Show when={store.overlay.emptyTrashInProgress.get()}>
            <div class="absolute left-0 top-0 bottom-0 right-0 select-none outline-hidden"
                style={`background-color: #00000040; z-index: ${Z_INDEX_TEXT_OVERLAY}; display: flex; align-items: center; justify-content: center;`}>
                <div class="border border-slate-700 rounded-md bg-white shadow-lg"
                    style={`width: 280px; height: 80px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);`}>
                    <div class="px-4 py-3 h-full flex flex-col justify-center items-center">
                        <div class="flex items-center">
                            <i class="fa fa-spinner fa-spin mr-3 text-slate-600" />
                            <span class="font-medium">Emptying trash...</span>
                        </div>
                    </div>
                </div>
            </div>
        </Show>
    );
};
