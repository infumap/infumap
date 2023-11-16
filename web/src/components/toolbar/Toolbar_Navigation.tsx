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
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { navigateBack, navigateUp, switchToPage } from '../../layout/navigation';
import { ROOT_USERNAME } from '../../constants';
import { InfuIconButton } from "../library/InfuIconButton";


export const Toolbar_Navigation: Component = () => {
  const desktopStore = useDesktopStore();

  const handleHome = () => {
    const userMaybe = desktopStore.userStore.getUserMaybe();
    if (!userMaybe) {
      window.history.pushState(null, "", "/");
    } else {
      switchToPage(desktopStore, { itemId: desktopStore.userStore.getUser().homePageId, linkIdMaybe: null }, false, false);
      if (userMaybe.username == ROOT_USERNAME) {
        window.history.pushState(null, "", "/");
      } else {
        window.history.pushState(null, "", `/${userMaybe.username}`);
      }
    }
  };

  const handleBack = () => navigateBack(desktopStore);

  const handleUp = () => navigateUp(desktopStore);

  const handleSearchClick = () => { desktopStore.searchOverlayVisible.set(!desktopStore.searchOverlayVisible.get()); };

  return (
    <div class="inline-block p-[4px] flex-grow-0">
      <Show when={desktopStore.userStore.getUserMaybe()}>
        <InfuIconButton icon="fa fa-home" highlighted={false} clickHandler={handleHome} />        
      </Show>
      <InfuIconButton icon="fa fa-search" highlighted={false} clickHandler={handleSearchClick} />
      <InfuIconButton icon="fa fa-arrow-circle-up" highlighted={false} clickHandler={handleUp} />
      <InfuIconButton icon="fa fa-arrow-circle-left" highlighted={false} clickHandler={handleBack} />
    </div>
  )
}
