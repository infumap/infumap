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
import { navigateBack, navigateToLocalRoot, navigateToSearches, navigateUp } from '../../layout/navigation';
import { InfuIconButton } from "../library/InfuIconButton";


export const Toolbar_Navigation: Component = () => {
  const store = useStore();

  const handleHome = () => {
    void navigateToLocalRoot(store);
  };

  const handleBack = async () => { await navigateBack(store); };

  const handleUp = async () => { await navigateUp(store); };

  const handleSearchClick = async () => {
    await navigateToSearches(store);
  };

  return (
    <div class="inline-block p-[4px]" style="height: 30px; overflow-y: hidden;">
      <Show when={store.user.getUserMaybe()}>
        <InfuIconButton icon="fa fa-home" highlighted={false} clickHandler={handleHome} />
      </Show>
      <InfuIconButton icon="fa fa-search" highlighted={false} clickHandler={handleSearchClick} />
      <InfuIconButton icon="fa fa-arrow-circle-up" highlighted={false} clickHandler={handleUp} />
      <InfuIconButton icon="fa fa-arrow-circle-left" highlighted={false} clickHandler={handleBack} />
    </div>
  )
}
