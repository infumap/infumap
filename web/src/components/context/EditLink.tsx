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

import { Component, Show, onCleanup } from "solid-js";
import { server } from "../../server";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";
import { arrange } from "../../layout/arrange";
import { LinkItem, asLinkItem } from "../../items/link-item";
import { EMPTY_UID } from "../../util/uid";
import { EditItem } from "./EditItem";
import { Item } from "../../items/base/item";
import { itemState } from "../../store/ItemState";
import { panic } from "../../util/lang";


export const EditLink: Component<{linkItem: LinkItem, linkedTo: boolean}> = (props: {linkItem: LinkItem, linkedTo: boolean}) => {
  const desktopStore = useDesktopStore();

  const linkId = props.linkItem.id;
  const linkToItem = (): Item | null => {
    if (props.linkedTo) {
      // not supported to have link item linked to.
      panic();
    }
    if (props.linkItem.linkTo == EMPTY_UID) {
      return null;
    }
    const item = itemState.getItem(props.linkItem.linkTo);
    return item;
  }
  let deleted = false;

  const handleLinkToInput = (v: string) => {
    if (!deleted) {
      asLinkItem(itemState.getItem(linkId)!).linkToResolvedId = null;
      asLinkItem(itemState.getItem(linkId)!).linkTo = v;
      arrange(desktopStore);
    }
  };

  const handleLinkToBaseUrlInput = (v: string) => {
    if (!deleted) {
      asLinkItem(itemState.getItem(linkId)!).linkToResolvedId = null;
      asLinkItem(itemState.getItem(linkId)!).linkToBaseUrl = v;
      arrange(desktopStore);
    }
  };

  const deleteLink = async () => {
    deleted = true;
    await server.deleteItem(linkId); // throws on failure.
    itemState.deleteItem(linkId);
    desktopStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(itemState.getItem(linkId)!);
    }
  });

  return (
    <>
      <div class="m-1">
        <div class="text-slate-800 text-sm">Link To: <InfuTextInput value={props.linkItem.linkTo} onChangeOrCleanup={handleLinkToInput} /></div>
        <div class="text-slate-800 text-sm">Base Url: <InfuTextInput value={props.linkItem.linkToBaseUrl} onChangeOrCleanup={handleLinkToBaseUrlInput} /></div>
        <div><InfuButton text="delete" onClick={deleteLink} /></div>
      </div>
      <Show when={linkToItem() != null && props.linkItem.linkToBaseUrl == ""}>
        <EditItem item={linkToItem()!} linkedTo={true} />
      </Show>
    </>
  );
}
