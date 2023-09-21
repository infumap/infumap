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
import { CompositeItem } from "../../../items/composite-item";
import { useDesktopStore } from "../../../store/DesktopStoreProvider";
import { InfuButton } from "../../library/InfuButton";
import { server } from "../../../server";
import { itemState } from "../../../store/ItemState";
import { arrange } from "../../../layout/arrange";


export const EditComposite: Component<{compositeItem: CompositeItem, linkedTo: boolean}> = (props: { compositeItem: CompositeItem, linkedTo: boolean }) => {
  const desktopStore = useDesktopStore();

  const compositeId = props.compositeItem.id;
  let deleted = false;

  const deleteComposite = async () => {
    deleted = true;
    await server.deleteItem(compositeId); // throws on failure.
    itemState.delete(compositeId);
    desktopStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  return (
    <div class="m-1">
      <Show when={!props.linkedTo}>
        <div><InfuButton text="delete" onClick={deleteComposite} /></div>
      </Show>
    </div>
  );
}