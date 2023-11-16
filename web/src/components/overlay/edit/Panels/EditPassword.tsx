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
import { server } from "../../../../server";
import { useStore } from "../../../../store/StoreProvider";
import { asPasswordItem, PasswordItem } from "../../../../items/password-item";
import { InfuButton } from "../../../library/InfuButton";
import { InfuTextInput } from "../../../library/InfuTextInput";
import { itemState } from "../../../../store/ItemState";
import { arrange } from "../../../../layout/arrange";


export const EditPassword: Component<{passwordItem: PasswordItem, linkedTo: boolean}> = (props: { passwordItem: PasswordItem, linkedTo: boolean }) => {
  const store = useStore();

  const passwordId = props.passwordItem.id;
  let deleted = false;

  const handleTextInput = (v: string) => {
    asPasswordItem(itemState.get(passwordId)!).text = v;
    arrange(store);
  };

  const deletePassword = async () => {
    deleted = true;
    await server.deleteItem(passwordId); // throws on failure.
    itemState.delete(passwordId);
    store.editDialogInfo.set(null);
    arrange(store);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(itemState.get(passwordId)!);
    }
  });

  return (
    <div>
      <div class="text-slate-800 text-sm">Text <InfuTextInput value={props.passwordItem.text} onInput={handleTextInput} focus={true} /></div>
      <Show when={!props.linkedTo}>
        <div><InfuButton text="delete" onClick={deletePassword} /></div>
      </Show>
    </div>
  );
}
