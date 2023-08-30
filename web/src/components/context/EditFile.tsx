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
import { asFileItem, FileItem } from "../../items/file-item";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";
import { arrange } from "../../layout/arrange";
import { itemState } from "../../store/ItemState";


export const EditFile: Component<{fileItem: FileItem, linkedTo: boolean}> = (props: {fileItem: FileItem, linkedTo: boolean}) => {
  const desktopStore = useDesktopStore();

  const fileId = props.fileItem.id;
  let deleted = false;

  const handleTextInput = (v: string) => {
    asFileItem(itemState.getItem(fileId)!).title = v;
    // rearrangeVisualElementsWithItemId(desktopStore, fileId);
    arrange(desktopStore);
  };

  const deleteFile = async () => {
    deleted = true;
    await server.deleteItem(fileId); // throws on failure.
    itemState.deleteItem(fileId);
    desktopStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(itemState.getItem(fileId)!);
    }
  });

  return (
    <div>
      <div class="text-slate-800 text-sm">Text <InfuTextInput value={props.fileItem.title} onInput={handleTextInput} focus={true} /></div>
      <Show when={!props.linkedTo}>
        <div><InfuButton text="delete" onClick={deleteFile} /></div>
      </Show>
    </div>
  );
}
