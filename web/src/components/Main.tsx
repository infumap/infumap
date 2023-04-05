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
import { Component, onMount, Show } from "solid-js";
import { server } from "../server";
import { arrange, childrenLoadInitiatedOrComplete, switchToPage } from "../store/desktop/layout/arrange";
import { useDesktopStore } from "../store/desktop/DesktopStoreProvider";
import { useGeneralStore } from "../store/GeneralStoreProvider";
import { useUserStore } from "../store/UserStoreProvider";
import { Desktop } from "./Desktop";
import { Toolbar } from "./Toolbar";
import { EMPTY_UID } from "../util/uid";


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
      const result = await server.fetchChildrenWithTheirAttachments(null);
      const rootPage = result.items.find((a: any) => a['parentId'] == EMPTY_UID) as any;
      const rootId = rootPage.id;
      childrenLoadInitiatedOrComplete[rootId] = true;
      desktopStore.setChildItemsFromServerObjects(rootId, result.items);
      Object.keys(result.attachments).forEach(id => {
        desktopStore.setAttachmentItemsFromServerObjects(id, result.attachments[id]);
      });
      switchToPage(desktopStore, rootId);

    } catch (e) {
      console.log("An error occurred loading root page, clearing user session.", e);
      userStore.clear();
      generalStore.clearInstallationState();
      await generalStore.retrieveInstallationState();
    }
  });

  return (
    <div class="fixed top-0 left-0 right-0 bottom-0 select-none touch-none overflow-hidden">
      <Show when={desktopStore.currentPageId() != null}>
        <Desktop visualElement={arrange(desktopStore)!} />
      </Show>
      <Toolbar />
    </div>
  );
}
