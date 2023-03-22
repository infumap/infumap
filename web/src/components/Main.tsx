/*
  Copyright (C) 2023 The Infumap Authors
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

import { useNavigate } from "@solidjs/router";
import { Component, onMount } from "solid-js";
import { server } from "../server";
import { childrenLoadInitiatedOrComplete, switchToPage } from "../store/desktop/layout/arrange";
import { useDesktopStore } from "../store/desktop/DesktopStoreProvider";
import { useGeneralStore } from "../store/GeneralStoreProvider";
import { useUserStore } from "../store/UserStoreProvider";
import { Desktop } from "./Desktop";
import { Toolbar } from "./Toolbar";


export const Main: Component = () => {
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();
  const generalStore = useGeneralStore();
  const navigate = useNavigate();

  onMount(async () => {
    if (!generalStore.installationState()!.hasRootUser) {
      navigate('/setup');
    }
    let user = userStore.getUserMaybe();
    if (user == null) {
      navigate('/login');
    }

    try {
      const rootId = user!.rootPageId!;
      const result = await server.fetchChildrenWithTheirAttachments(rootId);
      childrenLoadInitiatedOrComplete[rootId] = true;
      desktopStore.setChildItems(rootId, result.items);
      Object.keys(result.attachments).forEach(id => {
        desktopStore.setAttachmentItems(id, result.attachments[id]);
      });
      switchToPage(desktopStore, rootId, userStore.getUser());

    } catch (e) {
      console.log("An error occurred loading root page, clearing user session.", e);
      userStore.clear();
      generalStore.clearInstallationState();
      await generalStore.retrieveInstallationState();
    }
  });

  return (
    <div class="fixed top-0 left-0 right-0 bottom-0 select-none touch-none overflow-hidden">
      <Desktop />
      <Toolbar />
    </div>
  );
}
