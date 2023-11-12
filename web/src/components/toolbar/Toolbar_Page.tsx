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
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { asPageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { InfuIconButton } from "../library/InfuIconButton";
import { InfuColorSelector } from "../library/InfuColorSelector";


export const Toolbar_Page: Component = () => {
  const desktopStore = useDesktopStore();

  const pageItem = () => asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);

  const handleChangeAlgorithm = () => {};

  return (
    <div class="inline-block p-[4px] flex-grow-0">
      <span>{pageItem().arrangeAlgorithm}</span>
      <InfuIconButton icon="refresh" highlighted={false} clickHandler={handleChangeAlgorithm} />
      <InfuColorSelector item={pageItem()} />
    </div>
  );
}
