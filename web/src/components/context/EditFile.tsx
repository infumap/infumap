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

import { Component, onCleanup } from "solid-js";
import { server } from "../../server";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { asFileItem, FileItem } from "../../store/desktop/items/file-item";
import { useGeneralStore } from "../../store/GeneralStoreProvider";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";
import { arrange } from "../../store/desktop/layout/arrange";
import { rearrangeVisualElementsWithId } from "../../store/desktop/layout/rearrange";


export const EditFile: Component<{fileItem: FileItem}> = (props: {fileItem: FileItem}) => {
  const desktopStore = useDesktopStore();
  const generalStore = useGeneralStore();

  const fileId = props.fileItem.id;
  let deleted = false;

  const handleTextInput = (v: string) => {
    desktopStore.updateItem(fileId, item => asFileItem(item).title = v);
    rearrangeVisualElementsWithId(desktopStore, fileId);
  };

  const deleteFile = async () => {
    deleted = true;
    await server.deleteItem(fileId); // throws on failure.
    desktopStore.deleteItem(fileId);
    generalStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(desktopStore.getItem(fileId)!);
    }
  });

  return (
    <div>
      <div class="text-slate-800 text-sm">Text <InfuTextInput value={props.fileItem.title} onInput={handleTextInput} focus={true} /></div>
      <div><InfuButton text="delete" onClick={deleteFile} /></div>
    </div>
  );
}
