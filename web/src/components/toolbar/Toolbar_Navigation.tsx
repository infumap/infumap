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
import { navigateBack, navigateUp, switchToPage } from '../../layout/navigation';
import { ROOT_USERNAME } from '../../constants';
import { InfuIconButton } from "../library/InfuIconButton";


export const Toolbar_Navigation: Component = () => {
  const store = useStore();

  const handleHome = () => {
    const userMaybe = store.user.getUserMaybe();
    if (!userMaybe) {
      window.history.pushState(null, "", "/");
    } else {
      switchToPage(store, { itemId: store.user.getUser().homePageId, linkIdMaybe: null }, false, false);
      if (userMaybe.username == ROOT_USERNAME) {
        window.history.pushState(null, "", "/");
      } else {
        window.history.pushState(null, "", `/${userMaybe.username}`);
      }
    }
  };

  const handleBack = () => navigateBack(store);

  const handleUp = () => navigateUp(store);

  const handleSearchClick = () => { store.searchOverlayVisible.set(!store.searchOverlayVisible.get()); };

  return (
    <div class="inline-block p-[4px] flex-grow-0">
      <Show when={store.user.getUserMaybe()}>
        <InfuIconButton icon="fa fa-home" highlighted={false} clickHandler={handleHome} />        
      </Show>
      <InfuIconButton icon="fa fa-search" highlighted={false} clickHandler={handleSearchClick} />
      <InfuIconButton icon="fa fa-arrow-circle-up" highlighted={false} clickHandler={handleUp} />
      <InfuIconButton icon="fa fa-arrow-circle-left" highlighted={false} clickHandler={handleBack} />
    </div>
  )
}
