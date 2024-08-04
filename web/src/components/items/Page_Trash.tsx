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

import { useStore } from "../../store/StoreProvider";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const renderAsTrash = (pageFns: any) => {
  const store = useStore();

  const trashFontSizePx = () => {
    return pageFns.boundsPx().h * 0.65;
  }

  return (
    <div class={`absolute rounded-sm align-middle text-center`}
         style={`left: ${pageFns.boundsPx().x}px; top: ${pageFns.boundsPx().y}px; width: ${pageFns.boundsPx().w}px; height: ${pageFns.boundsPx().h}px; ` +
                `background-color: ${store.perVe.getMovingItemIsOver(pageFns.vePath()) ? "#dddddd" : (store.perVe.getMouseIsOver(pageFns.vePath()) ? "#eeeeee" : "#ffffff")}; ` +
                `font-size: ${trashFontSizePx()}px;`}>
      <i class="fa fa-trash" />
    </div>);
}
